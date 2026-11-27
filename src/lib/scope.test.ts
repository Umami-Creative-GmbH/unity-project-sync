import { describe, expect, it } from "vitest";

import {
  cloneDefaultScope,
  excludePatternError,
  isExcludedName,
  isScopeLike,
  sanitizeExclude,
  sanitizeScope,
  scopesEqual,
} from "@/lib/scope";
import { DEFAULT_SCOPE, MAX_EXCLUDE_PATTERN_LENGTH, MAX_EXCLUDE_PATTERNS, type SyncScope } from "@/lib/types";

const scope = (exclude: string[], folders = ["Assets"]): SyncScope => ({ includeRootFiles: true, folders, exclude });

describe("exclusion patterns", () => {
  it("rejects paths, control characters, empty and too long patterns", () => {
    expect(excludePatternError("*.log")).toBeNull();
    expect(excludePatternError("  Crash_??.dmp ")).toBeNull();
    expect(excludePatternError("   ")).not.toBeNull();
    expect(excludePatternError("Logs/*.log")).toMatch(/no \//);
    expect(excludePatternError("Assets\\x")).not.toBeNull();
    expect(excludePatternError("a\tb")).not.toBeNull();
    expect(excludePatternError("x".repeat(MAX_EXCLUDE_PATTERN_LENGTH))).toBeNull();
    expect(excludePatternError("x".repeat(MAX_EXCLUDE_PATTERN_LENGTH + 1))).not.toBeNull();
  });

  it("matches names like the backend: case-insensitive globs plus the .meta sidecar", () => {
    const patterns = ["*.log", "Crash_??.dmp", "Generated", "a+b(1).txt"];
    for (const name of ["Editor.LOG", "x.log.meta", "crash_01.DMP", "generated", "Generated.meta", "A+B(1).TXT"]) {
      expect(isExcludedName(name, patterns), name).toBe(true);
    }
    for (const name of ["Editor.log.txt", "crash_1.dmp", "MyGenerated", "Other.meta", ".meta", "aab(1).txt"]) {
      expect(isExcludedName(name, patterns), name).toBe(false);
    }
    expect(isExcludedName("x.log", [])).toBe(false);
  });

  it("trims, drops empty and invalid ones, de-duplicates case-insensitively and caps the count", () => {
    expect(sanitizeExclude([" *.log ", "", "*.LOG", "a/b", "*.tmp"])).toEqual(["*.log", "*.tmp"]);
    const many = Array.from({ length: MAX_EXCLUDE_PATTERNS + 5 }, (_, i) => `*.${i}`);
    expect(sanitizeExclude(many)).toHaveLength(MAX_EXCLUDE_PATTERNS);
  });
});

describe("scope helpers", () => {
  it("sanitizes a scope saved without exclusions", () => {
    const legacy = { includeRootFiles: false, folders: ["Assets", "assets", "Library"] };
    expect(isScopeLike(legacy)).toBe(true);
    expect(sanitizeScope(legacy)).toEqual({ includeRootFiles: false, folders: ["Assets"], exclude: [] });
  });

  it("rejects a scope whose exclusions are not a list of strings", () => {
    expect(isScopeLike({ includeRootFiles: true, folders: [], exclude: "*.log" })).toBe(false);
    expect(isScopeLike({ includeRootFiles: true, folders: [], exclude: [1] })).toBe(false);
    expect(isScopeLike({ includeRootFiles: true, folders: [], exclude: ["*.log"] })).toBe(true);
  });

  it("compares exclusions ignoring order and letter case", () => {
    expect(scopesEqual(scope(["*.log", "*.tmp"]), scope(["*.TMP", "*.log"]))).toBe(true);
    expect(scopesEqual(scope(["*.log"]), scope([]))).toBe(false);
    expect(scopesEqual(scope(["*.log"]), scope(["*.dmp"]))).toBe(false);
    expect(scopesEqual(scope([], ["Assets", "Packages"]), scope([], ["packages", "assets"]))).toBe(true);
  });

  it("clones the default scope (no exclusions) without sharing its lists", () => {
    const a = cloneDefaultScope();
    expect(a).toEqual(DEFAULT_SCOPE);
    expect(a.exclude).toEqual([]);
    a.exclude.push("*.log");
    a.folders.push("UserSettings");
    expect(DEFAULT_SCOPE.exclude).toEqual([]);
    expect(scopesEqual(cloneDefaultScope(), DEFAULT_SCOPE)).toBe(true);
  });
});
