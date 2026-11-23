// Persisted settings (source, target, scope) via @tauri-apps/plugin-store.
// "Shutdown after" is intentionally NOT persisted.
import { load, type Store } from "@tauri-apps/plugin-store";

import type { SyncScope } from "@/lib/types";
import { isScopeLike, sanitizeScope } from "@/lib/scope";

export interface PersistedSettings {
  source: string | null;
  target: string | null;
  scope: SyncScope | null;
}

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  storePromise ??= load("settings.json", { autoSave: true, defaults: {} });
  return storePromise;
}

function asPath(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export async function loadSettings(): Promise<PersistedSettings> {
  const store = await getStore();
  const [source, target, scope] = await Promise.all([
    store.get<unknown>("source"),
    store.get<unknown>("target"),
    store.get<unknown>("scope"),
  ]);
  return {
    source: asPath(source),
    target: asPath(target),
    scope: isScopeLike(scope) ? sanitizeScope(scope) : null,
  };
}

export async function saveSetting<K extends keyof PersistedSettings>(
  key: K,
  value: PersistedSettings[K],
): Promise<void> {
  const store = await getStore();
  if (value === null) await store.delete(key);
  else await store.set(key, value);
}
