// App-wide preferences (pure logic; persistence in ./store.ts, React binding in
// src/hooks/use-app-settings.ts).
import type { AppSettings, ThemePreference, ThreadInfo, ThreadSetting } from "@/lib/types";

export const APP_SETTINGS_KEY = "appSettings";

/** Fixed thread counts a user can pick (the backend accepts 1..32). */
export const MIN_FIXED_THREADS = 2;
export const MAX_THREADS = 32;
/** "Auto" never uses more than this many threads (more rarely helps disk-bound work). */
export const MAX_AUTO_THREADS = 16;
export const THREAD_CHOICES = [2, 4, 6, 8, 12, 16, 24, 32] as const;

export const THEMES: readonly ThemePreference[] = ["system", "light", "dark"];

export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = Object.freeze({
  multiThreaded: true,
  threads: "auto",
  theme: "system",
});

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/** "auto", or a whole number clamped to 2..32; anything else → null. */
export function sanitizeThreads(value: unknown): ThreadSetting | null {
  if (value === "auto") return "auto";
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return clamp(Math.round(value), MIN_FIXED_THREADS, MAX_THREADS);
}

/** Turns a stored value into valid settings; unknown or invalid fields fall back to the defaults. */
export function sanitizeAppSettings(value: unknown): AppSettings {
  const v = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    multiThreaded: typeof v.multiThreaded === "boolean" ? v.multiThreaded : DEFAULT_APP_SETTINGS.multiThreaded,
    threads: sanitizeThreads(v.threads) ?? DEFAULT_APP_SETTINGS.threads,
    theme: isThemePreference(v.theme) ? v.theme : DEFAULT_APP_SETTINGS.theme,
  };
}

export function appSettingsEqual(a: AppSettings, b: AppSettings): boolean {
  return a.multiThreaded === b.multiThreaded && a.threads === b.threads && a.theme === b.theme;
}

/**
 * The `threads` argument of `scan` / `run_sync`: null = auto (the backend decides), 1 when
 * multi-threading is off, else the fixed count.
 */
export function effectiveThreads(settings: Pick<AppSettings, "multiThreaded" | "threads">): number | null {
  if (!settings.multiThreaded) return 1;
  return settings.threads === "auto" ? null : settings.threads;
}

/** What "Auto" resolves to when the backend can't be asked: logical CPUs clamped to 1..16. */
export function fallbackThreadInfo(logicalCpus: number | undefined): ThreadInfo {
  const cpus = typeof logicalCpus === "number" && Number.isFinite(logicalCpus) && logicalCpus >= 1 ? Math.floor(logicalCpus) : 1;
  return { logicalCpus: cpus, autoThreads: clamp(cpus, 1, MAX_AUTO_THREADS), maxThreads: MAX_THREADS };
}

/** Threads a run with these settings will use (for display). */
export function resolvedThreadCount(settings: Pick<AppSettings, "multiThreaded" | "threads">, info: ThreadInfo): number {
  const requested = effectiveThreads(settings);
  return requested === null ? info.autoThreads : clamp(requested, 1, info.maxThreads || MAX_THREADS);
}

/** The thread choices offered in the UI, including a stored value that isn't one of the presets. */
export function threadChoices(current: ThreadSetting): number[] {
  const list: number[] = [...THREAD_CHOICES];
  if (typeof current === "number" && !list.includes(current)) {
    list.push(current);
    list.sort((a, b) => a - b);
  }
  return list;
}
