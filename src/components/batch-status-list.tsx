import type { ReactNode } from "react";
import {
  IconAlertTriangle,
  IconBan,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleX,
  IconLoader2,
  IconPlayerStop,
} from "@tabler/icons-react";

import { OutcomeIcon } from "@/components/outcome";
import { toneText } from "@/components/tone";
import { Card } from "@/components/ui/card";
import { activeWarnings, hasWork, itemOutcome, type BatchItem } from "@/lib/batch";
import { formatBytes, formatCount, formatPercent, plural, progressFraction } from "@/lib/format";
import { reportErrorCount } from "@/lib/report";
import { cn } from "@/lib/utils";

/** Compact per-project status list shown while scanning ("scan") or syncing ("sync"). */
export function BatchStatusList({ items, mode, title }: { items: BatchItem[]; mode: "scan" | "sync"; title: string }) {
  return (
    <Card size="sm" className="gap-0 py-0">
      <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">{title}</div>
      <ul className="divide-y">
        {items.map((it) => {
          const s = mode === "scan" ? scanStatus(it) : syncStatus(it);
          return (
            <li key={it.projectId} className="flex items-start gap-2.5 px-3 py-2">
              <span className="mt-0.5">{s.icon}</span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-baseline gap-3">
                  <span className={cn("min-w-0 flex-1 truncate text-sm", s.active && "font-medium")} title={it.name}>
                    {it.name}
                  </span>
                  <span className={cn("shrink-0 text-xs tabular-nums", s.textClass ?? "text-muted-foreground")}>
                    {s.text}
                  </span>
                </div>
                {s.detail && <div className="text-xs break-words text-muted-foreground">{s.detail}</div>}
                {activeWarnings(it, items).map((w) => (
                  <div key={w} className={cn("flex items-start gap-1 text-xs", toneText.warning)}>
                    <IconAlertTriangle className="mt-0.5 size-3 shrink-0" />
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

interface RowStatus {
  icon: ReactNode;
  text: ReactNode;
  textClass?: string;
  detail?: ReactNode;
  active?: boolean;
}

const ICON = "size-4 shrink-0";

function scanStatus(it: BatchItem): RowStatus {
  switch (it.scan) {
    case "skipped":
      return {
        icon: <IconBan className={cn(ICON, toneText.warning)} />,
        text: "Skipped",
        textClass: toneText.warning,
        detail: it.skipReason,
      };
    case "pending":
      return { icon: <IconCircleDashed className={cn(ICON, "text-muted-foreground")} />, text: "Waiting" };
    case "scanning":
      return {
        icon: <IconLoader2 className={cn(ICON, "animate-spin text-foreground")} />,
        text: it.scanProgress ? `Scanning · ${formatCount(it.scanProgress.entries)} entries` : "Scanning…",
        textClass: "text-foreground",
        active: true,
      };
    case "scanned": {
      const plan = it.plan!;
      return {
        icon: <IconCircleCheck className={cn(ICON, toneText.success)} />,
        text: hasWork(plan)
          ? `${plural(plan.totalEntries, "change")} · ${formatBytes(plan.totalBytes)}`
          : "Already in sync",
      };
    }
    case "failed":
      return {
        icon: <IconCircleX className={cn(ICON, toneText.destructive)} />,
        text: "Scan failed",
        textClass: toneText.destructive,
        detail: it.scanError,
      };
    case "cancelled":
      return { icon: <IconPlayerStop className={cn(ICON, "text-muted-foreground")} />, text: "Cancelled" };
  }
}

function syncStatus(it: BatchItem): RowStatus {
  switch (it.run) {
    case "pending":
      return { icon: <IconCircleDashed className={cn(ICON, "text-muted-foreground")} />, text: "Waiting" };
    case "running": {
      const p = it.syncProgress;
      return {
        icon: <IconLoader2 className={cn(ICON, "animate-spin text-foreground")} />,
        text: p ? `Syncing · ${formatPercent(progressFraction(p))}` : "Starting…",
        textClass: "text-foreground",
        active: true,
      };
    }
    case "done": {
      const r = it.report!;
      const errors = reportErrorCount(r);
      const outcome = itemOutcome(it);
      return {
        icon: <OutcomeIcon outcome={outcome} />,
        text: r.cancelled ? "Cancelled" : errors > 0 ? plural(errors, "error") : "Done",
        textClass: errors > 0 ? toneText.destructive : undefined,
      };
    }
    case "failed":
      return {
        icon: <IconCircleX className={cn(ICON, toneText.destructive)} />,
        text: "Failed",
        textClass: toneText.destructive,
        detail: it.runError,
      };
    case "notRun":
      return { icon: <IconCircleDashed className={cn(ICON, "text-muted-foreground")} />, text: "Not run" };
    case "none": {
      const outcome = itemOutcome(it);
      return {
        icon: <OutcomeIcon outcome={outcome} />,
        text:
          outcome === "inSync"
            ? "Already in sync"
            : outcome === "skipped"
              ? "Skipped"
              : outcome === "failed"
                ? "Scan failed"
                : outcome === "excluded"
                  ? "Not included"
                  : "—",
        detail: it.skipReason ?? it.scanError,
      };
    }
  }
}
