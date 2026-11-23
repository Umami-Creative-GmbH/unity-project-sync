import { useDeferredValue, useMemo, useState } from "react";
import {
  IconArrowLeft,
  IconChevronDown,
  IconCircleCheck,
  IconFilter,
  IconPlayerPlay,
  IconRefresh,
  IconAlertTriangle,
  IconTrash,
} from "@tabler/icons-react";

import { ACTION_META, REASON_LABEL } from "@/components/plan-meta";
import { RelativePath } from "@/components/path-text";
import { tone, toneText, type Tone } from "@/components/tone";
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
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatBytes, formatCount, formatDuration, plural } from "@/lib/format";
import type { PlanAction, PlanEntry, PlanSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

const MAX_ROWS = 500;

type Filter = PlanAction | "all";
const FILTERS: Filter[] = ["all", "copy", "update", "verify", "delete"];

interface PlanPreviewProps {
  plan: PlanSummary;
  onBack: () => void;
  onStart: () => void;
  onRescan: () => void;
}

export function PlanPreview({ plan, onBack, onStart, onRescan }: PlanPreviewProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const nothingToDo = plan.totalEntries === 0;
  const deleteCount = plan.delete.files + plan.delete.dirs;
  const transferFiles = plan.copy.files + plan.update.files + plan.verify.files;

  const handleStart = () => {
    if (deleteCount > 0) setConfirmOpen(true);
    else onStart();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <StatTile action="copy" files={plan.copy.files} bytes={plan.copy.bytes} />
        <StatTile action="update" files={plan.update.files} bytes={plan.update.bytes} />
        <StatTile action="verify" files={plan.verify.files} bytes={plan.verify.bytes} />
        <StatTile
          action="delete"
          files={plan.delete.files}
          bytes={plan.delete.bytes}
          extra={plan.delete.dirs > 0 ? plural(plan.delete.dirs, "folder") : undefined}
        />
        <StatTile
          action="unchanged"
          files={plan.unchanged.files}
          bytes={plan.unchanged.bytes}
          className="col-span-2 sm:col-span-1"
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span>
          {plan.verify.files > 0 ? "Up to " : ""}
          <span className="font-medium text-foreground">{formatBytes(plan.totalBytes)}</span> to transfer
          {transferFiles > 0 && <> in {plural(transferFiles, "file")}</>}
        </span>
        <span>Scanned in {formatDuration(plan.scanMs)}</span>
      </div>

      {plan.warnings.length > 0 && <WarningsPanel warnings={plan.warnings} />}

      {nothingToDo ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
            <div className={cn("flex size-12 items-center justify-center rounded-full", tone.success)}>
              <IconCircleCheck className="size-6" />
            </div>
            <h2 className="text-base font-medium">Already in sync</h2>
            <p className="max-w-sm text-sm text-muted-foreground">
              All {plural(plan.unchanged.files, "file")} in the scope match the source. There is nothing to copy or delete.
            </p>
          </CardContent>
        </Card>
      ) : (
        <EntryList plan={plan} />
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" onClick={onBack}>
          <IconArrowLeft data-icon="inline-start" />
          Back
        </Button>
        {nothingToDo ? (
          <Button variant="outline" onClick={onRescan}>
            <IconRefresh data-icon="inline-start" />
            Scan again
          </Button>
        ) : (
          <Button
            size="lg"
            onClick={handleStart}
            aria-label={deleteCount > 0 ? `Start sync, including ${formatCount(deleteCount)} deletions` : "Start sync"}
          >
            <IconPlayerPlay data-icon="inline-start" />
            Start sync
            {deleteCount > 0 && (
              <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-destructive px-1.5 py-px text-[0.7rem] font-medium text-white">
                <IconTrash className="size-3" />
                {formatCount(deleteCount)}
              </span>
            )}
          </Button>
        )}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className={tone.destructive}>
              <IconTrash />
            </AlertDialogMedia>
            <AlertDialogTitle>Delete files from target?</AlertDialogTitle>
            <AlertDialogDescription>
              {plural(plan.delete.files, "file")} and {plural(plan.delete.dirs, "folder")} will be deleted from the
              target because they don't exist in the source. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="truncate rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs" title={plan.target}>
            {plan.target}
          </div>
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
    </div>
  );
}

function StatTile({
  action,
  files,
  bytes,
  extra,
  className,
}: {
  action: PlanAction | "unchanged";
  files: number;
  bytes: number;
  extra?: string;
  className?: string;
}) {
  const meta = ACTION_META[action];
  const Icon = meta.icon;
  const active = files > 0 || (extra !== undefined && action === "delete");
  const t: Tone = active ? meta.tone : "muted";
  return (
    <div
      className={cn("flex min-w-0 flex-col gap-1.5 rounded-xl border bg-card p-3", className)}
      title={meta.description}
    >
      <div className={cn("flex items-center gap-1.5 text-xs font-medium", toneText[t])}>
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{meta.label}</span>
      </div>
      <div className={cn("text-xl font-semibold tabular-nums", !active && "text-muted-foreground")}>
        {formatCount(files)}
      </div>
      <div className="truncate text-xs text-muted-foreground">
        {formatBytes(bytes)}
        {extra && <> · {extra}</>}
      </div>
    </div>
  );
}

export function WarningsPanel({ warnings }: { warnings: string[] }) {
  return (
    <Collapsible className={cn("rounded-lg", tone.warning)}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        <IconAlertTriangle className="size-4 shrink-0" />
        <span className="flex-1">{plural(warnings.length, "warning")} while scanning</span>
        <IconChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="max-h-40 overflow-y-auto px-3 pb-2.5 font-mono text-xs leading-relaxed text-foreground/80">
          {warnings.map((w, i) => (
            <li key={i} className="break-all">
              {w}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function EntryList({ plan }: { plan: PlanSummary }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);

  // Entries actually loaded (the backend caps the list; deletions always survive the cap).
  const loaded = useMemo(() => {
    const c: Record<Filter, number> = { all: plan.entries.length, copy: 0, update: 0, verify: 0, delete: 0 };
    for (const e of plan.entries) c[e.action]++;
    return c;
  }, [plan.entries]);

  // Tab badges come from the uncapped plan totals (deletions: files + folders, like the tile and the
  // confirmation), never from the capped list.
  const counts = useMemo<Record<Filter, number>>(
    () => ({
      all: Math.max(plan.totalEntries, loaded.all),
      // Empty folders are listed as "copy" entries but not counted in copy.files.
      copy: Math.max(plan.copy.files, loaded.copy),
      update: Math.max(plan.update.files, loaded.update),
      verify: Math.max(plan.verify.files, loaded.verify),
      delete: Math.max(plan.delete.files + plan.delete.dirs, loaded.delete),
    }),
    [plan, loaded],
  );
  // A tab whose list is incomplete because of the cap (deleted folders list their root only).
  const partial =
    plan.entriesTruncated && filter !== "delete" && loaded[filter] < counts[filter]
      ? { loaded: loaded[filter], total: counts[filter] }
      : null;

  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    const result: PlanEntry[] = [];
    let total = 0;
    for (const e of plan.entries) {
      if (filter !== "all" && e.action !== filter) continue;
      if (q && !e.path.toLowerCase().includes(q)) continue;
      total++;
      if (result.length < MAX_ROWS) result.push(e);
    }
    return { rows: result, total };
  }, [plan.entries, filter, deferredQuery]);

  return (
    <Card size="sm" className="gap-0 py-0">
      <div className="flex flex-col gap-2 border-b p-3 sm:flex-row sm:items-center">
        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)} className="min-w-0">
          <TabsList className="max-w-full overflow-x-auto">
            {FILTERS.map((f) => (
              <TabsTrigger key={f} value={f} className="gap-1 px-2 text-xs">
                {f === "all" ? "All" : ACTION_META[f].label}
                <span className="tabular-nums text-muted-foreground">{formatCount(counts[f])}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="relative min-w-0 flex-1">
          <IconFilter className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by path…"
            aria-label="Filter files by path"
            className="h-8 pl-8 text-sm"
          />
        </div>
      </div>

      <ScrollArea className="h-72">
        {filtered.rows.length === 0 ? (
          <div className="flex h-72 items-center justify-center px-4 text-center text-sm text-muted-foreground">
            {partial && !deferredQuery.trim()
              ? `${formatCount(partial.total)} entries of this kind are not loaded (the list is capped).`
              : "No entries match this filter."}
          </div>
        ) : (
          <ul className="divide-y">
            {filtered.rows.map((e) => (
              <EntryRow key={`${e.action}:${e.path}`} entry={e} />
            ))}
          </ul>
        )}
      </ScrollArea>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t px-3 py-2 text-xs text-muted-foreground">
        <span>
          Showing {formatCount(filtered.rows.length)} of {formatCount(filtered.total)}
          {filtered.total > MAX_ROWS && " — refine the filter to see more"}
        </span>
        {filter === "delete" && plan.delete.dirs > 0 && (
          <span>Deleted folders are listed once; their contents are included in the count.</span>
        )}
        {partial ? (
          <span className={toneText.warning}>
            {formatCount(partial.loaded)} of {formatCount(partial.total)} loaded (list capped)
          </span>
        ) : (
          plan.entriesTruncated && (
            <span className={toneText.warning}>
              List capped: {formatCount(plan.entries.length)} of {formatCount(plan.totalEntries)} entries loaded
            </span>
          )
        )}
      </div>
    </Card>
  );
}

function EntryRow({ entry }: { entry: PlanEntry }) {
  const meta = ACTION_META[entry.action];
  return (
    <li className="grid grid-cols-[4.25rem_minmax(0,1fr)_auto] items-center gap-3 px-3 py-1.5 hover:bg-muted/40">
      <Badge className={cn("w-full", tone[meta.tone])} title={REASON_LABEL[entry.reason]}>
        {meta.badge}
      </Badge>
      <RelativePath path={entry.path} isDir={entry.isDir} />
      <span className="text-right text-xs tabular-nums text-muted-foreground">
        {entry.isDir ? "folder" : formatBytes(entry.size)}
      </span>
    </li>
  );
}
