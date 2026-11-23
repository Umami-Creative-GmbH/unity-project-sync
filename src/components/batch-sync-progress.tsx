import { useRef, useState } from "react";
import { IconLoader2, IconX } from "@tabler/icons-react";

import { BatchStatusList } from "@/components/batch-status-list";
import { ShutdownSwitch } from "@/components/shutdown-switch";
import { SyncProgressView } from "@/components/sync-progress";
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
import { overallProgress, type BatchState } from "@/lib/batch";
import { formatBytes, formatEta, formatPercent, plural } from "@/lib/format";

interface BatchSyncProgressProps {
  state: BatchState;
  onCancel: () => void;
  shutdownAfter: boolean;
  onShutdownAfterChange: (v: boolean) => void;
}

/** Overall progress across the projects of a batch + the detailed view of the current one. */
export function BatchSyncProgress({ state, onCancel, shutdownAfter, onShutdownAfterChange }: BatchSyncProgressProps) {
  const [confirmCancel, setConfirmCancel] = useState(false);
  const runItems = state.items.filter((it) => it.run !== "none");
  const current =
    runItems.find((it) => it.run === "running") ?? runItems.find((it) => it.run === "pending") ?? null;
  const computed = overallProgress(state.items, state.lastCostPerSec);
  // Belt and braces: the overall bar never moves backwards within one run.
  const maxRef = useRef<{ run: number | null; fraction: number }>({ run: null, fraction: 0 });
  if (maxRef.current.run !== state.syncStartedAt) maxRef.current = { run: state.syncStartedAt, fraction: 0 };
  maxRef.current.fraction = Math.max(maxRef.current.fraction, computed.fraction);
  const overall = { ...computed, fraction: maxRef.current.fraction };
  const remaining = runItems.filter((it) => it.run === "pending").length;
  const heading = (
    <h2 id="phase-heading" tabIndex={-1} className="sr-only">
      {runItems.length > 1 ? `Syncing ${plural(runItems.length, "project")}` : "Syncing"}
    </h2>
  );

  // A single project: the familiar single-sync view.
  if (runItems.length <= 1) {
    return (
      <div className="flex flex-col gap-4">
        {heading}
        {current && (
          <>
            <div className="truncate text-sm font-medium" title={current.target}>
              {current.name}
            </div>
            <SyncProgressView
              plan={current.plan!}
              progress={current.syncProgress}
              cancelling={state.cancelling}
              onCancel={onCancel}
              shutdownAfter={shutdownAfter}
              onShutdownAfterChange={onShutdownAfterChange}
            />
          </>
        )}
        {state.items.length > 1 && <BatchStatusList items={state.items} mode="sync" title="Projects in this batch" />}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {heading}
      <Card>
        <CardContent className="flex flex-col gap-3 py-2">
          <div className="flex items-end justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 truncate text-sm text-muted-foreground">
                {state.cancelling ? (
                  <>
                    <IconLoader2 className="size-4 animate-spin" /> Cancelling…
                  </>
                ) : current ? (
                  <span className="truncate">
                    Project {overall.position} of {overall.count}:{" "}
                    <span className="font-medium text-foreground">{current.name}</span>
                  </span>
                ) : (
                  "Finishing…"
                )}
              </div>
              <div className="text-4xl font-semibold tracking-tight tabular-nums" aria-live="off">
                {formatPercent(overall.fraction)}
              </div>
            </div>
            {/* "Shut down after" next to Cancel: always on screen during the run. */}
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              <ShutdownSwitch
                id="shutdown-during-batch"
                compact
                checked={shutdownAfter}
                onCheckedChange={onShutdownAfterChange}
              />
              <Button
                variant="outline"
                onClick={() => setConfirmCancel(true)}
                disabled={state.cancelling}
                aria-label="Cancel the batch sync"
              >
                <IconX data-icon="inline-start" />
                Cancel
              </Button>
            </div>
          </div>
          <Progress value={overall.fraction * 100} className="h-2" aria-label="Overall sync progress" />
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {formatBytes(overall.doneBytes)} of {formatBytes(overall.totalBytes)} · {overall.finished} of{" "}
              {plural(overall.count, "project")} done
            </span>
            <span className="tabular-nums">
              {overall.etaSecs == null ? "Estimating time left…" : `About ${formatEta(overall.etaSecs)} left in total`}
            </span>
          </div>
        </CardContent>
      </Card>

      {current && (
        <section aria-label={`Current project: ${current.name}`} className="flex flex-col gap-2">
          <h3 className="truncate text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Current project · {current.name}
          </h3>
          <SyncProgressView plan={current.plan!} progress={current.syncProgress} cancelling={state.cancelling} />
        </section>
      )}

      <BatchStatusList items={state.items} mode="sync" title="Projects in this batch" />


      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel the sync?</AlertDialogTitle>
            <AlertDialogDescription>
              The current project stops and stays partially synced
              {remaining > 0 ? <>; the remaining {plural(remaining, "project")} won't run</> : null}. Scan again later
              to finish the job.
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
