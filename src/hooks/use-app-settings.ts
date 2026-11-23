import { useCallback, useSyncExternalStore } from "react";

import { createAppSettingsStore, type AppSettingsStatus } from "@/lib/app-settings-store";
import { loadAppSettings, saveAppSettings } from "@/lib/store";
import { readThemeHint } from "@/lib/theme";
import type { AppSettings } from "@/lib/types";

function hintStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The app's settings (one instance for the app's lifetime). Until the store has loaded, the theme
 * comes from the startup hint so the UI doesn't flip.
 */
export const appSettings = createAppSettingsStore({
  load: loadAppSettings,
  save: saveAppSettings,
  initial: { theme: readThemeHint(hintStorage()) },
});

/** Current settings outside React (e.g. read once when a scan or sync starts). */
export function getAppSettings(): AppSettings {
  return appSettings.get();
}

/** Settings + an update function; changes apply immediately and are persisted. */
export function useAppSettings(): [AppSettings, (patch: Partial<AppSettings>) => void] {
  const settings = useSyncExternalStore(appSettings.subscribe, appSettings.get);
  const update = useCallback((patch: Partial<AppSettings>) => appSettings.update(patch), []);
  return [settings, update];
}

/** Load status of the stored settings ("failed": changes apply but aren't saved). */
export function useAppSettingsStatus(): AppSettingsStatus {
  return useSyncExternalStore(appSettings.subscribe, appSettings.status);
}
