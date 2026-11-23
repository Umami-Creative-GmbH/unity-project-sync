import type { ReactNode } from "react";
import {
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconDatabase,
  IconFilePlus,
  IconFolderMinus,
  IconPencil,
  IconScale,
  IconTrash,
} from "@tabler/icons-react";

import { WarningsPanel } from "@/components/plan-preview";
import { toneText } from "@/components/tone";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatBytes, formatCount, formatDuration, plural } from "@/lib/format";
import { reportErrorCount } from "@/lib/report";
import type { PlanSummary, SyncReport } from "@/lib/types";
import { cn } from "@/lib/utils";

/** At most this many errors are rendered. */
const MAX_ERROR_ROWS = 200;

/** Metrics, errors and scan warnings of one project's sync. */
export function SyncReportDetails({ plan, report }: { plan: PlanSummary | null; report: SyncReport }) {
  const errorCount = reportErrorCount(report);
  const shownErrors = report.errors.slice(0, MAX_ERROR_ROWS);
  const hiddenErrors = errorCount - shownErrors.length;
  const warnings = plan?.warnings ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric icon={<IconFilePlus className="size-3.5" />} label="Copied" value={formatCount(report.copied)} />
        <Metric icon={<IconPencil className="size-3.5" />} label="Updated" value={formatCount(report.updated)} />
        <Metric
          icon={<IconCheck className="size-3.5" />}
          label="Verified identical"
          value={formatCount(report.verifiedIdentical)}
        />
        <Metric
          icon={<IconScale className="size-3.5" />}
          label="Verified changed"
          value={formatCount(report.verifiedChanged)}
        />
        <Metric icon={<IconTrash className="size-3.5" />} label="Deleted files" value={formatCount(report.deletedFiles)} />
        <Metric
          icon={<IconFolderMinus className="size-3.5" />}
          label="Deleted folders"
          value={formatCount(report.deletedDirs)}
        />
        <Metric icon={<IconDatabase className="size-3.5" />} label="Bytes written" value={formatBytes(report.bytesWritten)} />
        <Metric icon={<IconClock className="size-3.5" />} label="Duration" value={formatDuration(report.durationMs)} />
      </div>

      {errorCount > 0 && (
        <Card size="sm" className="gap-0 py-0">
          <div className={cn("flex items-center gap-2 border-b px-3 py-2 text-sm font-medium", toneText.destructive)}>
            <IconAlertTriangle className="size-4" />
            {plural(errorCount, "error")}
          </div>
          <ScrollArea className={shownErrors.length > 6 ? "h-60" : undefined}>
            <ul className="divide-y">
              {shownErrors.map((err, i) => (
                <li key={`${i}:${err.path}`} className="flex flex-col gap-0.5 px-3 py-2">
                  <span className="truncate font-mono text-xs" title={err.path}>
                    {err.path || "Sync"}
                  </span>
                  <span className="text-xs break-words text-muted-foreground">{err.message}</span>
                </li>
              ))}
              {hiddenErrors > 0 && (
                <li className="px-3 py-2 text-xs text-muted-foreground">
                  …and {formatCount(hiddenErrors)} more {hiddenErrors === 1 ? "error" : "errors"}
                </li>
              )}
            </ul>
          </ScrollArea>
        </Card>
      )}

      {warnings.length > 0 && <WarningsPanel warnings={warnings} />}
    </div>
  );
}

export function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border bg-card p-3">
      <div className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="truncate text-base font-semibold tabular-nums">{value}</div>
    </div>
  );
}
