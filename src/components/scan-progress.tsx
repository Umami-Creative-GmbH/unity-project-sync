import { useEffect, useState } from "react";
import { IconBolt, IconLoader2, IconSearch, IconX } from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
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
  onCancel: () => void;
}

export function ScanProgressView({ progress, startedAt, autoSync, cancelling, onCancel }: ScanProgressViewProps) {
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
            <h2 className="text-base font-medium">{cancelling ? "Cancelling…" : PHASE_LABEL[phase]}</h2>
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {progress ? `${formatCount(progress.entries)} entries` : "Starting…"}
              <span className="mx-1.5">·</span>
              {formatSeconds((now - startedAt) / 1000)} elapsed
            </p>
          </div>
          <Button variant="outline" onClick={onCancel} disabled={cancelling}>
            {cancelling ? <IconLoader2 className="animate-spin" data-icon="inline-start" /> : <IconX data-icon="inline-start" />}
            Cancel
          </Button>
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
            Sync now: the sync starts automatically as soon as the scan finishes — no preview.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
