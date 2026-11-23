import type { SyncPhase } from "@/lib/types";

const intFormat = new Intl.NumberFormat("en-US");
const oneDecimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const twoDecimals = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** 1234 → "1,234" */
export function formatCount(n: number): string {
  return intFormat.format(n);
}

/** Binary units, e.g. 1536 → "1.5 KB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return `${intFormat.format(value)} B`;
  const fmt = value < 10 ? twoDecimals : oneDecimal;
  return `${fmt.format(value)} ${UNITS[unit]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Whole seconds → "45s", "2m 05s", "1h 02m". */
export function formatSeconds(totalSecs: number): string {
  const s = Math.max(0, Math.round(totalSecs));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad2(s % 60)}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${pad2(m % 60)}m`;
}

/** Milliseconds → "320 ms", "4.2s", "2m 05s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${oneDecimal.format(ms / 1000)}s`;
  return formatSeconds(ms / 1000);
}

export function formatEta(etaSecs: number | null | undefined): string {
  if (etaSecs == null || !Number.isFinite(etaSecs)) return "calculating…";
  if (etaSecs > 99 * 3600) return ">99h";
  return formatSeconds(etaSecs);
}

export function formatPercent(fraction: number): string {
  const pct = Math.min(100, Math.max(0, fraction * 100));
  return `${Math.floor(pct)}%`;
}

/**
 * Sync progress 0..1. While deleting: the deletion fraction. Otherwise by bytes, or by files when
 * there are no bytes to transfer, or by deletions for a deletion-only plan.
 */
export function progressFraction(p: {
  phase: SyncPhase;
  doneBytes: number;
  totalBytes: number;
  doneFiles: number;
  totalFiles: number;
  deleteDone: number;
  deleteTotal: number;
}): number {
  const deletion = p.deleteTotal > 0 ? Math.min(1, p.deleteDone / p.deleteTotal) : 0;
  if (p.phase === "deleting" && p.deleteTotal > 0) return deletion;
  if (p.totalBytes > 0) return Math.min(1, p.doneBytes / p.totalBytes);
  if (p.totalFiles > 0) return Math.min(1, p.doneFiles / p.totalFiles);
  if (p.deleteTotal > 0) return deletion;
  return 0;
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(n)} ${n === 1 ? singular : pluralForm}`;
}

/** Splits "Assets/Scenes/Main.unity" into ["Assets/Scenes/", "Main.unity"]. */
export function splitPath(path: string): [dir: string, name: string] {
  const i = path.lastIndexOf("/");
  return i < 0 ? ["", path] : [path.slice(0, i + 1), path.slice(i + 1)];
}
