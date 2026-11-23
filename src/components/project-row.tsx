import {
  IconAlertTriangle,
  IconArrowRight,
  IconBolt,
  IconCopy,
  IconCrown,
  IconDots,
  IconPencil,
  IconPlayerPlay,
  IconTargetArrow,
  IconTrash,
} from "@tabler/icons-react";

import { folderStatus } from "@/components/folder-card";
import { OUTCOME_META, OutcomeIcon } from "@/components/outcome";
import { AbsolutePath } from "@/components/path-text";
import { tone } from "@/components/tone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FolderInfoState } from "@/hooks/use-folder-infos";
import { formatBytes, formatDateTime, formatDuration, formatRelativeTime, plural } from "@/lib/format";
import { projectDisplayName, type ProjectIssue } from "@/lib/projects";
import type { ProjectLastRun, SyncProject } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ProjectRowProps {
  project: SyncProject;
  sourceState: FolderInfoState | undefined;
  targetState: FolderInfoState | undefined;
  /** Validation problems with the latest folder info; empty when the project can be synced. */
  issues: ProjectIssue[];
  /**
   * Its target is also used by another project (they can't run in the same batch). Not blocking:
   * the project can still be synced on its own.
   */
  sharedTarget?: string | null;
  selected: boolean;
  disabled: boolean;
  now: number;
  onSelectedChange: (selected: boolean) => void;
  onEdit: () => void;
  onSync: (autoSync: boolean) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function ProjectRow({
  project,
  sourceState,
  targetState,
  issues,
  sharedTarget,
  selected,
  disabled,
  now,
  onSelectedChange,
  onEdit,
  onSync,
  onDuplicate,
  onDelete,
}: ProjectRowProps) {
  const name = projectDisplayName(project);
  const needsAttention = issues.length > 0;
  const sourceStatus = folderStatus("source", project.source, sourceState?.info ?? null, sourceState?.loading ?? !!project.source);
  const targetStatus = folderStatus("target", project.target, targetState?.info ?? null, targetState?.loading ?? !!project.target);
  const targetNeedsAck = issues.some((i) => i.code === "targetNeedsAck");
  const targetLabel = targetNeedsAck ? "Not Unity — unconfirmed" : targetStatus.label;
  const descId = `${project.id}-desc`;
  const lastRunMeta = project.lastRun ? OUTCOME_META[project.lastRun.outcome] : null;
  // One description for screen readers instead of a tab stop per path, badge and cell.
  const description = [
    `${project.source ?? "No source"} to ${project.target ?? "No target"}.`,
    `Source: ${sourceStatus.label}.`,
    `Target: ${targetLabel}.`,
    project.lastRun && lastRunMeta
      ? `Last sync: ${lastRunMeta.label}, ${formatRelativeTime(project.lastRun.finishedAt, now)}.`
      : "Never synced.",
    needsAttention ? `Needs attention: ${issues.map((i) => i.message).join("; ")}.` : "",
    sharedTarget ? `${sharedTarget}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <li
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)_7rem_auto] items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/30",
        selected && "bg-muted/40 hover:bg-muted/50",
      )}
    >
      <Checkbox
        checked={selected}
        disabled={disabled}
        onCheckedChange={(v) => onSelectedChange(v === true)}
        aria-label={`Select ${name}`}
      />

      {/* Main cell — clicking it opens the editor. */}
      <div
        className={cn("flex min-w-0 flex-col gap-1", !disabled && "cursor-pointer")}
        onClick={disabled ? undefined : onEdit}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <button
            type="button"
            className="max-w-full min-w-0 truncate rounded-sm text-left text-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 disabled:no-underline"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            disabled={disabled}
            title={name}
            aria-describedby={descId}
          >
            {name}
          </button>
          <span id={descId} className="sr-only">
            {description}
          </span>
          {needsAttention && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge className={cn("cursor-default", tone.warning)}>
                  <IconAlertTriangle />
                  Needs attention
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="block max-w-72">
                <ul className="list-disc pl-3.5">
                  {issues.map((i) => (
                    <li key={i.code}>{i.message}</li>
                  ))}
                </ul>
              </TooltipContent>
            </Tooltip>
          )}
          {sharedTarget && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge className={cn("cursor-default", tone.warning)}>
                  <IconCopy />
                  Shared target
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-72">{sharedTarget}</TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Paths with each folder's status right below it. */}
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-1.5 gap-y-1 text-muted-foreground">
          {project.source ? (
            <AbsolutePath path={project.source} focusable={false} />
          ) : (
            <span className="truncate text-xs italic">No source</span>
          )}
          <IconArrowRight className="size-3.5" aria-label="mirrors into" />
          {project.target ? (
            <AbsolutePath path={project.target} focusable={false} />
          ) : (
            <span className="truncate text-xs italic">No target</span>
          )}
          <StatusBadge role="source" label={sourceStatus.label} toneName={sourceStatus.tone} />
          <span aria-hidden />
          <StatusBadge role="target" label={targetLabel} toneName={targetStatus.tone} />
        </div>
      </div>

      <LastRunCell lastRun={project.lastRun} now={now} />

      <div className="flex w-[8.5rem] items-center justify-end gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={needsAttention ? 0 : -1}>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled || needsAttention}
                onClick={() => onSync(false)}
                aria-label={`Sync ${name}`}
              >
                <IconPlayerPlay data-icon="inline-start" />
                Sync
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {needsAttention ? "Fix the problems in the editor first" : "Scan this project and preview the changes"}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" disabled={disabled} onClick={onEdit} aria-label={`Edit ${name}`}>
              <IconPencil />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Edit</TooltipContent>
        </Tooltip>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" disabled={disabled} aria-label={`More actions for ${name}`}>
              <IconDots />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem disabled={needsAttention} onSelect={() => onSync(true)}>
              <IconBolt />
              Sync now (no preview)
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onEdit}>
              <IconPencil />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onDuplicate}>
              <IconCopy />
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <IconTrash />
              Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

function StatusBadge({
  role,
  label,
  toneName,
}: {
  role: "source" | "target";
  label: string;
  toneName: keyof typeof tone;
}) {
  const Icon = role === "source" ? IconCrown : IconTargetArrow;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge className={cn("max-w-full cursor-default", tone[toneName])}>
          <Icon />
          <span className="truncate">{label}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        {role === "source" ? "Source" : "Target"}: {label}
      </TooltipContent>
    </Tooltip>
  );
}

function lastRunDetail(run: ProjectLastRun): string {
  if (run.outcome === "failed") return "The scan or sync failed";
  if (run.outcome === "partial") return plural(run.errorCount, "error");
  if (run.outcome === "cancelled") return "Cancelled";
  if (run.filesWritten > 0) return `${plural(run.filesWritten, "file")} written`;
  if (run.deleted > 0) return `${plural(run.deleted, "item")} deleted`;
  return "No changes";
}

function LastRunCell({ lastRun, now }: { lastRun: ProjectLastRun | null; now: number }) {
  if (!lastRun) {
    return <div className="text-xs text-muted-foreground">Never synced</div>;
  }
  const meta = OUTCOME_META[lastRun.outcome];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex min-w-0 cursor-default flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-1.5 text-xs">
            <OutcomeIcon outcome={lastRun.outcome} className="size-3.5" />
            <span className="truncate">{formatRelativeTime(lastRun.finishedAt, now)}</span>
          </div>
          <div className="truncate pl-5 text-[0.7rem] text-muted-foreground">{lastRunDetail(lastRun)}</div>
        </div>
      </TooltipTrigger>
      <TooltipContent className="block leading-relaxed">
        <div className="font-medium">{meta.label}</div>
        <div>{formatDateTime(lastRun.finishedAt)}</div>
        {lastRun.outcome !== "failed" && (
          <div>
            {plural(lastRun.filesWritten, "file")} written ({formatBytes(lastRun.bytesWritten)}),{" "}
            {plural(lastRun.deleted, "item")} deleted
            {lastRun.durationMs > 0 && <> in {formatDuration(lastRun.durationMs)}</>}
          </div>
        )}
        {lastRun.errorCount > 0 && lastRun.outcome !== "failed" && <div>{plural(lastRun.errorCount, "error")}</div>}
      </TooltipContent>
    </Tooltip>
  );
}
