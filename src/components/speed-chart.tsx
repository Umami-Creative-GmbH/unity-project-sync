import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Area, AreaChart, XAxis, YAxis } from "recharts";

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { formatDuration, formatSpeed } from "@/lib/format";
import {
  averageSpeed,
  formatSpeedTick,
  hasCurrentReading,
  niceSpeedMax,
  peakPoint,
  speedPoints,
  withLeadIn,
  type SpeedHistory,
  type SpeedPoint,
} from "@/lib/speed-history";
import { cn } from "@/lib/utils";

const chartConfig = {
  speed: { label: "Speed", color: "var(--chart-speed)" },
} satisfies ChartConfig;

/** Room the speed label pill needs at the right edge of the plot. */
const PILL_ROOM_PX = 150;
/** Approximate width of the "Speed 412 MB/s" pill. */
const PILL_WIDTH_PX = 120;
/** Gap between the progress front and the pill when the pill sits beside the front. */
const PILL_FRONT_GAP_PX = 8;
/** Approximate width of the "Peak 1.2 GB/s" label. */
const PEAK_LABEL_PX = 96;
/** Speed 0 sits this far above the plot's bottom edge, so the 2px stroke is not cut by the clip. */
const BASELINE_INSET_PX = 3;

interface SpeedChartProps {
  history: SpeedHistory;
  /** Progress front, 0..1 (≥ history.x). */
  front: number;
  /** Project names by run position, for the tooltip of a batch; null for a single project. */
  projectNames: readonly string[] | null;
  /** The speed is meaningless right now (deleting): no current-speed line or label. */
  speedIdle: boolean;
  /** "42 %, 412 MB/s, about 2 min left" */
  valueText: string;
  className?: string;
}

interface ChartPoint extends SpeedPoint {
  /** x in percent, 0..100 */
  pct: number;
}

/** Keyboard selection: following the live front, or a fixed place in the run. */
type KbSel = null | { follow: true } | { follow: false; x: number; project: number };

/** Index of the point nearest to `x`; on a tie (a vertical step) the one of `project`. */
function nearestIndex(points: readonly ChartPoint[], x: number, project: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = Math.abs(points[i].x - x);
    if (d < bestD || (d === bestD && points[i].project === project && points[best].project !== project)) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

/**
 * The progress bar of the transfer card: speed (y) over overall progress (x, fixed 0..100 %), with
 * the not-yet-done remainder as a quiet track. Live data — no recharts animation.
 */
export function SpeedChart({ history, front, projectNames, speedIdle, valueText, className }: SpeedChartProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const gradientId = `speed-fill-${uid}`;
  const [plotRef, { width: plotWidth, height: plotHeight }] = useElementSize<HTMLDivElement>();
  const [kbSel, setKbSel] = useState<KbSel>(null);

  const raw = useMemo(() => speedPoints(history), [history]);
  const points = useMemo<ChartPoint[]>(() => withLeadIn(raw).map((p) => ({ ...p, pct: p.x * 100 })), [raw]);
  // The peak of the real points (the lead-in copy at x = 0 would hide a startup peak).
  const peak = useMemo(() => peakPoint(raw), [raw]);
  // Grows only when the settled curve would leave it, never back down (see SpeedHistory.axisMax).
  // A momentary reading above it is clamped to the top edge.
  const yMax = history.axisMax > 0 ? history.axisMax : niceSpeedMax(0);
  // Speed 0 is lifted a few pixels off the plot's bottom edge: the domain extends below 0, and every
  // HTML overlay goes through the same mapping (yPct).
  const yMin = plotHeight > BASELINE_INSET_PX ? -(yMax * BASELINE_INSET_PX) / (plotHeight - BASELINE_INSET_PX) : 0;
  const yPct = (v: number) => Math.min(100, Math.max(0, ((v - yMin) / (yMax - yMin)) * 100));
  const hasData = points.length > 0;
  const hasSpeed = history.axisMax > 0;
  const avg = averageSpeed(history);
  const frontPct = Math.min(100, Math.max(0, front * 100));
  const end = points[points.length - 1] ?? null;
  const curY = yPct(history.current);
  const showCurrent = hasData && hasSpeed && !speedIdle && hasCurrentReading(history);

  // The label pill sits on the current-speed line at the right edge, unless the front (and its dot)
  // is there: then it moves above the line (below when there is no room above), on the done side of
  // the front so it never covers the front line or the end dot.
  const frontPx = (frontPct / 100) * plotWidth;
  const roomAbovePx = (1 - curY / 100) * plotHeight;
  const pillMode = plotWidth - frontPx > PILL_ROOM_PX ? "tag" : roomAbovePx >= 34 ? "above" : "below";

  const ticks = [0, yMax / 2, yMax];

  // "Peak" marker: only when it says something — a real spike, clearly above the average and the
  // current speed, not a plateau (on one it would mark an arbitrary spot) — away from the front and
  // the label.
  const peakPx = peak ? peak.x * plotWidth : 0;
  const peakLeftAligned = peakPx < PEAK_LABEL_PX / 2 + 4;
  const peakDotBottom = peak ? (yPct(peak.speed) / 100) * plotHeight : 0;
  // Above the dot inside the plot, or — when it would cross the plot's top edge — just above the plot.
  const peakLabelBottom = peakDotBottom + 8 + 11 <= plotHeight ? peakDotBottom + 8 : plotHeight + 4;
  const plateau = !!peak && raw.filter((p) => p.speed >= peak.speed * 0.97).length > raw.length * 0.15;
  const showPeak =
    !!peak &&
    plotWidth > 0 &&
    avg != null &&
    !plateau &&
    peak.speed > avg * 1.25 &&
    peak.speed > history.current * 1.08 &&
    peakPx < plotWidth - PILL_ROOM_PX &&
    frontPx - peakPx > (pillMode === "tag" ? 64 : PILL_FRONT_GAP_PX + PILL_WIDTH_PX + PEAK_LABEL_PX / 2);

  // The keyboard selection is a place in the run, resolved against the current points on every
  // render (the array is rebuilt ~10×/s and its indices shift); End follows the live front.
  const kbIndex =
    kbSel == null || points.length === 0
      ? null
      : kbSel.follow
        ? points.length - 1
        : nearestIndex(points, kbSel.x, kbSel.project);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (points.length === 0) return;
    const lastIdx = points.length - 1;
    const step = e.shiftKey ? 10 : 1;
    const select = (t: number) =>
      setKbSel(t >= lastIdx ? { follow: true } : { follow: false, x: points[t].x, project: points[t].project });
    if (e.key === "ArrowLeft") select(Math.max(0, (kbIndex ?? lastIdx + 1) - step));
    else if (e.key === "ArrowRight") select(Math.min(lastIdx, (kbIndex ?? lastIdx) + step));
    else if (e.key === "Home") select(0);
    else if (e.key === "End") setKbSel({ follow: true });
    else if (e.key === "Escape") setKbSel(() => null);
    else return;
    e.preventDefault();
  };

  return (
    // Tick labels live in a gutter left of the plot (centred on their gridlines), so the curve and
    // the current-speed line never run through them. The top and bottom labels overhang the plot by
    // half a line; the caller's padding leaves room for that.
    <div className={cn("relative flex", className)}>
      <div aria-hidden className="relative w-14 shrink-0 text-[10px] leading-none">
        {hasSpeed &&
          ticks.map((t, i) => (
            <span
              key={i}
              className="absolute right-2 translate-y-1/2 whitespace-nowrap text-muted-foreground tabular-nums"
              style={{ bottom: `${yPct(t)}%` }}
            >
              {formatSpeedTick(t, yMax)}
            </span>
          ))}
      </div>
      <div
        ref={plotRef}
        role="progressbar"
        aria-label="Sync progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.floor(frontPct)}
        aria-valuetext={valueText}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={() => setKbSel(null)}
        // The pointer takes over from the keyboard.
        onPointerMove={() => kbSel != null && setKbSel(null)}
        className="group/plot relative h-[140px] min-w-0 flex-1 rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [@media(max-height:619px)]:h-[112px]"
      >
        {/* Track: the done part carries a faint accent wash, the remainder is a quieter track (in
            dark mode a step below the done wash, so the bar never reads inverted). */}
        <div
          aria-hidden
          className="absolute inset-0 overflow-hidden rounded-lg dark:ring-1 dark:ring-foreground/[0.06] dark:ring-inset"
        >
          <div
            className="absolute inset-y-0 left-0 bg-chart-speed/[0.06] dark:bg-chart-speed/[0.12]"
            style={{ width: `${frontPct}%` }}
          />
          <div
            className="absolute inset-y-0 right-0 bg-muted dark:bg-foreground/[0.03]"
            style={{ left: `${frontPct}%` }}
          />
          {!hasData && (
            <div className="absolute inset-0 overflow-hidden motion-reduce:hidden">
              <div className="h-full w-1/2 animate-shimmer bg-linear-to-r from-transparent via-foreground/[0.05] to-transparent" />
            </div>
          )}
          {hasData &&
            ticks.map((t, i) => (
              <div
                key={i}
                className="absolute inset-x-0 h-px bg-foreground/[0.07]"
                style={i === ticks.length - 1 ? { top: 0 } : { bottom: `${yPct(t)}%` }}
              />
            ))}
          {history.boundaries.map((b) => (
            <div key={b} className="absolute inset-y-0 w-px bg-foreground/15" style={{ left: `${b * 100}%` }} />
          ))}
        </div>

        <ChartContainer
          config={chartConfig}
          aria-hidden
          className="absolute inset-0 aspect-auto h-full w-full [&_.recharts-surface]:[clip-path:inset(0_round_var(--radius-lg))] [&_.recharts-tooltip-wrapper]:z-20"
          initialDimension={{ width: 640, height: 140 }}
        >
          <AreaChart
            // recharts honours the tooltip's defaultIndex only until the pointer has hovered the
            // chart once; a fresh chart for keyboard mode lets the arrow keys drive it after a hover.
            key={kbIndex == null ? "pointer" : "keyboard"}
            data={points}
            margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
            accessibilityLayer={false}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-speed)" stopOpacity={0.22} />
                <stop offset="100%" stopColor="var(--color-speed)" stopOpacity={0.03} />
              </linearGradient>
            </defs>
            <XAxis dataKey="pct" type="number" domain={[0, 100]} allowDataOverflow hide />
            {/* The domain reaches below 0 (BASELINE_INSET_PX); the area's base stays at 0. */}
            <YAxis type="number" domain={[yMin, yMax]} allowDataOverflow hide />
            <ChartTooltip
              isAnimationActive={false}
              defaultIndex={kbIndex ?? undefined}
              offset={14}
              cursor={<Crosshair />}
              content={
                <ChartTooltipContent
                  className="min-w-40 bg-popover"
                  labelFormatter={(_, payload) => {
                    const p = payload?.[0]?.payload as ChartPoint | undefined;
                    return p ? `${Math.floor(p.pct)}% done` : null;
                  }}
                  formatter={(_value, _name, item) => (
                    <TooltipRows point={item.payload as ChartPoint} projectNames={projectNames} />
                  )}
                />
              }
            />
            <Area
              dataKey="speed"
              type="monotone"
              baseValue={0}
              stroke="var(--color-speed)"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              fill={`url(#${gradientId})`}
              fillOpacity={1}
              isAnimationActive={false}
              dot={false}
              activeDot={{ r: 4, fill: "var(--color-speed)", stroke: "var(--card)", strokeWidth: 2 }}
            />
          </AreaChart>
        </ChartContainer>

        {/* Live annotations (clipped to the plot): progress front and current-speed line. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg">
          {hasData && frontPct > 0 && (
            <div
              className="absolute inset-y-0 w-px -translate-x-1/2 bg-chart-speed/80"
              style={{ left: `${frontPct}%` }}
            />
          )}
          {showCurrent && (
            <div className="absolute inset-x-0 h-px bg-foreground/25" style={{ bottom: `${curY}%` }} />
          )}
        </div>

        {/* Unclipped annotations: end dot, peak marker, speed label. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 z-10 text-[10px] leading-none">
          {showPeak && peak && (
            <div
              className="absolute"
              // The dot stays inside the plot at its left edge (never in the tick gutter).
              style={{ left: `max(${peak.x * 100}%, 4px)`, bottom: `${yPct(peak.speed)}%` }}
            >
              <span className="absolute size-[7px] -translate-x-1/2 translate-y-1/2 rounded-full border-[1.5px] border-chart-speed bg-card" />
              <span
                style={{ bottom: peakLabelBottom - peakDotBottom }}
                className={cn(
                  "absolute whitespace-nowrap text-muted-foreground tabular-nums [text-shadow:0_0_3px_var(--color-card),0_0_2px_var(--color-card)]",
                  peakLeftAligned ? "-left-1" : "-translate-x-1/2",
                )}
              >
                Peak <span className="font-medium text-foreground/80">{formatSpeed(peak.speed)}</span>
              </span>
            </div>
          )}

          {end && (
            <span
              className="absolute size-2.5 -translate-x-1/2 translate-y-1/2"
              style={{ left: `${end.x * 100}%`, bottom: `${yPct(end.speed)}%` }}
            >
              {!speedIdle && (
                <span className="absolute inset-0 animate-speed-pulse rounded-full bg-chart-speed motion-reduce:hidden" />
              )}
              <span className="absolute inset-0 rounded-full bg-chart-speed ring-2 ring-card" />
            </span>
          )}

          {showCurrent && (
            <span
              className={cn(
                "absolute flex h-5 items-center gap-1 rounded-full bg-card px-2 text-[11px] whitespace-nowrap shadow-xs ring-1 ring-foreground/10",
                pillMode === "tag" ? "right-1.5 -translate-y-1/2" : undefined,
              )}
              style={
                pillMode === "tag"
                  ? { top: `clamp(10px, ${100 - curY}%, calc(100% - 10px))` }
                  : {
                      // Beside the front on its done side: the front line and the end dot stay clear.
                      right: `calc(${100 - frontPct}% + ${PILL_FRONT_GAP_PX}px)`,
                      ...(pillMode === "above"
                        ? { bottom: `calc(${curY}% + 10px)` }
                        : { top: `calc(${100 - curY}% + 10px)` }),
                    }
              }
            >
              <span className="text-muted-foreground">Speed</span>
              <span className="font-medium text-foreground tabular-nums">{formatSpeed(history.current)}</span>
            </span>
          )}

          {!hasData && (
            <span className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
              Preparing…
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function TooltipRows({ point, projectNames }: { point: ChartPoint; projectNames: readonly string[] | null }) {
  const name = projectNames?.[point.project];
  return (
    <div className="grid w-full grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <span className="h-0.5 w-2.5 rounded-full bg-(--color-speed)" />
        Speed
      </span>
      <span className="text-right font-medium text-foreground tabular-nums">
        {point.noReading ? "—" : formatSpeed(point.speed)}
      </span>
      <span className="pl-4 text-muted-foreground">Elapsed</span>
      <span className="text-right text-foreground tabular-nums">{formatDuration(point.elapsedMs)}</span>
      {name && (
        <>
          <span className="pl-4 text-muted-foreground">Project</span>
          <span className="max-w-40 truncate text-right text-foreground">{name}</span>
        </>
      )}
    </div>
  );
}

/** Crosshair of the tooltip: a hairline across the plot at the hovered x. */
function Crosshair({ points, height }: { points?: { x: number; y: number }[]; height?: number }) {
  const x = points?.[0]?.x;
  if (x == null) return null;
  return (
    <line
      x1={x}
      x2={x}
      y1={points?.[0]?.y ?? 0}
      y2={points?.[1]?.y ?? height ?? 0}
      stroke="var(--muted-foreground)"
      strokeOpacity={0.55}
      strokeWidth={1}
      shapeRendering="crispEdges"
    />
  );
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = (width: number, height: number) =>
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    const r = el.getBoundingClientRect();
    update(r.width, r.height);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => update(entries[0].contentRect.width, entries[0].contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}
