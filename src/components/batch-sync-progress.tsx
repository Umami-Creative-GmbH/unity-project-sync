import { useRef, useState } from "react";

import { BatchStatusList } from "@/components/batch-status-list";
import { TransferCard } from "@/components/transfer-card";
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
import { Progress } from "@/components/ui/progress";
import { overallProgress, type BatchItem, type BatchState } from "@/lib/batch";
import { formatBytes, formatCount, formatPercent, plural, progressFraction } from "@/lib/format";
import { reportErrorCount } from "@/lib/report";

interface BatchSyncProgressProps {
  state: BatchState;
  onCancel: () => void;
  shutdownAfter: boolean;
  onShutdownAfterChange: (v: boolean) => void;
}

/**
 * The sync phase: one transfer card for the whole run (a single project is a batch of one), plus the
 * current project and the project list when several projects run.
 */
export function BatchSyncProgress({ state, onCancel, shutdownAfter, onShutdownAfterChange }: BatchSyncProgressProps) {
  const [confirmCancel, setConfirmCancel] = useState(false);
  const runItems = state.items.filter((it) => it.run !== "none");
  const multi = runItems.length > 1;
  const current =
    runItems.find((it) => it.run === "running") ?? runItems.find((it) => it.run === "pending") ?? null;
  const running = current?.run === "running" ? current : null;
  const overall = overallProgress(state.items, state.lastCostPerSec);
  // The chart's front (history.x) never moves backwards; belt and braces for the computed fraction.
  const maxRef = useRef<{ run: number | null; fraction: number }>({ run: null, fraction: 0 });
  if (maxRef.current.run !== state.syncStartedAt) maxRef.current = { run: state.syncStartedAt, fraction: 0 };
  maxRef.current.fraction = Math.max(maxRef.current.fraction, overall.fraction, state.speedHistory.x);
  const fraction = maxRef.current.fraction;
  const remaining = runItems.filter((it) => it.run === "pending").length;
  const errors =
    runItems.reduce((n, it) => n + (it.report ? reportErrorCount(it.report) : 0), 0) +
    (running?.syncProgress?.errors ?? 0);

  return (
    <div className="flex flex-col gap-4">
      <h2 id="phase-heading" tabIndex={-1} className="sr-only">
        {multi ? `Syncing ${plural(runItems.length, "project")}` : "Syncing"}
      </h2>

      <TransferCard
        fraction={fraction}
        history={state.speedHistory}
        progress={running?.syncProgress ?? null}
        doneBytes={overall.doneBytes}
        totalBytes={overall.totalBytes}
        doneFiles={overall.doneFiles}
        totalFiles={overall.totalFiles}
        etaSecs={overall.etaSecs}
        errors={errors}
        cancelling={state.cancelling}
        projectName={current?.name ?? null}
        batch={multi ? { position: overall.position, count: overall.count, names: runItems.map((it) => it.name) } : null}
        onCancel={() => setConfirmCancel(true)}
        cancelLabel={multi ? "Cancel the batch sync" : "Cancel sync"}
        shutdownAfter={shutdownAfter}
        onShutdownAfterChange={onShutdownAfterChange}
        shutdownSwitchId={multi ? "shutdown-during-batch" : "shutdown-during-sync"}
      />

      {multi && current && <CurrentProject item={current} />}

      {state.items.length > 1 && <BatchStatusList items={state.items} mode="sync" title="Projects in this batch" />}

      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel the sync?</AlertDialogTitle>
            <AlertDialogDescription>
              {multi ? (
                <>
                  The current project stops and stays partially synced
                  {remaining > 0 ? <>; the remaining {plural(remaining, "project")} won't run</> : null}. Scan again
                  later to finish the job.
                </>
              ) : (
                <>
                  Files already copied or deleted stay that way, so the target will be partially synced. Scan again
                  later to finish the job.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep syncing</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmCancel(false);
                onCancel();
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

/** The running project of a batch, kept light: its own thin bar and numbers (the chart is overall). */
function CurrentProject({ item }: { item: BatchItem }) {
  const p = item.run === "running" ? item.syncProgress : null;
  const fraction = p ? progressFraction(p) : 0;
  const deleting = p?.phase === "deleting" && p.deleteTotal > 0;
  const totalBytes = p?.totalBytes ?? item.plan?.totalBytes ?? 0;
  return (
    <section
      aria-label={`Current project: ${item.name}`}
      className="flex flex-col gap-2 rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10"
    >
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <h3 className="min-w-0 truncate text-xs text-muted-foreground" title={item.target}>
          <span className="font-medium tracking-wide uppercase">Current project</span>
          <span className="px-1.5 text-muted-foreground/60">·</span>
          <span className="text-sm font-medium text-foreground">{item.name}</span>
        </h3>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{p ? formatPercent(fraction) : "Waiting"}</span>
      </div>
      <Progress
        value={fraction * 100}
        className="h-1 *:data-[slot=progress-indicator]:bg-foreground/45"
        aria-label={`Progress of ${item.name}`}
      />
      <div className="truncate text-xs text-muted-foreground tabular-nums">
        {deleting && p
          ? `Deleting · ${formatCount(Math.min(p.deleteDone, p.deleteTotal))} of ${plural(p.deleteTotal, "item")}`
          : `${formatBytes(p?.doneBytes ?? 0)} of ${formatBytes(totalBytes)} · ${formatCount(p?.doneFiles ?? 0)} of ${
              p ? plural(p.totalFiles, "file") : "… files"
            }`}
      </div>
    </section>
  );
}
