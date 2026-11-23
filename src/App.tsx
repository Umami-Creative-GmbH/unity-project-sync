import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { IconAlertTriangle, IconBolt, IconLoader2, IconPlus, IconSearch, IconX } from "@tabler/icons-react";
import { toast } from "sonner";

import { AppHeader } from "@/components/app-header";
import { BatchPreview } from "@/components/batch-preview";
import { BatchReport } from "@/components/batch-report";
import { BatchScanProgress } from "@/components/batch-scan-progress";
import { BatchSyncProgress } from "@/components/batch-sync-progress";
import { InlineNotice } from "@/components/folder-card";
import { ProjectEditor } from "@/components/project-editor";
import { ProjectList } from "@/components/project-list";
import { SettingsDialog, type SettingsSection } from "@/components/settings-dialog";
import { ShutdownDialog } from "@/components/shutdown-dialog";
import { ShutdownSwitch } from "@/components/shutdown-switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { appSettings, getAppSettings } from "@/hooks/use-app-settings";
import { useBatchRunner } from "@/hooks/use-batch-runner";
import { useFolderInfos } from "@/hooks/use-folder-infos";
import { updates } from "@/hooks/use-update";
import { api, errorMessage } from "@/lib/api";
import {
  failedLastRun,
  includedItems,
  lastRunFor,
  overallProgress,
  shutdownBlocker,
  summarizeBatch,
  type BatchState,
} from "@/lib/batch";
import { formatDuration, formatPercent, plural } from "@/lib/format";
import {
  createProject,
  duplicateProject,
  projectDisplayName,
  sharedTargetConflicts,
  validateProject,
  type ProjectIssue,
} from "@/lib/projects";
import { cloneDefaultScope, sanitizeScope } from "@/lib/scope";
import { effectiveThreads } from "@/lib/settings";
import { loadProjects, persistStep, saveProjects, type PersistMode } from "@/lib/store";
import type { SyncProject, SyncScope } from "@/lib/types";

const APP_TITLE = "Unity Project Sync";
/** The startup update check waits this long after the projects have loaded. */
const STARTUP_UPDATE_CHECK_DELAY_MS = 4000;

function App() {
  // ---- persisted ------------------------------------------------------------------------------
  const [loaded, setLoaded] = useState(false);
  const [projects, setProjects] = useState<SyncProject[]>([]);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const [defaultScope, setDefaultScope] = useState<SyncScope>(cloneDefaultScope);

  // ---- session-only ---------------------------------------------------------------------------
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  /** `insertAfter`: a new project (e.g. a duplicate) goes right below this one when saved. */
  const [editing, setEditing] = useState<{
    project: SyncProject;
    isNew: boolean;
    session: number;
    insertAfter?: string;
  } | null>(null);
  const editSessionRef = useRef(0);
  const [shutdownAfter, setShutdownAfter] = useState(false);
  const shutdownAfterRef = useRef(false);
  shutdownAfterRef.current = shutdownAfter;
  const [shutdownOpen, setShutdownOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("sync");
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;
  const [refreshKey, setRefreshKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  /** See persistStep: never write back what was just loaded, and never save after a failed load. */
  const persistRef = useRef<PersistMode>("off");

  // Load the backend default scope and the projects (migrating old single-project settings).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let def = cloneDefaultScope();
      try {
        def = sanitizeScope(await api.defaultScope());
      } catch (e) {
        console.warn("Could not get the default scope:", e);
      }
      let list: SyncProject[] = [];
      let ok = false;
      let backupPath: string | null = null;
      try {
        ({ projects: list, backupPath } = await loadProjects(def));
        ok = true;
        // The settings file is reachable now: re-read app settings whose first load failed, so
        // the first scan uses the stored thread choice.
        if (appSettings.status() === "failed") void appSettings.load();
      } catch (e) {
        console.warn("Could not load projects:", e);
        toast.error("Couldn't load the saved projects", {
          description: `${errorMessage(e)} The settings file is left untouched: changes made now won't be saved. Restart the app to try again.`,
          duration: Infinity,
        });
      }
      if (cancelled) return;
      if (backupPath) {
        toast.warning("The settings file couldn't be read", {
          description: `It was kept as ${backupPath}. Starting with an empty project list.`,
          duration: Infinity,
        });
      }
      // Only a successful load enables saving; the save run caused by this load itself is skipped.
      if (ok) persistRef.current = "skip-initial";
      setDefaultScope(def);
      setProjects(list);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist every change (by the user or a batch) after the initial load.
  useEffect(() => {
    if (!loaded) return;
    const step = persistStep(persistRef.current);
    persistRef.current = step.next;
    if (step.save) saveProjects(projects).catch((e) => console.warn("Could not save projects:", e));
  }, [loaded, projects]);

  // Relative "last sync" times stay current.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // ---- batch runner ---------------------------------------------------------------------------
  /** Explains a skipped shutdown (only when "Shutdown after" is on). */
  const notifyShutdownSkipped = useCallback((reason: string) => {
    if (!shutdownAfterRef.current) return;
    toast.warning("Shutdown skipped", { description: `Shutdown skipped because ${reason}.` });
  }, []);

  const handleFinished = useCallback(
    (state: BatchState) => {
      const finishedAt = Date.now();
      const runs = new Map(state.items.map((it) => [it.projectId, lastRunFor(it, finishedAt)]));
      setProjects((prev) =>
        prev.map((p) => {
          const lastRun = runs.get(p.id);
          return lastRun ? { ...p, lastRun } : p;
        }),
      );
      setRefreshKey((k) => k + 1);

      const s = summarizeBatch(state);
      const single = state.items.length === 1;
      const details = `${plural(s.filesWritten, "file")} written, ${plural(s.deleted, "item")} deleted in ${formatDuration(s.durationMs)}.`;
      if (s.outcome === "success") {
        if (s.synced === 0) toast.success("Already in sync", { description: "Nothing needed to change." });
        else toast.success(single ? "Sync complete" : `${plural(s.synced + s.inSync, "project")} in sync`, { description: details });
      } else if (s.outcome === "warnings") {
        toast.warning(s.synced > 0 ? "Synced with warnings" : "Already in sync", {
          description: s.skipped > 0 ? `${plural(s.skipped, "project")} skipped. See the report.` : "Some paths were skipped during the scan. See the report.",
        });
      } else if (s.outcome === "partial") {
        toast.warning(s.errorCount > 0 ? `Sync finished with ${plural(s.errorCount, "error")}` : "Sync finished with problems", {
          description: s.failed > 0 ? `${plural(s.failed, "project")} failed. See the report.` : "See the report for details.",
        });
      } else if (s.outcome === "cancelled") {
        toast.info("Sync cancelled", { description: "Some targets are only partially synced." });
      } else if (s.failed === 0 && s.skipped > 0) {
        toast.error("Nothing was synced", { description: `${plural(s.skipped, "project")} skipped. See the report.` });
      } else {
        toast.error("Sync failed", { description: "See the report for details." });
      }

      if (!shutdownAfterRef.current) return;
      const blocker = shutdownBlocker(state);
      if (blocker) {
        notifyShutdownSkipped(blocker);
        return;
      }
      if (s.outcome === "warnings") {
        toast.warning("Shutting down despite warnings", {
          description: "Some paths were skipped during the scan (see the report). Cancel the shutdown to review them.",
        });
      }
      setShutdownOpen(true);
    },
    [notifyShutdownSkipped],
  );

  /** Recorded as soon as a scan fails, however the batch ends afterwards. */
  const handleScanFailed = useCallback((projectId: string) => {
    const lastRun = failedLastRun(Date.now());
    setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, lastRun } : p)));
  }, []);

  const handleScanCancelled = useCallback(
    (autoSync: boolean, keptPreview: boolean) => {
      if (keptPreview) {
        // The user is on the preview now; Back discards the held plans.
        toast.info("Scan cancelled", { description: "Showing the projects that finished scanning." });
        return;
      }
      toast.info("Scan cancelled");
      if (autoSync) notifyShutdownSkipped("the scan was cancelled");
      setRefreshKey((k) => k + 1);
    },
    [notifyShutdownSkipped],
  );

  const handleFailed = useCallback(
    (message: string) => {
      toast.error("Something went wrong", { description: message });
      notifyShutdownSkipped("the run failed");
      setRefreshKey((k) => k + 1);
    },
    [notifyShutdownSkipped],
  );

  const runner = useBatchRunner({
    getProjects: () => projectsRef.current,
    getThreads: () => effectiveThreads(getAppSettings()),
    onFinished: handleFinished,
    onScanFailed: handleScanFailed,
    onScanCancelled: handleScanCancelled,
    onFailed: handleFailed,
  });
  const batch = runner.state;
  const busy = runner.busy;
  const onHome = batch.phase === "idle" || batch.phase === "error";

  // ---- updates --------------------------------------------------------------------------------
  // Installing exits the app (the installer restarts it), which would kill a running scan or sync.
  useEffect(() => updates.setBusy(busy), [busy]);

  // One quiet check a few seconds after startup; failures are only logged. An update shows a
  // single toast (never repeated this session); Settings → About has the details.
  const startupCheckedRef = useRef(false);
  useEffect(() => {
    if (!loaded || startupCheckedRef.current) return;
    const timer = window.setTimeout(() => {
      startupCheckedRef.current = true;
      void updates.check({ silent: true }).then((state) => {
        // Settings already open: the About page shows it (no toast on top).
        if (state.status !== "available" || settingsOpenRef.current) return;
        toast.info(`Update ${state.update.version} available`, {
          id: "update-available",
          description: "See what's new and install it from Settings.",
          duration: 30_000,
          action: {
            label: "View",
            onClick: () => {
              setSettingsSection("about");
              setSettingsOpen(true);
            },
          },
        });
      });
    }, STARTUP_UPDATE_CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [loaded]);

  // Each phase (list, scanning, preview, syncing, report) starts at the top, with the keyboard focus
  // on its heading (the previous view's controls are gone).
  const mainRef = useRef<HTMLElement>(null);
  const firstPhaseRef = useRef(true);
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
    if (firstPhaseRef.current) {
      firstPhaseRef.current = false; // not on startup
      return;
    }
    const raf = requestAnimationFrame(() =>
      (document.getElementById("phase-heading") ?? document.getElementById("projects-heading"))?.focus({
        preventScroll: true,
      }),
    );
    return () => cancelAnimationFrame(raf);
  }, [batch.phase]);

  // ---- folder status on the list ------------------------------------------------------------
  const paths = useMemo(() => projects.flatMap((p) => [p.source, p.target]), [projects]);
  const infos = useFolderInfos(onHome ? paths : [], refreshKey);

  const issuesById = useMemo(() => {
    const out: Record<string, ProjectIssue[]> = {};
    for (const p of projects) {
      const si = p.source ? infos[p.source]?.info : undefined;
      const ti = p.target ? infos[p.target]?.info : undefined;
      out[p.id] = validateProject(p, si, ti);
    }
    return out;
  }, [projects, infos]);

  // Not blocking (each project can still run alone), but a batch with both skips them: say so early.
  const sharedTargetById = useMemo(
    () => sharedTargetConflicts(projects, (path) => infos[path]?.info?.comparePath || path),
    [projects, infos],
  );

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
        /* not running in Tauri */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Overall progress of the run; never shown going backwards within one run (belt and braces).
  const titleMaxRef = useRef<{ run: number | null; fraction: number }>({ run: null, fraction: 0 });
  const titleFraction = useMemo(() => {
    if (batch.phase !== "syncing") return 0;
    const f = overallProgress(batch.items, batch.lastCostPerSec).fraction;
    const m = titleMaxRef.current;
    if (m.run !== batch.syncStartedAt) titleMaxRef.current = { run: batch.syncStartedAt, fraction: f };
    else titleMaxRef.current = { run: m.run, fraction: Math.max(m.fraction, f) };
    return titleMaxRef.current.fraction;
  }, [batch]);

  // Screen-reader announcement of each phase.
  const phaseAnnouncement = useMemo(() => {
    switch (batch.phase) {
      case "preflight":
        return `Checking ${plural(batch.chosenIds.length, "project")}`;
      case "scanning": {
        const scannable = batch.items.filter((it) => it.scan !== "skipped");
        return `Scanning ${plural(scannable.length, "project")}`;
      }
      case "preview": {
        const n = includedItems(batch).length;
        return n > 0 ? `Preview ready: ${plural(n, "project")} with changes` : "Preview ready: nothing to sync";
      }
      case "syncing":
        return `Syncing ${plural(batch.items.filter((it) => it.run !== "none").length, "project")}`;
      case "report": {
        const s = summarizeBatch(batch);
        return `Sync finished: ${s.synced + s.inSync} in sync, ${s.withErrors + s.failed} with problems, ${s.skipped} skipped`;
      }
      case "error":
        return `Something went wrong: ${batch.error ?? ""}`;
      default:
        return "";
    }
    // Only on phase changes, not on every progress event.
  }, [batch.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Window title shows progress while busy.
  const windowTitle = useMemo(() => {
    if (batch.phase === "preflight") return `Checking… — ${APP_TITLE}`;
    if (batch.phase === "scanning") {
      const scannable = batch.items.filter((it) => it.scan !== "skipped");
      const done = scannable.filter((it) => it.scan !== "pending" && it.scan !== "scanning").length;
      return scannable.length > 1
        ? `Scanning ${Math.min(done + 1, scannable.length)}/${scannable.length} — ${APP_TITLE}`
        : `Scanning… — ${APP_TITLE}`;
    }
    if (batch.phase === "syncing") return `${formatPercent(titleFraction)} — ${APP_TITLE}`;
    return APP_TITLE;
  }, [batch, titleFraction]);
  useEffect(() => {
    document.title = windowTitle;
    getCurrentWindow()
      .setTitle(windowTitle)
      .catch(() => {
        /* not running in Tauri or missing permission — document.title is the fallback */
      });
  }, [windowTitle]);

  // ---- project actions ------------------------------------------------------------------------
  const openEditor = (project: SyncProject, isNew: boolean, insertAfter?: string) => {
    editSessionRef.current += 1;
    setEditing({ project, isNew, session: editSessionRef.current, insertAfter });
  };
  const addProject = () => openEditor(createProject(defaultScope), true);
  const editProject = (id: string) => {
    const p = projects.find((x) => x.id === id);
    if (p) openEditor(p, false);
  };

  const saveProject = (project: SyncProject) => {
    const insertAfter = editing?.insertAfter;
    setProjects((prev) => {
      if (prev.some((p) => p.id === project.id)) return prev.map((p) => (p.id === project.id ? project : p));
      const i = insertAfter ? prev.findIndex((p) => p.id === insertAfter) : -1;
      if (i < 0) return [...prev, project];
      const next = [...prev];
      next.splice(i + 1, 0, project);
      return next;
    });
    if (editing?.isNew) toast.success("Project added", { description: projectDisplayName(project) });
    setEditing(null);
    setRefreshKey((k) => k + 1);
  };

  const deleteProject = (id: string) => {
    const p = projects.find((x) => x.id === id);
    setProjects((prev) => prev.filter((x) => x.id !== id));
    setSelected((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setEditing((e) => (e?.project.id === id ? null : e));
    if (p) toast.success("Project deleted", { description: projectDisplayName(p) });
  };

  const duplicate = (id: string) => {
    const p = projects.find((x) => x.id === id);
    if (!p) return;
    // The copy has no target yet (two projects with one target can't share a batch): open it in the
    // editor; Cancel discards it, saving adds it right below the original.
    const copy = duplicateProject(p, projects.map(projectDisplayName));
    openEditor(copy, true, id);
  };

  // ---- batch actions --------------------------------------------------------------------------
  const selectedIds = projects.filter((p) => selected.has(p.id)).map((p) => p.id);
  const targetIds = selectedIds.length > 0 ? selectedIds : projects.map((p) => p.id);
  const runnableCount = targetIds.filter((id) => (issuesById[id] ?? []).length === 0).length;
  /** Projects of the target set that pre-flight will skip (they still show up in the report). */
  const attentionCount = targetIds.length - runnableCount;
  const scopeLabel = selectedIds.length > 0 ? "selected" : "all";
  const countLabel = attentionCount > 0 ? `${runnableCount} of ${targetIds.length}` : `${runnableCount}`;
  const skippedNote = attentionCount > 0 ? ` (${attentionCount} skipped: needs attention)` : "";

  const startBatch = (ids: string[], autoSync: boolean) => {
    if (busy || ids.length === 0) return;
    runner.start(ids, autoSync);
  };

  // ---- shutdown -------------------------------------------------------------------------------
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
  const headerRight =
    batch.phase === "preflight" || batch.phase === "scanning" ? (
      <Badge variant="secondary">
        <IconLoader2 className="animate-spin" /> Scanning
      </Badge>
    ) : batch.phase === "syncing" ? (
      <Badge variant="secondary">
        <IconLoader2 className="animate-spin" /> Syncing
      </Badge>
    ) : onHome && projects.length > 0 ? (
      <Button onClick={addProject} disabled={!loaded}>
        <IconPlus data-icon="inline-start" />
        Add project
      </Button>
    ) : null;

  return (
    <div className="flex h-full flex-col bg-background">
      <AppHeader right={headerRight} onOpenSettings={() => setSettingsOpen(true)} />
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {phaseAnnouncement}
      </div>
      <main ref={mainRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-5 sm:px-6">
          {onHome && (
            <>
              {batch.phase === "error" && (
                <InlineNotice variant="destructive" className="items-start">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">Something went wrong</div>
                      <div className="break-words">{batch.error}</div>
                    </div>
                    <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={runner.close}>
                      <IconX />
                    </Button>
                  </div>
                </InlineNotice>
              )}
              {!loaded ? (
                <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                  <IconLoader2 className="size-4 animate-spin" /> Loading projects…
                </div>
              ) : (
                <>
                  {projects.length > 0 && (
                    <a
                      href="#batch-actions"
                      className="sr-only rounded-md bg-background px-2 py-1 text-sm focus:not-sr-only focus:self-start focus:ring-2 focus:ring-ring/50"
                    >
                      Skip to the batch actions
                    </a>
                  )}
                  <ProjectList
                  projects={projects}
                  infos={infos}
                  issuesById={issuesById}
                  sharedTargetById={sharedTargetById}
                  selected={selected}
                  disabled={busy}
                  now={now}
                  onSelectedChange={setSelected}
                  onAdd={addProject}
                  onEdit={editProject}
                  onSync={(id, autoSync) => startBatch([id], autoSync)}
                  onDuplicate={duplicate}
                  onDelete={deleteProject}
                  />
                </>
              )}
            </>
          )}

          {(batch.phase === "preflight" || batch.phase === "scanning") && (
            <BatchScanProgress
              state={batch}
              onCancel={runner.cancel}
              shutdownAfter={shutdownAfter}
              onShutdownAfterChange={setShutdownAfter}
            />
          )}

          {batch.phase === "preview" && (
            <BatchPreview
              state={batch}
              onSetInclude={runner.setInclude}
              onBack={() => {
                runner.close();
                setRefreshKey((k) => k + 1);
              }}
              onRescan={runner.rescan}
              onStart={runner.startSync}
              shutdownAfter={shutdownAfter}
              onShutdownAfterChange={setShutdownAfter}
            />
          )}

          {batch.phase === "syncing" && (
            <BatchSyncProgress
              state={batch}
              onCancel={runner.cancel}
              shutdownAfter={shutdownAfter}
              onShutdownAfterChange={setShutdownAfter}
            />
          )}

          {batch.phase === "report" && (
            <BatchReport
              state={batch}
              onRescan={runner.rescan}
              onDone={() => {
                runner.close();
                setRefreshKey((k) => k + 1);
              }}
            />
          )}
        </div>
      </main>

      {onHome && loaded && projects.length > 0 && (
        <footer id="batch-actions" tabIndex={-1} className="shrink-0 border-t bg-background outline-none">
          <div className="mx-auto flex max-w-4xl items-center gap-2 px-4 py-3 sm:px-6">
            <ShutdownSwitch id="shutdown-after" compact checked={shutdownAfter} onCheckedChange={setShutdownAfter} />
            {shutdownAfter && attentionCount > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="flex shrink-0 text-amber-600 dark:text-amber-400"
                    tabIndex={0}
                    aria-label={`Shutdown will be skipped: ${plural(attentionCount, "project")} need${attentionCount === 1 ? "s" : ""} attention`}
                  >
                    <IconAlertTriangle className="size-4" />
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-64">
                  Shutdown will be skipped: {plural(attentionCount, "project")} need{attentionCount === 1 ? "s" : ""}{" "}
                  attention and will be skipped.
                </TooltipContent>
              </Tooltip>
            )}
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {selectedIds.length > 0
                ? `${selectedIds.length} of ${plural(projects.length, "project")} selected`
                : projects.length === 1
                  ? "1 project"
                  : `All ${projects.length} projects`}
              {attentionCount > 0 && (
                <span className="text-amber-600 dark:text-amber-400">
                  {" "}
                  · {attentionCount} need{attentionCount === 1 ? "s" : ""} attention and will be skipped
                </span>
              )}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={-1}>
                  <Button
                    variant="outline"
                    size="lg"
                    disabled={busy || runnableCount === 0}
                    onClick={() => startBatch(targetIds, true)}
                  >
                    <IconBolt data-icon="inline-start" />
                    {scopeLabel === "selected" ? `Sync selected now (${countLabel})` : `Sync all now (${countLabel})`}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {runnableCount === 0
                  ? "Fix the projects that need attention first"
                  : `Scan and sync ${plural(runnableCount, "project")} right away — skips the preview${skippedNote}`}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={-1}>
                  <Button size="lg" disabled={busy || runnableCount === 0} onClick={() => startBatch(targetIds, false)}>
                    <IconSearch data-icon="inline-start" />
                    {scopeLabel === "selected" ? `Scan selected (${countLabel})` : `Scan all (${countLabel})`}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {runnableCount === 0
                  ? "Fix the projects that need attention first"
                  : `Scan ${plural(runnableCount, "project")}, then review one combined preview before syncing${skippedNote}`}
              </TooltipContent>
            </Tooltip>
          </div>
        </footer>
      )}

      {editing && (
        <ProjectEditor
          key={editing.session}
          project={editing.project}
          isNew={editing.isNew}
          defaultScope={defaultScope}
          refreshKey={refreshKey}
          otherProjects={projects}
          onSave={saveProject}
          onCancel={() => setEditing(null)}
          onDelete={deleteProject}
        />
      )}

      <ShutdownDialog open={shutdownOpen} onCancel={cancelShutdown} onShutdown={() => void shutdownNow()} />

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        busy={busy}
        section={settingsSection}
        onSectionChange={setSettingsSection}
      />
    </div>
  );
}

export default App;
