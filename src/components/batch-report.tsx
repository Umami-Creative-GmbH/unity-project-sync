import { useState } from "react";
import { IconChevronRight, IconClock, IconDatabase, IconFiles, IconRefresh, IconTrash } from "@tabler/icons-react";

import { OUTCOME_META, OutcomeIcon, OutcomeMedia } from "@/components/outcome";
import { Metric, SyncReportDetails } from "@/components/sync-report";
import { toneText } from "@/components/tone";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { activeWarnings, itemOutcome, summarizeBatch, type BatchItem, type BatchState, type BatchSummary } from "@/lib/batch";
import { formatBytes, formatCount, formatDuration, plural } from "@/lib/format";
import { reportDeleted, reportErrorCount, reportFilesWritten } from "@/lib/report";
import { cn } from "@/lib/utils";

interface BatchReportProps {
  state: BatchState;
  onRescan: () => void;
  onDone: () => void;
}

function headerText(s: BatchSummary, single: boolean): { title: string; text: string } {
  // Unticked projects still have changes to sync: never claim that every target is up to date.
  const excludedNote =
    s.excluded > 0
      ? `${plural(s.excluded, "project was", "projects were")} not included and still ${s.excluded === 1 ? "has" : "have"} changes to sync.`
      : "";
  const withNote = (text: string) => (excludedNote ? `${text} ${excludedNote}` : text);
  const others = s.excluded > 0 ? "Everything else that was included" : "Everything else";
  switch (s.outcome) {
    case "success":
      if (s.excluded > 0)
        return {
          title: single ? "Sync complete" : s.synced === 0 ? "Already in sync" : `${plural(s.synced + s.inSync, "project")} synced`,
          text: excludedNote,
        };
      if (s.synced === 0 && s.inSync > 0)
        return { title: "Already in sync", text: "Every target already mirrors its source. Nothing was changed." };
      return {
        title: single ? "Sync complete" : `${plural(s.synced + s.inSync, "project")} in sync`,
        text: single
          ? "The target now mirrors the source within the sync scope."
          : "Every target now mirrors its source within the sync scope.",
      };
    case "warnings":
      return {
        title: s.synced > 0 ? "Synced with warnings" : "Already in sync, with warnings",
        text: withNote(
          s.skipped > 0
            ? `${plural(s.skipped, "project was", "projects were")} skipped. ${
                s.synced === 0 ? `${others} was already in sync.` : s.excluded > 0 ? `${others} was synced.` : "The others were synced."
              }`
            : `${s.excluded > 0 ? "Everything included" : "Everything in the plan"} was synced, but some paths were skipped during the scan.`,
        ),
      };
    case "partial":
      return {
        title: s.errorCount > 0 ? `Finished with ${plural(s.errorCount, "error")}` : "Finished with problems",
        text: withNote(
          s.failed > 0
            ? `${plural(s.failed, "project")} failed. ${
                s.synced + s.withErrors > 0
                  ? `The other${s.excluded > 0 ? " included" : ""} projects were synced — fix`
                  : s.inSync > 0
                    ? "The others were already in sync. Fix"
                    : "Fix"
              } the problems and rescan.`
            : `${others} was synced. Fix the problems below and rescan.`,
        ),
      };
    case "cancelled":
      return {
        title: "Sync cancelled",
        text: "Projects that didn't finish are only partially synced (or not at all). Rescan to finish.",
      };
    case "failed":
      return s.failed === 0 && s.skipped > 0
        ? {
            title: "Nothing was synced",
            text: `${plural(s.skipped, "project was", "projects were")} skipped. Fix the problems below and rescan.`,
          }
        : {
            title: "Sync failed",
            text:
              s.skipped > 0
                ? `No project could be synced (${formatCount(s.skipped)} skipped). See the details below.`
                : "No project could be synced. See the details below.",
          };
  }
}
/** Report of a batch: overall outcome, totals and one expandable row per project. */
export function BatchReport({ state, onRescan, onDone }: BatchReportProps) {
  const summary = summarizeBatch(state);
  const single = state.items.length === 1;
  const header = headerText(summary, single);
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    single && state.items[0].report ? new Set([state.items[0].projectId]) : new Set(),
  );
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex items-center gap-4 py-2">
          <OutcomeMedia outcome={summary.outcome} />
          <div className="min-w-0">
            <h2 id="phase-heading" tabIndex={-1} className="text-lg font-medium outline-none">
              {header.title}
            </h2>
            <p className="text-sm text-muted-foreground">{header.text}</p>
          </div>
        </CardContent>
      </Card>

      {!single && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric icon={<IconFiles className="size-3.5" />} label="Files written" value={formatCount(summary.filesWritten)} />
          <Metric icon={<IconTrash className="size-3.5" />} label="Items deleted" value={formatCount(summary.deleted)} />
          <Metric icon={<IconDatabase className="size-3.5" />} label="Bytes written" value={formatBytes(summary.bytesWritten)} />
          <Metric icon={<IconClock className="size-3.5" />} label="Duration" value={formatDuration(summary.durationMs)} />
        </div>
      )}

      <Card className="gap-0 py-0">
        <ul className="divide-y">
          {state.items.map((it) => (
            <ReportRow key={it.projectId} item={it} warnings={activeWarnings(it, state.items)} expanded={expanded.has(it.projectId)} onToggle={() => toggle(it.projectId)} />
          ))}
        </ul>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" onClick={onRescan}>
          <IconRefresh data-icon="inline-start" />
          {single ? "Scan again" : "Rescan these projects"}
        </Button>
        <Button onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

function rowSummary(it: BatchItem): string {
  const r = it.report;
  if (r) {
    const parts = [`${formatCount(reportFilesWritten(r))} written`, `${formatCount(reportDeleted(r))} deleted`];
    const errors = reportErrorCount(r);
    if (errors > 0) parts.push(plural(errors, "error"));
    parts.push(formatDuration(r.durationMs));
    return parts.join(" · ");
  }
  return "";
}

function ReportRow({
  item,
  warnings,
  expanded,
  onToggle,
}: {
  item: BatchItem;
  warnings: string[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const outcome = itemOutcome(item);
  const meta = OUTCOME_META[outcome];
  const expandable = !!item.report;
  const reason =
    outcome === "skipped"
      ? item.skipReason
      : outcome === "failed"
        ? (item.runError ?? item.scanError)
        : outcome === "notRun"
          ? "Not run because the sync was cancelled."
          : outcome === "excluded"
            ? "Not included in this sync."
            : null;

  return (
    <li>
      <button
        type="button"
        className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left outline-none hover:bg-muted/30 focus-visible:bg-muted/40 disabled:cursor-default disabled:hover:bg-transparent"
        onClick={onToggle}
        disabled={!expandable}
        aria-expanded={expandable ? expanded : undefined}
      >
        <IconChevronRight
          className={cn(
            "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90",
            !expandable && "invisible",
          )}
        />
        <OutcomeIcon outcome={outcome} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-3">
            <span className="min-w-0 flex-1 truncate text-sm font-medium" title={item.name}>
              {item.name}
            </span>
            <span className={cn("shrink-0 text-xs", toneText[meta.tone])}>{meta.label}</span>
          </div>
          {item.report ? (
            <div className="text-xs text-muted-foreground tabular-nums">{rowSummary(item)}</div>
          ) : (
            reason && <div className="text-xs break-words text-muted-foreground">{reason}</div>
          )}
          {warnings.map((w) => (
            <div key={w} className={cn("text-xs", toneText.warning)}>
              {w}.
            </div>
          ))}
        </div>
      </button>
      {expanded && item.report && (
        <div className="border-t bg-muted/20 p-3">
          <div className="mb-2 truncate text-xs text-muted-foreground" title={item.target}>
            Target: <span className="font-mono">{item.target}</span>
          </div>
          <SyncReportDetails plan={item.plan} report={item.report} />
        </div>
      )}
    </li>
  );
}
