import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { IconLoader2, IconX } from "@tabler/icons-react";
import { toast } from "sonner";

import { AppHeader } from "@/components/app-header";
import { InlineNotice } from "@/components/folder-card";
import { PlanPreview } from "@/components/plan-preview";
import { RouteSummary } from "@/components/route-summary";
import { ScanProgressView } from "@/components/scan-progress";
import { SetupPanel } from "@/components/setup-panel";
import { ShutdownDialog } from "@/components/shutdown-dialog";
import { SyncProgressView } from "@/components/sync-progress";
import { reportErrorCount, reportOutcome, SyncReportView } from "@/components/sync-report";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useProjectInfo } from "@/hooks/use-project-info";
import { api, errorMessage, isCancelledError, onScanProgress, onSyncProgress } from "@/lib/api";
import { formatDuration, formatPercent, plural, progressFraction } from "@/lib/format";
import { initialScreen, isBusy, screenReducer } from "@/lib/machine";
import { cloneDefaultScope, isScopeEmpty, pathsOverlap, sanitizeScope, scopesEqual } from "@/lib/scope";
import { loadSettings, saveSetting } from "@/lib/store";
import type { PlanSummary, ProjectInfo, SyncReport, SyncScope } from "@/lib/types";

const APP_TITLE = "Unity Project Sync";

function App() {
  // ---- persisted settings ---------------------------------------------------------------------
  const [loaded, setLoaded] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [scope, setScope] = useState<SyncScope>(cloneDefaultScope);
  const [defaultScope, setDefaultScope] = useState<SyncScope>(cloneDefaultScope);

  // ---- session-only state ---------------------------------------------------------------------
  const [targetAck, setTargetAck] = useState(false);
  const [shutdownAfter, setShutdownAfter] = useState(false);
  const shutdownAfterRef = useRef(false);
  shutdownAfterRef.current = shutdownAfter;
  const [shutdownOpen, setShutdownOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const [screen, dispatch] = useReducer(screenReducer, initialScreen);
  const busy = isBusy(screen);
  const cancelRequestedRef = useRef(false);
  /** Id of the current (or last) scan/sync; a cancel is tied to it. */
  const opIdRef = useRef(0);

  const sourceState = useProjectInfo(source, refreshKey);
  const targetState = useProjectInfo(target, refreshKey);

  // Load settings + backend default scope once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [settings, backendDefault] = await Promise.allSettled([loadSettings(), api.defaultScope()]);
      if (cancelled) return;
      const def = backendDefault.status === "fulfilled" ? sanitizeScope(backendDefault.value) : cloneDefaultScope();
      setDefaultScope(def);
      if (settings.status === "fulfilled") {
        setSource(settings.value.source);
        setTarget(settings.value.target);
        setScope(settings.value.scope ?? def);
      } else {
        setScope(def);
        console.warn("Could not load settings:", settings.reason);
      }
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist changes (after the initial load so defaults never overwrite stored values).
  useEffect(() => {
    if (loaded) saveSetting("source", source).catch((e) => console.warn("save source", e));
  }, [loaded, source]);
  useEffect(() => {
    if (loaded) saveSetting("target", target).catch((e) => console.warn("save target", e));
  }, [loaded, target]);
  useEffect(() => {
    if (loaded) saveSetting("scope", scope).catch((e) => console.warn("save scope", e));
  }, [loaded, scope]);

  // Progress events, registered for the lifetime of the app.
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
  }, []);

  // Re-inspect the folders when the window regains focus (they may have changed in Explorer).
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused && !busyRef.current) setRefreshKey((k) => k + 1);
      })
      .then((un) => (disposed ? un() : (unlisten = un)))
      .catch(() => {
        /* not running in Tauri — the re-inspection before each scan still applies */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Window title shows progress while busy.
  const windowTitle = useMemo(() => {
    if (screen.kind === "scanning") return `Scanning… — ${APP_TITLE}`;
    if (screen.kind === "syncing") {
      return screen.progress ? `${formatPercent(progressFraction(screen.progress))} — ${APP_TITLE}` : `Syncing… — ${APP_TITLE}`;
    }
    return APP_TITLE;
  }, [screen]);
  useEffect(() => {
    document.title = windowTitle;
    getCurrentWindow()
      .setTitle(windowTitle)
      .catch(() => {
        /* not running in Tauri or missing permission — document.title is the fallback */
      });
  }, [windowTitle]);

  // ---- derived --------------------------------------------------------------------------------
  const targetInfo = targetState.info;
  const targetNeedsAck = !!targetInfo && targetInfo.exists && !targetInfo.isEmpty && !targetInfo.isUnityProject;

  const blocker = useMemo((): string | null => {
    if (!loaded) return "Loading settings…";
    if (!source) return "Choose a source folder.";
    if (!target) return "Choose a target folder.";
    const si = sourceState.info;
    const ti = targetState.info;
    if (!si || !ti) return sourceState.loading || targetState.loading ? "Checking folders…" : "Couldn't inspect the folders.";
    if (!si.exists) return "The source folder doesn't exist.";
    if (!si.isUnityProject) return "The source must be a Unity project.";
    if (pathsOverlap(source, target)) return "Source and target must be different folders, not inside each other.";
    if (isScopeEmpty(scope)) return "The sync scope is empty.";
    if (targetNeedsAck && !targetAck) return "Confirm the target folder warning to continue.";
    return null;
  }, [loaded, source, target, sourceState, targetState, scope, targetNeedsAck, targetAck]);

  // ---- actions --------------------------------------------------------------------------------
  const browse = useCallback(
    async (role: "source" | "target") => {
      const current = role === "source" ? source : target;
      try {
        const picked = await open({
          directory: true,
          multiple: false,
          title: role === "source" ? "Choose the source Unity project" : "Choose the target folder",
          defaultPath: current ?? undefined,
        });
        if (!picked) return;
        if (role === "source") setSource(picked);
        else {
          setTarget(picked);
          if (picked !== target) setTargetAck(false);
        }
      } catch (e) {
        toast.error("Couldn't open the folder picker", { description: errorMessage(e) });
      }
    },
    [source, target],
  );

  const swap = useCallback(() => {
    setSource(target);
    setTarget(source);
    setTargetAck(false);
  }, [source, target]);

  /** Explains a skipped shutdown (only when "Shutdown after" is on). */
  const notifyShutdownSkipped = useCallback((reason: string) => {
    if (!shutdownAfterRef.current) return;
    toast.warning("Shutdown skipped", { description: `Shutdown skipped because ${reason}.` });
  }, []);

  const finishSync = useCallback(
    (report: SyncReport, plan: PlanSummary) => {
      dispatch({ type: "syncFinished", report });
      setRefreshKey((k) => k + 1);

      // A cancel the backend never saw (e.g. it raced with the start of the operation) still
      // counts as "cancelled" for the shutdown decision.
      const userCancelled = cancelRequestedRef.current;
      const outcome = reportOutcome(report, plan.warnings.length);
      const errorCount = reportErrorCount(report);
      const warningCount = plan.warnings.length;
      const written = report.copied + report.updated + report.verifiedChanged;
      const deleted = report.deletedFiles + report.deletedDirs;
      if (outcome === "success") {
        toast.success("Sync complete", {
          description: `${plural(written, "file")} written, ${plural(deleted, "item")} deleted in ${formatDuration(report.durationMs)}.`,
        });
      } else if (outcome === "warnings") {
        toast.warning(`Sync finished with ${plural(warningCount, "warning")}`, {
          description: "Some paths were skipped during the scan. See the report.",
        });
      } else if (outcome === "partial") {
        toast.warning(`Sync finished with ${plural(errorCount, "error")}`, {
          description: "See the report for details.",
        });
      } else {
        toast.info("Sync cancelled", { description: "The target is only partially synced." });
      }

      if (!shutdownAfterRef.current) return;
      if (userCancelled || outcome === "cancelled") {
        notifyShutdownSkipped("the sync was cancelled");
      } else if (outcome === "partial") {
        notifyShutdownSkipped(`the sync finished with ${plural(errorCount, "error")}`);
      } else {
        // "success" or "warnings": zero errors and not cancelled (the agreed shutdown gate).
        if (outcome === "warnings") {
          toast.warning("Shutting down despite skipped paths", {
            description: `The scan skipped ${plural(warningCount, "path")} (see the report). Cancel the shutdown to review them.`,
          });
        }
        setShutdownOpen(true);
      }
    },
    [notifyShutdownSkipped],
  );

  const runSync = useCallback(
    async (plan: PlanSummary) => {
      cancelRequestedRef.current = false;
      opIdRef.current += 1;
      const opId = opIdRef.current;
      dispatch({ type: "syncStarted", plan });
      try {
        const report = await api.runSync(plan.planId, opId);
        finishSync(report, plan);
      } catch (e) {
        const message = errorMessage(e);
        toast.error("Sync failed", { description: message });
        notifyShutdownSkipped("the sync failed");
        dispatch({ type: "failed", message, during: "sync" });
        setRefreshKey((k) => k + 1);
      }
    },
    [finishSync, notifyShutdownSkipped],
  );

  const startScan = useCallback(
    async (autoSync: boolean) => {
      if (!source || !target || blocker) {
        // E.g. "Scan again" after a folder changed on disk — go back to the setup screen.
        if (blocker) toast.error("Can't scan yet", { description: blocker });
        dispatch({ type: "reset" });
        return;
      }
      // The cached folder info may be old: re-check before anything can be deleted.
      let freshSource: ProjectInfo;
      let freshTarget: ProjectInfo;
      try {
        [freshSource, freshTarget] = await Promise.all([api.inspectProject(source), api.inspectProject(target)]);
      } catch (e) {
        toast.error("Couldn't inspect the folders", { description: errorMessage(e) });
        if (autoSync) notifyShutdownSkipped("the folders couldn't be inspected");
        dispatch({ type: "reset" });
        return;
      }
      const sourceProblem = !freshSource.exists
        ? "The source folder doesn't exist."
        : !freshSource.isUnityProject
          ? "The source must be a Unity project."
          : null;
      const targetNeedsAckNow = freshTarget.exists && !freshTarget.isEmpty && !freshTarget.isUnityProject;
      if (sourceProblem || (targetNeedsAckNow && !targetAck)) {
        setRefreshKey((k) => k + 1); // the setup panel then shows the warning (and checkbox)
        toast.error("Can't scan yet", {
          description: sourceProblem ?? "The target folder changed and now needs confirmation.",
        });
        if (autoSync) notifyShutdownSkipped("the folders changed and need attention");
        dispatch({ type: "reset" });
        return;
      }

      cancelRequestedRef.current = false;
      opIdRef.current += 1;
      const opId = opIdRef.current;
      dispatch({ type: "scanStarted", autoSync });
      let plan: PlanSummary;
      try {
        plan = await api.scan(source, target, scope, opId);
      } catch (e) {
        if (cancelRequestedRef.current || isCancelledError(e)) {
          toast.info("Scan cancelled");
          if (autoSync) notifyShutdownSkipped("the scan was cancelled");
          dispatch({ type: "reset" });
        } else {
          const message = errorMessage(e);
          toast.error("Scan failed", { description: message });
          if (autoSync) notifyShutdownSkipped("the scan failed");
          dispatch({ type: "failed", message, during: "scan" });
        }
        return;
      }
      if (cancelRequestedRef.current) {
        // Cancel was pressed just as the scan finished.
        toast.info("Scan cancelled");
        if (autoSync) notifyShutdownSkipped("the scan was cancelled");
        dispatch({ type: "reset" });
        return;
      }
      if (autoSync) await runSync(plan);
      else dispatch({ type: "scanFinished", plan });
    },
    [source, target, scope, blocker, targetAck, runSync, notifyShutdownSkipped],
  );

  const cancelOperation = useCallback(async () => {
    cancelRequestedRef.current = true;
    dispatch({ type: "cancelRequested" });
    try {
      await api.cancelOperation(opIdRef.current);
    } catch (e) {
      toast.error("Couldn't cancel", { description: errorMessage(e) });
    }
  }, []);

  const backToIdle = useCallback(() => {
    dispatch({ type: "reset" });
    setRefreshKey((k) => k + 1);
  }, []);

  const shutdownNow = useCallback(async () => {
    setShutdownOpen(false);
    toast.loading("Shutting down…", { id: "shutdown" });
    try {
      await api.shutdownSystem();
    } catch (e) {
      toast.error("Couldn't shut down", { id: "shutdown", description: errorMessage(e) });
    }
  }, []);

  const cancelShutdown = useCallback(() => {
    setShutdownOpen(false);
    toast.info("Shutdown cancelled");
  }, []);

  // ---- render ---------------------------------------------------------------------------------
  const statusBadge =
    screen.kind === "scanning" ? (
      <Badge variant="secondary">
        <IconLoader2 className="animate-spin" /> Scanning
      </Badge>
    ) : screen.kind === "syncing" ? (
      <Badge variant="secondary">
        <IconLoader2 className="animate-spin" /> Syncing
      </Badge>
    ) : null;

  return (
    <div className="flex h-full flex-col bg-background">
      <AppHeader right={statusBadge} />
      <main className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-5 sm:px-6">
          {(screen.kind === "idle" || screen.kind === "error") && (
            <>
              {screen.kind === "error" && (
                <InlineNotice variant="destructive" className="items-start">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{screen.during === "scan" ? "Scan failed" : "Sync failed"}</div>
                      <div className="break-words">{screen.message}</div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Dismiss error"
                      onClick={() => dispatch({ type: "reset" })}
                    >
                      <IconX />
                    </Button>
                  </div>
                </InlineNotice>
              )}
              <SetupPanel
                source={{ path: source, info: sourceState.info, inspecting: sourceState.loading }}
                target={{ path: target, info: targetState.info, inspecting: targetState.loading }}
                scope={scope}
                scopeIsDefault={scopesEqual(scope, defaultScope)}
                targetNeedsAck={targetNeedsAck}
                targetAck={targetAck}
                shutdownAfter={shutdownAfter}
                blocker={blocker}
                disabled={!loaded || busy}
                onBrowse={browse}
                onSwap={swap}
                onScopeChange={(s) => setScope(sanitizeScope(s))}
                onScopeReset={() => setScope({ ...defaultScope, folders: [...defaultScope.folders] })}
                onTargetAckChange={setTargetAck}
                onShutdownAfterChange={setShutdownAfter}
                onScan={() => void startScan(false)}
                onSyncNow={() => void startScan(true)}
              />
            </>
          )}

          {screen.kind === "scanning" && source && target && (
            <>
              <RouteSummary source={source} target={target} scope={scope} />
              <ScanProgressView
                progress={screen.progress}
                startedAt={screen.startedAt}
                autoSync={screen.autoSync}
                cancelling={screen.cancelling}
                onCancel={() => void cancelOperation()}
              />
            </>
          )}

          {screen.kind === "preview" && (
            <>
              <RouteSummary source={screen.plan.source} target={screen.plan.target} scope={screen.plan.scope} />
              <PlanPreview
                plan={screen.plan}
                onBack={backToIdle}
                onStart={() => void runSync(screen.plan)}
                onRescan={() => void startScan(false)}
              />
            </>
          )}

          {screen.kind === "syncing" && (
            <>
              <RouteSummary source={screen.plan.source} target={screen.plan.target} scope={screen.plan.scope} />
              <SyncProgressView
                plan={screen.plan}
                progress={screen.progress}
                cancelling={screen.cancelling}
                onCancel={() => void cancelOperation()}
                shutdownAfter={shutdownAfter}
                onShutdownAfterChange={setShutdownAfter}
              />
            </>
          )}

          {screen.kind === "done" && (
            <>
              <RouteSummary source={screen.plan.source} target={screen.plan.target} scope={screen.plan.scope} />
              <SyncReportView
                plan={screen.plan}
                report={screen.report}
                onScanAgain={() => void startScan(false)}
                onDone={backToIdle}
              />
            </>
          )}
        </div>
      </main>

      <ShutdownDialog open={shutdownOpen} onCancel={cancelShutdown} onShutdown={() => void shutdownNow()} />
    </div>
  );
}

export default App;
