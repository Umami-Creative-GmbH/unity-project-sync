import { DEFAULT_SCOPE, NEVER_SYNC, type SyncScope } from "@/lib/types";

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

export function containsName(list: string[], name: string): boolean {
  return list.some((n) => sameName(n, name));
}

/** Removes duplicates (case-insensitive), never-synced and invalid names. */
export function sanitizeScope(scope: SyncScope): SyncScope {
  const folders: string[] = [];
  for (const raw of scope.folders) {
    const name = raw.trim();
    if (!name || /[\\/]/.test(name) || name === "." || name === "..") continue;
    if (isNeverSync(name) || isAliasProne(name) || containsName(folders, name)) continue;
    folders.push(name);
  }
  return { includeRootFiles: scope.includeRootFiles, folders };
}

export function isScopeLike(value: unknown): value is SyncScope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.includeRootFiles === "boolean" &&
    Array.isArray(v.folders) &&
    v.folders.every((f) => typeof f === "string")
  );
}

export function scopesEqual(a: SyncScope, b: SyncScope): boolean {
  if (a.includeRootFiles !== b.includeRootFiles) return false;
  if (a.folders.length !== b.folders.length) return false;
  const sortedA = [...a.folders].map((f) => f.toLowerCase()).sort();
  const sortedB = [...b.folders].map((f) => f.toLowerCase()).sort();
  return sortedA.every((f, i) => f === sortedB[i]);
}

export function isScopeEmpty(scope: SyncScope): boolean {
  return !scope.includeRootFiles && scope.folders.length === 0;
}

export function cloneDefaultScope(): SyncScope {
  return { includeRootFiles: DEFAULT_SCOPE.includeRootFiles, folders: [...DEFAULT_SCOPE.folders] };
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
