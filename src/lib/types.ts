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
 * update = size differs (or type conflict) → will be overwritten
 * verify = same size, different mtime → contents compared at sync time; copied only if different
 * delete = exists in target (inside scope) but not in source
 */
export type PlanAction = "copy" | "update" | "verify" | "delete";

export type PlanReason = "new" | "size" | "mtime" | "type" | "extra";

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
  phase: "source" | "target" | "compare";
  /** Entries visited so far in the current phase. */
  entries: number;
}

export type SyncPhase = "deleting" | "copying" | "finalizing";

/** Payload of the `sync-progress` event (emitted ~10x per second while `run_sync` runs). */
export interface SyncProgress {
  phase: SyncPhase;
  doneBytes: number;
  totalBytes: number;
  doneFiles: number;
  totalFiles: number;
  /** Smoothed throughput. */
  bytesPerSec: number;
  /** Estimated seconds remaining; null while not enough data. */
  etaSecs: number | null;
  elapsedMs: number;
  currentFile: string | null;
  errors: number;
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
  errors: SyncError[];
}

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
