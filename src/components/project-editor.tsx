import { useMemo, useState } from "react";
import { open as openFolderPicker } from "@tauri-apps/plugin-dialog";
import { IconAlertTriangle, IconArrowsLeftRight, IconDeviceFloppy, IconTrash } from "@tabler/icons-react";
import { toast } from "sonner";

import { FolderCard, InlineNotice, type FolderRole } from "@/components/folder-card";
import { DeleteProjectDialog } from "@/components/project-list";
import { ScopeEditor } from "@/components/scope-editor";
import { toneText } from "@/components/tone";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useProjectInfo } from "@/hooks/use-project-info";
import { errorMessage } from "@/lib/api";
import {
  defaultProjectName,
  sharedTargetConflicts,
  swapFolders,
  targetNeedsAck,
  validateProject,
  withSource,
  withTarget,
} from "@/lib/projects";
import { cloneScope, sanitizeScope, scopesEqual } from "@/lib/scope";
import type { SyncProject, SyncScope } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ProjectEditorProps {
  /** The project to edit (a fresh one for "Add project"). */
  project: SyncProject;
  isNew: boolean;
  defaultScope: SyncScope;
  /** Bumped by the app to re-inspect folders (e.g. on window focus). */
  refreshKey: number;
  /** The other saved projects, to point out a target they already use. */
  otherProjects?: Pick<SyncProject, "id" | "name" | "source" | "target">[];
  onSave: (project: SyncProject) => void;
  onCancel: () => void;
  onDelete: (id: string) => void;
}

/** Large dialog to create or edit a project. Mount it per edit session (keyed), it keeps a draft. */
export function ProjectEditor({
  project,
  isNew,
  defaultScope,
  refreshKey,
  otherProjects = [],
  onSave,
  onCancel,
  onDelete,
}: ProjectEditorProps) {
  const [draft, setDraft] = useState<SyncProject>(project);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // A custom exclusion pattern typed but not added yet (it only reaches the scope via Add/Enter).
  const [pendingExclude, setPendingExclude] = useState("");
  // Unsaved edits (for a new project, the fresh project is the baseline).
  const dirty =
    pendingExclude !== "" ||
    draft.name !== project.name ||
    draft.source !== project.source ||
    draft.target !== project.target ||
    draft.targetAck !== project.targetAck ||
    !scopesEqual(sanitizeScope(draft.scope), sanitizeScope(project.scope));
  /** Esc, the X button and Cancel: ask before throwing edits away. */
  const requestClose = () => (dirty ? setConfirmDiscard(true) : onCancel());
  const sharedTarget = useMemo(
    () => sharedTargetConflicts([draft, ...otherProjects.filter((p) => p.id !== draft.id)])[draft.id] ?? null,
    [draft, otherProjects],
  );
  const source = useProjectInfo(draft.source, refreshKey);
  const target = useProjectInfo(draft.target, refreshKey);

  const issues = useMemo(
    () => validateProject(draft, source.info, target.info),
    [draft, source.info, target.info],
  );
  const has = (code: string) => issues.some((i) => i.code === code);
  const needsAck = targetNeedsAck(target.info);
  const versionMismatch =
    source.info?.unityVersion && target.info?.unityVersion && source.info.unityVersion !== target.info.unityVersion;

  const browse = async (role: FolderRole) => {
    const current = role === "source" ? draft.source : draft.target;
    try {
      const picked = await openFolderPicker({
        directory: true,
        multiple: false,
        title: role === "source" ? "Choose the source Unity project" : "Choose the target folder",
        defaultPath: current ?? undefined,
      });
      if (!picked) return;
      setDraft((d) => (role === "source" ? withSource(d, picked) : withTarget(d, picked)));
    } catch (e) {
      toast.error("Couldn't open the folder picker", { description: errorMessage(e) });
    }
  };

  const save = () => {
    // Never drop a typed pattern silently; adding it may fail, and the user must see why.
    if (pendingExclude) {
      toast.warning("Add or clear the custom exclusion pattern first", { description: pendingExclude });
      document.getElementById("custom-exclude")?.focus();
      return;
    }
    const name = draft.name.trim() || defaultProjectName(draft.source);
    onSave({ ...draft, name, scope: sanitizeScope(draft.scope) });
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        // `open` stays true until the parent unmounts the editor (onCancel), so not calling it keeps it open.
        if (!o) requestClose();
      }}
    >
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(48rem,calc(100%-2rem))]"
        // A stray click next to the dialog doesn't throw away unsaved edits (and doesn't prompt either).
        onInteractOutside={(e) => {
          if (dirty) e.preventDefault();
        }}
      >
        <DialogHeader className="shrink-0 border-b px-4 pt-4 pb-3">
          <DialogTitle>{isNew ? "Add project" : "Edit project"}</DialogTitle>
          <DialogDescription>
            The source is the truth: its files are mirrored into the target, within the sync scope.
          </DialogDescription>
        </DialogHeader>

        {/* Not a <form>: the reused folder/scope components contain plain buttons. */}
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              value={draft.name}
              placeholder={defaultProjectName(draft.source) || "Named after the source folder"}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  save();
                }
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <section
            aria-label="Folders"
            className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-start"
          >
            <FolderCard
              role="source"
              path={draft.source}
              info={source.info}
              inspecting={source.loading}
              onBrowse={() => void browse("source")}
            >
              {has("sourceMissing") && <InlineNotice variant="destructive">This folder doesn't exist.</InlineNotice>}
              {has("sourceNotUnity") && (
                <InlineNotice variant="warning">
                  The source must be a Unity project (with <span className="font-mono">Assets</span> and{" "}
                  <span className="font-mono">ProjectSettings</span> folders).
                </InlineNotice>
              )}
              {source.error && <InlineNotice variant="destructive">{source.error}</InlineNotice>}
            </FolderCard>

            <div className="flex justify-center sm:pt-12">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="rounded-full"
                    onClick={() => setDraft((d) => swapFolders(d))}
                    disabled={!draft.source && !draft.target}
                    aria-label="Swap source and target"
                  >
                    <IconArrowsLeftRight className="rotate-90 sm:rotate-0" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Swap source and target</TooltipContent>
              </Tooltip>
            </div>

            <FolderCard
              role="target"
              path={draft.target}
              info={target.info}
              inspecting={target.loading}
              onBrowse={() => void browse("target")}
            >
              {needsAck && (
                <div className="flex flex-col gap-2">
                  <InlineNotice variant="warning">
                    This folder isn't empty and isn't a Unity project. Anything inside the sync scope that doesn't exist
                    in the source will be <strong>deleted</strong> here.
                  </InlineNotice>
                  <div className="flex items-start gap-2 px-0.5">
                    <Checkbox
                      id="target-ack"
                      className="mt-0.5"
                      checked={draft.targetAck}
                      onCheckedChange={(v) => setDraft((d) => ({ ...d, targetAck: v === true }))}
                    />
                    <Label htmlFor="target-ack" className="text-xs leading-snug font-normal">
                      I understand — use this folder as the target anyway.
                    </Label>
                  </div>
                </div>
              )}
              {versionMismatch && (
                <InlineNotice variant="info">
                  Different Unity version than the source ({source.info!.unityVersion}). The target will take the
                  source's version.
                </InlineNotice>
              )}
              {target.error && <InlineNotice variant="destructive">{target.error}</InlineNotice>}
              {sharedTarget && (
                <InlineNotice variant="warning">
                  {sharedTarget}. Each can still be synced on its own; a batch with both skips them.
                </InlineNotice>
              )}
            </FolderCard>
          </section>

          {has("overlap") && (
            <InlineNotice variant="destructive">
              Source and target must be different folders, and neither may be inside the other.
            </InlineNotice>
          )}

          <ScopeEditor
            scope={draft.scope}
            isDefault={scopesEqual(draft.scope, defaultScope)}
            sourceInfo={source.info}
            onChange={(s) => setDraft((d) => ({ ...d, scope: sanitizeScope(s) }))}
            onPendingExcludeChange={setPendingExclude}
            onReset={() =>
              setDraft((d) => ({
                ...d,
                scope: cloneScope(defaultScope),
              }))
            }
          />
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t bg-muted/50 px-4 py-3">
          {!isNew && (
            <Button type="button" variant="ghost" className={toneText.destructive} onClick={() => setConfirmDelete(true)}>
              <IconTrash data-icon="inline-start" />
              Delete
            </Button>
          )}
          <div className="min-w-0 flex-1 text-xs text-muted-foreground">
            {issues.length > 0 && (
              <span className={cn("inline-flex items-start gap-1.5", toneText.warning)}>
                <IconAlertTriangle className="mt-px size-3.5 shrink-0" />
                <span>
                  {issues[0].code === "targetNeedsAck" ? "Confirm the target folder warning" : issues[0].message}
                  {issues.length > 1 && ` (+${issues.length - 1} more)`}. You can save it, but it can't be synced until
                  fixed.
                </span>
              </span>
            )}
          </div>
          <Button type="button" variant="outline" onClick={requestClose}>
            Cancel
          </Button>
          <Button type="button" onClick={save}>
            <IconDeviceFloppy data-icon="inline-start" />
            {isNew ? "Add project" : "Save"}
          </Button>
        </div>

        <DeleteProjectDialog
          project={confirmDelete ? draft : null}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            onDelete(draft.id);
          }}
        />

        <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>Discard changes?</AlertDialogTitle>
              <AlertDialogDescription>
                {isNew ? "This project hasn't been added yet." : "Your edits to this project haven't been saved."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep editing</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  setConfirmDiscard(false);
                  onCancel();
                }}
              >
                Discard
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
