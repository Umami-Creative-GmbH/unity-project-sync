import {
  DEFAULT_SCOPE,
  MAX_EXCLUDE_PATTERN_LENGTH,
  MAX_EXCLUDE_PATTERNS,
  NEVER_SYNC,
  type SyncScope,
} from "@/lib/types";

const NEVER_SYNC_LOWER = new Set(NEVER_SYNC.map((n) => n.toLowerCase()));

export function isNeverSync(name: string): boolean {
  return NEVER_SYNC_LOWER.has(name.toLowerCase());
}

/**
 * Names the backend rejects in a scope: '~' (8.3 short names such as GIT~1) or a trailing dot or
 * space (stripped by Windows path normalization).
 */
export function isAliasProne(name: string): boolean {
  return name.includes("~") || name.endsWith(".") || name.endsWith(" ");
}

export function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function containsName(list: readonly string[], name: string): boolean {
  return list.some((n) => sameName(n, name));
}

/** A scope as stored by older versions (no `exclude` yet) or as sent by the backend. */
export type ScopeInput = Omit<SyncScope, "exclude"> & { exclude?: readonly string[] };

/** Quick toggles of the scope editor; each one is just a pattern in `SyncScope.exclude`. */
export const EXCLUDE_PRESETS = [
  { label: "Logs", pattern: "*.log" },
  { label: "Unity packages", pattern: "*.unitypackage" },
  { label: "Crash dumps", pattern: "*.dmp" },
  { label: "Temp files", pattern: "*.tmp" },
] as const;

// Same as Rust's char::is_control.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/** Why the backend would reject an exclusion pattern (after trimming), or null when it is fine. */
export function excludePatternError(raw: string): string | null {
  const pattern = raw.trim();
  if (!pattern) return "Enter a file or folder name pattern.";
  if (/[\\/]/.test(pattern)) return "Patterns match names, not paths: no / or \\.";
  if (CONTROL_CHARS.test(pattern)) return "Control characters aren't allowed.";
  if ([...pattern].length > MAX_EXCLUDE_PATTERN_LENGTH) {
    return `At most ${MAX_EXCLUDE_PATTERN_LENGTH} characters.`;
  }
  return null;
}

/** Trims patterns, drops empty and invalid ones and duplicates (case-insensitive), caps the count. */
export function sanitizeExclude(patterns: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (excludePatternError(pattern) !== null || containsName(out, pattern)) continue;
    out.push(pattern);
  }
  return out.slice(0, MAX_EXCLUDE_PATTERNS);
}

function globRegExp(pattern: string): RegExp {
  const body = [...pattern]
    .map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`, "iu");
}

/**
 * True when an entry `name` matches one of `patterns` or is the `.meta` sidecar of a name that
 * does — the backend's rule (src-tauri/src/exclude.rs); used by the demo backend.
 */
export function isExcludedName(name: string, patterns: readonly string[]): boolean {
  const res = patterns.map((p) => p.trim()).filter(Boolean).map(globRegExp);
  const stem = /\.meta$/i.test(name) && name.length > 5 ? name.slice(0, -5) : null;
  return res.some((re) => re.test(name) || (stem !== null && re.test(stem)));
}

/** Removes duplicates (case-insensitive), never-synced and invalid names and patterns. */
export function sanitizeScope(scope: ScopeInput): SyncScope {
  const folders: string[] = [];
  for (const raw of scope.folders) {
    const name = raw.trim();
    if (!name || /[\\/]/.test(name) || name === "." || name === "..") continue;
    if (isNeverSync(name) || isAliasProne(name) || containsName(folders, name)) continue;
    folders.push(name);
  }
  return { includeRootFiles: scope.includeRootFiles, folders, exclude: sanitizeExclude(scope.exclude ?? []) };
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((f) => typeof f === "string");

/** Shape check for stored scopes; `exclude` may be missing (saved before exclusions existed). */
export function isScopeLike(value: unknown): value is ScopeInput {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.includeRootFiles === "boolean" &&
    isStringArray(v.folders) &&
    (v.exclude === undefined || isStringArray(v.exclude))
  );
}

/** Same names, ignoring order and letter case. */
function sameNameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = a.map((f) => f.toLowerCase()).sort();
  const sortedB = b.map((f) => f.toLowerCase()).sort();
  return sortedA.every((f, i) => f === sortedB[i]);
}

export function scopesEqual(a: SyncScope, b: SyncScope): boolean {
  return (
    a.includeRootFiles === b.includeRootFiles &&
    sameNameSet(a.folders, b.folders) &&
    sameNameSet(a.exclude, b.exclude)
  );
}

export function isScopeEmpty(scope: SyncScope): boolean {
  return !scope.includeRootFiles && scope.folders.length === 0;
}

export function cloneScope(scope: SyncScope): SyncScope {
  return { includeRootFiles: scope.includeRootFiles, folders: [...scope.folders], exclude: [...scope.exclude] };
}

export function cloneDefaultScope(): SyncScope {
  return cloneScope(DEFAULT_SCOPE);
}

const WINDOWS_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\)/; // drive letter or UNC

/** Normalizes a filesystem path for comparisons (slashes, trailing separator; case only on Windows, like the backend). */
export function normalizePath(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return WINDOWS_PATH.test(path) ? p.toLowerCase() : p;
}

/** True when both paths point at the same folder or one is inside the other. */
export function pathsOverlap(a: string, b: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (!na || !nb) return false;
  return na === nb || na.startsWith(`${nb}/`) || nb.startsWith(`${na}/`);
}
