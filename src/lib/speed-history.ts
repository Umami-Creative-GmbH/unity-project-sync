// Speed history of a sync run for the transfer chart: x = overall progress 0..1, y = speed.
//
// Bounded memory: the x range is split into a fixed number of bins and every sample is averaged
// into the bin its x falls in, so a run of any length keeps at most SPEED_BINS points (plus a few
// per project for steps and gaps). x never goes backwards (each sample is clamped to the running
// maximum). Pure and immutable — the history lives in the batch reducer state (src/lib/batch.ts) so
// a remount of the progress view keeps it.
import type { SyncPhase } from "@/lib/types";

export const SPEED_BINS = 200;
/** x distance of a step (project boundary, copy restart, gap): 0.1 % of the run, about a pixel. */
export const BOUNDARY_STEP = 0.001;
/** Room above the plotted peak when the y axis has to grow. */
const AXIS_HEADROOM = 1.15;
/** A bin with this many samples is calm enough to size the axis on its own. */
const SETTLED_BIN_SAMPLES = 5;
/**
 * The engine publishes its byte speed only after a short warm-up, so a copy phase reads 0 B/s at
 * first ("no reading yet"). A copy phase that still reads 0 after this long really moves no bytes
 * (only empty files, type conflicts, case renames): from then on 0 is drawn as 0.
 */
export const NO_READING_GRACE_MS = 1000;

export interface SpeedSample {
  /** Overall progress of the run, 0..1. */
  x: number;
  /**
   * Bytes per second (0 while deleting), or null when there is no reading yet (see `speedReading`):
   * the sample then moves the front and keeps the bookkeeping, but draws no point — the curve would
   * otherwise dip to 0 at the start of every project.
   */
  speed: number | null;
  /** Elapsed time of the current project (SyncProgress.elapsedMs); the history adds earlier projects. */
  elapsedMs: number;
  /** 0-based position of the project in the run. */
  projectIndex: number;
  /** Bytes transferred so far in the whole run (for the average speed). */
  doneBytes: number;
  /** The sample is from the copy phase (only those count toward the average speed). */
  copying: boolean;
  /** The sample is from the deletion phase (the copy phase after it restarts the curve). */
  deleting: boolean;
}

interface SpeedBin {
  xSum: number;
  speedSum: number;
  count: number;
  /** Run elapsed time of the bin's last sample. */
  elapsedMs: number;
  /** Project of the bin's samples (a bin never mixes projects). */
  project: number;
  /** The bin's last sample is from the deletion phase. */
  deleting: boolean;
}

export interface SpeedPoint {
  /** 0..1 */
  x: number;
  speed: number;
  /** Elapsed time of the run at that point. */
  elapsedMs: number;
  project: number;
  /** Drawing aid only (see `withLeadIn`): there was no reading here. */
  noReading?: boolean;
}

/** The span of a project that failed or was cancelled before it covered its share of the run. */
export interface SpeedGap {
  from: number;
  to: number;
  project: number;
}

export interface SpeedHistory {
  readonly bins: ReadonlyArray<SpeedBin | null>;
  /** Running maximum of x (the progress front). */
  readonly x: number;
  /** Last reading's speed (0 after a project failed). */
  readonly current: number;
  /** Project of the last reading (-1 before the first). */
  readonly currentProject: number;
  /** Highest sample speed. */
  readonly peak: number;
  /**
   * Highest speed the plotted curve has *settled* on — two consecutive finished bins of a project,
   * or one bin with several samples — so a one-sample spike never counts. Only grows.
   */
  readonly plotPeak: number;
  /**
   * Top of the chart's y axis (0 before any speed). Only grows, and only once the settled curve would
   * leave it — then to a nice value with ~15 % headroom — so the axis rescales rarely and never back.
   */
  readonly axisMax: number;
  /** Bin that is being filled (-1 before the first reading). */
  readonly openBin: number;
  /** Average and project of the last finished bin (for the two-bin rule of `plotPeak`). */
  readonly settledAvg: number | null;
  readonly settledProject: number;
  /** Bytes moved and milliseconds spent between consecutive copy-phase samples. */
  readonly copyBytes: number;
  readonly copyMs: number;
  /** x at which each project after the first started. */
  readonly boundaries: readonly number[];
  /** x at which a project's copy phase started after its deletion phase (at most one per project). */
  readonly restarts: readonly number[];
  /** Spans of failed or cancelled projects (drawn at speed 0). */
  readonly gaps: readonly SpeedGap[];
  readonly samples: number;
  /** Project of the last sample (-1 before the first). */
  readonly projectIndex: number;
  /** Elapsed time of the projects before the current one. */
  readonly elapsedOffsetMs: number;
  /** Project elapsed time of the current project's first copy-phase sample (null before it). */
  readonly copyStartMs: number | null;
  /** The current project's copy phase has had a speed reading. */
  readonly copyHasReading: boolean;
  readonly last: { elapsedMs: number; doneBytes: number; copying: boolean; deleting: boolean } | null;
}

export function createSpeedHistory(): SpeedHistory {
  return {
    bins: new Array<SpeedBin | null>(SPEED_BINS).fill(null),
    x: 0,
    current: 0,
    currentProject: -1,
    peak: 0,
    plotPeak: 0,
    axisMax: 0,
    openBin: -1,
    settledAvg: null,
    settledProject: -1,
    copyBytes: 0,
    copyMs: 0,
    boundaries: [],
    restarts: [],
    gaps: [],
    samples: 0,
    projectIndex: -1,
    elapsedOffsetMs: 0,
    copyStartMs: null,
    copyHasReading: false,
    last: null,
  };
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function finiteOr0(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * The speed to record for a progress event of project `projectIndex`: 0 while deleting (no bytes
 * move), the engine's speed when it has one, and null ("no reading yet") for a 0 early in a copy
 * phase — the engine publishes its speed only after a short warm-up. Once the copy phase has had a
 * reading, or has read 0 for NO_READING_GRACE_MS, a 0 is a real 0.
 */
export function speedReading(
  h: SpeedHistory,
  e: { phase: SyncPhase; bytesPerSec: number; elapsedMs: number; projectIndex: number },
): number | null {
  if (e.phase === "deleting") return 0;
  if (Number.isFinite(e.bytesPerSec) && e.bytesPerSec > 0) return e.bytesPerSec;
  if (e.phase !== "copying") return 0;
  const start = h.projectIndex === e.projectIndex ? h.copyStartMs : null;
  if (start != null && (h.copyHasReading || e.elapsedMs - start >= NO_READING_GRACE_MS)) return 0;
  return null;
}

/** The current speed belongs to the running project (not a previous one's held value) and is > 0. */
export function hasCurrentReading(h: SpeedHistory): boolean {
  return h.currentProject === h.projectIndex && h.current > 0;
}

/**
 * Moves the progress front without a speed sample: a project ended. `end` names it; when it was
 * aborted (failed or cancelled), the rest of its share of the run becomes a gap drawn at speed 0
 * instead of the previous speed stretched across it.
 */
export function advanceSpeedHistory(
  h: SpeedHistory,
  x: number,
  end?: { project: number; aborted: boolean },
): SpeedHistory {
  const nx = Math.max(h.x, clamp01(x));
  if (nx === h.x) return h;
  if (!end) return { ...h, x: nx };
  // A project that ended without a single event still started where the front was.
  let boundaries = h.boundaries;
  if (end.project > 0 && h.projectIndex !== end.project && h.x > 0 && !boundaries.includes(h.x)) {
    boundaries = [...boundaries, h.x];
  }
  if (!end.aborted || nx - h.x <= BOUNDARY_STEP) return { ...h, x: nx, boundaries };
  const switched = h.projectIndex !== end.project;
  return {
    ...h,
    x: nx,
    boundaries,
    gaps: [...h.gaps, { from: h.x, to: nx, project: end.project }],
    current: 0,
    // The next project's first sample then sees a new project and starts at the gap's end.
    projectIndex: end.project,
    elapsedOffsetMs: switched && h.last ? h.elapsedOffsetMs + h.last.elapsedMs : h.elapsedOffsetMs,
    last: switched ? null : h.last,
    copyStartMs: switched ? null : h.copyStartMs,
    copyHasReading: switched ? false : h.copyHasReading,
  };
}

export function addSpeedSample(h: SpeedHistory, s: SpeedSample): SpeedHistory {
  const speed = s.speed == null ? null : finiteOr0(s.speed);
  const elapsed = finiteOr0(s.elapsedMs);
  const newProject = s.projectIndex !== h.projectIndex;

  // A project after the first starts where the front is now.
  let boundaries = h.boundaries;
  if (newProject && s.projectIndex > Math.max(h.projectIndex, 0) && h.x > 0 && !h.boundaries.includes(h.x)) {
    boundaries = [...h.boundaries, h.x];
  }
  // The copy phase after a deletion phase starts where the front is now.
  let restarts = h.restarts;
  if (!newProject && h.last?.deleting && s.copying && !h.restarts.includes(h.x)) {
    restarts = [...h.restarts, h.x];
  }
  // Earlier projects' time counts toward the run's elapsed time.
  const elapsedOffsetMs = newProject && h.last ? h.elapsedOffsetMs + h.last.elapsedMs : h.elapsedOffsetMs;
  const runElapsed = elapsedOffsetMs + elapsed;

  // Average speed: bytes over time, between consecutive copy-phase samples of the same project.
  let { copyBytes, copyMs } = h;
  if (!newProject && h.last && h.last.copying && s.copying) {
    const dt = elapsed - h.last.elapsedMs;
    const db = s.doneBytes - h.last.doneBytes;
    if (dt > 0) {
      copyMs += dt;
      copyBytes += Math.max(0, db);
    }
  }

  const x = Math.max(h.x, clamp01(s.x));
  let { bins, plotPeak, openBin, settledAvg, settledProject } = h;
  if (speed != null) {
    let i = Math.min(SPEED_BINS - 1, Math.floor(x * SPEED_BINS));
    // A bin never mixes two projects, nor a project's deletion zeros with its first copy reading
    // (either would smear the step): skip past such slots. A project whose whole span fits inside
    // one bin was itself moved forward, so several hops may be needed. x stays monotonic, so every
    // slot after the last occupied one is free. (At the last bin, merging is unavoidable.)
    while (i < SPEED_BINS - 1) {
      const b = h.bins[i];
      if (!b || (b.project === s.projectIndex && !(b.deleting && !s.deleting && speed > 0))) break;
      i++;
    }

    // The previous bin is finished: the curve has settled on a level when two finished bins in a
    // row of the same project show it (one-sample spikes never size the axis).
    if (openBin >= 0 && i !== openBin) {
      const done = h.bins[openBin];
      if (done) {
        const avg = done.speedSum / done.count;
        if (settledAvg != null && settledProject === done.project) plotPeak = Math.max(plotPeak, Math.min(avg, settledAvg));
        settledAvg = avg;
        settledProject = done.project;
      }
    }
    openBin = i;

    const prev = h.bins[i];
    const bin: SpeedBin = {
      xSum: (prev?.xSum ?? 0) + x,
      speedSum: (prev?.speedSum ?? 0) + speed,
      count: (prev?.count ?? 0) + 1,
      elapsedMs: runElapsed,
      project: s.projectIndex,
      deleting: s.deleting,
    };
    const next = h.bins.slice();
    next[i] = bin;
    bins = next;
    const binAvg = bin.speedSum / bin.count;
    // A bin with several samples is an average, not a spike. And the first reading sets the
    // initial scale (once), so the axis is not empty at the start.
    if (bin.count >= SETTLED_BIN_SAMPLES || plotPeak === 0) plotPeak = Math.max(plotPeak, binAvg);
  }

  const copyStartMs = s.copying
    ? newProject || h.copyStartMs == null
      ? elapsed
      : h.copyStartMs
    : newProject
      ? null
      : h.copyStartMs;

  return {
    bins,
    x,
    // No reading yet: the last known speed holds (as the copy dialog of Windows does).
    current: speed ?? h.current,
    currentProject: speed != null ? s.projectIndex : h.currentProject,
    peak: Math.max(h.peak, speed ?? 0),
    plotPeak,
    axisMax: plotPeak > h.axisMax ? niceSpeedMax(plotPeak * AXIS_HEADROOM) : h.axisMax,
    openBin,
    settledAvg,
    settledProject,
    copyBytes,
    copyMs,
    boundaries,
    restarts,
    gaps: h.gaps,
    samples: h.samples + 1,
    projectIndex: s.projectIndex,
    elapsedOffsetMs,
    copyStartMs,
    copyHasReading: (!newProject && h.copyHasReading) || (s.copying && speed != null),
    last: { elapsedMs: elapsed, doneBytes: s.doneBytes, copying: s.copying, deleting: s.deleting },
  };
}

/** Average copy speed (bytes/s) of the run so far, or null while there is too little data. */
export function averageSpeed(h: SpeedHistory): number | null {
  return h.copyMs >= 500 ? (h.copyBytes / h.copyMs) * 1000 : null;
}

/** Elapsed time of the run at the last sample. */
export function runElapsedMs(h: SpeedHistory): number {
  return h.elapsedOffsetMs + (h.last?.elapsedMs ?? 0);
}

/**
 * The first of `edges` within [from, to], or -1. (The next project's own boundary can sit on `to`
 * when its first sample was at the front; after a gap, `from` is the gap's end, past the boundary
 * where the gap began.)
 */
function firstEdge(edges: readonly number[], from: number, to: number): number {
  let edge = -1;
  for (const x of edges) if (x >= from && x <= to && (edge < 0 || x < edge)) edge = x;
  return edge;
}

/**
 * The chart series: one point per non-empty bin (at the mean x of its samples), plus a live point
 * at the front with the current speed so the curve ends exactly at the progress front.
 *
 * Changes are drawn as steps, not as slopes across x values that had no reading:
 * - where a project starts, the previous project's last speed holds up to the boundary and the next
 *   project's first speed starts on it;
 * - where a project's copy phase starts after its deletion phase (speed 0), the first measured
 *   speed starts at the copy start;
 * - the span of a failed or cancelled project is drawn at speed 0 (a gap).
 */
export function speedPoints(h: SpeedHistory): SpeedPoint[] {
  const points: SpeedPoint[] = [];
  let g = 0;
  /** Draws the gaps that end at or before `x` (all remaining ones when `trailing`). */
  const drawGaps = (x: number, trailing: boolean) => {
    while (g < h.gaps.length && (trailing || h.gaps[g].to <= x + BOUNDARY_STEP)) {
      const gap = h.gaps[g++];
      const prev = points[points.length - 1];
      // The last speed holds up to the gap, then drops to 0 across it.
      if (prev && gap.from - prev.x > BOUNDARY_STEP) points.push({ ...prev, x: gap.from });
      const before = points[points.length - 1];
      const elapsedMs = before?.elapsedMs ?? 0;
      const startX = before ? before.x + BOUNDARY_STEP : gap.from;
      // A gap at the very end runs up to the front; otherwise the next project steps up at its end.
      const endX = trailing && g === h.gaps.length ? gap.to : gap.to - BOUNDARY_STEP;
      points.push({ x: startX, speed: 0, elapsedMs, project: gap.project });
      if (endX - startX > BOUNDARY_STEP) points.push({ x: endX, speed: 0, elapsedMs, project: gap.project });
    }
  };

  for (const b of h.bins) {
    if (!b) continue;
    const p: SpeedPoint = { x: b.xSum / b.count, speed: b.speedSum / b.count, elapsedMs: b.elapsedMs, project: b.project };
    drawGaps(p.x, false);
    const prev = points[points.length - 1];
    if (prev) {
      const projectChange = prev.project !== p.project;
      const restart = !projectChange && prev.speed === 0 && p.speed > 0;
      if (projectChange || restart) {
        // The edge between the two points (the previous project's last samples — finalizing — and
        // the deletion's last samples often sit exactly on it).
        const edge = firstEdge(projectChange ? h.boundaries : h.restarts, prev.x, p.x);
        if (edge >= 0) {
          // The old speed holds until just before the edge, the new one starts on it: a crisp step.
          const holdX = edge - BOUNDARY_STEP;
          if (holdX - prev.x > BOUNDARY_STEP) points.push({ ...prev, x: holdX });
          const leadX = Math.max(edge, prev.x + BOUNDARY_STEP);
          if (p.x - leadX > BOUNDARY_STEP) points.push({ ...p, x: leadX });
        }
      }
    }
    points.push(p);
  }

  const trailingGaps = g < h.gaps.length;
  drawGaps(h.x, true);
  const last = points[points.length - 1];
  if (!last) return points;
  if (h.x > last.x) {
    points.push({ x: h.x, speed: h.current, elapsedMs: last.elapsedMs, project: last.project });
  } else if (!trailingGaps) {
    // The front is inside the last bin's mean: show the latest speed at the end. (A trailing gap
    // already ends at the front.)
    points[points.length - 1] = { ...last, speed: h.current };
  }
  return points;
}

/**
 * The first reading also stands for x = 0 only when it arrived this close to the start (about two
 * bins): it closes the sliver at the plot's left edge, but never paints one value across a stretch
 * of the run that had no reading.
 */
export const LEAD_IN_MAX_X = 2 / SPEED_BINS;

/**
 * The series as drawn: `points` with a lead-in to x = 0 when the first point is close to it.
 * Otherwise the curve rises from the baseline at the first reading (a zero-height anchor marked
 * `noReading`, so the tooltip does not claim a speed of 0 there) instead of the area starting with
 * a cut-off edge.
 */
export function withLeadIn(points: readonly SpeedPoint[]): SpeedPoint[] {
  const first = points[0];
  if (!first || first.x <= 0) return [...points];
  if (first.x <= LEAD_IN_MAX_X) return [{ ...first, x: 0 }, ...points];
  if (first.speed <= 0) return [...points];
  return [{ ...first, x: first.x - 1e-6, speed: 0, noReading: true }, ...points];
}

/** The highest plotted point (what the curve shows), or null without samples. */
export function peakPoint(points: readonly SpeedPoint[]): SpeedPoint | null {
  let best: SpeedPoint | null = null;
  for (const p of points) if (!best || p.speed > best.speed) best = p;
  return best && best.speed > 0 ? best : null;
}

const KB = 1024;
const STEPS = [
  1, 1.2, 1.6, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 30, 40, 50, 60, 80, 100, 120, 160, 200, 300, 400, 500, 600, 800,
];

/**
 * A "nice" axis maximum ≥ v whose half is nice as well (1/1.2/1.6/2/3/4/5/6/8 × 10ⁿ in the binary
 * unit that fits v), e.g. 870 MB/s → 1 GB/s, 130 MB/s → 160 MB/s, 1.1 GB/s → 1.2 GB/s. 1 MB/s for
 * nothing.
 */
export function niceSpeedMax(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return KB * KB;
  let unit = 1;
  while (v >= 1000 * unit && unit < KB ** 5) unit *= KB;
  const scaled = v / unit;
  for (const s of STEPS) if (s >= scaled) return s * unit;
  return unit * KB; // 800 < scaled < 1000: the next unit's 1
}

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];
const tickFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/**
 * Axis tick label in the axis' unit (the unit of `max`), e.g. ticks of a 1 GB/s axis:
 * "0", "0.5 GB/s", "1 GB/s".
 */
export function formatSpeedTick(value: number, max: number): string {
  if (value <= 0) return "0";
  let unit = 0;
  while (max >= 1000 * KB ** unit && unit < UNITS.length - 1) unit++;
  return `${tickFormat.format(value / KB ** unit)} ${UNITS[unit]}/s`;
}
