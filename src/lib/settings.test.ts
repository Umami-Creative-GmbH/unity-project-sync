import { describe, expect, it } from "vitest";

import {
  DEFAULT_APP_SETTINGS,
  effectiveThreads,
  fallbackThreadInfo,
  resolvedThreadCount,
  sanitizeAppSettings,
  sanitizeThreads,
  threadChoices,
} from "@/lib/settings";

describe("sanitizeAppSettings", () => {
  it("defaults to multi-threaded, auto threads and the system theme", () => {
    expect(DEFAULT_APP_SETTINGS).toEqual({ multiThreaded: true, threads: "auto", theme: "system" });
    for (const v of [undefined, null, 42, "x", [], [1, 2], true]) {
      expect(sanitizeAppSettings(v)).toEqual(DEFAULT_APP_SETTINGS);
    }
  });

  it("keeps valid values", () => {
    expect(sanitizeAppSettings({ multiThreaded: false, threads: 8, theme: "dark" })).toEqual({
      multiThreaded: false,
      threads: 8,
      theme: "dark",
    });
    expect(sanitizeAppSettings({ multiThreaded: true, threads: "auto", theme: "light" })).toEqual({
      multiThreaded: true,
      threads: "auto",
      theme: "light",
    });
  });

  it("replaces each invalid field with its default, independently", () => {
    expect(sanitizeAppSettings({ multiThreaded: "no", threads: "many", theme: "blue" })).toEqual(DEFAULT_APP_SETTINGS);
    expect(sanitizeAppSettings({ multiThreaded: false, threads: null, theme: 1 })).toEqual({
      ...DEFAULT_APP_SETTINGS,
      multiThreaded: false,
    });
    expect(sanitizeAppSettings({ theme: "dark" })).toEqual({ ...DEFAULT_APP_SETTINGS, theme: "dark" });
  });

  it("ignores unknown keys", () => {
    expect(sanitizeAppSettings({ theme: "light", extra: 1 })).toEqual({ ...DEFAULT_APP_SETTINGS, theme: "light" });
  });
});

describe("sanitizeThreads", () => {
  it("clamps numbers to 2..32 and rounds them", () => {
    expect(sanitizeThreads(1)).toBe(2);
    expect(sanitizeThreads(0)).toBe(2);
    expect(sanitizeThreads(-5)).toBe(2);
    expect(sanitizeThreads(64)).toBe(32);
    expect(sanitizeThreads(32)).toBe(32);
    expect(sanitizeThreads(6.6)).toBe(7);
  });

  it("accepts auto; rejects everything else", () => {
    expect(sanitizeThreads("auto")).toBe("auto");
    expect(sanitizeThreads(Number.NaN)).toBeNull();
    expect(sanitizeThreads(Number.POSITIVE_INFINITY)).toBeNull();
    expect(sanitizeThreads("8")).toBeNull();
    expect(sanitizeThreads("Auto")).toBeNull();
    expect(sanitizeThreads(undefined)).toBeNull();
  });
});

describe("effectiveThreads", () => {
  it("is null (backend auto) for auto", () => {
    expect(effectiveThreads({ multiThreaded: true, threads: "auto" })).toBeNull();
  });

  it("is the fixed count when multi-threaded", () => {
    expect(effectiveThreads({ multiThreaded: true, threads: 12 })).toBe(12);
  });

  it("is exactly 1 when multi-threading is off, whatever the thread setting", () => {
    expect(effectiveThreads({ multiThreaded: false, threads: "auto" })).toBe(1);
    expect(effectiveThreads({ multiThreaded: false, threads: 24 })).toBe(1);
  });
});

describe("thread info", () => {
  it("falls back to logical CPUs clamped to 1..16", () => {
    expect(fallbackThreadInfo(8)).toEqual({ logicalCpus: 8, autoThreads: 8, maxThreads: 32 });
    expect(fallbackThreadInfo(64)).toEqual({ logicalCpus: 64, autoThreads: 16, maxThreads: 32 });
    expect(fallbackThreadInfo(undefined)).toEqual({ logicalCpus: 1, autoThreads: 1, maxThreads: 32 });
    expect(fallbackThreadInfo(0).autoThreads).toBe(1);
  });

  it("resolves the count a run will use", () => {
    const info = { logicalCpus: 24, autoThreads: 16, maxThreads: 32 };
    expect(resolvedThreadCount({ multiThreaded: true, threads: "auto" }, info)).toBe(16);
    expect(resolvedThreadCount({ multiThreaded: true, threads: 4 }, info)).toBe(4);
    expect(resolvedThreadCount({ multiThreaded: false, threads: 4 }, info)).toBe(1);
  });

  it("offers the presets plus a stored custom value", () => {
    expect(threadChoices("auto")).toEqual([2, 4, 6, 8, 12, 16, 24, 32]);
    expect(threadChoices(8)).toEqual([2, 4, 6, 8, 12, 16, 24, 32]);
    expect(threadChoices(3)).toEqual([2, 3, 4, 6, 8, 12, 16, 24, 32]);
  });
});
