import { describe, expect, it } from "vitest";

import {
  NO_READING_GRACE_MS,
  SPEED_BINS,
  addSpeedSample,
  advanceSpeedHistory,
  averageSpeed,
  createSpeedHistory,
  formatSpeedTick,
  hasCurrentReading,
  niceSpeedMax,
  peakPoint,
  runElapsedMs,
  speedPoints,
  speedReading,
  withLeadIn,
  type SpeedHistory,
  type SpeedSample,
} from "@/lib/speed-history";

const MB = 1024 * 1024;
const GB = 1024 * MB;

function sample(partial: Partial<SpeedSample> = {}): SpeedSample {
  return { x: 0, speed: 0, elapsedMs: 0, projectIndex: 0, doneBytes: 0, copying: true, deleting: false, ...partial };
}

const DELETING = { speed: 0, copying: false, deleting: true } as const;

function feed(h: SpeedHistory, ...samples: Partial<SpeedSample>[]): SpeedHistory {
  return samples.reduce((acc, s) => addSpeedSample(acc, sample(s)), h);
}

describe("speed history", () => {
  it("starts empty", () => {
    const h = createSpeedHistory();
    expect(h.bins).toHaveLength(SPEED_BINS);
    expect(speedPoints(h)).toEqual([]);
    expect(peakPoint(speedPoints(h))).toBeNull();
    expect(averageSpeed(h)).toBeNull();
    expect(h.x).toBe(0);
  });

  it("averages samples that fall into the same bin and tracks current and peak", () => {
    const h = feed(createSpeedHistory(), { x: 0.1, speed: 100 }, { x: 0.1001, speed: 300 }, { x: 0.5, speed: 50 });
    const pts = speedPoints(h);
    expect(pts[0]).toMatchObject({ speed: 200 });
    expect(pts[0].x).toBeCloseTo(0.10005);
    expect(pts[pts.length - 1]).toMatchObject({ x: 0.5, speed: 50 });
    expect(h.current).toBe(50);
    expect(h.peak).toBe(300);
    expect(peakPoint(pts)).toMatchObject({ speed: 200 });
  });

  it("never moves x backwards", () => {
    const h = feed(createSpeedHistory(), { x: 0.4, speed: 10 }, { x: 0.2, speed: 20 });
    expect(h.x).toBe(0.4);
    // The late sample is recorded at the front, not behind it.
    expect(speedPoints(h).every((p) => p.x >= 0.4)).toBe(true);
    expect(advanceSpeedHistory(h, 0.3)).toBe(h);
    expect(advanceSpeedHistory(h, 0.6).x).toBe(0.6);
  });

  it("ends the curve at the front with the current speed", () => {
    let h = feed(createSpeedHistory(), { x: 0.3, speed: 10 });
    h = advanceSpeedHistory(h, 0.35);
    const pts = speedPoints(h);
    expect(pts[pts.length - 1]).toMatchObject({ x: 0.35, speed: 10 });
  });

  it("keeps memory bounded however many samples arrive", () => {
    let h = createSpeedHistory();
    for (let i = 0; i <= 10_000; i++) h = addSpeedSample(h, sample({ x: i / 10_000, speed: i, elapsedMs: i * 100 }));
    expect(h.bins).toHaveLength(SPEED_BINS);
    expect(speedPoints(h).length).toBeLessThanOrEqual(SPEED_BINS + 1);
    expect(h.samples).toBe(10_001);
  });

  it("clamps x to 0..1 and ignores invalid speeds", () => {
    const h = feed(createSpeedHistory(), { x: 1.7, speed: Number.NaN }, { x: -1, speed: -5 });
    expect(h.x).toBe(1);
    expect(h.peak).toBe(0);
    expect(speedPoints(h)).toHaveLength(1);
  });

  it("records where each project after the first started and the run's elapsed time", () => {
    let h = feed(
      createSpeedHistory(),
      { x: 0.1, projectIndex: 0, elapsedMs: 1000 },
      { x: 0.4, projectIndex: 0, elapsedMs: 4000 },
    );
    h = advanceSpeedHistory(h, 0.5); // the first project finished
    h = feed(h, { x: 0.55, projectIndex: 1, elapsedMs: 500 }, { x: 0.9, projectIndex: 2, elapsedMs: 200 });
    expect(h.boundaries).toEqual([0.5, 0.55]);
    expect(runElapsedMs(h)).toBe(4000 + 500 + 200);
    // (the first project's speed holds up to the boundary at 0.5, the second one's starts on it)
    expect(speedPoints(h).map((p) => p.project)).toEqual([0, 0, 0, 1, 1, 2, 2]);
    expect(speedPoints(h)[3].x).toBe(0.5);
    expect(speedPoints(h)[3].elapsedMs).toBe(4500);
  });

  it("averages bytes over copy time only", () => {
    const h = feed(
      createSpeedHistory(),
      { copying: false, elapsedMs: 0, doneBytes: 0 }, // deleting
      { copying: true, elapsedMs: 5000, doneBytes: 0 },
      { copying: true, elapsedMs: 6000, doneBytes: 100 * MB },
      { copying: true, elapsedMs: 7000, doneBytes: 300 * MB },
      // Next project: the gap between projects is not copy time.
      { copying: true, elapsedMs: 0, doneBytes: 300 * MB, projectIndex: 1 },
      { copying: true, elapsedMs: 1000, doneBytes: 400 * MB, projectIndex: 1 },
    );
    expect(averageSpeed(h)).toBeCloseTo((400 * MB) / 3);
  });

  it("keeps the front and the last speed for a sample without a reading", () => {
    let h = feed(createSpeedHistory(), { x: 0.1, speed: null });
    expect(h.x).toBe(0.1);
    expect(speedPoints(h)).toEqual([]);
    h = feed(h, { x: 0.2, speed: 80 }, { x: 0.3, speed: null });
    expect(h.current).toBe(80);
    expect(h.x).toBe(0.3);
    expect(speedPoints(h).map((p) => [p.x, p.speed])).toEqual([
      [0.2, 80],
      [0.3, 80],
    ]);
  });

  it("steps at a project boundary instead of easing across the gap", () => {
    let h = feed(createSpeedHistory(), { x: 0.1, speed: 60, projectIndex: 0 }, { x: 0.4, speed: 60, projectIndex: 0 });
    h = advanceSpeedHistory(h, 0.5);
    h = feed(h, { x: 0.5, speed: 0, projectIndex: 1, copying: false }, { x: 0.6, speed: 0, projectIndex: 1, copying: false });
    const pts = speedPoints(h).map((p) => [p.x, p.speed, p.project]);
    // The first project's speed holds until just before the boundary, then drops there.
    expect(pts[2][0]).toBeCloseTo(0.499);
    expect(pts[2].slice(1)).toEqual([60, 0]);
    expect(pts[3]).toEqual([0.5, 0, 1]);
  });

  it("steps right after the boundary when the previous project's last point sits on it", () => {
    // The first project's finalizing samples are recorded at its end, which is the boundary.
    let h = feed(createSpeedHistory(), { x: 0.3, speed: 60 }, { x: 0.5, speed: 40 });
    h = feed(h, { x: 0.5, speed: 0, projectIndex: 1, copying: false }, { x: 0.56, speed: 0, projectIndex: 1, copying: false });
    expect(h.boundaries).toEqual([0.5]);
    const pts = speedPoints(h).map((p) => [p.x, p.speed]);
    const i = pts.findIndex(([x]) => x === 0.5);
    // A vertical step on the boundary (the curve handles equal x), then the new project's zeros.
    expect(pts.slice(i, i + 2)).toEqual([
      [0.5, 40],
      [0.5, 0],
    ]);
    expect(pts.slice(i + 1).every(([, s]) => s === 0)).toBe(true);
  });

  it("puts the new project's first speed on the boundary when its first point comes later", () => {
    let h = feed(createSpeedHistory(), { x: 0.3, speed: 60 }, { x: 0.5, speed: 40 });
    h = feed(h, { x: 0.53, speed: 0, projectIndex: 1, copying: false }); // (front still at 0.5 → boundary 0.5)
    const pts = speedPoints(h).map((p) => [p.x, p.speed]);
    const i = pts.findIndex(([x]) => x === 0.5);
    expect(pts[i]).toEqual([0.5, 40]);
    expect(pts[i + 1][0]).toBeCloseTo(0.501);
    expect(pts[i + 1][1]).toBe(0);
  });

  it("never mixes two projects in one bin", () => {
    let h = feed(createSpeedHistory(), { x: 0.495, speed: 60, projectIndex: 0 });
    h = advanceSpeedHistory(h, 0.4975); // same bin (0.495..0.5)
    h = feed(h, { x: 0.4975, speed: 0, projectIndex: 1, copying: false }, { x: 0.4985, speed: 0, projectIndex: 1, copying: false });
    const pts = speedPoints(h);
    expect(pts.filter((p) => p.project === 0).every((p) => p.speed === 60)).toBe(true);
    expect(pts.filter((p) => p.project === 1).every((p) => p.speed === 0)).toBe(true);
    // The old speed holds until just before the boundary.
    expect(Math.max(...pts.filter((p) => p.project === 0).map((p) => p.x))).toBeCloseTo(0.4965);
  });

  it("sets the initial scale from the first reading", () => {
    const h = feed(createSpeedHistory(), { x: 0.1, speed: 50 * MB });
    expect(h.plotPeak).toBe(50 * MB);
    expect(h.axisMax).toBeGreaterThan(0);
  });

  it("grows the axis only when the settled curve would leave it, with headroom", () => {
    let h = feed(createSpeedHistory(), { x: 0.1, speed: 50 * MB });
    expect(h.axisMax).toBe(60 * MB);
    h = feed(h, { x: 0.2, speed: 58 * MB }, { x: 0.3, speed: 60 * MB }, { x: 0.35, speed: 60 * MB });
    expect(h.axisMax).toBe(60 * MB); // still fits: no rescale
    // A new level counts once two finished bins in a row show it.
    h = feed(h, { x: 0.4, speed: 61 * MB }, { x: 0.41, speed: 61 * MB });
    expect(h.axisMax).toBe(60 * MB);
    h = feed(h, { x: 0.42, speed: 61 * MB });
    expect(h.axisMax).toBe(80 * MB);
    h = feed(h, { x: 0.5, speed: 10 * MB }, { x: 0.6, speed: 10 * MB });
    expect(h.axisMax).toBe(80 * MB); // never back down
  });

  it("never rescales the axis for a one-sample spike", () => {
    let h = createSpeedHistory();
    const steady = (from: number, to: number) => {
      for (let x = from; x < to; x += 0.01) h = feed(h, { x, speed: 400 * MB });
    };
    steady(0.1, 0.3);
    const axis = niceSpeedMax(400 * MB * 1.15);
    expect(h.axisMax).toBe(axis);
    h = feed(h, { x: 0.305, speed: 1.1 * GB }); // one sample in a bin of its own
    steady(0.32, 0.4);
    expect(h.peak).toBe(1.1 * GB);
    expect(h.axisMax).toBe(axis);
  });

  it("grows the axis for a sustained step up", () => {
    let h = createSpeedHistory();
    for (let x = 0.1; x < 0.2; x += 0.01) h = feed(h, { x, speed: 400 * MB });
    for (let x = 0.2; x < 0.25; x += 0.01) h = feed(h, { x, speed: 800 * MB });
    expect(h.axisMax).toBe(niceSpeedMax(800 * MB * 1.15));
  });

  it("sizes the axis from a bin with several samples on its own", () => {
    let h = feed(createSpeedHistory(), { x: 0.1, speed: 100 * MB });
    for (let i = 0; i < 5; i++) h = feed(h, { x: 0.2 + i * 0.0005, speed: 300 * MB });
    expect(h.axisMax).toBe(niceSpeedMax(300 * MB * 1.15));
  });

  it("records the deletion phase at speed 0", () => {
    const h = feed(createSpeedHistory(), { x: 0.01, ...DELETING }, { x: 0.02, ...DELETING });
    expect(speedPoints(h).every((p) => p.speed === 0)).toBe(true);
    expect(peakPoint(speedPoints(h))).toBeNull();
    expect(averageSpeed(h)).toBeNull();
  });

  it("steps up where the copy phase starts after the deletion phase", () => {
    let h = feed(createSpeedHistory(), { x: 0.01, ...DELETING }, { x: 0.02, ...DELETING });
    // The copy phase starts without a reading, the first one comes later.
    h = feed(h, { x: 0.05, speed: null }, { x: 0.1, speed: 60e6 });
    expect(h.restarts).toEqual([0.02]);
    const pts = speedPoints(h);
    const i = pts.findIndex((p) => p.speed === 60e6);
    expect(pts[i - 1].speed).toBe(0);
    expect(pts[i - 1].x).toBeGreaterThanOrEqual(0.02 - 0.0011);
    expect(pts[i].x).toBeLessThanOrEqual(0.02 + 0.0011);
    // No made-up ramp across the stretch without a reading.
    expect(pts.some((p) => p.speed > 0 && p.speed < 60e6)).toBe(false);
  });

  it("never averages the first copy reading with deletion zeros", () => {
    const h = feed(createSpeedHistory(), { x: 0.021, ...DELETING }, { x: 0.022, speed: 60e6 }); // both bin 4
    expect(h.bins[4]).toMatchObject({ speedSum: 0, deleting: true });
    expect(h.bins[5]).toMatchObject({ speedSum: 60e6, count: 1, deleting: false });
  });

  it("keeps three projects apart when a middle project fits inside one bin", () => {
    let h = feed(createSpeedHistory(), { x: 0.5005, speed: 500, projectIndex: 0 });
    h = feed(h, { x: 0.501, speed: 0, projectIndex: 1 }, { x: 0.5015, speed: 0, projectIndex: 1 });
    h = feed(h, { x: 0.502, speed: 800, projectIndex: 2 }, { x: 0.5025, speed: 800, projectIndex: 2 });
    expect(h.bins[100]).toMatchObject({ project: 0 });
    expect(h.bins[101]).toMatchObject({ project: 1, speedSum: 0, count: 2 });
    expect(h.bins[102]).toMatchObject({ project: 2, speedSum: 1600, count: 2 });
    expect(h.boundaries).toEqual([0.5005, 0.5015]);
    const pts = speedPoints(h);
    expect(pts.some((p) => p.project === 1)).toBe(true);
    const firstOf2 = pts.find((p) => p.project === 2)!;
    expect(firstOf2.speed).toBe(800);
    expect(firstOf2.x).toBeGreaterThanOrEqual(0.5015);
  });

  it("draws a project that ended early as a gap at speed 0", () => {
    let h = feed(createSpeedHistory(), { x: 0.2, speed: 60, projectIndex: 0 }, { x: 0.45, speed: 60, projectIndex: 1 });
    h = advanceSpeedHistory(h, 2 / 3, { project: 1, aborted: true });
    expect(h.gaps).toEqual([{ from: 0.45, to: 2 / 3, project: 1 }]);
    expect(h.current).toBe(0);
    let pts = speedPoints(h);
    expect(pts.filter((p) => p.x > 0.4505).every((p) => p.speed === 0 && p.project === 1)).toBe(true);
    expect(pts[pts.length - 1].x).toBe(2 / 3);
    // The next project starts at the end of the gap.
    h = feed(h, { x: 0.7, speed: 40, projectIndex: 2 });
    expect(h.boundaries).toContain(2 / 3);
    pts = speedPoints(h);
    const first = pts.find((p) => p.project === 2)!;
    expect(first).toMatchObject({ speed: 40 });
    expect(first.x).toBeCloseTo(2 / 3);
  });

  it("extends the first reading to x = 0 only when it arrived close to the start", () => {
    const late = speedPoints(feed(createSpeedHistory(), { x: 0.41, speed: 70 }));
    expect(withLeadIn(late).some((p) => p.x === 0)).toBe(false);
    // The curve rises from the baseline at the first reading instead (no claimed speed before it).
    expect(withLeadIn(late)[0]).toMatchObject({ speed: 0, noReading: true });
    expect(withLeadIn(late)[0].x).toBeCloseTo(0.41, 5);
    const early = speedPoints(feed(createSpeedHistory(), { x: 0.004, speed: 70 }, { x: 0.1, speed: 70 }));
    expect(withLeadIn(early)[0]).toMatchObject({ x: 0, speed: 70 });
    expect(withLeadIn(early)).toHaveLength(early.length + 1);
  });

  it("finds a startup peak on a real point, not on the lead-in", () => {
    const pts = speedPoints(feed(createSpeedHistory(), { x: 0.004, speed: 900 }, { x: 0.1, speed: 300 }, { x: 0.2, speed: 300 }));
    expect(peakPoint(pts)).toMatchObject({ x: 0.004, speed: 900 });
  });
});

describe("speed readings", () => {
  const event = (partial: Partial<Parameters<typeof speedReading>[1]> = {}) => ({
    phase: "copying" as const,
    bytesPerSec: 0,
    elapsedMs: 0,
    projectIndex: 0,
    ...partial,
  });

  it("tells a real 0 from no reading yet", () => {
    const h0 = createSpeedHistory();
    expect(speedReading(h0, event({ phase: "deleting", bytesPerSec: 5 }))).toBe(0);
    expect(speedReading(h0, event({ bytesPerSec: 42 }))).toBe(42);
    expect(speedReading(h0, event({ phase: "finalizing" }))).toBe(0);
    // Early in the copy phase, 0 is "no reading yet" …
    expect(speedReading(h0, event())).toBeNull();
    const h = feed(h0, { speed: null, elapsedMs: 100 });
    expect(speedReading(h, event({ elapsedMs: 400 }))).toBeNull();
    // … until the copy phase has read 0 for the grace period (it moves no bytes) …
    expect(speedReading(h, event({ elapsedMs: 100 + NO_READING_GRACE_MS }))).toBe(0);
    // … or has had a reading (then 0 is a stall).
    const read = feed(h, { speed: 50, elapsedMs: 400 });
    expect(speedReading(read, event({ elapsedMs: 500 }))).toBe(0);
    // A new project starts over.
    expect(speedReading(read, event({ elapsedMs: 5000, projectIndex: 1 }))).toBeNull();
  });

  it("never reports another project's speed as the current one", () => {
    let h = feed(createSpeedHistory(), { x: 0.2, speed: 400 * MB, projectIndex: 0 });
    expect(hasCurrentReading(h)).toBe(true);
    h = feed(h, { x: 0.55, speed: null, projectIndex: 1, elapsedMs: 0 });
    expect(h.current).toBe(400 * MB); // the curve holds it up to the step …
    expect(hasCurrentReading(h)).toBe(false); // … but it is not project 1's speed
    h = feed(h, { x: 0.56, speed: 0, projectIndex: 1, elapsedMs: 1500 });
    expect(h.current).toBe(0);
    expect(hasCurrentReading(h)).toBe(false);
    h = feed(h, { x: 0.6, speed: 90 * MB, projectIndex: 1, elapsedMs: 1600 });
    expect(hasCurrentReading(h)).toBe(true);
  });
});

describe("speed axis", () => {
  it("picks a nice maximum whose half is nice", () => {
    expect(niceSpeedMax(0)).toBe(MB);
    expect(niceSpeedMax(130 * MB)).toBe(160 * MB);
    expect(niceSpeedMax(450 * MB)).toBe(500 * MB);
    expect(niceSpeedMax(870 * MB)).toBe(GB);
    expect(niceSpeedMax(1000 * MB)).toBe(GB);
    expect(niceSpeedMax(1.1 * GB)).toBe(1.2 * GB);
    expect(niceSpeedMax(1.3 * GB)).toBe(1.6 * GB);
    expect(niceSpeedMax(1.7 * GB)).toBe(2 * GB);
    expect(niceSpeedMax(700)).toBe(800);
    for (const v of [1, 999, 12_345, 3 * MB, 77 * MB, 2.5 * GB]) expect(niceSpeedMax(v)).toBeGreaterThanOrEqual(v);
  });

  it("labels ticks compactly in the axis' unit", () => {
    expect(formatSpeedTick(0, GB)).toBe("0");
    expect(formatSpeedTick(GB / 2, GB)).toBe("0.5 GB/s");
    expect(formatSpeedTick(GB, GB)).toBe("1 GB/s");
    expect(formatSpeedTick(250 * MB, 500 * MB)).toBe("250 MB/s");
    expect(formatSpeedTick(80 * MB, 160 * MB)).toBe("80 MB/s");
    expect(formatSpeedTick(0.6 * GB, 1.2 * GB)).toBe("0.6 GB/s");
  });
});
