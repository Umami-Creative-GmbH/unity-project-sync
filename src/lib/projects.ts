// Pure helpers for saved projects (source → target pairs): creation, naming, validation and the
// cross-project conflict checks of a batch run. No Tauri imports — unit-tested in projects.test.ts.
import { isScopeEmpty, pathsOverlap } from "@/lib/scope";
import type { ProjectInfo, SyncProject, SyncScope } from "@/lib/types";

export const UNTITLED_PROJECT = "Untitled project";

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Fallback for very old webviews; ids only need to be unique within the stored list.
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function cloneScope(scope: SyncScope): SyncScope {
  return { includeRootFiles: scope.includeRootFiles, folders: [...scope.folders] };
}

/**
 * The last segment of a folder path, used as the default project name.
 *   "C:\Work\MyGame\"     → "MyGame"
 *   "/home/me/MyGame"     → "MyGame"
 *   "C:\" or "C:"         → "C:"
 *   "\\server\share\"     → "share"
 *   "/"                   → "/"
 */
export function defaultProjectName(path: string | null | undefined): string {
  if (!path) return "";
  const trimmed = path.trim();
  if (!trimmed) return "";
  const withoutTrailing = trimmed.replace(/[\\/]+$/, "");
  if (!withoutTrailing) return "/"; // the Unix root
  const segments = withoutTrailing.split(/[\\/]+/).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : withoutTrailing;
}

/** The name shown in the UI: the saved name, else the source folder's name, else "Untitled project". */
export function projectDisplayName(project: Pick<SyncProject, "name" | "source">): string {
  return project.name.trim() || defaultProjectName(project.source) || UNTITLED_PROJECT;
}

/**
 * True while the name follows the source folder (it was never customised): an empty name or the
 * default name of `previousSource`. Picking a new source then updates the name automatically.
 */
export function nameFollowsSource(name: string, previousSource: string | null): boolean {
  const n = name.trim();
  return n === "" || n === defaultProjectName(previousSource);
}

/** Applies a newly picked source; renames the project too while its name follows the source. */
export function withSource<P extends Pick<SyncProject, "name" | "source">>(project: P, source: string | null): P {
  const name = nameFollowsSource(project.name, project.source) ? defaultProjectName(source) : project.name;
  return { ...project, source, name };
}

/** Applies a newly picked target; a different target always needs a fresh acknowledgement. */
export function withTarget<P extends Pick<SyncProject, "target" | "targetAck">>(project: P, target: string | null): P {
  return { ...project, target, targetAck: target === project.target ? project.targetAck : false };
}

/** Swaps source and target (the name follows the new source while it isn't custom). */
export function swapFolders<P extends Pick<SyncProject, "name" | "source" | "target" | "targetAck">>(project: P): P {
  const swapped = withSource(project, project.target);
  return { ...swapped, target: project.source, targetAck: false };
}

export function createProject(
  defaultScope: SyncScope,
  init: Partial<Pick<SyncProject, "source" | "target" | "scope" | "name">> = {},
  id: string = newId(),
): SyncProject {
  const source = init.source ?? null;
  return {
    id,
    name: init.name ?? defaultProjectName(source),
    source,
    target: init.target ?? null,
    scope: cloneScope(init.scope ?? defaultScope),
    targetAck: false,
    lastRun: null,
  };
}

/**
 * A copy named "X (copy)", "X (copy 2)", … — without the last run and without the target: two
 * projects with the same target can't run in the same batch, so the copy needs a target of its own.
 */
export function duplicateProject(
  project: SyncProject,
  existingNames: string[],
  id: string = newId(),
): SyncProject {
  const base = projectDisplayName(project);
  const taken = new Set(existingNames.map((n) => n.trim().toLowerCase()));
  let name = `${base} (copy)`;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} (copy ${i})`;
  return { ...project, id, name, target: null, targetAck: false, scope: cloneScope(project.scope), lastRun: null };
}

// ---- validation ---------------------------------------------------------------------------------

export type ProjectIssueCode =
  | "noSource"
  | "noTarget"
  | "sourceMissing"
  | "sourceNotUnity"
  | "overlap"
  | "scopeEmpty"
  | "targetNeedsAck";

export interface ProjectIssue {
  code: ProjectIssueCode;
  /** Where the editor shows it. */
  field: "source" | "target" | "folders" | "scope";
  /** Short sentence, also used as a "skipped: …" reason. */
  message: string;
}

const ISSUE: Record<ProjectIssueCode, Omit<ProjectIssue, "code">> = {
  noSource: { field: "source", message: "No source folder chosen" },
  noTarget: { field: "target", message: "No target folder chosen" },
  sourceMissing: { field: "source", message: "Source folder not found" },
  sourceNotUnity: { field: "source", message: "Source is not a Unity project" },
  overlap: { field: "folders", message: "Source and target are the same folder or inside each other" },
  scopeEmpty: { field: "scope", message: "The sync scope is empty" },
  targetNeedsAck: {
    field: "target",
    message: "Target isn't empty and isn't a Unity project — confirm it in the project editor",
  },
};

function issue(code: ProjectIssueCode): ProjectIssue {
  return { code, ...ISSUE[code] };
}

/** A target that exists, has content and is not a Unity project needs an explicit acknowledgement. */
export function targetNeedsAck(info: ProjectInfo | null | undefined): boolean {
  return !!info && info.exists && !info.isEmpty && !info.isUnityProject;
}

/**
 * Everything that keeps a project from being synced. `sourceInfo` / `targetInfo` are the
 * inspection results; when they are unknown (null/undefined) only the static checks run.
 */
export function validateProject(
  project: Pick<SyncProject, "source" | "target" | "scope" | "targetAck">,
  sourceInfo?: ProjectInfo | null,
  targetInfo?: ProjectInfo | null,
): ProjectIssue[] {
  const issues: ProjectIssue[] = [];
  if (!project.source) issues.push(issue("noSource"));
  else if (sourceInfo) {
    if (!sourceInfo.exists) issues.push(issue("sourceMissing"));
    else if (!sourceInfo.isUnityProject) issues.push(issue("sourceNotUnity"));
  }
  if (!project.target) issues.push(issue("noTarget"));
  else if (targetNeedsAck(targetInfo) && !project.targetAck) issues.push(issue("targetNeedsAck"));
  if (project.source && project.target) {
    // As written, and resolved (junctions, symlinks, mapped drives) once both folders are inspected.
    const sc = sourceInfo?.comparePath;
    const tc = targetInfo?.comparePath;
    if (pathsOverlap(project.source, project.target) || (!!sc && !!tc && pathsOverlap(sc, tc))) {
      issues.push(issue("overlap"));
    }
  }
  if (isScopeEmpty(project.scope)) issues.push(issue("scopeEmpty"));
  return issues;
}

/**
 * Projects whose target is the same folder as (or nested with) another project's target, with a
 * short explanation. Such projects can still be synced one at a time, but a batch containing both
 * skips them, so the list flags them ahead of time. `resolve` maps a raw path to its comparison
 * form (ProjectInfo.comparePath) when known.
 */
export function sharedTargetConflicts(
  projects: Pick<SyncProject, "id" | "name" | "source" | "target">[],
  resolve: (path: string) => string = (p) => p,
): Record<string, string> {
  const out: Record<string, string> = {};
  const withTarget = projects
    .filter((p) => !!p.target)
    .map((p) => ({ p, raw: p.target!, cmp: resolve(p.target!) || p.target! }));
  for (const a of withTarget) {
    const b = withTarget.find(
      (x) => x.p.id !== a.p.id && (pathsOverlap(a.raw, x.raw) || pathsOverlap(a.cmp, x.cmp)),
    );
    if (b) {
      out[a.p.id] = `Its target is also used by “${projectDisplayName(b.p)}” — they can't run in the same batch`;
    }
  }
  return out;
}

// ---- cross-project conflicts of one batch -------------------------------------------------------

export interface BatchConflictInput {
  id: string;
  name: string;
  source: string;
  target: string;
}

/** A project's source is written by another project (`byId`) of the same batch. */
export interface BatchWarning {
  byId: string;
  message: string;
}

export interface BatchConflicts {
  /** Projects that must not run in this batch, with the reason. */
  skipped: Record<string, string>;
  /** Projects that run, but whose source is written by another project of the batch. */
  warnings: Record<string, BatchWarning[]>;
}

/**
 * Checks the projects of one batch (already individually valid, in list order):
 *  - two projects whose targets are the same or nested would write into each other → both skipped;
 *  - a project whose source equals/contains/is inside another (running) project's target is kept,
 *    but warned: its scan is taken before the other project changes its source.
 */
export function detectBatchConflicts(projects: BatchConflictInput[]): BatchConflicts {
  const skipped: Record<string, string> = {};
  const warnings: Record<string, BatchWarning[]> = {};

  for (const a of projects) {
    const clash = projects.find((b) => b.id !== a.id && pathsOverlap(a.target, b.target));
    if (clash) {
      skipped[a.id] = `Its target overlaps the target of “${clash.name}” in this batch — run them separately`;
    }
  }

  const running = projects.filter((p) => !(p.id in skipped));
  for (const a of running) {
    for (const b of running) {
      if (b.id === a.id || !pathsOverlap(a.source, b.target)) continue;
      (warnings[a.id] ??= []).push({
        byId: b.id,
        message: `Its source is changed by “${b.name}” in this batch; its scan was taken before that — rescan afterwards`,
      });
    }
  }
  return { skipped, warnings };
}
