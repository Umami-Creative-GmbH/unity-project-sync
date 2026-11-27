import { useState } from "react";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconBan,
  IconChevronRight,
  IconCircleCheck,
  IconCircleX,
  IconCpu,
  IconPlayerPlay,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";

import { ActionFooter, ActionFooterStatus } from "@/components/action-footer";
import { ACTION_META } from "@/components/plan-meta";
import { AbsolutePath } from "@/components/path-text";
import { PlanDetails, PlanStatTiles } from "@/components/plan-preview";
import { ShutdownSwitch } from "@/components/shutdown-switch";
import { tone, toneText } from "@/components/tone";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { activeWarnings, canInclude, hasWork, includedItems, sumPlans, type BatchItem, type BatchState } from "@/lib/batch";
import { formatBytes, formatCount, formatDuration, plural } from "@/lib/format";
import type { PlanAction, PlanSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

interface BatchPreviewProps {
  state: BatchState;
  onSetInclude: (projectId: string, include: boolean) => void;
}

/** One combined preview for all scanned projects of a batch (its actions: BatchPreviewFooter). */
export function BatchPreview({ state, onSetInclude }: BatchPreviewProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    state.items.length === 1 ? new Set([state.items[0].projectId]) : new Set(),
  );

  const included = includedItems(state);
  const totals = sumPlans(included.map((it) => it.plan!));
  const scanned = state.items.filter((it) => it.scan === "scanned");
  const withWork = scanned.filter((it) => hasWork(it.plan!));
  // "Unchanged" also counts projects that are already in sync (they can't be included).
  const unchangedTotals = sumPlans(scanned.filter((it) => it.include || !hasWork(it.plan!)).map((it) => it.plan!)).unchanged;
  const tileCounts = { ...totals, unchanged: unchangedTotals };
  const deleteCount = totals.delete.files + totals.delete.dirs;
  const transferFiles = totals.copy.files + totals.update.files + totals.verify.files;
  const scanStats = scanSummary(scanned.map((it) => it.plan!));

  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const headline =
    withWork.length === 0
      ? scanned.length > 0
        ? scanned.length === 1
          ? "Already in sync"
          : "All scanned projects are already in sync"
        : "Nothing could be scanned"
      : included.length === 0
        ? "No project selected for syncing"
        : state.items.length === 1
          ? "Ready to sync"
          : included.length === state.items.length
            ? `Ready to sync ${included.length === 2 ? "both" : `all ${included.length}`} projects`
            : `Ready to sync ${included.length} of ${state.items.length} projects`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="phase-heading" tabIndex={-1} className="text-base font-medium outline-none">
          {headline}
        </h2>
        <p className="text-sm text-muted-foreground">
          {included.length > 0 ? (
            <>
              {totals.verify.files > 0 ? "Up to " : ""}
              <span className="font-medium text-foreground">{formatBytes(totals.totalBytes)}</span> to transfer
              {transferFiles > 0 && <> in {plural(transferFiles, "file")}</>}
              {deleteCount > 0 && <>, {plural(deleteCount, "item")} to delete</>}.
            </>
          ) : withWork.length > 0 ? (
            "Tick the projects you want to sync."
          ) : (
            "There is nothing to copy or delete."
          )}
        </p>
        {scanStats && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
            <IconCpu className="size-3.5 shrink-0" />
            Scanned in {formatDuration(scanStats.ms)} with {scanStats.threads}
          </p>
        )}
      </div>

      <PlanStatTiles counts={tileCounts} />

      <Card className="gap-0 py-0">
        <div className="flex items-center gap-3 border-b bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">
          <span className="w-4" aria-hidden />
          <span className="flex-1">{plural(state.items.length, "project")}</span>
          <span>Changes</span>
        </div>
        <ul className="divide-y">
          {state.items.map((it) => (
            <PreviewRow
              key={it.projectId}
              item={it}
              warnings={activeWarnings(it, state.items)}
              expanded={expanded.has(it.projectId)}
              onToggleExpanded={() => toggleExpanded(it.projectId)}
              onSetInclude={(v) => onSetInclude(it.projectId, v)}
            />
          ))}
        </ul>
      </Card>
    </div>
  );
}

interface BatchPreviewFooterProps {
  state: BatchState;
  onBack: () => void;
  onRescan: () => void;
  onStart: () => void;
  shutdownAfter: boolean;
  onShutdownAfterChange: (v: boolean) => void;
}

/** The preview's actions for the fixed footer; deletions are confirmed before the sync starts. */
export function BatchPreviewFooter({
  state,
  onBack,
  onRescan,
  onStart,
  shutdownAfter,
  onShutdownAfterChange,
}: BatchPreviewFooterProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const included = includedItems(state);
  const totals = sumPlans(included.map((it) => it.plan!));
  const deleting = included.filter((it) => it.plan!.delete.files + it.plan!.delete.dirs > 0);
  const deleteCount = totals.delete.files + totals.delete.dirs;
  const hasChanges = state.items.some((it) => it.plan && hasWork(it.plan));

  const handleStart = () => {
    if (deleting.length > 0) setConfirmOpen(true);
    else onStart();
  };

  return (
    <ActionFooter label="Preview actions">
      <ShutdownSwitch id="shutdown-after" compact checked={shutdownAfter} onCheckedChange={onShutdownAfterChange} />
      <ActionFooterStatus>
        {included.length > 0
          ? `${totals.verify.files > 0 ? "Up to " : ""}${formatBytes(totals.totalBytes)} to transfer`
          : hasChanges
            ? "No project selected"
            : "Nothing to sync"}
      </ActionFooterStatus>
      <Button variant="ghost" size="lg" onClick={onBack}>
        <IconArrowLeft data-icon="inline-start" />
        Back
      </Button>
      <Button variant="outline" size="lg" onClick={onRescan}>
        <IconRefresh data-icon="inline-start" />
        Rescan
      </Button>
      <Button
        size="lg"
        onClick={handleStart}
        disabled={included.length === 0}
        aria-label={deleteCount > 0 ? `Start sync, including ${formatCount(deleteCount)} deletions` : "Start sync"}
      >
        <IconPlayerPlay data-icon="inline-start" />
        Start sync{included.length > 1 && ` (${included.length})`}
        {deleteCount > 0 && (
          <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-destructive px-1.5 py-px text-[0.7rem] font-medium text-white">
            <IconTrash className="size-3" />
            {formatCount(deleteCount)}
          </span>
        )}
      </Button>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="data-[size=default]:sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogMedia className={tone.destructive}>
              <IconTrash />
            </AlertDialogMedia>
            <AlertDialogTitle>Delete files from {deleting.length === 1 ? "the target" : "targets"}?</AlertDialogTitle>
            <AlertDialogDescription>
              These items don't exist in the source and will be deleted. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="flex max-h-56 flex-col gap-2 overflow-y-auto">
            {deleting.map((it) => (
              <li key={it.projectId} className="flex flex-col gap-1 rounded-md bg-muted px-2.5 py-2 text-xs">
                <span className="min-w-0 wrap-anywhere">
                  <span className="font-medium">{it.name}:</span> {plural(it.plan!.delete.files, "file")} and{" "}
                  {plural(it.plan!.delete.dirs, "folder")} will be deleted from
                </span>
                {/* The full path, wrapped: the user must be able to check which folder is affected. */}
                <span className="font-mono break-all">{it.target}</span>
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                onStart();
              }}
            >
              Delete &amp; sync
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ActionFooter>
  );
}

function PreviewRow({
  item,
  warnings,
  expanded,
  onToggleExpanded,
  onSetInclude,
}: {
  item: BatchItem;
  warnings: string[];
  expanded: boolean;
  onToggleExpanded: () => void;
  onSetInclude: (include: boolean) => void;
}) {
  const plan = item.plan;
  const expandable = !!plan;
  const includable = canInclude(item);
  const problem =
    item.scan === "skipped"
      ? { icon: <IconBan className="size-3.5" />, label: "Skipped", reason: item.skipReason, tone: "warning" as const }
      : item.scan === "failed"
        ? { icon: <IconCircleX className="size-3.5" />, label: "Scan failed", reason: item.scanError, tone: "destructive" as const }
        : item.scan === "cancelled"
          ? { icon: <IconCircleX className="size-3.5" />, label: "Cancelled", reason: null, tone: "muted" as const }
          : null;

  return (
    <li>
      <div className="flex items-start gap-3 px-3 py-2.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="mt-0.5 flex">
              <Checkbox
                checked={item.include}
                disabled={!includable}
                onCheckedChange={(v) => onSetInclude(v === true)}
                aria-label={`Include ${item.name} in the sync`}
              />
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {includable
              ? item.include
                ? "Included in the sync"
                : "Not included"
              : problem
                ? "Can't be synced"
                : "Nothing to sync"}
          </TooltipContent>
        </Tooltip>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <button
              type="button"
              className="flex min-w-0 items-center gap-1 rounded-sm text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default"
              onClick={onToggleExpanded}
              disabled={!expandable}
              aria-expanded={expandable ? expanded : undefined}
            >
              <IconChevronRight
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform",
                  expanded && "rotate-90",
                  !expandable && "invisible",
                )}
              />
              <span className="truncate">{item.name}</span>
            </button>
            {plan && !hasWork(plan) && (
              <Badge className={tone.success}>
                <IconCircleCheck />
                Already in sync
              </Badge>
            )}
            {plan && plan.warnings.length > 0 && (
              <Badge className={tone.warning}>
                <IconAlertTriangle />
                {plural(plan.warnings.length, "warning")}
              </Badge>
            )}
            {warnings.length > 0 && (
              <Badge className={tone.warning}>
                <IconAlertTriangle />
                Rescan afterwards
              </Badge>
            )}
            {problem && (
              <Badge className={tone[problem.tone]}>
                {problem.icon}
                {problem.label}
              </Badge>
            )}
            <div className="ml-auto">{plan && hasWork(plan) && <PlanChips plan={plan} />}</div>
          </div>
          {problem?.reason ? (
            <p className={cn("pl-5 text-xs break-words", toneText[problem.tone])}>{problem.reason}</p>
          ) : (
            <div className="flex min-w-0 items-center gap-1 pl-5 text-muted-foreground">
              <span aria-hidden className="shrink-0 font-mono text-xs">
                →
              </span>
              <AbsolutePath path={item.target} className="flex-1 text-muted-foreground" />
            </div>
          )}
          {warnings.map((w) => (
            <p key={w} className={cn("pl-5 text-xs", toneText.warning)}>
              {w}.
            </p>
          ))}
        </div>
      </div>

      {expanded && plan && (
        <div className="border-t bg-muted/20 p-3">
          <PlanDetails plan={plan} />
        </div>
      )}
    </li>
  );
}

/** "Scanned in 1.2s with 8 threads" (sum of the scan times; a range when the projects differ). */
function scanSummary(plans: PlanSummary[]): { ms: number; threads: string } | null {
  const threads = [...new Set(plans.map((p) => p.scanThreads).filter((n) => typeof n === "number" && n > 0))];
  if (plans.length === 0 || threads.length === 0) return null;
  const min = Math.min(...threads);
  const max = Math.max(...threads);
  return {
    ms: plans.reduce((sum, p) => sum + (p.scanMs || 0), 0),
    threads: min === max ? plural(min, "thread") : `${min}–${max} threads`,
  };
}

const CHIP_ACTIONS: PlanAction[] = ["copy", "update", "verify", "delete"];

/** "+12 ~3 ≈4 −2 · 1.2 GB" — the per-project change counts as small tinted chips. */
function PlanChips({ plan }: { plan: PlanSummary }) {
  const count = (a: PlanAction) => (a === "delete" ? plan.delete.files + plan.delete.dirs : plan[a].files);
  return (
    <div className="flex items-center gap-1.5">
      {CHIP_ACTIONS.filter((a) => count(a) > 0).map((a) => {
        const meta = ACTION_META[a];
        const Icon = meta.icon;
        return (
          <Tooltip key={a}>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "inline-flex h-5 cursor-default items-center gap-1 rounded-full px-1.5 text-[0.7rem] font-medium tabular-nums",
                  tone[meta.tone],
                )}
                tabIndex={0}
              >
                <Icon className="size-3" />
                {formatCount(count(a))}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {meta.label}: {meta.description}
            </TooltipContent>
          </Tooltip>
        );
      })}
      <span className="ml-1 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
        {formatBytes(plan.totalBytes)}
      </span>
    </div>
  );
}
