// Shared contract between the React UI and the Rust backend (src-tauri/src).
// Rust structs mirror these with `#[serde(rename_all = "camelCase")]`.
// Keep both sides in sync when changing anything here.

/** Result of `inspect_project(path)`. */
export interface ProjectInfo {
  path: string;
  exists: boolean;
  /** Directory exists and contains no entries at all. */
  isEmpty: boolean;
  /** Has both `Assets/` and `ProjectSettings/` directories. */
  isUnityProject: boolean;
  /** `m_EditorVersion` from `ProjectSettings/ProjectVersion.txt`, if present. */
  unityVersion: string | null;
  /** Names of top-level directories, sorted case-insensitively. */
  rootDirs: string[];
  /**
   * Canonical form of `path` for comparing folders across projects (junctions, symlinks, mapped
   * drives resolved; no `\\?\` prefix; lowercase on Windows). Empty for a blank path.
   */
  comparePath: string;
}

/** What part of the project gets mirrored. Anything outside is never read or touched in the target. */
export interface SyncScope {
  /** Mirror loose files directly in the project root (not sub-directories). */
  includeRootFiles: boolean;
  /** Top-level folder names, e.g. ["Assets", "Packages", "ProjectSettings"]. */
  folders: string[];
}

/**
 * copy   = missing in target
 * update = size differs (or type conflict, or a case-only rename) → will be overwritten / renamed
 * verify = same size, different mtime → contents compared at sync time; copied only if different
 * delete = exists in target (inside scope) but not in source
 */
export type PlanAction = "copy" | "update" | "verify" | "delete";

/** `case` = the name differs only in letter case: the target entry is renamed to the source casing. */
export type PlanReason = "new" | "size" | "mtime" | "type" | "extra" | "case";

export interface PlanEntry {
  /** Relative path with forward slashes, e.g. "Assets/Scenes/Main.unity". */
  path: string;
  action: PlanAction;
  reason: PlanReason;
  /** Bytes of the source file (copy/update/verify) or target file (delete). 0 for dirs. */
  size: number;
  isDir: boolean;
}

export interface CountBytes {
  files: number;
  bytes: number;
}

/** Result of `scan(source, target, scope)`. */
export interface PlanSummary {
  planId: number;
  source: string;
  target: string;
  scope: SyncScope;
  copy: CountBytes;
  update: CountBytes;
  verify: CountBytes;
  delete: CountBytes & { dirs: number };
  unchanged: CountBytes;
  /** Bytes the sync has to read/write (copy + update + verify). */
  totalBytes: number;
  /** All non-unchanged entries, sorted by path; capped at 20 000 (see entriesTruncated). */
  entries: PlanEntry[];
  entriesTruncated: boolean;
  totalEntries: number;
  /** Non-fatal issues found while scanning (skipped symlinks, unreadable entries, ...). */
  warnings: string[];
  scanMs: number;
}

/** Payload of the `scan-progress` event. */
export interface ScanProgress {
  /** The scan this event belongs to (events may arrive after the command returned). */
  opId: OperationId;
  phase: "source" | "target" | "compare";
  /** Entries visited so far in the current phase. */
  entries: number;
}

export type SyncPhase = "deleting" | "copying" | "finalizing";

/** Payload of the `sync-progress` event (emitted ~10x per second while `run_sync` runs). */
export interface SyncProgress {
  /** The sync this event belongs to (events may arrive after the command returned). */
  opId: OperationId;
  phase: SyncPhase;
  doneBytes: number;
  totalBytes: number;
  doneFiles: number;
  totalFiles: number;
  /** Smoothed throughput. */
  bytesPerSec: number;
  /**
   * Smoothed copy-phase rate in cost units per second (bytes + 64 KiB per file, see
   * ITEM_COST_BYTES / sync.rs OVERHEAD_PER_FILE) — the rate behind `etaSecs`; 0 while unknown.
   */
  costPerSec: number;
  /** Estimated seconds remaining; null while not enough data. */
  etaSecs: number | null;
  elapsedMs: number;
  currentFile: string | null;
  errors: number;
  /** Items (files + folders) removed so far in the deletion phase. */
  deleteDone: number;
  /** Items (files + folders) the plan deletes. */
  deleteTotal: number;
}

export interface SyncError {
  path: string;
  message: string;
}

/** Result of `run_sync(planId)`. */
export interface SyncReport {
  copied: number;
  updated: number;
  verifiedIdentical: number;
  verifiedChanged: number;
  deletedFiles: number;
  deletedDirs: number;
  bytesWritten: number;
  durationMs: number;
  cancelled: boolean;
  /** The first 1000 errors; `errorCount` is the real number. */
  errors: SyncError[];
  errorCount: number;
}

/**
 * Commands (see src/lib/api.ts). `opId` is chosen by the UI per scan/sync so that a cancel is tied
 * to exactly one operation:
 *   scan({ source, target, scope, opId }), run_sync({ planId, opId }), cancel_operation({ opId }),
 *   discard_plans({ planIds }) — releases stored scan plans that will not be run,
 *   prepare_settings() / backup_settings() — protect settings.json (see src/lib/store.ts).
 * The `scan-progress` / `sync-progress` events carry the `opId` of their operation.
 * The backend keeps several scan plans at once (one per scanned project) until they run or are
 * discarded; `run_sync` consumes its plan.
 */
export type OperationId = number;

export const DEFAULT_SCOPE: SyncScope = {
  includeRootFiles: true,
  folders: ["Assets", "Packages", "ProjectSettings"],
};

/**
 * Top-level folders that Unity/IDEs/VCS regenerate or own. The UI never offers them and the
 * backend rejects a scope containing them (case-insensitive). Any other top-level folder of the
 * source (e.g. UserSettings) can be added to the scope.
 */
export const NEVER_SYNC = ["Library", "Temp", "Logs", "obj", ".git", ".vs", ".utmp"];

// ---- UI-only types (persisted by the frontend, not part of the Rust contract) ------------------

/**
 * Result of a project's last run:
 *   success   = synced without errors (or already in sync)
 *   warnings  = synced without errors, but the scan skipped some paths
 *   partial   = finished with errors
 *   cancelled = cancelled by the user while syncing
 *   failed    = the scan or the sync itself failed
 */
export type RunOutcome = "success" | "warnings" | "partial" | "cancelled" | "failed";

export interface ProjectLastRun {
  /** Epoch milliseconds. */
  finishedAt: number;
  outcome: RunOutcome;
  durationMs: number;
  bytesWritten: number;
  /** Files copied, updated or rewritten after verification. */
  filesWritten: number;
  /** Files + folders removed from the target. */
  deleted: number;
  errorCount: number;
}

/** A saved source → target pair ("project"), persisted in the store under `projects`. */
export interface SyncProject {
  id: string;
  /** Display name; defaults to the source folder's name. */
  name: string;
  source: string | null;
  target: string | null;
  scope: SyncScope;
  /** The user confirmed a non-empty, non-Unity target. Reset whenever the target changes. */
  targetAck: boolean;
  lastRun: ProjectLastRun | null;
}
