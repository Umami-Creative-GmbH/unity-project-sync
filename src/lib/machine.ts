// Screen state machine: idle → scanning → preview → syncing → done (and error).
import type { PlanSummary, ScanProgress, SyncProgress, SyncReport } from "@/lib/types";

export type Screen =
  | { kind: "idle" }
  | { kind: "error"; message: string; during: "scan" | "sync" }
  | {
      kind: "scanning";
      /** "Sync now": run the sync right after the scan, without preview. */
      autoSync: boolean;
      startedAt: number;
      progress: ScanProgress | null;
      cancelling: boolean;
    }
  | { kind: "preview"; plan: PlanSummary }
  | { kind: "syncing"; plan: PlanSummary; progress: SyncProgress | null; cancelling: boolean }
  | { kind: "done"; plan: PlanSummary; report: SyncReport };

export type ScreenAction =
  | { type: "scanStarted"; autoSync: boolean }
  | { type: "scanProgress"; progress: ScanProgress }
  | { type: "scanFinished"; plan: PlanSummary }
  | { type: "syncStarted"; plan: PlanSummary }
  | { type: "syncProgress"; progress: SyncProgress }
  | { type: "syncFinished"; report: SyncReport }
  | { type: "cancelRequested" }
  | { type: "failed"; message: string; during: "scan" | "sync" }
  | { type: "reset" };

export const initialScreen: Screen = { kind: "idle" };

export function screenReducer(state: Screen, action: ScreenAction): Screen {
  switch (action.type) {
    case "scanStarted":
      return { kind: "scanning", autoSync: action.autoSync, startedAt: Date.now(), progress: null, cancelling: false };
    case "scanProgress":
      return state.kind === "scanning" ? { ...state, progress: action.progress } : state;
    case "scanFinished":
      return state.kind === "scanning" ? { kind: "preview", plan: action.plan } : state;
    case "syncStarted":
      return { kind: "syncing", plan: action.plan, progress: null, cancelling: false };
    case "syncProgress":
      return state.kind === "syncing" ? { ...state, progress: action.progress } : state;
    case "syncFinished":
      return state.kind === "syncing" ? { kind: "done", plan: state.plan, report: action.report } : state;
    case "cancelRequested":
      return state.kind === "scanning" || state.kind === "syncing" ? { ...state, cancelling: true } : state;
    case "failed":
      return { kind: "error", message: action.message, during: action.during };
    case "reset":
      return initialScreen;
  }
}

export function isBusy(screen: Screen): boolean {
  return screen.kind === "scanning" || screen.kind === "syncing";
}
