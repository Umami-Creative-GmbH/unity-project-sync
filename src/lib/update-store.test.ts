import { describe, expect, it, vi } from "vitest";

import { createUpdateStore, isUpdateInProgress, updateOf, type UpdateState } from "@/lib/update-store";
import type { DownloadProgress, UpdateCheckResult, UpdateHandle } from "@/lib/updates";

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

function fakeHandle(overrides: Partial<UpdateHandle> = {}) {
  const handle = {
    download: vi.fn(async (onProgress?: (p: DownloadProgress) => void) => {
      onProgress?.({ downloaded: 0, total: 100 });
      onProgress?.({ downloaded: 100, total: 100 });
    }),
    install: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  };
  return handle;
}

function available(handle: UpdateHandle, version = "0.2.0"): UpdateCheckResult {
  return { status: "available", currentVersion: "0.1.0", version, notes: "Notes", ...handle };
}

const UPDATE = { currentVersion: "0.1.0", version: "0.2.0", notes: "Notes" };

function recorder(store: { get(): UpdateState; subscribe(l: () => void): () => void }) {
  const states: UpdateState[] = [];
  store.subscribe(() => states.push(store.get()));
  return states;
}

describe("createUpdateStore: check", () => {
  it("goes idle → checking → up-to-date", async () => {
    const store = createUpdateStore({ check: async () => ({ status: "up-to-date", currentVersion: "0.1.0" }) });
    expect(store.get()).toEqual({ status: "idle" });
    const states = recorder(store);
    const result = await store.check();
    expect(result).toEqual({ status: "up-to-date", currentVersion: "0.1.0" });
    expect(states.map((s) => s.status)).toEqual(["checking", "up-to-date"]);
  });

  it("dedupes concurrent checks", async () => {
    const d = deferred<UpdateCheckResult>();
    const check = vi.fn(() => d.promise);
    const store = createUpdateStore({ check });
    const a = store.check();
    const b = store.check({ silent: true });
    expect(a).toBe(b);
    d.resolve({ status: "up-to-date", currentVersion: null });
    await a;
    expect(check).toHaveBeenCalledTimes(1);
    await store.check();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("shows errors of a user check, but a silent check only logs and returns to idle", async () => {
    const warn = vi.fn();
    const store = createUpdateStore({ check: async () => ({ status: "error", message: "offline" }), warn });
    expect(await store.check({ silent: true })).toEqual({ status: "idle" });
    expect(warn).toHaveBeenCalled();
    expect(await store.check()).toEqual({ status: "error", message: "offline", during: "check" });
  });

  it("surfaces the error when a user check joins a silent one", async () => {
    const d = deferred<UpdateCheckResult>();
    const store = createUpdateStore({ check: () => d.promise, warn: () => {} });
    const silent = store.check({ silent: true });
    void store.check();
    d.resolve({ status: "error", message: "offline" });
    expect((await silent).status).toBe("error");
  });

  it("treats a rejecting check function as an error", async () => {
    const store = createUpdateStore({
      check: async () => {
        throw new Error("boom");
      },
    });
    expect(await store.check()).toEqual({ status: "error", message: "boom", during: "check" });
  });

  it("releases the previous update when checking again", async () => {
    const first = fakeHandle();
    const second = fakeHandle();
    const results = [available(first), available(second, "0.3.0")];
    const store = createUpdateStore({ check: async () => results.shift()! });
    await store.check();
    expect(store.get()).toEqual({ status: "available", update: UPDATE, downloaded: false });
    await store.check();
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).not.toHaveBeenCalled();
    expect(updateOf(store.get())?.version).toBe("0.3.0");
  });

  it("keeps a downloaded update when a re-check fails, and can still install it", async () => {
    const d = deferred<void>();
    const handle = fakeHandle({ download: vi.fn(() => d.promise) });
    const results: UpdateCheckResult[] = [available(handle), { status: "error", message: "offline" }];
    const store = createUpdateStore({ check: async () => results.shift()!, warn: () => {} });
    await store.check();
    // download only: a sync starts during the download, so the install is postponed
    const run = store.install();
    store.setBusy(true);
    d.resolve();
    await run;
    expect(store.get()).toEqual({ status: "available", update: UPDATE, downloaded: true });
    store.setBusy(false);

    expect(await store.check()).toEqual({
      status: "error",
      message: "offline",
      during: "check",
      update: UPDATE,
      downloaded: true,
    });
    expect(handle.close).not.toHaveBeenCalled();
    expect(updateOf(store.get())).toEqual(UPDATE);

    await store.install();
    expect(handle.download).toHaveBeenCalledTimes(1);
    expect(handle.install).toHaveBeenCalledTimes(1);
  });

  it("a failed silent re-check goes back to the announced update", async () => {
    const handle = fakeHandle();
    const results: UpdateCheckResult[] = [available(handle), { status: "error", message: "offline" }];
    const warn = vi.fn();
    const store = createUpdateStore({ check: async () => results.shift()!, warn });
    await store.check();
    expect(await store.check({ silent: true })).toEqual({ status: "available", update: UPDATE, downloaded: false });
    expect(warn).toHaveBeenCalled();
    expect(handle.close).not.toHaveBeenCalled();
  });
});

describe("createUpdateStore: install", () => {
  it("downloads with progress, prepares, then installs", async () => {
    const handle = fakeHandle();
    const beforeInstall = vi.fn(async () => {});
    const store = createUpdateStore({ check: async () => available(handle), beforeInstall });
    await store.check();
    const states = recorder(store);
    await store.install();
    expect(states).toEqual([
      { status: "downloading", update: UPDATE, progress: { downloaded: 0, total: null } },
      { status: "downloading", update: UPDATE, progress: { downloaded: 0, total: 100 } },
      { status: "downloading", update: UPDATE, progress: { downloaded: 100, total: 100 } },
      { status: "installing", update: UPDATE },
    ]);
    expect(beforeInstall).toHaveBeenCalledTimes(1);
    expect(handle.install).toHaveBeenCalledTimes(1);
  });

  it("does nothing without an update", async () => {
    const store = createUpdateStore({ check: async () => ({ status: "up-to-date", currentVersion: null }) });
    await store.check();
    await store.install();
    expect(store.get().status).toBe("up-to-date");
  });

  it("refuses to install while a scan or sync is running", async () => {
    const handle = fakeHandle();
    const store = createUpdateStore({ check: async () => available(handle) });
    await store.check();
    store.setBusy(true);
    await store.install();
    expect(handle.download).not.toHaveBeenCalled();
    expect(store.get().status).toBe("available");
  });

  it("postpones the install when a sync starts during the download", async () => {
    const d = deferred<void>();
    const handle = fakeHandle({ download: vi.fn(() => d.promise) });
    const store = createUpdateStore({ check: async () => available(handle) });
    await store.check();
    const run = store.install();
    expect(isUpdateInProgress(store.get())).toBe(true);
    store.setBusy(true);
    d.resolve();
    await run;
    expect(handle.install).not.toHaveBeenCalled();
    expect(store.get()).toEqual({ status: "available", update: UPDATE, downloaded: true });

    // Once it has finished, installing doesn't download again.
    store.setBusy(false);
    await store.install();
    expect(handle.download).toHaveBeenCalledTimes(1);
    expect(handle.install).toHaveBeenCalledTimes(1);
  });

  it("keeps the update after a failed download so it can be retried", async () => {
    let fail = true;
    const handle = fakeHandle({
      download: vi.fn(async () => {
        if (fail) throw new Error("error sending request for url");
      }),
    });
    const store = createUpdateStore({ check: async () => available(handle), warn: () => {} });
    await store.check();
    await store.install();
    const failed = store.get();
    expect(failed).toMatchObject({ status: "error", during: "download", update: UPDATE });
    expect(updateOf(failed)).toEqual(UPDATE);

    fail = false;
    await store.install();
    expect(handle.download).toHaveBeenCalledTimes(2);
    expect(handle.install).toHaveBeenCalledTimes(1);
  });

  it("reports a failed install and retries without downloading again", async () => {
    const handle = fakeHandle({ install: vi.fn().mockRejectedValueOnce("access denied").mockResolvedValue(undefined) });
    const store = createUpdateStore({ check: async () => available(handle), warn: () => {} });
    await store.check();
    await store.install();
    expect(store.get()).toEqual({
      status: "error",
      message: "The installer couldn't be started: access denied",
      during: "install",
      update: UPDATE,
    });
    await store.install();
    expect(handle.download).toHaveBeenCalledTimes(1);
    expect(handle.install).toHaveBeenCalledTimes(2);
  });

  it("ignores a second install and checks while downloading", async () => {
    const d = deferred<void>();
    const handle = fakeHandle({ download: vi.fn(() => d.promise) });
    const check = vi.fn(async () => available(handle));
    const store = createUpdateStore({ check });
    await store.check();
    const run = store.install();
    void store.install();
    expect((await store.check()).status).toBe("downloading");
    expect(check).toHaveBeenCalledTimes(1);
    d.resolve();
    await run;
    expect(handle.download).toHaveBeenCalledTimes(1);
    expect(handle.install).toHaveBeenCalledTimes(1);
  });

  it("doesn't wait forever for a hanging preparation step", async () => {
    vi.useFakeTimers();
    try {
      const handle = fakeHandle();
      const store = createUpdateStore({
        check: async () => available(handle),
        beforeInstall: () => new Promise<void>(() => {}),
        beforeInstallTimeoutMs: 1000,
      });
      await store.check();
      const run = store.install();
      await vi.advanceTimersByTimeAsync(1000);
      await run;
      expect(handle.install).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
    await flush();
  });
});
