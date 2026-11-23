// Batch state machine ("scan all, one preview") plus the pure math around it.
//
//   idle ─begin→ preflight ─preflightDone→ scanning ─showPreview→ preview ─syncPhaseStarted→ syncing ─finished→ report
//                                              └──────────────── syncPhaseStarted ("Sync now") ──┘
//   any ─failed→ error, any ─reset→ idle
//
// No Tauri imports — unit-tested in batch.test.ts. The side effects (scans, syncs, cancel) live in
// src/hooks/use-batch-runner.ts.
import { reportDeleted, reportErrorCount, reportFilesWritten, reportOutcome } from "@/lib/report";
import type { BatchWarning } from "@/lib/projects";
import {
  addSpeedSample,
  advanceSpeedHistory,
  createSpeedHistory,
  speedReading,
  type SpeedHistory,
} from "@/lib/speed-history";
import type {
  CountBytes,
  PlanSummary,
  ProjectLastRun,
  ScanProgress,
  SyncProgress,
  SyncReport,
  SyncScope,
} from "@/lib/types";

export type BatchPhase = "idle" | "preflight" | "scanning" | "preview" | "syncing" | "report" | "error";

export type ScanStatus = "pending" | "scanning" | "scanned" | "failed" | "cancelled" | "skipped";
/** `none` = not part of the run (excluded, nothing to do, or not scanned). */
export type RunStatus = "none" | "pending" | "running" | "done" | "failed" | "notRun";

export interface BatchItem {
  projectId: string;
  name: string;
  source: string;
  target: string;
  scope: SyncScope;
  /** Pre-flight result: why the project is not scanned at all. */
  skipReason: string | null;
  /** Cross-project warnings (its source is another project's target); see `activeWarnings`. */
  warnings: BatchWarning[];
  scan: ScanStatus;
  scanProgress: ScanProgress | null;
  scanStartedAt: number | null;
  scanError: string | null;
  plan: PlanSummary | null;
  /** Preview: take part in the sync. */
  include: boolean;
  run: RunStatus;
  syncProgress: SyncProgress | null;
  report: SyncReport | null;
  runError: string | null;
}

export interface BatchState {
  phase: BatchPhase;
  /** "Sync now": no preview, sync every scanned project that has work. */
  autoSync: boolean;
  /** Project ids the user chose, in list order (for "Rescan these projects"). */
  chosenIds: string[];
  items: BatchItem[];
  /** Project being scanned or synced. */
  currentId: string | null;
  /** Operation id of that scan/sync; progress events of any other operation are dropped. */
  currentOpId: number | null;
  /** Last known cost rate of this run (cost units/s), for the overall ETA between projects. */
  lastCostPerSec: number;
  cancelling: boolean;
  /** Speed over overall progress of the run phase (the transfer chart); reset when syncing starts. */
  speedHistory: SpeedHistory;
  startedAt: number;
  syncStartedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}

export type BatchAction =
  | { type: "begin"; autoSync: boolean; chosenIds: string[]; now: number }
  | { type: "preflightDone"; items: BatchItem[] }
  | { type: "scanStarted"; id: string; opId: number; now: number }
  | { type: "scanProgress"; progress: ScanProgress }
  | { type: "scanFinished"; id: string; plan: PlanSummary }
  | { type: "scanFailed"; id: string; error: string }
  /** The current scan and every remaining one are cancelled. */
  | { type: "scanCancelled" }
  | { type: "showPreview" }
  | { type: "setInclude"; id: string; include: boolean }
  /** `ids`: the projects that will be synced, in order. */
  | { type: "syncPhaseStarted"; ids: string[]; now: number }
  | { type: "syncStarted"; id: string; opId: number }
  | { type: "syncProgress"; progress: SyncProgress }
  | { type: "syncFinished"; id: string; report: SyncReport }
  | { type: "syncFailed"; id: string; error: string }
  | { type: "cancelRequested" }
  /** Ends the run; projects still pending are marked "not run". */
  | { type: "finished"; now: number }
  | { type: "failed"; message: string }
  | { type: "reset" };

export const initialBatch: BatchState = {
  phase: "idle",
  autoSync: false,
  chosenIds: [],
  items: [],
  currentId: null,
  currentOpId: null,
  lastCostPerSec: 0,
  cancelling: false,
  speedHistory: createSpeedHistory(),
  startedAt: 0,
  syncStartedAt: null,
  finishedAt: null,
  error: null,
};

export function newBatchItem(init: {
  projectId: string;
  name: string;
  source: string;
  target: string;
  scope: SyncScope;
  skipReason?: string | null;
  warnings?: BatchWarning[];
}): BatchItem {
  const skipReason = init.skipReason ?? null;
  return {
    projectId: init.projectId,
    name: init.name,
    source: init.source,
    target: init.target,
    scope: init.scope,
    skipReason,
    warnings: init.warnings ?? [],
    scan: skipReason ? "skipped" : "pending",
    scanProgress: null,
    scanStartedAt: null,
    scanError: null,
    plan: null,
    include: false,
    run: "none",
    syncProgress: null,
    report: null,
    runError: null,
  };
}

function updateItem(state: BatchState, id: string, fn: (item: BatchItem) => BatchItem): BatchState {
  let changed = false;
  const items = state.items.map((it) => {
    if (it.projectId !== id) return it;
    changed = true;
    return fn(it);
  });
  return changed ? { ...state, items } : state;
}

/** Position of a project among the projects of the run phase (-1 if it does not run). */
function runIndex(items: BatchItem[], id: string): number {
  return items.filter((it) => it.run !== "none").findIndex((it) => it.projectId === id);
}

/**
 * A project ended: the chart's progress front moves to the new overall progress. When it failed or
 * was cancelled, the rest of its share of the run is drawn as a gap (speed 0), not as the previous
 * speed stretched across it.
 */
function withFrontAdvanced(state: BatchState, endedId: string, aborted: boolean): BatchState {
  const fraction = overallProgress(state.items, state.lastCostPerSec).fraction;
  const project = runIndex(state.items, endedId);
  const end = project >= 0 ? { project, aborted } : undefined;
  return { ...state, speedHistory: advanceSpeedHistory(state.speedHistory, fraction, end) };
}

export function isBatchBusy(state: BatchState): boolean {
  return state.phase === "preflight" || state.phase === "scanning" || state.phase === "syncing";
}

export function batchReducer(state: BatchState, action: BatchAction): BatchState {
  switch (action.type) {
    case "begin":
      return {
        ...initialBatch,
        phase: "preflight",
        autoSync: action.autoSync,
        chosenIds: [...action.chosenIds],
        startedAt: action.now,
      };

    case "preflightDone":
      if (state.phase !== "preflight") return state;
      return { ...state, phase: "scanning", items: action.items };

    case "scanStarted":
      if (state.phase !== "scanning") return state;
      return {
        ...updateItem(state, action.id, (it) =>
          it.scan === "pending" ? { ...it, scan: "scanning", scanStartedAt: action.now, scanProgress: null } : it,
        ),
        currentId: action.id,
        currentOpId: action.opId,
      };

    case "scanProgress": {
      // Events of an earlier operation can arrive after its command returned: drop them.
      if (state.phase !== "scanning" || !state.currentId || action.progress.opId !== state.currentOpId) return state;
      return updateItem(state, state.currentId, (it) =>
        it.scan === "scanning" ? { ...it, scanProgress: action.progress } : it,
      );
    }

    case "scanFinished":
      if (state.phase !== "scanning") return state;
      return {
        ...updateItem(state, action.id, (it) => ({
          ...it,
          scan: "scanned",
          plan: action.plan,
          include: hasWork(action.plan),
        })),
        currentId: null,
        currentOpId: null,
      };

    case "scanFailed":
      if (state.phase !== "scanning") return state;
      return {
        ...updateItem(state, action.id, (it) => ({ ...it, scan: "failed", scanError: action.error, include: false })),
        currentId: null,
        currentOpId: null,
      };

    case "scanCancelled":
      if (state.phase !== "scanning") return state;
      return {
        ...state,
        currentId: null,
        currentOpId: null,
        items: state.items.map((it) =>
          it.scan === "pending" || it.scan === "scanning" ? { ...it, scan: "cancelled", include: false } : it,
        ),
      };

    case "showPreview":
      if (state.phase !== "scanning") return state;
      return { ...state, phase: "preview", currentId: null, currentOpId: null, cancelling: false };

    case "setInclude":
      if (state.phase !== "preview") return state;
      return updateItem(state, action.id, (it) => ({ ...it, include: action.include && canInclude(it) }));

    case "syncPhaseStarted": {
      if (state.phase !== "preview" && state.phase !== "scanning") return state;
      const ids = new Set(action.ids);
      return {
        ...state,
        phase: "syncing",
        currentId: null,
        currentOpId: null,
        cancelling: false,
        speedHistory: createSpeedHistory(),
        syncStartedAt: action.now,
        items: state.items.map((it) => {
          const runs = ids.has(it.projectId) && canInclude(it);
          return { ...it, include: runs, run: runs ? "pending" : "none" };
        }),
      };
    }

    case "syncStarted":
      if (state.phase !== "syncing") return state;
      return {
        ...updateItem(state, action.id, (it) =>
          it.run === "pending" ? { ...it, run: "running", syncProgress: null } : it,
        ),
        currentId: action.id,
        currentOpId: action.opId,
      };

    case "syncProgress": {
      // Events of an earlier operation can arrive after its command returned: drop them.
      if (state.phase !== "syncing" || !state.currentId || action.progress.opId !== state.currentOpId) return state;
      const updated = updateItem(state, state.currentId, (it) =>
        it.run === "running" ? { ...it, syncProgress: action.progress } : it,
      );
      if (updated === state) return state;
      const p = action.progress;
      const rate = p.costPerSec;
      const next = rate > 0 && p.phase !== "deleting" ? { ...updated, lastCostPerSec: rate } : updated;
      // The chart's x is the overall progress, so a single project and a batch share one path.
      const overall = overallProgress(next.items, next.lastCostPerSec);
      const projectIndex = Math.max(0, runIndex(next.items, state.currentId));
      const h = next.speedHistory;
      return {
        ...next,
        speedHistory: addSpeedSample(h, {
          x: overall.fraction,
          // Deleting moves no bytes: speed 0. Early in a copy phase, 0 means "nothing measured yet".
          speed: speedReading(h, { phase: p.phase, bytesPerSec: p.bytesPerSec, elapsedMs: p.elapsedMs, projectIndex }),
          elapsedMs: p.elapsedMs,
          projectIndex,
          doneBytes: overall.doneBytes,
          copying: p.phase === "copying",
          deleting: p.phase === "deleting",
        }),
      };
    }

    case "syncFinished":
      if (state.phase !== "syncing") return state;
      return withFrontAdvanced(
        {
          ...updateItem(state, action.id, (it) => ({ ...it, run: "done", report: action.report })),
          currentId: null,
          currentOpId: null,
        },
        action.id,
        action.report.cancelled,
      );

    case "syncFailed":
      if (state.phase !== "syncing") return state;
      return withFrontAdvanced(
        {
          ...updateItem(state, action.id, (it) => ({ ...it, run: "failed", runError: action.error })),
          currentId: null,
          currentOpId: null,
        },
        action.id,
        true,
      );

    case "cancelRequested":
      if (!isBatchBusy(state)) return state;
      return { ...state, cancelling: true };

    case "finished":
      if (state.phase !== "syncing") return state;
      return {
        ...state,
        phase: "report",
        currentId: null,
        currentOpId: null,
        finishedAt: action.now,
        items: state.items.map((it) => (it.run === "pending" || it.run === "running" ? { ...it, run: "notRun" } : it)),
      };

    case "failed":
      return { ...state, phase: "error", currentId: null, currentOpId: null, cancelling: false, error: action.message };

    case "reset":
      return initialBatch;
  }
}

// ---- derived values -------------------------------------------------------------------------------

/** The plan changes something (copy, update, verify or delete). */
export function hasWork(plan: PlanSummary): boolean {
  return plan.totalEntries > 0;
}

/** Only successfully scanned projects with work can take part in a sync. */
export function canInclude(item: BatchItem): boolean {
  return item.scan === "scanned" && !!item.plan && hasWork(item.plan);
}

export function includedItems(state: BatchState): BatchItem[] {
  return state.items.filter((it) => it.include && canInclude(it));
}

/** The project may still write (or did write) its target in this batch. */
function mayWrite(item: BatchItem): boolean {
  if (item.scan === "pending" || item.scan === "scanning") return true;
  if (!canInclude(item) || !item.include) return false;
  return item.run !== "notRun";
}

/**
 * The item's cross-project warnings that still matter: a warning about a project that turned out
 * to be in sync, failed, was skipped or is not included is dropped.
 */
export function activeWarnings(item: BatchItem, items: BatchItem[]): string[] {
  return item.warnings
    .filter((w) => {
      const writer = items.find((it) => it.projectId === w.byId);
      return !writer || mayWrite(writer);
    })
    .map((w) => w.message);
}

export interface PlanTotals {
  copy: CountBytes;
  update: CountBytes;
  verify: CountBytes;
  delete: CountBytes & { dirs: number };
  unchanged: CountBytes;
  totalBytes: number;
  totalEntries: number;
  warnings: number;
}

export function sumPlans(plans: PlanSummary[]): PlanTotals {
  const t: PlanTotals = {
    copy: { files: 0, bytes: 0 },
    update: { files: 0, bytes: 0 },
    verify: { files: 0, bytes: 0 },
    delete: { files: 0, bytes: 0, dirs: 0 },
    unchanged: { files: 0, bytes: 0 },
    totalBytes: 0,
    totalEntries: 0,
    warnings: 0,
  };
  for (const p of plans) {
    for (const k of ["copy", "update", "verify", "unchanged"] as const) {
      t[k].files += p[k].files;
      t[k].bytes += p[k].bytes;
    }
    t.delete.files += p.delete.files;
    t.delete.bytes += p.delete.bytes;
    t.delete.dirs += p.delete.dirs;
    t.totalBytes += p.totalBytes;
    t.totalEntries += p.totalEntries;
    t.warnings += p.warnings.length;
  }
  return t;
}

/**
 * Weight of a plan for the overall progress bar: its bytes plus a fixed cost per file/deletion, so
 * that projects with only small files or only deletions still move the bar.
 */
export const ITEM_COST_BYTES = 64 * 1024;

export function planCost(plan: PlanSummary): number {
  const items = plan.copy.files + plan.update.files + plan.verify.files + plan.delete.files + plan.delete.dirs;
  return plan.totalBytes + items * ITEM_COST_BYTES;
}

export interface OverallProgress {
  /** 0..1 across all projects of the run; never decreases while a project moves through its phases. */
  fraction: number;
  /** Bytes to transfer across all projects (sum of plan totalBytes). */
  totalBytes: number;
  /** Finished projects' totals + the current project's doneBytes. */
  doneBytes: number;
  /** Files to copy/update/verify across all projects, and done the same way as the bytes. */
  totalFiles: number;
  doneFiles: number;
  /**
   * Remaining overall cost (bytes + per-item cost, pending projects included) / smoothed cost rate.
   * null while no rate is known yet — never 0 while projects remain.
   */
  etaSecs: number | null;
  /** 1-based position of the current (or next) project; 0 when there is none. */
  position: number;
  count: number;
  finished: number;
}

/**
 * Cost credited to a running project: its deletions fill the delete weight of its plan cost, the
 * copy phase adds bytes plus a per-file weight on top. So the credit only grows from Deleting to
 * Copying to Finalizing (the backend always deletes first).
 */
function runningCredit(plan: PlanSummary, p: SyncProgress, cost: number): number {
  const deleteItems = plan.delete.files + plan.delete.dirs;
  const deleteFrac =
    p.deleteTotal > 0 ? Math.min(1, p.deleteDone / p.deleteTotal) : p.phase === "deleting" ? 0 : 1;
  const deleteCredit = deleteFrac * deleteItems * ITEM_COST_BYTES;
  const transferCredit =
    p.phase === "deleting"
      ? 0
      : Math.min(p.doneBytes, p.totalBytes) + Math.min(p.doneFiles, p.totalFiles) * ITEM_COST_BYTES;
  return Math.min(cost, deleteCredit + transferCredit);
}

/**
 * Overall progress of the run phase (items with run ≠ "none"). `fallbackCostPerSec` is the last
 * known cost rate of this run (see BatchState.lastCostPerSec); it is used while the current project
 * has no rate of its own yet (deleting, warming up).
 */
export function overallProgress(items: BatchItem[], fallbackCostPerSec = 0): OverallProgress {
  const runItems = items.filter((it) => it.run !== "none" && it.plan);
  let totalCost = 0;
  let doneCost = 0;
  let totalBytes = 0;
  let doneBytes = 0;
  let totalFiles = 0;
  let doneFiles = 0;
  let pendingCost = 0;
  let currentRemainingCost = 0;
  let finished = 0;
  let position = 0;
  let current: BatchItem | null = null;

  for (let i = 0; i < runItems.length; i++) {
    const it = runItems[i];
    const plan = it.plan!;
    const cost = planCost(plan);
    totalCost += cost;
    totalBytes += plan.totalBytes;
    // The engine's own count (it includes type conflicts and case renames) once it is known.
    const files = it.syncProgress?.totalFiles ?? plan.copy.files + plan.update.files + plan.verify.files;
    totalFiles += files;
    if (it.run === "done" || it.run === "failed" || it.run === "notRun") {
      finished++;
      doneCost += cost;
      doneBytes += plan.totalBytes;
      doneFiles += files;
    } else if (it.run === "running") {
      current = it;
      position = i + 1;
      const p = it.syncProgress;
      const total = p?.totalBytes ?? plan.totalBytes;
      const credit = p ? runningCredit(plan, p, cost) : 0;
      doneCost += credit;
      doneBytes += Math.min(p?.doneBytes ?? 0, total);
      doneFiles += Math.min(p?.doneFiles ?? 0, files);
      currentRemainingCost = Math.max(0, cost - credit);
    } else {
      pendingCost += cost;
    }
  }

  if (!position && finished < runItems.length) position = finished + 1;
  const fraction =
    totalCost > 0 ? Math.min(1, doneCost / totalCost) : runItems.length > 0 ? finished / runItems.length : 0;

  let etaSecs: number | null = null;
  const cp = current?.syncProgress ?? null;
  const ownRate = cp && cp.phase !== "deleting" && cp.costPerSec > 0 ? cp.costPerSec : 0;
  const rate = ownRate > 0 ? ownRate : fallbackCostPerSec > 0 ? fallbackCostPerSec : 0;
  const remainingCost = currentRemainingCost + pendingCost;
  if (finished < runItems.length) {
    if (rate > 0) {
      etaSecs = remainingCost / rate; // 0 only when nothing at all remains
    } else if (cp && pendingCost === 0 && cp.phase === "copying" && cp.etaSecs != null && cp.etaSecs > 0) {
      etaSecs = cp.etaSecs; // the last project: its own ETA is the overall ETA
    }
  }

  return {
    fraction,
    totalBytes,
    doneBytes,
    totalFiles,
    doneFiles,
    etaSecs,
    position,
    count: runItems.length,
    finished,
  };
}

// ---- outcomes -------------------------------------------------------------------------------------

export type ItemOutcome =
  | "success"
  | "warnings"
  | "partial"
  | "cancelled"
  | "failed"
  | "skipped"
  | "notRun"
  | "inSync"
  | "excluded"
  | "pending";

export function itemOutcome(item: BatchItem): ItemOutcome {
  if (item.skipReason || item.scan === "skipped") return "skipped";
  if (item.scan === "failed") return "failed";
  if (item.scan === "cancelled") return "cancelled";
  if (item.run === "done" && item.report) return reportOutcome(item.report, item.plan?.warnings.length ?? 0);
  if (item.run === "failed") return "failed";
  if (item.run === "notRun") return "notRun";
  if (item.scan === "scanned" && item.plan && item.run === "none") return hasWork(item.plan) ? "excluded" : "inSync";
  return "pending";
}

/** The last run stored for a project whose scan or sync failed. */
export function failedLastRun(now: number): ProjectLastRun {
  return { finishedAt: now, outcome: "failed", durationMs: 0, bytesWritten: 0, filesWritten: 0, deleted: 0, errorCount: 1 };
}

/** What to store as the project's last run after the batch, or null to keep the previous one. */
export function lastRunFor(item: BatchItem, now: number): ProjectLastRun | null {
  const zero = { durationMs: 0, bytesWritten: 0, filesWritten: 0, deleted: 0, errorCount: 0 };
  const outcome = itemOutcome(item);
  switch (outcome) {
    case "success":
    case "warnings":
    case "partial":
    case "cancelled":
      if (!item.report) return null; // a cancelled scan never ran
      return {
        finishedAt: now,
        outcome,
        durationMs: item.report.durationMs,
        bytesWritten: item.report.bytesWritten,
        filesWritten: reportFilesWritten(item.report),
        deleted: reportDeleted(item.report),
        errorCount: reportErrorCount(item.report),
      };
    case "failed":
      return failedLastRun(now);
    case "inSync":
      return { finishedAt: now, outcome: item.plan!.warnings.length > 0 ? "warnings" : "success", ...zero };
    default:
      return null;
  }
}

function quoted(name: string): string {
  return `“${name}”`;
}

/**
 * Why "Shutdown after" must not shut down after this batch, or null when every chosen project ended
 * in success/warnings (no errors, no cancel, no scan/pre-flight failure or skip).
 */
export function shutdownBlocker(state: BatchState): string | null {
  const items = state.items;
  const by = (o: ItemOutcome) => items.filter((it) => itemOutcome(it) === o);

  if (state.cancelling || by("cancelled").length > 0 || by("notRun").length > 0) return "the sync was cancelled";
  const failed = by("failed");
  if (failed.length === 1) {
    const it = failed[0];
    return it.scan === "failed" ? `the scan of ${quoted(it.name)} failed` : `the sync of ${quoted(it.name)} failed`;
  }
  if (failed.length > 1) return `${failed.length} projects failed`;
  const partial = by("partial");
  if (partial.length === 1) {
    const n = reportErrorCount(partial[0].report!);
    return `${quoted(partial[0].name)} finished with ${n} ${n === 1 ? "error" : "errors"}`;
  }
  if (partial.length > 1) return `${partial.length} projects finished with errors`;
  const skipped = by("skipped");
  if (skipped.length === 1) return `${quoted(skipped[0].name)} was skipped (${skipped[0].skipReason ?? "not scanned"})`;
  if (skipped.length > 1) return `${skipped.length} projects were skipped`;
  if (items.length === 0) return "no project was synced";
  return null;
}

export interface BatchSummary {
  /** Overall result for the report header. */
  outcome: "success" | "warnings" | "partial" | "cancelled" | "failed";
  synced: number;
  inSync: number;
  withErrors: number;
  failed: number;
  skipped: number;
  notRun: number;
  excluded: number;
  errorCount: number;
  filesWritten: number;
  deleted: number;
  bytesWritten: number;
  durationMs: number;
}

export function summarizeBatch(state: BatchState): BatchSummary {
  const s: BatchSummary = {
    outcome: "success",
    synced: 0,
    inSync: 0,
    withErrors: 0,
    failed: 0,
    skipped: 0,
    notRun: 0,
    excluded: 0,
    errorCount: 0,
    filesWritten: 0,
    deleted: 0,
    bytesWritten: 0,
    durationMs: state.finishedAt && state.syncStartedAt ? Math.max(0, state.finishedAt - state.syncStartedAt) : 0,
  };
  let warnings = false;
  let cancelled = false;
  for (const it of state.items) {
    const o = itemOutcome(it);
    if (it.report) {
      s.errorCount += reportErrorCount(it.report);
      s.filesWritten += reportFilesWritten(it.report);
      s.deleted += reportDeleted(it.report);
      s.bytesWritten += it.report.bytesWritten;
    }
    switch (o) {
      case "success":
        s.synced++;
        break;
      case "warnings":
        s.synced++;
        warnings = true;
        break;
      case "partial":
        s.withErrors++;
        break;
      case "cancelled":
        cancelled = true;
        break;
      case "failed":
        s.failed++;
        break;
      case "skipped":
        s.skipped++;
        break;
      case "notRun":
        s.notRun++;
        cancelled = true;
        break;
      case "inSync":
        s.inSync++;
        if (it.plan && it.plan.warnings.length > 0) warnings = true;
        break;
      case "excluded":
        s.excluded++;
        break;
    }
  }
  // A batch in which nothing ran or was already in sync (everything failed or was skipped) failed.
  const ran = s.synced + s.withErrors + s.inSync;
  if (cancelled) s.outcome = "cancelled";
  else if ((s.failed > 0 || s.skipped > 0) && ran === 0) s.outcome = "failed";
  else if (s.withErrors > 0 || s.failed > 0) s.outcome = "partial";
  else if (warnings || s.skipped > 0) s.outcome = "warnings";
  return s;
}
