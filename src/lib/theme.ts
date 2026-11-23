// Theme controller: applies the System / Light / Dark preference to <html class="dark">.
//
// "System" follows the OS live (prefers-color-scheme). The preference itself is persisted in the
// settings store (appSettings.theme); a copy is kept in localStorage only as a startup hint, read
// synchronously by the inline script in index.html and by main.tsx so the first paint already has
// the right theme (the store loads asynchronously over IPC).
import type { ThemePreference } from "@/lib/types";
import { isThemePreference } from "@/lib/settings";

/** localStorage key of the startup hint. Keep in sync with the inline script in index.html. */
export const THEME_HINT_KEY = "ups.theme";

export type ResolvedTheme = "light" | "dark";

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === "light" || preference === "dark") return preference;
  return systemDark ? "dark" : "light";
}

/** Minimal Storage surface (localStorage can be missing or throw, e.g. with blocked site data). */
export interface HintStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readThemeHint(storage: HintStorage | null | undefined): ThemePreference {
  try {
    const v = storage?.getItem(THEME_HINT_KEY);
    return isThemePreference(v) ? v : "system";
  } catch {
    return "system";
  }
}

export function writeThemeHint(storage: HintStorage | null | undefined, preference: ThemePreference): void {
  try {
    storage?.setItem(THEME_HINT_KEY, preference);
  } catch {
    /* only a startup hint */
  }
}

export interface ThemeEnvironment {
  /** Gets the "dark" class. */
  root: { classList: { toggle(token: string, force?: boolean): boolean } };
  /** `window.matchMedia("(prefers-color-scheme: dark)")`. */
  darkQuery: Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener">;
  storage?: HintStorage | null;
  /**
   * Native window theme (title bar): null = follow the OS. Best effort; may be async and fail
   * outside Tauri.
   */
  setNativeTheme?: (theme: ResolvedTheme | null) => unknown;
}

export interface ThemeController {
  readonly preference: ThemePreference;
  readonly resolved: ResolvedTheme;
  set(preference: ThemePreference): void;
  dispose(): void;
}

export function createThemeController(env: ThemeEnvironment, initial: ThemePreference): ThemeController {
  let preference = initial;
  let resolved: ResolvedTheme = "light";

  const apply = () => {
    resolved = resolveTheme(preference, env.darkQuery.matches);
    env.root.classList.toggle("dark", resolved === "dark");
  };
  const setNative = () => {
    if (!env.setNativeTheme) return;
    try {
      const r = env.setNativeTheme(preference === "system" ? null : preference);
      if (r && typeof (r as Promise<unknown>).catch === "function") (r as Promise<unknown>).catch(() => {});
    } catch {
      /* not running in Tauri or missing permission */
    }
  };
  // Live OS changes matter only for "system"; apply() reads the current preference.
  const onChange = () => apply();
  env.darkQuery.addEventListener("change", onChange);
  apply();
  if (preference !== "system") setNative();

  return {
    get preference() {
      return preference;
    },
    get resolved() {
      return resolved;
    },
    set(next) {
      if (next === preference) return;
      preference = next;
      apply();
      writeThemeHint(env.storage, next);
      setNative();
    },
    dispose() {
      env.darkQuery.removeEventListener("change", onChange);
    },
  };
}
