import { useState, type ReactNode } from "react";
import {
  IconAlertTriangle,
  IconClock,
  IconCopy,
  IconFile,
  IconGauge,
  IconHourglass,
  IconLoader2,
  IconSparkles,
  IconTrash,
  IconX,
} from "@tabler/icons-react";

import { ShutdownSwitch } from "@/components/shutdown-switch";
import { toneText } from "@/components/tone";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  formatBytes,
  formatCount,
  formatDuration,
  formatEta,
  formatPercent,
  formatSpeed,
  progressFraction,
} from "@/lib/format";
import type { PlanSummary, SyncPhase, SyncProgress } from "@/lib/types";
import { cn } from "@/lib/utils";

const PHASE: Record<SyncPhase, { label: string; icon: ReactNode }> = {
  deleting: { label: "Deleting", icon: <IconTrash className="size-4" /> },
  copying: { label: "Copying", icon: <IconCopy className="size-4" /> },
  finalizing: { label: "Finalizing", icon: <IconSparkles className="size-4" /> },
};

interface SyncProgressViewProps {
  plan: PlanSummary;
  progress: SyncProgress | null;
  cancelling: boolean;
  /** Omit to hide the Cancel button (e.g. when the batch view has its own). */
  onCancel?: () => void;
  /** Omit `onShutdownAfterChange` to hide the "Shut down after" switch. */
  shutdownAfter?: boolean;
  onShutdownAfterChange?: (v: boolean) => void;
}

export function SyncProgressView({
  plan,
  progress,
  cancelling,
  onCancel,
  shutdownAfter,
  onShutdownAfterChange,
}: SyncProgressViewProps) {
  const [confirmCancel, setConfirmCancel] = useState(false);

  const fraction = progress ? progressFraction(progress) : 0;
  const pct = fraction * 100;
  const phase = progress ? PHASE[progress.phase] : null;
  const totalBytes = progress?.totalBytes ?? plan.totalBytes;
  const errors = progress?.errors ?? 0;
  const deleting = progress?.phase === "deleting" && progress.deleteTotal > 0;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-col gap-4 py-2">
          <div className="flex items-end justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                {cancelling ? (
                  <>
                    <IconLoader2 className="size-4 animate-spin" /> Cancelling…
                  </>
                ) : phase ? (
                  <>
                    {phase.icon} {phase.label}…
                  </>
                ) : (
                  <>
                    <IconLoader2 className="size-4 animate-spin" /> Preparing…
                  </>
                )}
              </div>
              <div className="text-5xl font-semibold tracking-tight tabular-nums" aria-live="off">
                {formatPercent(fraction)}
              </div>
            </div>
            {(onCancel || onShutdownAfterChange) && (
              // The "Shut down after" switch sits next to Cancel so it stays on screen during the run.
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                {onShutdownAfterChange && (
                  <ShutdownSwitch
                    id="shutdown-during-sync"
                    compact
                    checked={!!shutdownAfter}
                    onCheckedChange={onShutdownAfterChange}
                  />
                )}
                {onCancel && (
                  <Button
                    variant="outline"
                    onClick={() => setConfirmCancel(true)}
                    disabled={cancelling}
                    aria-label="Cancel sync"
                  >
                    <IconX data-icon="inline-start" />
                    Cancel
                  </Button>
                )}
              </div>
            )}
          </div>

          <Progress value={pct} className="h-2" aria-label="Sync progress" />

          <div className="flex h-5 min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <IconFile className="size-3.5 shrink-0" />
            {progress?.currentFile ? (
              <span className="min-w-0 truncate font-mono" title={progress.currentFile}>
                {progress.currentFile}
              </span>
            ) : (
              <span>—</span>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="Transferred" icon={<IconCopy className="size-3.5" />}>
          {formatBytes(progress?.doneBytes ?? 0)}
          <span className="text-muted-foreground"> / {formatBytes(totalBytes)}</span>
        </Stat>
        {deleting && progress ? (
          <Stat label="Deleted items" icon={<IconTrash className="size-3.5" />}>
            {formatCount(Math.min(progress.deleteDone, progress.deleteTotal))}
            <span className="text-muted-foreground"> / {formatCount(progress.deleteTotal)}</span>
          </Stat>
        ) : (
          <Stat label="Files" icon={<IconFile className="size-3.5" />}>
            {formatCount(progress?.doneFiles ?? 0)}
            <span className="text-muted-foreground"> / {progress ? formatCount(progress.totalFiles) : "…"}</span>
          </Stat>
        )}
        <Stat label="Speed" icon={<IconGauge className="size-3.5" />}>
          {progress && !deleting ? formatSpeed(progress.bytesPerSec) : "—"}
        </Stat>
        <Stat label="Elapsed" icon={<IconClock className="size-3.5" />}>
          {progress ? formatDuration(progress.elapsedMs) : "—"}
        </Stat>
        <Stat label="Remaining" icon={<IconHourglass className="size-3.5" />}>
          {formatEta(progress?.etaSecs)}
        </Stat>
        <Stat
          label="Errors"
          icon={<IconAlertTriangle className="size-3.5" />}
          className={errors > 0 ? toneText.destructive : undefined}
        >
          {formatCount(errors)}
        </Stat>
      </div>


      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel the sync?</AlertDialogTitle>
            <AlertDialogDescription>
              Files already copied or deleted stay that way, so the target will be partially synced. Scan again
              later to finish the job.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep syncing</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmCancel(false);
                onCancel?.();
              }}
            >
              Cancel sync
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Stat({
  label,
  icon,
  children,
  className,
}: {
  label: string;
  icon: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border bg-card p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className={cn("truncate text-sm font-medium tabular-nums", className)}>{children}</div>
    </div>
  );
}
