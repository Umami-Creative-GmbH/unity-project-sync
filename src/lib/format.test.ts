import { describe, expect, it } from "vitest";

import { formatRelativeTime, progressFraction } from "@/lib/format";

describe("formatRelativeTime", () => {
  const now = Date.UTC(2026, 10, 23, 12, 0, 0);
  const ago = (ms: number) => formatRelativeTime(now - ms, now);
  const MIN = 60_000;

  it("formats recent times", () => {
    expect(ago(10_000)).toBe("just now");
    expect(ago(5 * MIN)).toBe("5 min ago");
    expect(ago(3 * 60 * MIN)).toBe("3 h ago");
    expect(ago(30 * 60 * MIN)).toBe("yesterday");
    expect(ago(4 * 24 * 60 * MIN)).toBe("4 days ago");
  });

  it("falls back to a date for older times and clamps the future", () => {
    expect(ago(30 * 24 * 60 * MIN)).toMatch(/2026/);
    expect(formatRelativeTime(now + 5 * MIN, now)).toBe("just now");
  });
});

describe("progressFraction", () => {
  const base = { phase: "copying" as const, doneBytes: 0, totalBytes: 0, doneFiles: 0, totalFiles: 0, deleteDone: 0, deleteTotal: 0 };
  it("uses bytes, then files, then deletions", () => {
    expect(progressFraction({ ...base, doneBytes: 25, totalBytes: 100 })).toBe(0.25);
    expect(progressFraction({ ...base, doneFiles: 1, totalFiles: 4 })).toBe(0.25);
    expect(progressFraction({ ...base, phase: "deleting", deleteDone: 3, deleteTotal: 4, totalBytes: 100 })).toBe(0.75);
  });
});
