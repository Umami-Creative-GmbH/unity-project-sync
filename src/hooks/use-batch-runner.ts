import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { runLimited } from "@/hooks/use-folder-infos";
import { api, errorMessage, isCancelledError, onScanProgress, onSyncProgress } from "@/lib/api";
import {
  batchReducer,
  canInclude,
  includedItems,
  initialBatch,
  isBatchBusy,
  newBatchItem,
  retryableIds,
  type BatchAction,
  type BatchItem,
  type BatchState,
} from "@/lib/batch";
import { detectBatchConflicts, projectDisplayName, validateProject } from "@/lib/projects";
import type { ProjectInfo, SyncProject } from "@/lib/types";

interface BatchRunnerOptions {
  /** The current project list (read when a batch starts). */
  getProjects: () => SyncProject[];
  /**
   * The `threads` request for the backend (null = auto), see effectiveThreads(). Read once when a
   * batch starts scanning (a "sync now" batch keeps it for its syncs too) and once when the preview's
   * "Start sync" is pressed: a running batch never changes its thread count.
   */
  getThreads: () => number | null;
  /** The run phase ended (the report is showing). */
  onFinished: (state: BatchState) => void;
  /**
   * A project's scan failed. Called right away (not only at the end of the run), so its last run
   * is recorded however the batch ends afterwards (cancel, Back, nothing to sync).
   */
  onScanFailed: (projectId: string) => void;
  /**
   * The batch was cancelled while checking or scanning. `keptPreview`: the projects that finished
   * scanning are shown in the preview; otherwise the UI is back on the list.
   */
  onScanCancelled: (autoSync: boolean, keptPreview: boolean) => void;
  /** Something unexpected went wrong; the UI shows the error on the list. */
  onFailed: (message: string) => void;
}

export interface BatchRunner {
  state: BatchState;
  busy: boolean;
  /** Pre-flight + sequential scans of `projectIds` (list order); then preview, or sync right away. */
  start: (projectIds: string[], autoSync: boolean) => void;
  setInclude: (projectId: string, include: boolean) => void;
  /** Preview → sync the included projects. */
  startSync: () => void;
  /** Rescan the projects of the current batch (preview or report). */
  rescan: () => void;
  /**
   * Report → scan the projects that ended with errors or failed again, in the same mode as this
   * batch (preview or sync now).
   */
  retry: () => void;
  /** Cancels the current scan/sync and skips the remaining ones. */
  cancel: () => void;
  /** Leaves preview/report/error for the list (discarding plans that won't run). */
  close: () => void;
}

/**
 * Drives a batch: inspects, validates and scans the chosen projects one after another (each with its
 * own opId), then syncs them one after another, continuing on errors. Progress events are received
 * once for the app's lifetime and routed to the current project.
 */
export function useBatchRunner(options: BatchRunnerOptions): BatchRunner {
  const [state, setState] = useState<BatchState>(initialBatch);
  // The async flow needs the latest state synchronously, so the reducer runs here, not in React.
  const stateRef = useRef<BatchState>(initialBatch);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const opIdRef = useRef(0);
  const cancelRef = useRef(false);
  /** Bumped per batch so a superseded flow stops touching the state. */
  const tokenRef = useRef(0);

  const dispatch = useCallback((action: BatchAction) => {
    const next = batchReducer(stateRef.current, action);
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
  }, []);

  // Progress events for the lifetime of the app (StrictMode-safe: late registrations are undone).
  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    const register = (p: Promise<UnlistenFn>) =>
      p
        .then((un) => (disposed ? un() : unlisteners.push(un)))
        .catch((e) => console.warn("Could not listen to backend events:", e));
    register(onScanProgress((progress) => dispatch({ type: "scanProgress", progress })));
    register(onSyncProgress((progress) => dispatch({ type: "syncProgress", progress })));
    return () => {
      disposed = true;
      unlisteners.forEach((un) => un());
    };
  }, [dispatch]);

  const discard = useCallback((planIds: number[]) => {
    if (planIds.length === 0) return;
    api.discardPlans(planIds).catch((e) => console.warn("Could not discard scan plans:", e));
  }, []);

  /** Plans the backend still holds for the current batch and that have not been run. */
  const discardHeldPlans = useCallback(
    (items: BatchItem[]) =>
      discard(items.filter((it) => it.plan && (it.run === "none" || it.run === "pending")).map((it) => it.plan!.planId)),
    [discard],
  );

  const preflight = useCallback(async (projects: SyncProject[]): Promise<BatchItem[]> => {
    const paths = [...new Set(projects.flatMap((p) => [p.source, p.target]).filter((p): p is string => !!p))];
    const infos = new Map<string, ProjectInfo | { error: string }>();
    await runLimited(paths, 4, async (path) => {
      try {
        infos.set(path, await api.inspectProject(path));
      } catch (e) {
        infos.set(path, { error: errorMessage(e) });
      }
    });
    const infoOf = (path: string | null) => {
      const v = path ? infos.get(path) : undefined;
      return v && !("error" in v) ? v : null;
    };
    const errorOf = (path: string | null) => {
      const v = path ? infos.get(path) : undefined;
      return v && "error" in v ? v.error : null;
    };

    const skip = new Map<string, string>();
    for (const p of projects) {
      const sourceError = errorOf(p.source);
      const targetError = errorOf(p.target);
      const issues = validateProject(p, infoOf(p.source), infoOf(p.target));
      if (sourceError) skip.set(p.id, `Couldn't inspect the source folder: ${sourceError}`);
      else if (targetError) skip.set(p.id, `Couldn't inspect the target folder: ${targetError}`);
      else if (issues.length > 0) skip.set(p.id, issues[0].message);
    }
    // Compare resolved paths (junctions, symlinks, mapped drives, UNC aliases), falling back to the
    // path as written; the UI keeps showing the user's paths.
    const cmp = (path: string) => infoOf(path)?.comparePath || path;
    const conflicts = detectBatchConflicts(
      projects
        .filter((p) => !skip.has(p.id))
        .map((p) => ({ id: p.id, name: projectDisplayName(p), source: cmp(p.source!), target: cmp(p.target!) })),
    );
    return projects.map((p) =>
      newBatchItem({
        projectId: p.id,
        name: projectDisplayName(p),
        source: p.source ?? "",
        target: p.target ?? "",
        scope: { includeRootFiles: p.scope.includeRootFiles, folders: [...p.scope.folders], exclude: [...p.scope.exclude] },
        skipReason: skip.get(p.id) ?? conflicts.skipped[p.id] ?? null,
        warnings: conflicts.warnings[p.id] ?? [],
      }),
    );
  }, []);

  const runSyncs = useCallback(
    async (token: number, projectIds: string[], threads: number | null) => {
      const runIds = new Set(projectIds);
      // Plans that won't run (excluded, nothing to do) are released right away.
      discard(
        stateRef.current.items
          .filter((it) => it.plan && !(runIds.has(it.projectId) && canInclude(it)))
          .map((it) => it.plan!.planId),
      );
      dispatch({ type: "syncPhaseStarted", ids: projectIds, now: Date.now() });

      const queue = stateRef.current.items.filter((it) => it.run === "pending");
      for (const item of queue) {
        if (cancelRef.current || token !== tokenRef.current) break;
        opIdRef.current += 1;
        const opId = opIdRef.current;
        dispatch({ type: "syncStarted", id: item.projectId, opId });
        try {
          const report = await api.runSync(item.plan!.planId, opId, threads);
          if (token !== tokenRef.current) return;
          dispatch({ type: "syncFinished", id: item.projectId, report });
          if (report.cancelled) break;
        } catch (e) {
          if (token !== tokenRef.current) return;
          dispatch({ type: "syncFailed", id: item.projectId, error: errorMessage(e) });
          // Continue with the next project (unless the user cancelled).
        }
      }
      if (token !== tokenRef.current) return;
      discardHeldPlans(stateRef.current.items.filter((it) => it.run === "pending"));
      dispatch({ type: "finished", now: Date.now() });
      optionsRef.current.onFinished(stateRef.current);
    },
    [discard, discardHeldPlans, dispatch],
  );

  const start = useCallback(
    (projectIds: string[], autoSync: boolean) => {
      if (isBatchBusy(stateRef.current)) return;
      discardHeldPlans(stateRef.current.items);
      cancelRef.current = false;
      const token = ++tokenRef.current;
      const threads = optionsRef.current.getThreads();
      dispatch({ type: "begin", autoSync, chosenIds: projectIds, now: Date.now() });

      void (async () => {
        try {
          const wanted = new Set(projectIds);
          const projects = optionsRef.current.getProjects().filter((p) => wanted.has(p.id));
          const items = await preflight(projects);
          if (token !== tokenRef.current) return;
          if (cancelRef.current) {
            dispatch({ type: "reset" });
            optionsRef.current.onScanCancelled(autoSync, false);
            return;
          }
          dispatch({ type: "preflightDone", items });

          let cancelled = false;
          for (const item of items) {
            if (item.scan !== "pending") continue;
            if (cancelRef.current) {
              cancelled = true;
              break;
            }
            opIdRef.current += 1;
            const opId = opIdRef.current;
            dispatch({ type: "scanStarted", id: item.projectId, opId, now: Date.now() });
            try {
              const plan = await api.scan(item.source, item.target, item.scope, opId, threads);
              if (token !== tokenRef.current) {
                discard([plan.planId]);
                return;
              }
              dispatch({ type: "scanFinished", id: item.projectId, plan });
              if (cancelRef.current) {
                cancelled = true; // Cancel was pressed just as the scan finished.
                break;
              }
            } catch (e) {
              if (token !== tokenRef.current) return;
              if (cancelRef.current || isCancelledError(e)) {
                cancelled = true;
                break;
              }
              // One failed scan doesn't stop the others.
              dispatch({ type: "scanFailed", id: item.projectId, error: errorMessage(e) });
              optionsRef.current.onScanFailed(item.projectId);
            }
          }

          if (cancelled) {
            dispatch({ type: "scanCancelled" }); // pending/scanning → "cancelled", not includable
            const anyScanned = stateRef.current.items.some((it) => it.scan === "scanned");
            if (!autoSync && anyScanned) {
              // Keep the finished scans: the preview shows them; cancelled rows can't be included.
              dispatch({ type: "showPreview" }); // also clears `cancelling`
              optionsRef.current.onScanCancelled(autoSync, true);
              return;
            }
            discardHeldPlans(stateRef.current.items);
            dispatch({ type: "reset" });
            optionsRef.current.onScanCancelled(autoSync, false);
            return;
          }

          if (!autoSync) {
            dispatch({ type: "showPreview" });
            return;
          }
          const withWork = stateRef.current.items.filter(canInclude).map((it) => it.projectId);
          // "Sync now" is one run: the sync keeps the threads the scan started with.
          await runSyncs(token, withWork, threads);
        } catch (e) {
          if (token !== tokenRef.current) return;
          const message = errorMessage(e);
          discardHeldPlans(stateRef.current.items);
          dispatch({ type: "failed", message });
          optionsRef.current.onFailed(message);
        }
      })();
    },
    [discard, discardHeldPlans, dispatch, preflight, runSyncs],
  );

  const setInclude = useCallback(
    (projectId: string, include: boolean) => dispatch({ type: "setInclude", id: projectId, include }),
    [dispatch],
  );

  const startSync = useCallback(() => {
    const s = stateRef.current;
    if (s.phase !== "preview") return;
    cancelRef.current = false;
    const token = tokenRef.current;
    const ids = includedItems(s).map((it) => it.projectId);
    // Settings changed while the preview was open apply to this sync.
    void runSyncs(token, ids, optionsRef.current.getThreads()).catch((e) => {
      if (token !== tokenRef.current) return;
      const message = errorMessage(e);
      discardHeldPlans(stateRef.current.items);
      dispatch({ type: "failed", message });
      optionsRef.current.onFailed(message);
    });
  }, [discardHeldPlans, dispatch, runSyncs]);

  const rescan = useCallback(() => {
    const ids = stateRef.current.chosenIds;
    if (ids.length > 0) start(ids, false);
  }, [start]);

  // Keeps the batch's mode: a "Sync now" batch retries without preview; a preview batch shows the
  // preview again (the retried projects get new plans, so their deletions need a new confirmation).
  const retry = useCallback(() => {
    const s = stateRef.current;
    if (s.phase !== "report") return;
    const ids = retryableIds(s);
    if (ids.length > 0) start(ids, s.autoSync);
  }, [start]);

  const cancel = useCallback(() => {
    if (!isBatchBusy(stateRef.current)) return;
    cancelRef.current = true;
    dispatch({ type: "cancelRequested" });
    api.cancelOperation(opIdRef.current).catch((e) => console.warn("Could not cancel:", e));
  }, [dispatch]);

  const close = useCallback(() => {
    if (isBatchBusy(stateRef.current)) return;
    discardHeldPlans(stateRef.current.items);
    tokenRef.current++;
    dispatch({ type: "reset" });
  }, [discardHeldPlans, dispatch]);

  return { state, busy: isBatchBusy(state), start, setInclude, startSync, rescan, retry, cancel, close };
}
