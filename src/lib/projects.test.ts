import { describe, expect, it } from "vitest";

import {
  createProject,
  defaultProjectName,
  detectBatchConflicts,
  duplicateProject,
  nameFollowsSource,
  projectDisplayName,
  sharedTargetConflicts,
  swapFolders,
  validateProject,
  withSource,
  withTarget,
} from "@/lib/projects";
import type { ProjectInfo, SyncScope } from "@/lib/types";

const SCOPE: SyncScope = { includeRootFiles: true, folders: ["Assets", "Packages", "ProjectSettings"], exclude: ["*.log"] };

function info(partial: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    path: "X",
    exists: true,
    isEmpty: false,
    isUnityProject: true,
    unityVersion: "6000.0.23f1",
    rootDirs: ["Assets", "Packages", "ProjectSettings"],
    comparePath: "",
    ...partial,
  };
}

describe("defaultProjectName", () => {
  it.each([
    ["C:\\Work\\MyGame", "MyGame"],
    ["C:\\Work\\MyGame\\", "MyGame"],
    ["C:\\Work\\MyGame\\\\", "MyGame"],
    ["C:/Work/MyGame/", "MyGame"],
    ["/home/me/MyGame", "MyGame"],
    ["/home/me/My Game/", "My Game"],
    ["C:\\Work/mixed\\Sep", "Sep"],
    ["C:\\", "C:"],
    ["C:", "C:"],
    ["D:/", "D:"],
    ["\\\\server\\share\\", "share"],
    ["\\\\server\\share\\Projects\\Game", "Game"],
    ["/", "/"],
    ["  C:\\Work\\Padded  ", "Padded"],
  ])("%s → %s", (path, expected) => {
    expect(defaultProjectName(path)).toBe(expected);
  });

  it("returns an empty string for no path", () => {
    expect(defaultProjectName(null)).toBe("");
    expect(defaultProjectName(undefined)).toBe("");
    expect(defaultProjectName("   ")).toBe("");
  });
});

describe("project creation and naming", () => {
  it("creates a project named after the source with a copy of the default scope", () => {
    const p = createProject(SCOPE, { source: "C:\\Work\\Game", target: "D:\\Backup\\Game" }, "id-1");
    expect(p).toMatchObject({ id: "id-1", name: "Game", targetAck: false, lastRun: null });
    expect(p.scope).toEqual(SCOPE);
    expect(p.scope).not.toBe(SCOPE);
    expect(p.scope.folders).not.toBe(SCOPE.folders);
    expect(p.scope.exclude).not.toBe(SCOPE.exclude);
  });

  it("generates unique ids", () => {
    const a = createProject(SCOPE);
    const b = createProject(SCOPE);
    expect(a.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
  });

  it("renames on a new source while the name follows the source", () => {
    const p = createProject(SCOPE, { source: "C:\\A\\First" });
    expect(withSource(p, "C:\\B\\Second").name).toBe("Second");
    const empty = { ...p, name: "" };
    expect(withSource(empty, "C:\\B\\Third").name).toBe("Third");
  });

  it("keeps a custom name when the source changes", () => {
    const p = { ...createProject(SCOPE, { source: "C:\\A\\First" }), name: "My mirror" };
    expect(withSource(p, "C:\\B\\Second").name).toBe("My mirror");
    expect(nameFollowsSource("My mirror", "C:\\A\\First")).toBe(false);
    expect(nameFollowsSource("First", "C:\\A\\First")).toBe(true);
  });

  it("resets the acknowledgement only when the target changes", () => {
    const p = { ...createProject(SCOPE, { target: "D:\\T" }), targetAck: true };
    expect(withTarget(p, "D:\\T").targetAck).toBe(true);
    expect(withTarget(p, "D:\\Other").targetAck).toBe(false);
  });

  it("swaps folders, renames an auto-named project and resets the acknowledgement", () => {
    const p = { ...createProject(SCOPE, { source: "C:\\Src\\Game", target: "D:\\Dst\\Copy" }), targetAck: true };
    const s = swapFolders(p);
    expect(s).toMatchObject({ source: "D:\\Dst\\Copy", target: "C:\\Src\\Game", name: "Copy", targetAck: false });
  });

  it("duplicates with a unique '(copy)' name, without the last run and without the target", () => {
    const p = {
      ...createProject(SCOPE, { source: "C:\\Game", target: "D:\\Mirror" }, "orig"),
      targetAck: true,
      lastRun: {
        finishedAt: 1,
        outcome: "success" as const,
        durationMs: 1,
        bytesWritten: 1,
        filesWritten: 1,
        deleted: 0,
        errorCount: 0,
      },
    };
    const d1 = duplicateProject(p, ["Game"], "d1");
    expect(d1).toMatchObject({ id: "d1", name: "Game (copy)", lastRun: null, source: "C:\\Game", target: null, targetAck: false });
    expect(d1.scope).not.toBe(p.scope);
    expect(d1.scope).toEqual(p.scope);
    expect(d1.scope.exclude).not.toBe(p.scope.exclude);
    const d2 = duplicateProject(p, ["Game", "Game (copy)"], "d2");
    expect(d2.name).toBe("Game (copy 2)");
  });

  it("displays a fallback name", () => {
    expect(projectDisplayName({ name: "  ", source: "C:\\X\\Proj" })).toBe("Proj");
    expect(projectDisplayName({ name: "", source: null })).toBe("Untitled project");
  });
});

describe("validateProject", () => {
  const base = { source: "C:\\Src", target: "D:\\Dst", scope: SCOPE, targetAck: false };
  const codes = (...args: Parameters<typeof validateProject>) => validateProject(...args).map((i) => i.code);

  it("accepts a valid project", () => {
    expect(codes(base, info(), info())).toEqual([]);
    expect(codes(base, info(), info({ exists: false, isUnityProject: false }))).toEqual([]);
    expect(codes(base, info(), info({ isEmpty: true, isUnityProject: false }))).toEqual([]);
  });

  it("requires both folders", () => {
    expect(codes({ ...base, source: null, target: null })).toEqual(["noSource", "noTarget"]);
  });

  it("requires an existing Unity project as source", () => {
    expect(codes(base, info({ exists: false, isUnityProject: false }), info())).toEqual(["sourceMissing"]);
    expect(codes(base, info({ isUnityProject: false }), info())).toEqual(["sourceNotUnity"]);
  });

  it("skips the folder checks while the info is unknown", () => {
    expect(codes(base, null, undefined)).toEqual([]);
  });

  it("rejects the same or nested folders (case-insensitive on Windows)", () => {
    expect(codes({ ...base, target: "c:\\src\\" }, info(), info())).toContain("overlap");
    expect(codes({ ...base, target: "C:\\Src\\Backup" }, info(), info())).toContain("overlap");
    expect(codes({ ...base, source: "D:\\Dst\\Inner" }, info(), info())).toContain("overlap");
    expect(codes({ ...base, target: "C:\\Src2" }, info(), info())).not.toContain("overlap");
  });

  it("rejects folders that resolve to the same place (junction, mapped drive)", () => {
    const src = info({ comparePath: "\\\\nas\\share\\game" });
    const tgt = info({ comparePath: "\\\\nas\\share\\game\\mirror" });
    expect(codes({ ...base, source: "Z:\\Game", target: "D:\\Mirror" }, src, tgt)).toContain("overlap");
    // Unknown comparison forms fall back to the paths as written.
    expect(codes(base, info(), info())).not.toContain("overlap");
  });

  it("rejects an empty scope", () => {
    expect(codes({ ...base, scope: { includeRootFiles: false, folders: [], exclude: ["*.log"] } }, info(), info())).toEqual(["scopeEmpty"]);
  });

  it("requires an acknowledgement for a non-empty, non-Unity target", () => {
    const plain = info({ isUnityProject: false, unityVersion: null });
    expect(codes(base, info(), plain)).toEqual(["targetNeedsAck"]);
    expect(codes({ ...base, targetAck: true }, info(), plain)).toEqual([]);
  });
});

describe("detectBatchConflicts", () => {
  const p = (id: string, source: string, target: string) => ({ id, name: id.toUpperCase(), source, target });

  it("finds nothing for independent projects", () => {
    expect(detectBatchConflicts([p("a", "C:\\A", "D:\\A"), p("b", "C:\\B", "D:\\B")])).toEqual({
      skipped: {},
      warnings: {},
    });
  });

  it("skips both projects when targets are the same", () => {
    const r = detectBatchConflicts([p("a", "C:\\A", "D:\\T"), p("b", "C:\\B", "d:\\t\\"), p("c", "C:\\C", "D:\\C")]);
    expect(Object.keys(r.skipped).sort()).toEqual(["a", "b"]);
    expect(r.skipped.a).toContain("“B”");
    expect(r.skipped.b).toContain("“A”");
  });

  it("skips both projects when targets are nested", () => {
    const r = detectBatchConflicts([p("a", "C:\\A", "D:\\T"), p("b", "C:\\B", "D:\\T\\Inner")]);
    expect(Object.keys(r.skipped).sort()).toEqual(["a", "b"]);
  });

  it("warns a project whose source is (inside) another project's target", () => {
    // a mirrors C:\Main → D:\Mirror; b mirrors D:\Mirror → E:\Backup (a chain).
    const r = detectBatchConflicts([p("a", "C:\\Main", "D:\\Mirror"), p("b", "D:\\Mirror", "E:\\Backup")]);
    expect(r.skipped).toEqual({});
    expect(r.warnings.b).toHaveLength(1);
    expect(r.warnings.b[0]).toEqual({ byId: "a", message: expect.stringContaining("“A”") });
    expect(r.warnings.a).toBeUndefined();

    const inside = detectBatchConflicts([p("a", "C:\\Main", "D:\\Mirror"), p("b", "D:\\Mirror\\Sub", "E:\\B")]);
    expect(inside.warnings.b).toHaveLength(1);
    const contains = detectBatchConflicts([p("a", "C:\\Main", "D:\\Mirror\\Game"), p("b", "D:\\Mirror", "E:\\B")]);
    expect(contains.warnings.b).toHaveLength(1);
  });

  it("skips both projects when their targets resolve to the same folder", () => {
    // Z: is mapped to \\nas\share; the pre-flight passes the comparison forms (ProjectInfo.comparePath).
    const cmp: Record<string, string> = {
      "Z:\\Builds\\Game": "\\\\nas\\share\\builds\\game",
      "\\\\nas\\share\\Builds\\Game": "\\\\nas\\share\\builds\\game",
      "C:\\A": "c:\\a",
      "C:\\B": "c:\\b",
    };
    const r = detectBatchConflicts(
      [p("a", "C:\\A", "Z:\\Builds\\Game"), p("b", "C:\\B", "\\\\nas\\share\\Builds\\Game")].map((x) => ({
        ...x,
        source: cmp[x.source],
        target: cmp[x.target],
      })),
    );
    expect(Object.keys(r.skipped).sort()).toEqual(["a", "b"]);
  });

  it("does not warn about a project that is skipped anyway", () => {
    const r = detectBatchConflicts([
      p("a", "C:\\A", "D:\\T"),
      p("b", "C:\\B", "D:\\T"),
      p("c", "D:\\T", "E:\\C"),
    ]);
    expect(Object.keys(r.skipped).sort()).toEqual(["a", "b"]);
    expect(r.warnings.c).toBeUndefined();
  });
});

describe("sharedTargetConflicts", () => {
  const p = (id: string, target: string | null) => ({ id, name: id.toUpperCase(), source: `C:\\${id}`, target });

  it("flags projects that share (or nest) a target", () => {
    const r = sharedTargetConflicts([p("a", "D:\\T"), p("b", "d:\\t\\"), p("c", "D:\\C"), p("d", "D:\\C\\Inner"), p("e", null), p("f", "E:\\F")]);
    expect(Object.keys(r).sort()).toEqual(["a", "b", "c", "d"]);
    expect(r.a).toContain("“B”");
    expect(r.d).toContain("“C”");
  });

  it("compares resolved paths too", () => {
    const resolve = (path: string) => (path.startsWith("Z:") ? path.replace("Z:", "\\\\nas\\share").toLowerCase() : path.toLowerCase());
    const r = sharedTargetConflicts([p("a", "Z:\\Game"), p("b", "\\\\nas\\share\\Game")], resolve);
    expect(Object.keys(r).sort()).toEqual(["a", "b"]);
    expect(sharedTargetConflicts([p("a", "Z:\\Game"), p("b", "\\\\nas\\share\\Game")])).toEqual({});
  });
});
