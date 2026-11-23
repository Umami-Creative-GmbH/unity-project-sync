import type { ReactNode } from "react";
import {
  IconAlertTriangle,
  IconCopy,
  IconFile,
  IconLoader2,
  IconSparkles,
  IconTrash,
  IconX,
} from "@tabler/icons-react";

import { ShutdownSwitch } from "@/components/shutdown-switch";
import { SpeedChart } from "@/components/speed-chart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatBytes, formatCount, formatDuration, formatEta, formatSpeed, plural } from "@/lib/format";
import { averageSpeed, hasCurrentReading, runElapsedMs, type SpeedHistory } from "@/lib/speed-history";
import type { SyncPhase, SyncProgress } from "@/lib/types";
import { cn } from "@/lib/utils";

const PHASE: Record<SyncPhase, { label: string; icon: ReactNode }> = {
  deleting: { label: "Deleting…", icon: <IconTrash className="size-4" /> },
  copying: { label: "Copying…", icon: <IconCopy className="size-4" /> },
  finalizing: { label: "Finalizing…", icon: <IconSparkles className="size-4" /> },
};

export interface TransferCardProps {
  /** Overall progress of the run, 0..1 (monotonic). */
  fraction: number;
  history: SpeedHistory;
  /** Latest progress of the project that is running, if any. */
  progress: SyncProgress | null;
  doneBytes: number;
  totalBytes: number;
  doneFiles: number;
  totalFiles: number;
  etaSecs: number | null;
  /** Errors of the whole run so far. */
  errors: number;
  cancelling: boolean;
  /** Name of the running project. */
  projectName: string | null;
  /** Batch of several projects: position of the running one. */
  batch: { position: number; count: number; names: readonly string[] } | null;
  onCancel: () => void;
  cancelLabel: string;
  shutdownAfter: boolean;
  onShutdownAfterChange: (v: boolean) => void;
  shutdownSwitchId: string;
}

/**
 * KPI card of a running sync, Windows copy-dialog style: the speed chart *is* the progress bar,
 * with the hero percentage above and the key numbers below.
 */
export function TransferCard(props: TransferCardProps) {
  const { fraction, history, progress, cancelling, batch, projectName, errors } = props;
  const pct = Math.floor(Math.min(1, Math.max(0, fraction)) * 100);
  const phase = progress ? PHASE[progress.phase] : null;
  const deleting = progress?.phase === "deleting" && progress.deleteTotal > 0;
  const avg = averageSpeed(history);
  const elapsed = runElapsedMs(history);
  // Only the running project's own reading (never a previous project's held speed).
  const speedText = progress && !deleting && hasCurrentReading(history) ? formatSpeed(history.current) : null;
  const etaText = props.etaSecs == null ? null : formatEta(props.etaSecs);
  const valueText = [`${pct} %`, speedText, etaText ? `about ${etaText} left` : "estimating time left"]
    .filter(Boolean)
    .join(", ");

  return (
    <Card className="@container gap-0 py-0">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 px-4 pt-4">
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
            {cancelling ? (
              <IconLoader2 className="size-4 shrink-0 animate-spin" />
            ) : phase ? (
              <span className="flex shrink-0">{phase.icon}</span>
            ) : (
              <IconLoader2 className="size-4 shrink-0 animate-spin" />
            )}
            <span className="min-w-0 truncate">
              {cancelling ? "Cancelling…" : phase ? phase.label : projectName ? "Preparing…" : "Finishing…"}
              {batch && (
                <>
                  <Dot />
                  Project {batch.position} of {batch.count}
                </>
              )}
              {projectName && (
                <>
                  <Dot />
                  <span className="font-medium text-foreground">{projectName}</span>
                </>
              )}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-3">
            {/* Hero figure: same sans, proportional figures. */}
            <div className="text-5xl leading-none font-semibold tracking-tight" aria-live="off">
              {pct}
              <span className="ml-0.5 text-3xl font-medium text-muted-foreground">%</span>
            </div>
            {errors > 0 && (
              <Badge variant="destructive" className="self-end">
                <IconAlertTriangle data-icon="inline-start" />
                {plural(errors, "error")}
              </Badge>
            )}
          </div>
        </div>
        {/* "Shut down after" next to Cancel: always on screen during the run. */}
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <ShutdownSwitch
            id={props.shutdownSwitchId}
            compact
            checked={props.shutdownAfter}
            onCheckedChange={props.onShutdownAfterChange}
          />
          <Button variant="outline" onClick={props.onCancel} disabled={cancelling} aria-label={props.cancelLabel}>
            <IconX data-icon="inline-start" />
            Cancel
          </Button>
        </div>
      </div>

      <SpeedChart
        className="px-4 pt-6"
        history={history}
        front={fraction}
        projectNames={batch?.names ?? null}
        speedIdle={!progress || deleting || progress.phase === "finalizing"}
        valueText={valueText}
      />

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 pt-4 pb-4 @min-[560px]:grid-cols-4">
        <Stat
          label={
            <>
              <span aria-hidden className="h-0.5 w-2.5 rounded-full bg-chart-speed" />
              Speed
            </>
          }
          value={speedText ?? "—"}
          sub={avg != null ? `avg ${formatSpeed(avg)}` : "avg —"}
        />
        <Stat label="Transferred" value={formatBytes(props.doneBytes)} sub={`of ${formatBytes(props.totalBytes)}`} />
        {deleting && progress ? (
          <Stat
            label="Deleted items"
            value={formatCount(Math.min(progress.deleteDone, progress.deleteTotal))}
            sub={`of ${formatCount(progress.deleteTotal)}`}
          />
        ) : (
          <Stat label="Files" value={formatCount(props.doneFiles)} sub={`of ${formatCount(props.totalFiles)}`} />
        )}
        <Stat
          label="Time left"
          value={etaText ?? "Estimating…"}
          valueClassName={etaText ? undefined : "text-muted-foreground"}
          sub={history.samples > 0 ? `elapsed ${formatDuration(elapsed)}` : "elapsed —"}
        />
      </dl>

      <div className="flex h-9 min-w-0 items-center gap-2 border-t bg-muted/40 px-4 text-xs text-muted-foreground">
        <IconFile className="size-3.5 shrink-0" />
        {progress?.currentFile ? (
          <span className="min-w-0 truncate font-mono" title={progress.currentFile}>
            {progress.currentFile}
          </span>
        ) : (
          <span>—</span>
        )}
      </div>
    </Card>
  );
}

function Dot() {
  return (
    <span aria-hidden className="px-1.5 text-muted-foreground/50">
      ·
    </span>
  );
}

function Stat({
  label,
  value,
  sub,
  valueClassName,
}: {
  label: ReactNode;
  value: ReactNode;
  sub: ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-1 truncate text-base leading-tight font-medium tabular-nums", valueClassName)}>{value}</dd>
      <dd className="mt-0.5 truncate text-xs text-muted-foreground tabular-nums">{sub}</dd>
    </div>
  );
}
