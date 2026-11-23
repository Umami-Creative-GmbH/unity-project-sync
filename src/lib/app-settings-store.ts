// In-memory holder of the app settings: applies changes immediately (subscribers, e.g. the theme
// controller and React via useAppSettings) and persists them in the background.
import { appSettingsEqual, DEFAULT_APP_SETTINGS, sanitizeAppSettings } from "@/lib/settings";
import type { AppSettings } from "@/lib/types";

export type AppSettingsStatus = "idle" | "loading" | "ready" | "failed";

export interface AppSettingsStore {
  get(): AppSettings;
  status(): AppSettingsStatus;
  /** Notified when the settings or the load status change. */
  subscribe(listener: () => void): () => void;
  /**
   * Applies right away; saved once the stored settings have been loaded. Changes made before that
   * win over the stored values of the same keys only.
   */
  update(patch: Partial<AppSettings>): void;
  /**
   * Loads the stored settings; concurrent calls share one attempt; after a failure the next call
   * tries again; no-op once ready.
   */
  load(): Promise<void>;
}

export interface AppSettingsStoreDeps {
  load: () => Promise<AppSettings>;
  save: (settings: AppSettings) => Promise<void>;
  /** Values shown until the stored ones are loaded (e.g. the theme from the startup hint). */
  initial?: Partial<AppSettings>;
  warn?: (message: string, error: unknown) => void;
}

export function createAppSettingsStore(deps: AppSettingsStoreDeps): AppSettingsStore {
  const warn = deps.warn ?? ((m, e) => console.warn(m, e));
  let current = sanitizeAppSettings({ ...DEFAULT_APP_SETTINGS, ...deps.initial });
  let status: AppSettingsStatus = "idle";
  /**
   * Keys the user changed before the stored settings arrived (sanitized values): those keys win
   * over the stored ones, every other key keeps its stored value. Kept across failed loads, so a
   * later successful load still saves the session's changes.
   */
  let pending: Partial<AppSettings> | null = null;
  let loadPromise: Promise<void> | null = null;
  // Saves run one after another so the file always ends with the latest value.
  let saveChain: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();

  const emit = () => listeners.forEach((l) => l());
  const persist = () => {
    const snapshot = current;
    saveChain = saveChain.then(() => deps.save(snapshot)).catch((e) => warn("Could not save the settings:", e));
  };

  return {
    get: () => current,
    status: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(patch) {
      const next = sanitizeAppSettings({ ...current, ...patch });
      if (appSettingsEqual(next, current)) return;
      current = next;
      emit();
      if (status === "ready") {
        persist();
        return;
      }
      // Not loaded (yet): never write over a file that hasn't been read; remember only the keys
      // of this patch so the stored values of the others survive.
      const keep: Partial<AppSettings> = pending ?? {};
      for (const k of Object.keys(patch) as (keyof AppSettings)[]) {
        if (k in next) (keep as Record<string, unknown>)[k] = next[k];
      }
      pending = keep;
    },
    load() {
      if (status === "ready") return Promise.resolve();
      loadPromise ??= (async () => {
        status = "loading";
        emit();
        try {
          // Always asynchronous, so the catch below never runs before loadPromise is assigned.
          const stored = await Promise.resolve().then(deps.load);
          const changes = pending;
          pending = null;
          const merged = changes ? sanitizeAppSettings({ ...stored, ...changes }) : stored;
          status = "ready";
          if (!appSettingsEqual(merged, current)) current = merged;
          emit();
          if (changes && !appSettingsEqual(merged, stored)) persist();
        } catch (e) {
          // Session-only until a later attempt succeeds: never write over a file that couldn't
          // be read.
          status = "failed";
          loadPromise = null;
          warn("Could not load the settings:", e);
          emit();
        }
      })();
      return loadPromise;
    },
  };
}
