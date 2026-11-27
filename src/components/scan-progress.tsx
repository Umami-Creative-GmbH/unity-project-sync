import { useEffect, useState, type ReactNode } from "react";
import { IconBolt, IconSearch } from "@tabler/icons-react";

import { Card, CardContent } from "@/components/ui/card";
import { formatCount, formatSeconds } from "@/lib/format";
import type { ScanProgress } from "@/lib/types";

const PHASE_LABEL: Record<ScanProgress["phase"], string> = {
  source: "Scanning source…",
  target: "Scanning target…",
  compare: "Comparing…",
};

const PHASES: ScanProgress["phase"][] = ["source", "target", "compare"];

interface ScanProgressViewProps {
  progress: ScanProgress | null;
  startedAt: number;
  autoSync: boolean;
  cancelling: boolean;
  /** Line above the phase title, e.g. "Project 2 of 5 · MyGame". */
  context?: ReactNode;
}

/** Progress of the running scan (Cancel lives in the app's action footer). */
export function ScanProgressView({ progress, startedAt, autoSync, cancelling, context }: ScanProgressViewProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);

  const phase = progress?.phase ?? "source";
  const phaseIndex = PHASES.indexOf(phase);

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 py-4">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
            {autoSync ? <IconBolt className="size-5" /> : <IconSearch className="size-5" />}
          </div>
          <div className="min-w-0 flex-1">
            {context && <div className="truncate text-xs font-medium text-muted-foreground">{context}</div>}
            <h2 className="text-base font-medium">{cancelling ? "Cancelling…" : PHASE_LABEL[phase]}</h2>
            {/* No aria-live: it would announce the elapsed time every 500 ms (the app announces phases). */}
            <p className="text-sm text-muted-foreground">
              {progress ? `${formatCount(progress.entries)} entries` : "Starting…"}
              <span className="mx-1.5">·</span>
              {formatSeconds((now - startedAt) / 1000)} elapsed
            </p>
          </div>
        </div>

        <div
          className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label="Scanning"
          aria-busy="true"
        >
          <div className="absolute inset-y-0 left-0 w-1/3 animate-indeterminate rounded-full bg-primary" />
        </div>

        <ol className="grid grid-cols-3 gap-2 text-xs">
          {PHASES.map((p, i) => (
            <li
              key={p}
              className={
                i < phaseIndex
                  ? "text-foreground"
                  : i === phaseIndex
                    ? "font-medium text-foreground"
                    : "text-muted-foreground"
              }
            >
              <div
                className={`mb-1.5 h-0.5 rounded-full ${i <= phaseIndex ? "bg-primary" : "bg-muted"}`}
              />
              {i + 1}. {p === "source" ? "Source" : p === "target" ? "Target" : "Compare"}
            </li>
          ))}
        </ol>

        {autoSync && (
          <p className="text-xs text-muted-foreground">
            Sync now: syncing starts automatically as soon as the scans finish — no preview.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
