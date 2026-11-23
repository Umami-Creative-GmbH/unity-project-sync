import type { ReactNode } from "react";
import {
  IconAlertTriangle,
  IconCheck,
  IconCircleCheck,
  IconFilePlus,
  IconFolderMinus,
  IconPencil,
  IconPlayerStop,
  IconRefresh,
  IconScale,
  IconTrash,
  IconDatabase,
  IconClock,
} from "@tabler/icons-react";

import { WarningsPanel } from "@/components/plan-preview";
import { tone, toneText } from "@/components/tone";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatBytes, formatCount, formatDuration, plural } from "@/lib/format";
import type { PlanSummary, SyncReport } from "@/lib/types";
import { cn } from "@/lib/utils";

export type ReportOutcome = "success" | "warnings" | "partial" | "cancelled";

/** `warningCount`: scan warnings of the plan (paths that were skipped and not synced). */
export function reportOutcome(report: SyncReport, warningCount = 0): ReportOutcome {
  if (report.cancelled) return "cancelled";
  if (report.errorCount > 0 || report.errors.length > 0) return "partial";
  if (warningCount > 0) return "warnings";
  return "success";
}

/** Number of errors of a report (the list itself is capped by the backend). */
export function reportErrorCount(report: SyncReport): number {
  return Math.max(report.errorCount, report.errors.length);
}

/** At most this many errors are rendered. */
const MAX_ERROR_ROWS = 200;

interface SyncReportViewProps {
  plan: PlanSummary;
  report: SyncReport;
  onScanAgain: () => void;
  onDone: () => void;
}

export function SyncReportView({ plan, report, onScanAgain, onDone }: SyncReportViewProps) {
  const warningCount = plan.warnings.length;
  const outcome = reportOutcome(report, warningCount);
  const errorCount = reportErrorCount(report);
  const shownErrors = report.errors.slice(0, MAX_ERROR_ROWS);
  const hiddenErrors = errorCount - shownErrors.length;
  const header = {
    success: {
      icon: <IconCircleCheck className="size-6" />,
      tone: tone.success,
      title: "Sync complete",
      text: "The target now mirrors the source within the sync scope.",
    },
    warnings: {
      icon: <IconAlertTriangle className="size-6" />,
      tone: tone.warning,
      title: "Synced with warnings",
      text: "Everything in the plan was synced, but some paths were skipped during the scan (see below).",
    },
    partial: {
      icon: <IconAlertTriangle className="size-6" />,
      tone: tone.warning,
      title: `Finished with ${plural(errorCount, "error")}`,
      text:
        warningCount > 0
          ? "Some files could not be synced and some paths were skipped during the scan. See below, fix the problems and scan again."
          : "Everything else was synced. Fix the problems below and scan again.",
    },
    cancelled: {
      icon: <IconPlayerStop className="size-6" />,
      tone: tone.muted,
      title: "Sync cancelled",
      text: "The target is only partially synced. Scan again to finish.",
    },
  }[outcome];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex items-center gap-4 py-2">
          <div className={cn("flex size-12 shrink-0 items-center justify-center rounded-full", header.tone)}>
            {header.icon}
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-medium">{header.title}</h2>
            <p className="text-sm text-muted-foreground">{header.text}</p>
          </div>
        </CardContent>
      </Card>

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

      {warningCount > 0 && <WarningsPanel warnings={plan.warnings} />}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={plan.target}>
          Target: <span className="font-mono">{plan.target}</span>
        </span>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" onClick={onScanAgain}>
            <IconRefresh data-icon="inline-start" />
            Scan again
          </Button>
          <Button onClick={onDone}>Done</Button>
        </div>
      </div>
    </div>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
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
