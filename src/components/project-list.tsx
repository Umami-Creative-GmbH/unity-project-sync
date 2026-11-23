import { useState } from "react";
import { IconFolders, IconPlus, IconTrash } from "@tabler/icons-react";

import { ProjectRow } from "@/components/project-row";
import { tone } from "@/components/tone";
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
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import type { FolderInfoState } from "@/hooks/use-folder-infos";
import { projectDisplayName, type ProjectIssue } from "@/lib/projects";
import type { SyncProject } from "@/lib/types";

interface ProjectListProps {
  projects: SyncProject[];
  infos: Record<string, FolderInfoState>;
  issuesById: Record<string, ProjectIssue[]>;
  /** Non-blocking: projects whose target is also used by another project (see sharedTargetConflicts). */
  sharedTargetById?: Record<string, string>;
  selected: Set<string>;
  disabled: boolean;
  now: number;
  onSelectedChange: (selected: Set<string>) => void;
  onAdd: () => void;
  onEdit: (id: string) => void;
  onSync: (id: string, autoSync: boolean) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}

export function ProjectList(props: ProjectListProps) {
  const { projects, selected, disabled } = props;
  const [pendingDelete, setPendingDelete] = useState<SyncProject | null>(null);

  if (projects.length === 0) return <EmptyState onAdd={props.onAdd} disabled={disabled} />;

  const selectedCount = projects.filter((p) => selected.has(p.id)).length;
  const allSelected = selectedCount === projects.length;
  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    props.onSelectedChange(next);
  };

  return (
    <Card className="gap-0 py-0">
      <h2 id="projects-heading" tabIndex={-1} className="sr-only">
        Projects
      </h2>
      <div className="grid grid-cols-[auto_minmax(0,1fr)_7rem_auto] items-center gap-3 border-b bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">
        <Checkbox
          checked={allSelected ? true : selectedCount > 0 ? "indeterminate" : false}
          disabled={disabled}
          onCheckedChange={(v) => props.onSelectedChange(v === true ? new Set(projects.map((p) => p.id)) : new Set())}
          aria-label={allSelected ? "Deselect all projects" : "Select all projects"}
        />
        <span>Project</span>
        <span>Last sync</span>
        {/* Width of the action buttons, so the header columns line up with the rows. */}
        <span className="w-[8.5rem]" aria-hidden />
      </div>
      <ul className="divide-y">
        {projects.map((p) => (
          <ProjectRow
            key={p.id}
            project={p}
            sourceState={p.source ? props.infos[p.source] : undefined}
            targetState={p.target ? props.infos[p.target] : undefined}
            issues={props.issuesById[p.id] ?? []}
            sharedTarget={props.sharedTargetById?.[p.id] ?? null}
            selected={selected.has(p.id)}
            disabled={disabled}
            now={props.now}
            onSelectedChange={(on) => toggle(p.id, on)}
            onEdit={() => props.onEdit(p.id)}
            onSync={(autoSync) => props.onSync(p.id, autoSync)}
            onDuplicate={() => props.onDuplicate(p.id)}
            onDelete={() => setPendingDelete(p)}
          />
        ))}
      </ul>

      <DeleteProjectDialog
        project={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) props.onDelete(pendingDelete.id);
          setPendingDelete(null);
        }}
      />
    </Card>
  );
}

/** Confirmation before removing a project from the list (no files are touched). */
export function DeleteProjectDialog({
  project,
  onCancel,
  onConfirm,
}: {
  project: Pick<SyncProject, "name" | "source"> | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={!!project} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className={tone.destructive}>
            <IconTrash />
          </AlertDialogMedia>
          <AlertDialogTitle className="max-w-full min-w-0 wrap-anywhere">
            Delete “{project ? projectDisplayName(project) : ""}”?
          </AlertDialogTitle>
          <AlertDialogDescription>
            The project is removed from the list. No files are deleted — the source and target folders stay as they
            are.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Delete project
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function EmptyState({ onAdd, disabled }: { onAdd: () => void; disabled: boolean }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-muted">
          <IconFolders className="size-7 text-muted-foreground" />
        </div>
        <div className="flex flex-col gap-1">
          <h2 id="projects-heading" tabIndex={-1} className="text-base font-medium outline-none">
            No projects yet
          </h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            A project pairs a source Unity project with a target folder. Add one, then sync it whenever you like — or
            sync several in one go.
          </p>
        </div>
        <Button size="lg" onClick={onAdd} disabled={disabled} className="mt-1">
          <IconPlus data-icon="inline-start" />
          Add your first project
        </Button>
      </CardContent>
    </Card>
  );
}
