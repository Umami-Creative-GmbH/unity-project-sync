import { IconArrowRight, IconFiles, IconFolder } from "@tabler/icons-react";

import { AbsolutePath } from "@/components/path-text";
import type { SyncScope } from "@/lib/types";

/** Read-only "source → target" strip shown while scanning, previewing, syncing and on the report. */
export function RouteSummary({ source, target, scope }: { source: string; target: string; scope: SyncScope }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border bg-muted/30 px-3 py-2.5">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
        <div className="min-w-0">
          <div className="text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase">Source</div>
          <AbsolutePath path={source} />
        </div>
        <IconArrowRight className="size-4 text-muted-foreground" aria-label="mirrors into" />
        <div className="min-w-0">
          <div className="text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase">Target</div>
          <AbsolutePath path={target} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span>Scope:</span>
        {scope.includeRootFiles && (
          <span className="inline-flex items-center gap-1 rounded-full bg-background px-2 py-0.5 ring-1 ring-border">
            <IconFiles className="size-3" /> Root files
          </span>
        )}
        {scope.folders.map((f) => (
          <span
            key={f}
            className="inline-flex items-center gap-1 rounded-full bg-background px-2 py-0.5 ring-1 ring-border"
          >
            <IconFolder className="size-3" /> {f}
          </span>
        ))}
      </div>
    </div>
  );
}
