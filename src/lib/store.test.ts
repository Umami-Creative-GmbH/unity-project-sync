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
  SettingsUnreadableError,
  loadProjects,
  loadProjectsFrom,
  persistStep,
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
  it("backs up an unusable list and starts empty, writing nothing", async () => {
    const store = new FakeStore({ projects: "garbage" });
    mocks.load.mockResolvedValue(store);
    const result = await loadProjects(DEFAULT);
    expect(mocks.prepareSettings).toHaveBeenCalledBefore(mocks.load);
    expect(mocks.backupSettings).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ projects: [], backupPath: "C:\\AppData\\settings.json.bak-1" });
    expect(store.writes).toBe(0);
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
