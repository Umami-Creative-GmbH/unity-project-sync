// Persisted settings via @tauri-apps/plugin-store: the list of projects under "projects" and the
// app preferences under "appSettings" (see ./settings.ts).
// "Shutdown after" and the list selection are intentionally NOT persisted.
//
// Migration: the single-project version stored "source", "target" and "scope". When those exist and
// "projects" does not, they become the first project and the old keys are removed.
//
// Safety: the file is never rewritten just because it was loaded. An unparsable file is moved aside
// by the backend before the store loads (see src-tauri/src/settings.rs); a "projects" value that
// isn't a list is backed up before anything is written.
import { load, type Store } from "@tauri-apps/plugin-store";

import { api } from "@/lib/api";
import { createProject, defaultProjectName } from "@/lib/projects";
import { isScopeLike, sanitizeScope, scopesEqual } from "@/lib/scope";
import { APP_SETTINGS_KEY, sanitizeAppSettings } from "@/lib/settings";
import type { AppSettings, ProjectLastRun, RunOutcome, SyncProject, SyncScope } from "@/lib/types";

export const PROJECTS_KEY = "projects";
export const LEGACY_KEYS = ["source", "target", "scope"] as const;

/** The subset of the plugin-store API used here (mockable in tests). */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
}

export const SETTINGS_FILE = "settings.json";

/** The stored project list can't be used (e.g. "projects" isn't a list). Nothing was written. */
export class SettingsUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsUnreadableError";
  }
}

let storePromise: Promise<{ store: Store; quarantined: string | null }> | null = null;

function getStore(): Promise<{ store: Store; quarantined: string | null }> {
  storePromise ??= (async () => {
    // Must run before load(): the plugin silently ignores a file it can't parse.
    const quarantined = await api.prepareSettings();
    const store = await load(SETTINGS_FILE, { autoSave: true, defaults: {} });
    return { store, quarantined };
  })();
  storePromise.catch(() => {
    storePromise = null; // try again next time
  });
  return storePromise;
}

function asPath(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

const OUTCOMES: RunOutcome[] = ["success", "warnings", "partial", "cancelled", "failed"];

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asLastRun(value: unknown): ProjectLastRun | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.outcome !== "string" || !OUTCOMES.includes(v.outcome as RunOutcome)) return null;
  if (typeof v.finishedAt !== "number" || !Number.isFinite(v.finishedAt)) return null;
  return {
    finishedAt: v.finishedAt,
    outcome: v.outcome as RunOutcome,
    durationMs: asNumber(v.durationMs),
    bytesWritten: asNumber(v.bytesWritten),
    filesWritten: asNumber(v.filesWritten),
    deleted: asNumber(v.deleted),
    errorCount: asNumber(v.errorCount),
  };
}

/** Turns one stored value into a valid project (or null when it is unusable). */
export function sanitizeProject(value: unknown, defaultScope: SyncScope): SyncProject | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const source = asPath(v.source);
  const project = createProject(
    defaultScope,
    {
      source,
      target: asPath(v.target),
      scope: isScopeLike(v.scope) ? sanitizeScope(v.scope) : defaultScope,
      name: typeof v.name === "string" ? v.name : defaultProjectName(source),
    },
    typeof v.id === "string" && v.id ? v.id : undefined,
  );
  project.targetAck = v.targetAck === true;
  project.lastRun = asLastRun(v.lastRun);
  return project;
}

/**
 * Loads the projects, migrating the single-project settings if needed. Duplicate ids (e.g. from a
 * hand-edited file) are replaced so React keys and selection stay unique; such a repaired list is
 * written back right away. Throws SettingsUnreadableError (without writing) when "projects" isn't a
 * list. Writes nothing otherwise — loading never rewrites the file.
 */
export async function loadProjectsFrom(store: KeyValueStore, defaultScope: SyncScope): Promise<SyncProject[]> {
  if (await store.has(PROJECTS_KEY)) {
    const raw = await store.get<unknown>(PROJECTS_KEY);
    if (!Array.isArray(raw)) {
      throw new SettingsUnreadableError(`The saved "${PROJECTS_KEY}" value isn't a list.`);
    }
    const seen = new Set<string>();
    const projects: SyncProject[] = [];
    let repaired = false;
    for (const entry of raw) {
      let p = sanitizeProject(entry, defaultScope);
      if (!p) {
        repaired = true;
        continue;
      }
      if (seen.has(p.id)) {
        p = { ...p, id: createProject(defaultScope).id };
        repaired = true;
      }
      seen.add(p.id);
      projects.push(p);
    }
    if (repaired) await store.set(PROJECTS_KEY, projects);
    return projects;
  }

  const [source, target, scope] = await Promise.all(LEGACY_KEYS.map((k) => store.get<unknown>(k)));
  const legacyScope = isScopeLike(scope) ? sanitizeScope(scope) : null;
  // The old version deleted source/target when they were cleared but kept the scope: a customised
  // scope alone still becomes a (folder-less, "needs attention") project so it isn't lost.
  const customScope = legacyScope && !scopesEqual(legacyScope, defaultScope) ? legacyScope : null;
  const projects: SyncProject[] = [];
  if (asPath(source) || asPath(target) || customScope) {
    projects.push(
      createProject(defaultScope, {
        source: asPath(source),
        target: asPath(target),
        scope: legacyScope ?? defaultScope,
      }),
    );
  }
  const hadLegacy = (await Promise.all(LEGACY_KEYS.map((k) => store.has(k)))).some(Boolean);
  if (hadLegacy) {
    // Save the new key first so a crash in between can't lose the old settings.
    await store.set(PROJECTS_KEY, projects);
    await Promise.all(LEGACY_KEYS.map((k) => store.delete(k)));
  }
  return projects;
}

export async function saveProjectsTo(store: KeyValueStore, projects: SyncProject[]): Promise<void> {
  await store.set(PROJECTS_KEY, projects);
}

/**
 * Gate for the app's "save on every change" effect:
 *   off          → never save (not loaded yet, or the settings couldn't be read this session)
 *   skip-initial → the effect run caused by the load itself: don't write back what was just read
 *   on           → save
 */
export type PersistMode = "off" | "skip-initial" | "on";

export function persistStep(mode: PersistMode): { save: boolean; next: PersistMode } {
  if (mode === "off") return { save: false, next: "off" };
  if (mode === "skip-initial") return { save: false, next: "on" };
  return { save: true, next: "on" };
}

export interface LoadedProjects {
  projects: SyncProject[];
  /**
   * The settings file couldn't be used and was backed up here; the list starts empty. Saving is
   * safe again (the original content is in the backup).
   */
  backupPath: string | null;
}

/** Writing to the settings file is not allowed this session (its projects couldn't be loaded). */
export class SettingsReadOnlyError extends Error {
  constructor() {
    super("The settings file is read-only for this session.");
    this.name = "SettingsReadOnlyError";
  }
}

/**
 * Session-wide write gate shared by the projects and the app settings (one file, one autosaving
 * store). Writes wait until the projects have been loaded; when that failed the file is left
 * untouched for the session, as the app tells the user.
 */
export interface WriteGate {
  /** Records the outcome of a projects load (the latest one counts). */
  settle(ok: boolean): void;
  /** Resolves once the projects load has settled; throws SettingsReadOnlyError when it failed. */
  assertWritable(): Promise<void>;
}

export function createWriteGate(): WriteGate {
  let writable: boolean | null = null;
  let resolveSettled!: () => void;
  const settled = new Promise<void>((r) => (resolveSettled = r));
  return {
    settle(ok) {
      writable = ok;
      resolveSettled();
    },
    async assertWritable() {
      await settled;
      if (!writable) throw new SettingsReadOnlyError();
    },
  };
}

const writeGate = createWriteGate();

/**
 * Loads the saved projects. Throws when the settings can't be read and couldn't be backed up —
 * the caller must then not save during this session (the shared write gate enforces this for the
 * app settings, too).
 */
export async function loadProjects(defaultScope: SyncScope): Promise<LoadedProjects> {
  try {
    const { store, quarantined } = await getStore();
    let loaded: LoadedProjects;
    try {
      loaded = { projects: await loadProjectsFrom(store, defaultScope), backupPath: quarantined };
    } catch (e) {
      if (!(e instanceof SettingsUnreadableError)) throw e;
      // Throws when the backup fails: the file then stays untouched.
      loaded = { projects: [], backupPath: await api.backupSettings() };
    }
    writeGate.settle(true);
    return loaded;
  } catch (e) {
    writeGate.settle(false);
    throw e;
  }
}

export async function saveProjects(projects: SyncProject[]): Promise<void> {
  await writeGate.assertWritable();
  await saveProjectsTo((await getStore()).store, projects);
}

// ---- app settings ("appSettings") ------------------------------------------------------------

/** Reads the app settings; missing or invalid values become the defaults. Never writes. */
export async function loadAppSettingsFrom(store: KeyValueStore): Promise<AppSettings> {
  return sanitizeAppSettings(await store.get<unknown>(APP_SETTINGS_KEY));
}

export async function saveAppSettingsTo(store: KeyValueStore, settings: AppSettings): Promise<void> {
  await store.set(APP_SETTINGS_KEY, sanitizeAppSettings(settings));
}

/**
 * Waits for the projects load (same file): when the file is read-only for this session this throws
 * SettingsReadOnlyError, so the settings store never tries to save over it.
 */
export async function loadAppSettings(): Promise<AppSettings> {
  await writeGate.assertWritable();
  return loadAppSettingsFrom((await getStore()).store);
}

export async function saveAppSettings(settings: AppSettings): Promise<void> {
  await writeGate.assertWritable();
  await saveAppSettingsTo((await getStore()).store, settings);
}
