import { describe, expect, it } from "vitest";

import {
  ITEM_COST_BYTES,
  activeWarnings,
  failedLastRun,
  batchReducer,
  includedItems,
  initialBatch,
  isBatchBusy,
  itemOutcome,
  lastRunFor,
  newBatchItem,
  overallProgress,
  planCost,
  shutdownBlocker,
  summarizeBatch,
  sumPlans,
  type BatchAction,
  type BatchItem,
  type BatchState,
} from "@/lib/batch";
import { speedPoints } from "@/lib/speed-history";
import type { PlanSummary, SyncProgress, SyncReport } from "@/lib/types";

const SCOPE = { includeRootFiles: true, folders: ["Assets"] };

let nextPlanId = 1;
function plan(partial: Partial<PlanSummary> = {}): PlanSummary {
  const copy = partial.copy ?? { files: 0, bytes: 0 };
  const update = partial.update ?? { files: 0, bytes: 0 };
  const verify = partial.verify ?? { files: 0, bytes: 0 };
  const del = partial.delete ?? { files: 0, bytes: 0, dirs: 0 };
  const totalEntries = copy.files + update.files + verify.files + del.files + del.dirs;
  return {
    planId: nextPlanId++,
    source: "C:\\S",
    target: "D:\\T",
    scope: SCOPE,
    copy,
    update,
    verify,
    delete: del,
    unchanged: { files: 10, bytes: 1000 },
    totalBytes: copy.bytes + update.bytes + verify.bytes,
    entries: [],
    entriesTruncated: false,
    totalEntries,
    warnings: [],
    scanMs: 5,
    ...partial,
  };
}

function report(partial: Partial<SyncReport> = {}): SyncReport {
  return {
    copied: 2,
    updated: 1,
    verifiedIdentical: 0,
    verifiedChanged: 1,
    deletedFiles: 1,
    deletedDirs: 1,
    bytesWritten: 300,
    durationMs: 1200,
    cancelled: false,
    errors: [],
    errorCount: 0,
    ...partial,
  };
}

function progress(partial: Partial<SyncProgress> = {}): SyncProgress {
  return {
    opId: 1,
    phase: "copying",
    costPerSec: 0,
    doneBytes: 0,
    totalBytes: 0,
    doneFiles: 0,
    totalFiles: 0,
    bytesPerSec: 0,
    etaSecs: null,
    elapsedMs: 0,
    currentFile: null,
    errors: 0,
    deleteDone: 0,
    deleteTotal: 0,
    ...partial,
  };
}

function item(id: string, extra: Partial<BatchItem> = {}): BatchItem {
  return {
    ...newBatchItem({ projectId: id, name: id.toUpperCase(), source: `C:\\${id}`, target: `D:\\${id}`, scope: SCOPE }),
    ...extra,
  };
}

function run(state: BatchState, ...actions: BatchAction[]): BatchState {
  return actions.reduce(batchReducer, state);
}

const WORK = () => plan({ copy: { files: 2, bytes: 200 }, update: { files: 1, bytes: 100 } });
const NO_WORK = () => plan();

describe("batchReducer", () => {
  it("walks preflight → scanning → preview → syncing → report", () => {
    let s = run(initialBatch, { type: "begin", autoSync: false, chosenIds: ["a", "b", "c"], now: 1 });
    expect(s.phase).toBe("preflight");
    expect(isBatchBusy(s)).toBe(true);

    const skipped = item("c", { skipReason: "Source is not a Unity project", scan: "skipped" });
    s = run(s, { type: "preflightDone", items: [item("a"), item("b"), skipped] });
    expect(s.phase).toBe("scanning");

    const pa = WORK();
    const pb = NO_WORK();
    s = run(s, { type: "scanStarted", id: "a", opId: 1, now: 2 }, { type: "scanProgress", progress: { opId: 1, phase: "source", entries: 42 } });
    expect(s.currentId).toBe("a");
    expect(s.items[0]).toMatchObject({ scan: "scanning", scanStartedAt: 2, scanProgress: { entries: 42 } });

    s = run(
      s,
      { type: "scanFinished", id: "a", plan: pa },
      { type: "scanStarted", id: "b", opId: 1, now: 3 },
      { type: "scanFinished", id: "b", plan: pb },
      { type: "showPreview" },
    );
    expect(s.phase).toBe("preview");
    expect(s.items.map((it) => it.include)).toEqual([true, false, false]); // only projects with work
    expect(includedItems(s).map((it) => it.projectId)).toEqual(["a"]);

    // Projects without work or that failed can't be included.
    s = run(s, { type: "setInclude", id: "b", include: true }, { type: "setInclude", id: "c", include: true });
    expect(includedItems(s).map((it) => it.projectId)).toEqual(["a"]);
    s = run(s, { type: "setInclude", id: "a", include: false });
    expect(includedItems(s)).toEqual([]);
    s = run(s, { type: "setInclude", id: "a", include: true });

    s = run(s, { type: "syncPhaseStarted", ids: ["a"], now: 10 });
    expect(s.phase).toBe("syncing");
    expect(s.items.map((it) => it.run)).toEqual(["pending", "none", "none"]);

    s = run(s, { type: "syncStarted", id: "a", opId: 1 }, { type: "syncProgress", progress: progress({ doneBytes: 100 }) });
    expect(s.items[0]).toMatchObject({ run: "running", syncProgress: { doneBytes: 100 } });

    s = run(s, { type: "syncFinished", id: "a", report: report() }, { type: "finished", now: 20 });
    expect(s.phase).toBe("report");
    expect(s.items.map(itemOutcome)).toEqual(["success", "inSync", "skipped"]);
    expect(isBatchBusy(s)).toBe(false);
  });

  it("ignores actions that don't fit the phase", () => {
    const idle = initialBatch;
    expect(run(idle, { type: "scanProgress", progress: { opId: 1, phase: "source", entries: 1 } })).toBe(idle);
    expect(run(idle, { type: "syncProgress", progress: progress() })).toBe(idle);
    expect(run(idle, { type: "cancelRequested" })).toBe(idle);
    expect(run(idle, { type: "finished", now: 1 })).toBe(idle);
    const scanning = run(idle, { type: "begin", autoSync: false, chosenIds: ["a"], now: 0 }, { type: "preflightDone", items: [item("a")] });
    expect(run(scanning, { type: "setInclude", id: "a", include: true })).toBe(scanning);
  });

  it("keeps scanning after a failed scan", () => {
    let s = run(
      initialBatch,
      { type: "begin", autoSync: true, chosenIds: ["a", "b"], now: 0 },
      { type: "preflightDone", items: [item("a"), item("b")] },
      { type: "scanStarted", id: "a", opId: 1, now: 1 },
      { type: "scanFailed", id: "a", error: "Access denied" },
      { type: "scanStarted", id: "b", opId: 1, now: 2 },
      { type: "scanFinished", id: "b", plan: WORK() },
    );
    expect(s.items.map((it) => it.scan)).toEqual(["failed", "scanned"]);
    // "Sync now" goes straight from scanning to syncing.
    s = run(s, { type: "syncPhaseStarted", ids: ["a", "b"], now: 3 });
    expect(s.phase).toBe("syncing");
    expect(s.items.map((it) => it.run)).toEqual(["none", "pending"]);
  });

  it("cancels the current and the remaining scans", () => {
    const s = run(
      initialBatch,
      { type: "begin", autoSync: false, chosenIds: ["a", "b", "c"], now: 0 },
      { type: "preflightDone", items: [item("a"), item("b"), item("c")] },
      { type: "scanStarted", id: "a", opId: 1, now: 1 },
      { type: "scanFinished", id: "a", plan: WORK() },
      { type: "scanStarted", id: "b", opId: 1, now: 2 },
      { type: "cancelRequested" },
      { type: "scanCancelled" },
    );
    expect(s.cancelling).toBe(true);
    expect(s.items.map((it) => it.scan)).toEqual(["scanned", "cancelled", "cancelled"]);
  });
  it("can show the preview with the scans that finished before the cancel", () => {
    const s = run(
      initialBatch,
      { type: "begin", autoSync: false, chosenIds: ["a", "b", "c"], now: 0 },
      { type: "preflightDone", items: [item("a"), item("b"), item("c")] },
      { type: "scanStarted", id: "a", opId: 1, now: 1 },
      { type: "scanFinished", id: "a", plan: WORK() },
      { type: "scanStarted", id: "b", opId: 2, now: 2 },
      { type: "cancelRequested" },
      { type: "scanCancelled" },
      { type: "showPreview" },
    );
    expect(s.phase).toBe("preview");
    expect(s.cancelling).toBe(false);
    expect(s.items.map((it) => it.scan)).toEqual(["scanned", "cancelled", "cancelled"]);
    expect(s.items.map((it) => it.include)).toEqual([true, false, false]);
    const tried = run(s, { type: "setInclude", id: "b", include: true });
    expect(includedItems(tried).map((it) => it.projectId)).toEqual(["a"]);
  });

  it("marks the remaining projects 'not run' after a cancelled sync", () => {
    const s = run(
      initialBatch,
      { type: "begin", autoSync: true, chosenIds: ["a", "b"], now: 0 },
      { type: "preflightDone", items: [item("a"), item("b")] },
      { type: "scanStarted", id: "a", opId: 1, now: 1 },
      { type: "scanFinished", id: "a", plan: WORK() },
      { type: "scanStarted", id: "b", opId: 1, now: 1 },
      { type: "scanFinished", id: "b", plan: WORK() },
      { type: "syncPhaseStarted", ids: ["a", "b"], now: 2 },
      { type: "syncStarted", id: "a", opId: 1 },
      { type: "cancelRequested" },
      { type: "syncFinished", id: "a", report: report({ cancelled: true }) },
      { type: "finished", now: 3 },
    );
    expect(s.items.map(itemOutcome)).toEqual(["cancelled", "notRun"]);
    expect(shutdownBlocker(s)).toBe("the sync was cancelled");
    expect(summarizeBatch(s).outcome).toBe("cancelled");
  });

  it("continues after a failed sync and can be reset or fail", () => {
    let s = run(
      initialBatch,
      { type: "begin", autoSync: true, chosenIds: ["a", "b"], now: 0 },
      { type: "preflightDone", items: [item("a"), item("b")] },
      { type: "scanStarted", id: "a", opId: 1, now: 0 },
      { type: "scanFinished", id: "a", plan: WORK() },
      { type: "scanStarted", id: "b", opId: 1, now: 0 },
      { type: "scanFinished", id: "b", plan: WORK() },
      { type: "syncPhaseStarted", ids: ["a", "b"], now: 0 },
      { type: "syncStarted", id: "a", opId: 1 },
      { type: "syncFailed", id: "a", error: "This scan result is no longer valid." },
      { type: "syncStarted", id: "b", opId: 1 },
      { type: "syncFinished", id: "b", report: report() },
      { type: "finished", now: 1 },
    );
    expect(s.items.map(itemOutcome)).toEqual(["failed", "success"]);
    expect(shutdownBlocker(s)).toBe("the sync of “A” failed");
    expect(summarizeBatch(s).outcome).toBe("partial");

    s = run(s, { type: "failed", message: "boom" });
    expect(s).toMatchObject({ phase: "error", error: "boom" });
    expect(run(s, { type: "reset" })).toEqual(initialBatch);
  });
});

describe("sumPlans", () => {
  it("adds up the plans", () => {
    const t = sumPlans([
      plan({ copy: { files: 1, bytes: 10 }, delete: { files: 2, bytes: 5, dirs: 1 }, warnings: ["w"] }),
      plan({ update: { files: 3, bytes: 30 }, verify: { files: 1, bytes: 7 } }),
    ]);
    expect(t).toMatchObject({
      copy: { files: 1, bytes: 10 },
      update: { files: 3, bytes: 30 },
      verify: { files: 1, bytes: 7 },
      delete: { files: 2, bytes: 5, dirs: 1 },
      unchanged: { files: 20, bytes: 2000 },
      totalBytes: 47,
      totalEntries: 8,
      warnings: 1,
    });
  });
});

describe("overallProgress", () => {
  const MB = 1024 * 1024;
  const GB = 1024 * MB;
  const bigPlan = (bytes: number, files = 1) => plan({ copy: { files, bytes } });

  it("is zero before anything ran", () => {
    const items = [item("a", { plan: bigPlan(100 * MB), run: "pending" }), item("b", { plan: bigPlan(100 * MB), run: "pending" })];
    const o = overallProgress(items);
    expect(o).toMatchObject({ fraction: 0, totalBytes: 200 * MB, doneBytes: 0, position: 1, count: 2, finished: 0, etaSecs: null });
  });

  it("sums finished totals and the current progress; ETA = remaining overall cost / cost rate", () => {
    const items = [
      item("a", { plan: bigPlan(100 * MB), run: "done" }),
      item("b", {
        plan: bigPlan(100 * MB),
        run: "running",
        syncProgress: progress({ doneBytes: 50 * MB, totalBytes: 100 * MB, doneFiles: 0, totalFiles: 1, costPerSec: 10 * MB, etaSecs: 5 }),
      }),
      item("c", { plan: bigPlan(100 * MB), run: "pending" }),
      item("x", { plan: bigPlan(999 * MB), run: "none" }), // excluded: not counted
    ];
    const o = overallProgress(items);
    expect(o.totalBytes).toBe(300 * MB);
    expect(o.doneBytes).toBe(150 * MB);
    expect(o.position).toBe(2);
    expect(o.count).toBe(3);
    expect(o.finished).toBe(1);
    const cost = planCost(bigPlan(100 * MB));
    // (rest of b: 50 MB + its file) + all of c, at 10 MB of cost per second
    expect(o.etaSecs).toBeCloseTo((cost - 50 * MB + cost) / (10 * MB));
    expect(o.fraction).toBeCloseTo((cost + 50 * MB) / (3 * cost));
  });

  it("counts many small files and deletions of pending projects in the ETA", () => {
    const running = item("a", {
      plan: bigPlan(4 * GB, 4),
      run: "running",
      syncProgress: progress({ doneBytes: 3 * GB, totalBytes: 4 * GB, doneFiles: 3, totalFiles: 4, costPerSec: 500 * MB, etaSecs: 2 }),
    });
    const smallFiles = plan({ copy: { files: 200_000, bytes: GB }, delete: { files: 30_000, bytes: 0, dirs: 0 } });
    const o = overallProgress([running, item("b", { plan: smallFiles, run: "pending" })]);
    // The pending project's per-item cost dominates (bytes alone would say ~4 s).
    expect(o.etaSecs!).toBeGreaterThan(planCost(smallFiles) / (500 * MB));
    expect(o.etaSecs!).toBeGreaterThan(20);
  });

  it("never reports ~0s while projects are still pending", () => {
    const finalizing = (costPerSec: number) =>
      item("a", {
        plan: bigPlan(100 * MB),
        run: "running",
        syncProgress: progress({ phase: "finalizing", doneBytes: 100 * MB, totalBytes: 100 * MB, doneFiles: 1, totalFiles: 1, costPerSec, etaSecs: 0 }),
      });
    const pending = item("b", { plan: bigPlan(100 * MB), run: "pending" });
    // No rate known: "estimating", not 0.
    expect(overallProgress([finalizing(0), pending]).etaSecs).toBeNull();
    // With a rate: the pending project's cost.
    const withRate = overallProgress([finalizing(10 * MB), pending]).etaSecs!;
    expect(withRate).toBeCloseTo(planCost(pending.plan!) / (10 * MB));
    // The last project's final event: nothing remains.
    expect(overallProgress([finalizing(10 * MB)]).etaSecs).toBe(0);
  });

  it("uses the run's last known rate while the current project has none yet", () => {
    const items = [
      item("a", {
        plan: plan({ delete: { files: 10, bytes: 0, dirs: 0 } }),
        run: "running",
        syncProgress: progress({ phase: "deleting", deleteDone: 5, deleteTotal: 10, etaSecs: null }),
      }),
      item("b", { plan: bigPlan(MB), run: "pending" }),
    ];
    expect(overallProgress(items).etaSecs).toBeNull();
    const o = overallProgress(items, ITEM_COST_BYTES);
    expect(o.etaSecs).toBeCloseTo((5 * ITEM_COST_BYTES + planCost(items[1].plan!)) / ITEM_COST_BYTES);
    // A deletion-only project still moves the bar (fixed per-item cost).
    expect(planCost(items[0].plan!)).toBe(10 * ITEM_COST_BYTES);
    expect(o.fraction).toBeGreaterThan(0);
  });

  it("never goes backwards when a project deletes before it copies", () => {
    const p = plan({ copy: { files: 1, bytes: GB }, delete: { files: 100, bytes: 0, dirs: 0 } });
    const at = (sp: Partial<SyncProgress>) =>
      overallProgress([
        item("a", { plan: p, run: "running", syncProgress: progress({ totalBytes: GB, totalFiles: 1, deleteTotal: 100, ...sp }) }),
        item("b", { plan: { ...p, planId: 999 }, run: "pending" }),
      ]).fraction;
    const steps = [
      at({ phase: "deleting", deleteDone: 0 }),
      at({ phase: "deleting", deleteDone: 50 }),
      at({ phase: "deleting", deleteDone: 100 }),
      at({ phase: "copying", deleteDone: 100, doneBytes: 0 }),
      at({ phase: "copying", deleteDone: 100, doneBytes: GB / 2 }),
      at({ phase: "copying", deleteDone: 100, doneBytes: GB, doneFiles: 1 }),
      at({ phase: "finalizing", deleteDone: 100, doneBytes: GB, doneFiles: 1 }),
    ];
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThanOrEqual(steps[i - 1]);
    // Deleting 100 items is a small share of a 1 GB project, not the whole project.
    expect(steps[2]).toBeLessThan(0.05);
    expect(steps[6]).toBeCloseTo(0.5);
  });

  it("counts finished projects by number when nothing has a cost", () => {
    const empty = plan({ totalBytes: 0 });
    const o = overallProgress([item("a", { plan: empty, run: "done" }), item("b", { plan: { ...empty }, run: "pending" })]);
    expect(o.fraction).toBe(0.5);
    expect(o.position).toBe(2);
  });

  it("is complete when everything finished", () => {
    const o = overallProgress([item("a", { plan: bigPlan(MB), run: "done" }), item("b", { plan: bigPlan(MB), run: "failed" })]);
    expect(o.fraction).toBe(1);
    expect(o.doneBytes).toBe(o.totalBytes);
    expect(o.etaSecs).toBeNull();
  });
});

describe("late progress events", () => {
  const twoScanned = () =>
    run(
      initialBatch,
      { type: "begin", autoSync: true, chosenIds: ["a", "b"], now: 0 },
      { type: "preflightDone", items: [item("a"), item("b")] },
      { type: "scanStarted", id: "a", opId: 1, now: 1 },
      { type: "scanFinished", id: "a", plan: WORK() },
      { type: "scanStarted", id: "b", opId: 2, now: 2 },
    );

  it("drops a scan event of the previous scan", () => {
    const s = twoScanned();
    const after = run(s, { type: "scanProgress", progress: { opId: 1, phase: "compare", entries: 999 } });
    expect(after).toBe(s);
    expect(after.items[1].scanProgress).toBeNull();
    const own = run(s, { type: "scanProgress", progress: { opId: 2, phase: "source", entries: 3 } });
    expect(own.items[1].scanProgress).toMatchObject({ entries: 3 });
    // Between scans nothing is current.
    const between = run(s, { type: "scanFinished", id: "b", plan: WORK() });
    expect(between.currentOpId).toBeNull();
    expect(run(between, { type: "scanProgress", progress: { opId: 2, phase: "compare", entries: 5 } })).toBe(between);
  });

  it("drops a sync event of the previous project", () => {
    let s = run(
      twoScanned(),
      { type: "scanFinished", id: "b", plan: WORK() },
      { type: "syncPhaseStarted", ids: ["a", "b"], now: 3 },
      { type: "syncStarted", id: "a", opId: 3 },
      { type: "syncFinished", id: "a", report: report() },
      { type: "syncStarted", id: "b", opId: 4 },
    );
    const before = overallProgress(s.items).fraction;
    const late = progress({ opId: 3, phase: "finalizing", doneBytes: 300, totalBytes: 300, doneFiles: 3, totalFiles: 3, costPerSec: 1e6 });
    const after = run(s, { type: "syncProgress", progress: late });
    expect(after).toBe(s);
    expect(after.items[1].syncProgress).toBeNull();
    expect(overallProgress(after.items).fraction).toBe(before);
    s = run(s, { type: "syncProgress", progress: progress({ opId: 4, doneBytes: 10, totalBytes: 300, costPerSec: 42 }) });
    expect(s.items[1].syncProgress).toMatchObject({ doneBytes: 10 });
    expect(s.lastCostPerSec).toBe(42);
  });
});
describe("speed history wiring", () => {
  const MB = 1024 * 1024;
  const bytesPlan = () => plan({ copy: { files: 1, bytes: 100 * MB } });
  const syncing = () =>
    run(
      initialBatch,
      { type: "begin", autoSync: true, chosenIds: ["a", "b"], now: 0 },
      { type: "preflightDone", items: [item("a"), item("b")] },
      { type: "scanStarted", id: "a", opId: 1, now: 0 },
      { type: "scanFinished", id: "a", plan: bytesPlan() },
      { type: "scanStarted", id: "b", opId: 2, now: 0 },
      { type: "scanFinished", id: "b", plan: bytesPlan() },
      { type: "syncPhaseStarted", ids: ["a", "b"], now: 1 },
      { type: "syncStarted", id: "a", opId: 3 },
    );
  const copying = (opId: number, doneBytes: number, extra: Partial<SyncProgress> = {}) =>
    progress({ opId, doneBytes, totalBytes: 100 * MB, totalFiles: 1, bytesPerSec: 50 * MB, elapsedMs: 1000, ...extra });

  it("records each accepted event at the overall progress, and drops late ones", () => {
    let s = run(syncing(), { type: "syncProgress", progress: copying(3, 50 * MB) });
    const h = s.speedHistory;
    expect(h.samples).toBe(1);
    expect(h.x).toBeCloseTo(overallProgress(s.items).fraction);
    expect(h.x).toBeGreaterThan(0.2);
    expect(h.x).toBeLessThan(0.3);
    expect(h.current).toBe(50 * MB);

    // A late event of another operation is dropped and doesn't touch the history.
    const after = run(s, { type: "syncProgress", progress: copying(99, 90 * MB) });
    expect(after).toBe(s);

    // Project "a" finishes: the front moves to its end; "b" starts there (a project boundary).
    s = run(
      s,
      { type: "syncFinished", id: "a", report: report() },
      { type: "syncStarted", id: "b", opId: 4 },
      { type: "syncProgress", progress: copying(4, 10 * MB, { elapsedMs: 200 }) },
    );
    expect(s.speedHistory.boundaries).toHaveLength(1);
    expect(s.speedHistory.boundaries[0]).toBeCloseTo(0.5);
    expect(s.speedHistory.x).toBeGreaterThan(0.5);
    expect(s.speedHistory.projectIndex).toBe(1);
  });

  it("records the deletion phase at speed 0", () => {
    const s = run(syncing(), {
      type: "syncProgress",
      progress: copying(3, 0, { phase: "deleting", bytesPerSec: 123, deleteDone: 1, deleteTotal: 2 }),
    });
    expect(s.speedHistory.samples).toBe(1);
    expect(s.speedHistory.current).toBe(0);
  });

  it("draws no point for a copy event without a speed reading yet", () => {
    const s = run(syncing(), { type: "syncProgress", progress: copying(3, 1 * MB, { bytesPerSec: 0, elapsedMs: 50 }) });
    expect(s.speedHistory.samples).toBe(1);
    expect(s.speedHistory.x).toBeGreaterThan(0);
    expect(speedPoints(s.speedHistory)).toEqual([]);
    const next = run(s, { type: "syncProgress", progress: copying(3, 5 * MB, { bytesPerSec: 40 * MB, elapsedMs: 150 }) });
    expect(speedPoints(next.speedHistory).map((p) => p.speed)).toEqual([40 * MB]);
  });

  it("draws a copy phase that moves no bytes at 0 once the grace period has passed", () => {
    let s = syncing();
    for (const elapsedMs of [0, 100, 300, 600, 900]) {
      s = run(s, { type: "syncProgress", progress: copying(3, 0, { bytesPerSec: 0, elapsedMs }) });
    }
    expect(speedPoints(s.speedHistory)).toEqual([]); // still "Preparing…"
    s = run(s, { type: "syncProgress", progress: copying(3, 0, { bytesPerSec: 0, elapsedMs: 1200 }) });
    expect(speedPoints(s.speedHistory).map((p) => p.speed)).toEqual([0]);
  });

  it("adds no point for a new project's first copy event without a reading", () => {
    let s = run(
      syncing(),
      { type: "syncProgress", progress: copying(3, 50 * MB, { bytesPerSec: 80 * MB }) },
      { type: "syncFinished", id: "a", report: report() },
      { type: "syncStarted", id: "b", opId: 4 },
    );
    const bins = s.speedHistory.bins.filter(Boolean).length;
    s = run(s, { type: "syncProgress", progress: copying(4, 1 * MB, { bytesPerSec: 0, elapsedMs: 100 }) });
    expect(s.speedHistory.bins.filter(Boolean)).toHaveLength(bins);
    expect(s.speedHistory.current).toBe(80 * MB);
    expect(s.speedHistory.projectIndex).toBe(1);
  });

  describe("a project that fails", () => {
    const three = () =>
      run(
        initialBatch,
        { type: "begin", autoSync: true, chosenIds: ["a", "b", "c"], now: 0 },
        { type: "preflightDone", items: [item("a"), item("b"), item("c")] },
        { type: "scanStarted", id: "a", opId: 1, now: 0 },
        { type: "scanFinished", id: "a", plan: bytesPlan() },
        { type: "scanStarted", id: "b", opId: 2, now: 0 },
        { type: "scanFinished", id: "b", plan: bytesPlan() },
        { type: "scanStarted", id: "c", opId: 3, now: 0 },
        { type: "scanFinished", id: "c", plan: bytesPlan() },
        { type: "syncPhaseStarted", ids: ["a", "b", "c"], now: 1 },
        { type: "syncStarted", id: "a", opId: 10 },
        { type: "syncProgress", progress: copying(10, 50 * MB) },
        {
          type: "syncProgress",
          progress: copying(10, 100 * MB, { phase: "finalizing", doneFiles: 1, elapsedMs: 2000 }),
        },
        { type: "syncFinished", id: "a", report: report() },
        { type: "syncStarted", id: "b", opId: 11 },
      );

    it("before its first event: its span is drawn at 0, not at the previous project's speed", () => {
      const s = run(
        three(),
        { type: "syncFailed", id: "b", error: "boom" },
        { type: "syncStarted", id: "c", opId: 12 },
        { type: "syncProgress", progress: copying(12, 10 * MB, { elapsedMs: 300 }) },
      );
      const h = s.speedHistory;
      expect(h.boundaries).toHaveLength(2);
      expect(h.boundaries[0]).toBeCloseTo(1 / 3);
      expect(h.boundaries[1]).toBeCloseTo(2 / 3);
      const pts = speedPoints(h);
      const inside = pts.filter((p) => p.x > 1 / 3 + 0.001 && p.x < 2 / 3);
      expect(inside.length).toBeGreaterThan(0);
      expect(inside.every((p) => p.speed === 0 && p.project === 1)).toBe(true);
      expect(pts.some((p) => p.project === 0 && p.speed > 0 && p.x > 1 / 3 + 0.001 && p.x < 2 / 3)).toBe(false);
      // The run's elapsed time still adds up the projects that ran.
      expect(h.elapsedOffsetMs).toBe(2000);
    });

    it("partway: its speed drops to 0 where it stopped", () => {
      let s = run(three(), { type: "syncProgress", progress: copying(11, 35 * MB, { bytesPerSec: 70 * MB }) });
      const stoppedAt = s.speedHistory.x;
      expect(stoppedAt).toBeGreaterThan(0.44);
      s = run(s, { type: "syncFailed", id: "b", error: "disk full" });
      const h = s.speedHistory;
      expect(h.x).toBeCloseTo(2 / 3);
      expect(h.current).toBe(0);
      const after = speedPoints(h).filter((p) => p.x > stoppedAt + 0.0005);
      expect(after.length).toBeGreaterThan(0);
      expect(after.every((p) => p.speed === 0)).toBe(true);
    });
  });

  it("starts a fresh history for every sync phase", () => {
    const s = run(syncing(), { type: "syncProgress", progress: copying(3, 50 * MB) });
    expect(s.speedHistory.samples).toBe(1);
    const again = run(
      s,
      { type: "syncFinished", id: "a", report: report() },
      { type: "finished", now: 5 },
      { type: "begin", autoSync: true, chosenIds: ["a"], now: 6 },
    );
    expect(again.speedHistory.samples).toBe(0);
    const resynced = run(
      again,
      { type: "preflightDone", items: [item("a")] },
      { type: "scanStarted", id: "a", opId: 5, now: 7 },
      { type: "scanFinished", id: "a", plan: bytesPlan() },
      { type: "syncPhaseStarted", ids: ["a"], now: 8 },
    );
    expect(resynced.speedHistory).toMatchObject({ samples: 0, x: 0, boundaries: [] });
  });
});

describe("outcomes, last runs and shutdown", () => {
  const reportState = (items: BatchItem[], extra: Partial<BatchState> = {}): BatchState => ({
    ...initialBatch,
    phase: "report",
    items,
    syncStartedAt: 1000,
    finishedAt: 4000,
    ...extra,
  });

  it("allows shutdown only when every project succeeded", () => {
    const ok = reportState([
      item("a", { scan: "scanned", plan: WORK(), run: "done", report: report() }),
      item("b", { scan: "scanned", plan: NO_WORK() }),
      item("w", { scan: "scanned", plan: plan({ ...WORK(), warnings: ["skipped link"] }), run: "done", report: report() }),
    ]);
    expect(shutdownBlocker(ok)).toBeNull();
    expect(summarizeBatch(ok)).toMatchObject({ outcome: "warnings", synced: 2, inSync: 1, filesWritten: 8, deleted: 4, durationMs: 3000 });
  });

  it("blocks shutdown on errors, skips and failed scans", () => {
    const errors = reportState([
      item("a", { scan: "scanned", plan: WORK(), run: "done", report: report({ errorCount: 2, errors: [{ path: "x", message: "y" }] }) }),
    ]);
    expect(shutdownBlocker(errors)).toBe("“A” finished with 2 errors");
    expect(summarizeBatch(errors).outcome).toBe("partial");

    const skipped = reportState([item("a", { skipReason: "Source folder not found", scan: "skipped" })]);
    expect(shutdownBlocker(skipped)).toBe("“A” was skipped (Source folder not found)");

    const scanFailed = reportState([item("a", { scan: "failed", scanError: "denied" })]);
    expect(shutdownBlocker(scanFailed)).toBe("the scan of “A” failed");
    expect(summarizeBatch(scanFailed).outcome).toBe("failed");

    expect(shutdownBlocker(reportState([], { cancelling: true }))).toBe("the sync was cancelled");
  });
  it("reports a batch in which every project was skipped as failed, not as synced", () => {
    const allSkipped = reportState([
      item("a", { skipReason: "Its target overlaps the target of “B”", scan: "skipped" }),
      item("b", { skipReason: "Its target overlaps the target of “A”", scan: "skipped" }),
    ]);
    expect(summarizeBatch(allSkipped)).toMatchObject({ outcome: "failed", skipped: 2, synced: 0, failed: 0 });
    expect(shutdownBlocker(allSkipped)).toBe("2 projects were skipped");

    // A skip next to a real sync is still "warnings".
    const mixed = reportState([
      item("a", { skipReason: "Source folder not found", scan: "skipped" }),
      item("b", { scan: "scanned", plan: WORK(), run: "done", report: report() }),
    ]);
    expect(summarizeBatch(mixed).outcome).toBe("warnings");
  });

  it("records a failed scan with the same shape as lastRunFor", () => {
    expect(failedLastRun(7)).toEqual(lastRunFor(item("a", { scan: "failed", scanError: "x" }), 7));
    expect(failedLastRun(7)).toMatchObject({ finishedAt: 7, outcome: "failed", errorCount: 1 });
  });

  it("builds the last run per project", () => {
    const now = 99;
    expect(lastRunFor(item("a", { scan: "scanned", plan: WORK(), run: "done", report: report() }), now)).toEqual({
      finishedAt: 99,
      outcome: "success",
      durationMs: 1200,
      bytesWritten: 300,
      filesWritten: 4,
      deleted: 2,
      errorCount: 0,
    });
    expect(lastRunFor(item("a", { scan: "failed", scanError: "x" }), now)).toMatchObject({ outcome: "failed" });
    expect(lastRunFor(item("a", { scan: "scanned", plan: WORK(), run: "failed", runError: "x" }), now)).toMatchObject({
      outcome: "failed",
    });
    expect(lastRunFor(item("a", { scan: "scanned", plan: NO_WORK() }), now)).toMatchObject({ outcome: "success", filesWritten: 0 });
    expect(
      lastRunFor(item("a", { scan: "scanned", plan: WORK(), run: "done", report: report({ cancelled: true }) }), now),
    ).toMatchObject({ outcome: "cancelled" });
    // Not run, excluded or skipped: keep the previous last run.
    expect(lastRunFor(item("a", { scan: "scanned", plan: WORK(), run: "notRun" }), now)).toBeNull();
    expect(lastRunFor(item("a", { scan: "scanned", plan: WORK() }), now)).toBeNull();
    expect(lastRunFor(item("a", { skipReason: "x", scan: "skipped" }), now)).toBeNull();
  });
});

describe("activeWarnings", () => {
  const warned = (extra: Partial<BatchItem> = {}) =>
    item("b", { warnings: [{ byId: "a", message: "changed by A" }], ...extra });

  it("keeps the warning while the writer may still change the source", () => {
    expect(activeWarnings(warned(), [item("a"), warned()])).toEqual(["changed by A"]);
    const writer = item("a", { scan: "scanned", plan: WORK(), include: true });
    expect(activeWarnings(warned(), [writer, warned()])).toEqual(["changed by A"]);
    const ran = item("a", { scan: "scanned", plan: WORK(), include: true, run: "done", report: report() });
    expect(activeWarnings(warned(), [ran, warned()])).toEqual(["changed by A"]);
  });

  it("drops the warning when the writer won't write", () => {
    const cases: BatchItem[] = [
      item("a", { scan: "scanned", plan: NO_WORK(), include: false }),
      item("a", { scan: "scanned", plan: WORK(), include: false }),
      item("a", { scan: "failed", scanError: "x" }),
      item("a", { scan: "skipped", skipReason: "x" }),
      item("a", { scan: "scanned", plan: WORK(), include: true, run: "notRun" }),
    ];
    for (const writer of cases) expect(activeWarnings(warned(), [writer, warned()])).toEqual([]);
  });
});
