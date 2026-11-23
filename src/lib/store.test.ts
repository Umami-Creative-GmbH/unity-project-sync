import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  prepareSettings: vi.fn(async () => null as string | null),
  backupSettings: vi.fn(async () => "C:\\AppData\\settings.json.bak-1"),
}));
vi.mock("@tauri-apps/plugin-store", () => ({ load: mocks.load }));
vi.mock("@/lib/api", () => ({
  api: { prepareSettings: mocks.prepareSettings, backupSettings: mocks.backupSettings },
}));

import {
  SettingsReadOnlyError,
  SettingsUnreadableError,
  createWriteGate,
  loadAppSettings,
  loadAppSettingsFrom,
  loadProjects,
  loadProjectsFrom,
  persistStep,
  saveAppSettings,
  saveAppSettingsTo,
  saveProjects,
  saveProjectsTo,
  sanitizeProject,
  type KeyValueStore,
  type PersistMode,
} from "@/lib/store";
import type { SyncScope } from "@/lib/types";

const DEFAULT: SyncScope = { includeRootFiles: true, folders: ["Assets", "Packages", "ProjectSettings"] };

class FakeStore implements KeyValueStore {
  data: Map<string, unknown>;
  writes = 0;
  constructor(initial: Record<string, unknown> = {}) {
    this.data = new Map(Object.entries(initial));
  }
  async get<T>(key: string) {
    return this.data.get(key) as T | undefined;
  }
  async set(key: string, value: unknown) {
    this.writes++;
    this.data.set(key, JSON.parse(JSON.stringify(value)));
  }
  async delete(key: string) {
    this.writes++;
    return this.data.delete(key);
  }
  async has(key: string) {
    return this.data.has(key);
  }
}

describe("loadProjectsFrom — migration from the single-project settings", () => {
  it("creates one project from source/target/scope and removes the old keys", async () => {
    const store = new FakeStore({
      source: "C:\\Work\\MyGame\\",
      target: "D:\\Backup\\MyGame",
      scope: { includeRootFiles: false, folders: ["Assets", "UserSettings", "Library"] },
    });
    const projects = await loadProjectsFrom(store, DEFAULT);

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      name: "MyGame",
      source: "C:\\Work\\MyGame\\",
      target: "D:\\Backup\\MyGame",
      // Library is never synced and is dropped by the sanitizer.
      scope: { includeRootFiles: false, folders: ["Assets", "UserSettings"] },
      targetAck: false,
      lastRun: null,
    });
    expect(projects[0].id).toBeTruthy();
    expect(store.data.has("source")).toBe(false);
    expect(store.data.has("target")).toBe(false);
    expect(store.data.has("scope")).toBe(false);
    expect(store.data.get("projects")).toEqual(projects);
  });

  it("uses the default scope when the old scope is missing or invalid", async () => {
    const store = new FakeStore({ source: "C:\\G", scope: "nonsense" });
    const [p] = await loadProjectsFrom(store, DEFAULT);
    expect(p.scope).toEqual(DEFAULT);
    expect(p.target).toBeNull();
  });

  it("keeps a customised old scope even without source and target", async () => {
    const scope = { includeRootFiles: false, folders: ["Assets", "UserSettings"] };
    const store = new FakeStore({ scope });
    const projects = await loadProjectsFrom(store, DEFAULT);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ source: null, target: null, scope });
    expect(store.data.has("scope")).toBe(false);
    expect(store.data.get("projects")).toEqual(projects);
  });

  it("removes leftover old keys without creating an empty project", async () => {
    const store = new FakeStore({ scope: DEFAULT });
    expect(await loadProjectsFrom(store, DEFAULT)).toEqual([]);
    expect(store.data.has("scope")).toBe(false);
    expect(store.data.get("projects")).toEqual([]);
  });

  it("does nothing on a fresh install", async () => {
    const store = new FakeStore();
    expect(await loadProjectsFrom(store, DEFAULT)).toEqual([]);
    expect(store.data.size).toBe(0);
    expect(store.writes).toBe(0);
  });

  it("ignores the old keys once a project list exists", async () => {
    const store = new FakeStore({
      projects: [{ id: "a", name: "A", source: "C:\\A", target: "D:\\A", scope: DEFAULT, targetAck: true, lastRun: null }],
      source: "C:\\Old",
    });
    const projects = await loadProjectsFrom(store, DEFAULT);
    expect(projects.map((p) => p.id)).toEqual(["a"]);
    expect(projects[0].targetAck).toBe(true);
    expect(store.data.get("source")).toBe("C:\\Old");
  });
});

describe("loadProjectsFrom — stored list", () => {
  it("sanitizes entries, drops garbage and de-duplicates ids", async () => {
    const store = new FakeStore({
      projects: [
        {
          id: "x",
          name: "Kept",
          source: "C:\\S",
          target: "",
          scope: { includeRootFiles: true, folders: ["Assets", "assets"] },
          lastRun: { finishedAt: 5, outcome: "partial", errorCount: 3 },
        },
        null,
        42,
        { id: "x", source: "C:\\Other\\Proj" },
        { id: "y", lastRun: { finishedAt: 1, outcome: "bogus" } },
      ],
    });
    const projects = await loadProjectsFrom(store, DEFAULT);
    expect(projects).toHaveLength(3);
    expect(projects[0]).toMatchObject({
      id: "x",
      name: "Kept",
      target: null,
      scope: { includeRootFiles: true, folders: ["Assets"] },
      lastRun: { finishedAt: 5, outcome: "partial", errorCount: 3, durationMs: 0, filesWritten: 0 },
    });
    expect(projects[1].id).not.toBe("x");
    expect(projects[1].name).toBe("Proj");
    expect(projects[1].scope).toEqual(DEFAULT);
    expect(projects[2].lastRun).toBeNull();
    // The repaired list is written back right away.
    expect(store.data.get("projects")).toEqual(projects);
  });

  it("does not write when loading a clean list", async () => {
    const p = sanitizeProject({ id: "r", name: "R", source: "C:\\R", target: "D:\\R", scope: DEFAULT }, DEFAULT)!;
    const store = new FakeStore({ projects: [p] });
    expect(await loadProjectsFrom(store, DEFAULT)).toEqual([p]);
    expect(store.writes).toBe(0);
    const empty = new FakeStore({ projects: [] });
    expect(await loadProjectsFrom(empty, DEFAULT)).toEqual([]);
    expect(empty.writes).toBe(0);
  });

  it("round-trips through save", async () => {
    const store = new FakeStore();
    const p = sanitizeProject({ id: "r", name: "R", source: "C:\\R", target: "D:\\R", scope: DEFAULT }, DEFAULT)!;
    await saveProjectsTo(store, [p]);
    expect(await loadProjectsFrom(store, DEFAULT)).toEqual([p]);
  });

  it("refuses a non-array value without writing", async () => {
    const store = new FakeStore({ projects: { nope: true } });
    await expect(loadProjectsFrom(store, DEFAULT)).rejects.toBeInstanceOf(SettingsUnreadableError);
    expect(store.writes).toBe(0);
    expect(store.data.get("projects")).toEqual({ nope: true });
  });
});

describe("loadProjects", () => {
  /** The plugin store the module opened (it is opened once and cached for the session). */
  let opened: FakeStore | null = null;

  it("backs up an unusable list and starts empty, writing nothing", async () => {
    const store = new FakeStore({ projects: "garbage" });
    opened = store;
    mocks.load.mockResolvedValue(store);
    const result = await loadProjects(DEFAULT);
    expect(mocks.prepareSettings).toHaveBeenCalledBefore(mocks.load);
    expect(mocks.backupSettings).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ projects: [], backupPath: "C:\\AppData\\settings.json.bak-1" });
    expect(store.writes).toBe(0);
    // The backup makes writing safe again: the app settings can be saved.
    await saveAppSettings({ multiThreaded: true, threads: 4, theme: "dark" });
    expect(store.data.get("appSettings")).toEqual({ multiThreaded: true, threads: 4, theme: "dark" });
  });

  it("leaves the file untouched for the session when the projects can't be loaded", async () => {
    // The plugin store is opened once per session: the one from the test above (still "garbage").
    const store = opened!;
    expect(store.data.get("projects")).toBe("garbage");
    const writesBefore = store.writes;
    mocks.backupSettings.mockRejectedValueOnce(new Error("disk full"));
    await expect(loadProjects(DEFAULT)).rejects.toThrow("disk full");
    // Neither saver writes, and the app settings don't even load (so nothing tries to save them).
    await expect(saveAppSettings({ multiThreaded: false, threads: 8, theme: "dark" })).rejects.toBeInstanceOf(
      SettingsReadOnlyError,
    );
    await expect(saveProjects([])).rejects.toBeInstanceOf(SettingsReadOnlyError);
    await expect(loadAppSettings()).rejects.toBeInstanceOf(SettingsReadOnlyError);
    expect(store.writes).toBe(writesBefore);
  });
});

describe("createWriteGate", () => {
  it("holds writes until the projects load settles, then allows or refuses them", async () => {
    const gate = createWriteGate();
    let passed = false;
    const waiting = gate.assertWritable().then(() => (passed = true));
    await Promise.resolve();
    expect(passed).toBe(false);
    gate.settle(true);
    await waiting;
    expect(passed).toBe(true);

    const refused = createWriteGate();
    const early = refused.assertWritable();
    refused.settle(false);
    await expect(early).rejects.toBeInstanceOf(SettingsReadOnlyError);
    await expect(refused.assertWritable()).rejects.toBeInstanceOf(SettingsReadOnlyError);
  });

  it("follows the latest projects load", async () => {
    const gate = createWriteGate();
    gate.settle(false);
    gate.settle(true);
    await expect(gate.assertWritable()).resolves.toBeUndefined();
  });
});

describe("app settings", () => {
  it("defaults when missing, without writing", async () => {
    const store = new FakeStore();
    expect(await loadAppSettingsFrom(store)).toEqual({ multiThreaded: true, threads: "auto", theme: "system" });
    expect(store.writes).toBe(0);
  });

  it("sanitizes a stored value, without writing it back", async () => {
    const store = new FakeStore({ appSettings: { multiThreaded: false, threads: 99, theme: "sepia" } });
    expect(await loadAppSettingsFrom(store)).toEqual({ multiThreaded: false, threads: 32, theme: "system" });
    expect(store.writes).toBe(0);
    expect(await loadAppSettingsFrom(new FakeStore({ appSettings: "garbage" }))).toEqual({
      multiThreaded: true,
      threads: "auto",
      theme: "system",
    });
  });

  it("round-trips through save under its own key, leaving the projects alone", async () => {
    const projects = [{ id: "a" }];
    const store = new FakeStore({ projects });
    await saveAppSettingsTo(store, { multiThreaded: true, threads: 6, theme: "dark" });
    expect(store.data.get("appSettings")).toEqual({ multiThreaded: true, threads: 6, theme: "dark" });
    expect(store.data.get("projects")).toEqual(projects);
    expect(await loadAppSettingsFrom(store)).toEqual({ multiThreaded: true, threads: 6, theme: "dark" });
  });
});

describe("persistStep", () => {
  const walk = (mode: PersistMode, n: number) => {
    const saves: boolean[] = [];
    for (let i = 0; i < n; i++) {
      const s = persistStep(mode);
      saves.push(s.save);
      mode = s.next;
    }
    return saves;
  };

  it("never writes back what was just loaded, then saves every change", () => {
    expect(walk("skip-initial", 3)).toEqual([false, true, true]);
  });

  it("never saves after a failed load", () => {
    expect(walk("off", 3)).toEqual([false, false, false]);
  });
});
