import { describe, expect, it } from "vitest";

import { needsInspection, runLimited } from "@/hooks/use-folder-infos";
import type { ProjectInfo } from "@/lib/types";

const INFO: ProjectInfo = {
  path: "C:\\P",
  exists: true,
  isEmpty: false,
  isUnityProject: true,
  unityVersion: null,
  rootDirs: [],
  comparePath: "c:\\p",
};

describe("needsInspection", () => {
  it("treats a never-finished placeholder like a missing entry", () => {
    expect(needsInspection(undefined)).toBe(true);
    // Left behind by a run whose cleanup hasn't been applied yet when the next run starts.
    expect(needsInspection({ info: null, loading: true, error: null })).toBe(true);
  });

  it("keeps known results (also while they are being refreshed)", () => {
    expect(needsInspection({ info: INFO, loading: false, error: null })).toBe(false);
    expect(needsInspection({ info: INFO, loading: true, error: null })).toBe(false);
    expect(needsInspection({ info: null, loading: false, error: "denied" })).toBe(false);
    expect(needsInspection({ info: null, loading: true, error: "denied" })).toBe(false);
  });
});

describe("runLimited", () => {
  it("runs everything with bounded concurrency", async () => {
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    await runLimited([1, 2, 3, 4, 5], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      done.push(n);
      active--;
    });
    expect(done.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });
});
