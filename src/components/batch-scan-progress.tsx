import { IconLoader2, IconX } from "@tabler/icons-react";

import { BatchStatusList } from "@/components/batch-status-list";
import { ScanProgressView } from "@/components/scan-progress";
import { ShutdownSwitch } from "@/components/shutdown-switch";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { BatchState } from "@/lib/batch";
import { plural } from "@/lib/format";

interface BatchScanProgressProps {
  state: BatchState;
  onCancel: () => void;
  shutdownAfter: boolean;
  onShutdownAfterChange: (v: boolean) => void;
}

/** Pre-flight check and the sequential scans of a batch. */
export function BatchScanProgress({ state, onCancel, shutdownAfter, onShutdownAfterChange }: BatchScanProgressProps) {
  const scannable = state.items.filter((it) => it.scan !== "skipped");
  const current =
    state.items.find((it) => it.projectId === state.currentId) ?? scannable.find((it) => it.scan === "pending") ?? null;
  const position = current ? scannable.indexOf(current) + 1 : scannable.length;

  return (
    <div className="flex flex-col gap-4">
      <h2 id="phase-heading" tabIndex={-1} className="sr-only">
        {state.phase === "preflight" ? "Checking projects" : `Scanning ${plural(scannable.length, "project")}`}
      </h2>
      {state.phase === "preflight" ? (
        <Card>
          <CardContent className="flex items-center gap-3 py-2">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
              <IconLoader2 className="size-5 animate-spin" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-medium">{state.cancelling ? "Cancelling…" : "Checking projects…"}</h2>
              <p className="text-sm text-muted-foreground">
                Inspecting the folders of {plural(state.chosenIds.length, "project")} before scanning.
              </p>
            </div>
            <Button variant="outline" onClick={onCancel} disabled={state.cancelling}>
              <IconX data-icon="inline-start" />
              Cancel
            </Button>
          </CardContent>
        </Card>
      ) : (
        <ScanProgressView
          key={current?.projectId ?? "none"}
          progress={current?.scanProgress ?? null}
          startedAt={current?.scanStartedAt ?? Date.now()}
          autoSync={state.autoSync}
          cancelling={state.cancelling}
          onCancel={onCancel}
          context={
            current
              ? scannable.length > 1
                ? `Project ${position} of ${scannable.length} · ${current.name}`
                : current.name
              : undefined
          }
        />
      )}

      {state.items.length > 0 && (
        <BatchStatusList
          items={state.items}
          mode="scan"
          title={
            state.items.length === 1 ? "Project" : `${plural(state.items.length, "project")} in this batch`
          }
        />
      )}

      <ShutdownSwitch id="shutdown-while-scanning" checked={shutdownAfter} onCheckedChange={onShutdownAfterChange} />
    </div>
  );
}
