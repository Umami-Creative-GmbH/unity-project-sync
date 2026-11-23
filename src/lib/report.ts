// Pure helpers that interpret a SyncReport.
import type { SyncReport } from "@/lib/types";

export type ReportOutcome = "success" | "warnings" | "partial" | "cancelled";

/** `warningCount`: scan warnings of the plan (paths that were skipped and not synced). */
export function reportOutcome(report: SyncReport, warningCount = 0): ReportOutcome {
  if (report.cancelled) return "cancelled";
  if (report.errorCount > 0 || report.errors.length > 0) return "partial";
  if (warningCount > 0) return "warnings";
  return "success";
}

/** Number of errors of a report (the list itself is capped by the backend). */
export function reportErrorCount(report: SyncReport): number {
  return Math.max(report.errorCount, report.errors.length);
}

/** Files copied, updated or rewritten after verification. */
export function reportFilesWritten(report: SyncReport): number {
  return report.copied + report.updated + report.verifiedChanged;
}

/** Files + folders removed from the target. */
export function reportDeleted(report: SyncReport): number {
  return report.deletedFiles + report.deletedDirs;
}
