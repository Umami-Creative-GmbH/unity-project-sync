// Typed wrappers around the Tauri commands and events defined in src-tauri.
// Payload shapes live in ./types.ts (the shared contract).
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  OperationId,
  PlanSummary,
  ProjectInfo,
  ScanProgress,
  SyncProgress,
  SyncReport,
  SyncScope,
} from "@/lib/types";

export const api = {
  inspectProject: (path: string) => invoke<ProjectInfo>("inspect_project", { path }),
  defaultScope: () => invoke<SyncScope>("default_scope"),
  scan: (source: string, target: string, scope: SyncScope, opId: OperationId) =>
    invoke<PlanSummary>("scan", { source, target, scope, opId }),
  runSync: (planId: number, opId: OperationId) => invoke<SyncReport>("run_sync", { planId, opId }),
  /** Releases stored scan plans that will not be run (unknown ids are ignored). */
  discardPlans: (planIds: number[]) => invoke<void>("discard_plans", { planIds }),
  /** Cancels operation `opId` (also when the backend has not started it yet). */
  cancelOperation: (opId: OperationId) => invoke<void>("cancel_operation", { opId }),
  shutdownSystem: () => invoke<void>("shutdown_system"),
  /**
   * Before the settings store is loaded: moves an unreadable settings file aside (the store
   * plugin would start empty and overwrite it). Returns the backup path, or null.
   */
  prepareSettings: () => invoke<string | null>("prepare_settings"),
  /** Copies the settings file to a timestamped backup; returns its path. */
  backupSettings: () => invoke<string>("backup_settings"),
};

export function onScanProgress(handler: (p: ScanProgress) => void): Promise<UnlistenFn> {
  return listen<ScanProgress>("scan-progress", (e) => handler(e.payload));
}

export function onSyncProgress(handler: (p: SyncProgress) => void): Promise<UnlistenFn> {
  return listen<SyncProgress>("sync-progress", (e) => handler(e.payload));
}

/** Turns an invoke rejection (usually a plain string from Rust) into a readable message. */
export function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    const msg = (err as { message: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** The backend rejects a cancelled scan with "Cancelled". */
export function isCancelledError(err: unknown): boolean {
  return errorMessage(err).trim().toLowerCase().startsWith("cancelled");
}
