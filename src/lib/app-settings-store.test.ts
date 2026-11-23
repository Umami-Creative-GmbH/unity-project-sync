import { describe, expect, it, vi } from "vitest";

import { createAppSettingsStore } from "@/lib/app-settings-store";
import { DEFAULT_APP_SETTINGS } from "@/lib/settings";
import type { AppSettings } from "@/lib/types";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createAppSettingsStore", () => {
  it("starts with the defaults (plus initial overrides) and loads the stored settings", async () => {
    const stored: AppSettings = { multiThreaded: false, threads: 4, theme: "dark" };
    const save = vi.fn(async () => {});
    const store = createAppSettingsStore({ load: async () => stored, save, initial: { theme: "light" } });
    expect(store.get()).toEqual({ ...DEFAULT_APP_SETTINGS, theme: "light" });
    const listener = vi.fn();
    store.subscribe(listener);
    await store.load();
    expect(store.get()).toEqual(stored);
    expect(store.status()).toBe("ready");
    expect(listener).toHaveBeenCalledTimes(2); // "loading", then the stored values + "ready"
    expect(save).not.toHaveBeenCalled(); // loading never writes
    await store.load(); // no-op once ready
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("applies updates immediately and saves them in order", async () => {
    const saved: AppSettings[] = [];
    const store = createAppSettingsStore({
      load: async () => DEFAULT_APP_SETTINGS,
      save: async (s) => {
        await flush();
        saved.push(s);
      },
    });
    await store.load();
    const listener = vi.fn();
    store.subscribe(listener);
    store.update({ theme: "dark" });
    expect(store.get().theme).toBe("dark");
    store.update({ multiThreaded: false });
    store.update({ multiThreaded: false }); // no change → no emit, no save
    expect(listener).toHaveBeenCalledTimes(2);
    await flush();
    await flush();
    await flush();
    expect(saved).toEqual([
      { ...DEFAULT_APP_SETTINGS, theme: "dark" },
      { ...DEFAULT_APP_SETTINGS, theme: "dark", multiThreaded: false },
    ]);
  });

  it("sanitizes updates", async () => {
    const store = createAppSettingsStore({ load: async () => DEFAULT_APP_SETTINGS, save: async () => {} });
    await store.load();
    store.update({ threads: 99 });
    expect(store.get().threads).toBe(32);
    store.update({ theme: "neon" as never });
    expect(store.get().theme).toBe("system");
  });

  it("keeps only the keys changed before the load finished and saves them", async () => {
    const d = deferred<AppSettings>();
    const save = vi.fn(async () => {});
    const store = createAppSettingsStore({ load: () => d.promise, save });
    const loading = store.load();
    store.update({ theme: "light" });
    expect(save).not.toHaveBeenCalled();
    d.resolve({ multiThreaded: false, threads: 8, theme: "dark" });
    await loading;
    // The stored values of the untouched keys survive.
    expect(store.get()).toEqual({ multiThreaded: false, threads: 8, theme: "light" });
    await flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ multiThreaded: false, threads: 8, theme: "light" });
  });

  it("does not save when a change made before the load equals the stored value", async () => {
    const d = deferred<AppSettings>();
    const save = vi.fn(async () => {});
    const store = createAppSettingsStore({ load: () => d.promise, save });
    const loading = store.load();
    store.update({ theme: "dark" });
    d.resolve({ multiThreaded: false, threads: 4, theme: "dark" });
    await loading;
    expect(store.get()).toEqual({ multiThreaded: false, threads: 4, theme: "dark" });
    await flush();
    expect(save).not.toHaveBeenCalled();
  });

  it("never saves while loading failed (changes stay session-only) and reports the status", async () => {
    const save = vi.fn(async () => {});
    const warn = vi.fn();
    const store = createAppSettingsStore({ load: async () => Promise.reject(new Error("io")), save, warn });
    const statuses: string[] = [];
    store.subscribe(() => statuses.push(store.status()));
    await store.load();
    expect(store.status()).toBe("failed");
    expect(statuses).toEqual(["loading", "failed"]);
    store.update({ theme: "dark" });
    expect(store.get().theme).toBe("dark");
    await flush();
    expect(save).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("retries a failed load and then saves the changes made meanwhile", async () => {
    const stored: AppSettings = { multiThreaded: false, threads: 6, theme: "system" };
    const load = vi.fn<() => Promise<AppSettings>>().mockRejectedValueOnce(new Error("locked")).mockResolvedValue(stored);
    const save = vi.fn(async () => {});
    const store = createAppSettingsStore({ load, save, warn: () => {} });
    await store.load();
    expect(store.status()).toBe("failed");
    store.update({ theme: "light" });
    await store.load();
    expect(load).toHaveBeenCalledTimes(2);
    expect(store.status()).toBe("ready");
    expect(store.get()).toEqual({ ...stored, theme: "light" });
    await flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ ...stored, theme: "light" });
  });

  it("loads only once and survives a failing save", async () => {
    const load = vi.fn(async () => DEFAULT_APP_SETTINGS);
    const warn = vi.fn();
    const save = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
    const store = createAppSettingsStore({ load, save, warn });
    await Promise.all([store.load(), store.load()]);
    expect(load).toHaveBeenCalledTimes(1);
    store.update({ theme: "dark" });
    await flush();
    store.update({ theme: "light" });
    await flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
