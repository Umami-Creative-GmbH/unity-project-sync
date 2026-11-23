// In-memory update state (one instance for the app's lifetime, see src/hooks/use-update.ts):
//   idle → checking → up-to-date | available | error
//   available → downloading (progress) → installing → (the app exits on Windows)
// A failed download or install keeps the update, so it can be retried; so does a failed re-check.
import { errorMessage } from "@/lib/api";
import {
  NO_PROGRESS,
  updateErrorMessage,
  type AvailableUpdate,
  type DownloadProgress,
  type UpdateCheckResult,
  type UpdateHandle,
} from "@/lib/updates";

export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "up-to-date"; currentVersion: string | null }
  /** `downloaded`: ready to install without downloading again (e.g. a sync started meanwhile). */
  | { status: "available"; update: AvailableUpdate; downloaded: boolean }
  | { status: "downloading"; update: AvailableUpdate; progress: DownloadProgress }
  | { status: "installing"; update: AvailableUpdate }
  | {
      status: "error";
      message: string;
      during: "check" | "download" | "install";
      /**
       * Kept after a failed download/install so it can be retried, and after a failed re-check
       * when an update was already announced.
       */
      update?: AvailableUpdate;
      /** The kept update is already downloaded (only after a failed re-check). */
      downloaded?: boolean;
    };

export interface UpdateStore {
  get(): UpdateState;
  subscribe(listener: () => void): () => void;
  /**
   * Asks the update server. Concurrent calls share one request. `silent`: a failure is only
   * logged and the state returns to idle (unless a non-silent caller joined the same check).
   * Ignored while downloading or installing. Resolves with the state after the check.
   */
  check(options?: { silent?: boolean }): Promise<UpdateState>;
  /**
   * Downloads (if needed) and installs the available update. Refused while busy; a scan or sync
   * that starts during the download postpones the install (the update stays downloaded).
   */
  install(): Promise<void>;
  /** A scan or sync is running: installing would kill it. */
  setBusy(busy: boolean): void;
}

export interface UpdateStoreDeps {
  check: () => Promise<UpdateCheckResult>;
  /** Runs right before the installer takes over (e.g. flush the settings file). */
  beforeInstall?: () => Promise<void>;
  /** Upper bound for beforeInstall, so a hanging flush never blocks the update. */
  beforeInstallTimeoutMs?: number;
  warn?: (message: string, error?: unknown) => void;
}

/** True while an update is being downloaded or installed (no new check, no second install). */
export function isUpdateInProgress(state: UpdateState): boolean {
  return state.status === "downloading" || state.status === "installing";
}

/** The update shown in the UI for this state, if any. */
export function updateOf(state: UpdateState): AvailableUpdate | undefined {
  switch (state.status) {
    case "available":
    case "downloading":
    case "installing":
      return state.update;
    case "error":
      return state.update;
    default:
      return undefined;
  }
}

export function createUpdateStore(deps: UpdateStoreDeps): UpdateStore {
  const warn = deps.warn ?? ((m, e) => console.warn(m, e));
  let state: UpdateState = { status: "idle" };
  /** The backend handle of the announced update (null when there is none). */
  let current: { update: AvailableUpdate; handle: UpdateHandle; downloaded: boolean } | null = null;
  let checkPromise: Promise<UpdateState> | null = null;
  let surfaceErrors = false;
  let installing = false;
  let busy = false;
  const listeners = new Set<() => void>();

  const set = (next: UpdateState) => {
    state = next;
    listeners.forEach((l) => l());
  };

  const release = (handle: UpdateHandle) => {
    handle.close().catch((e) => warn("Could not release the update:", e));
  };

  const runCheck = async (): Promise<UpdateState> => {
    set({ status: "checking" });
    let result: UpdateCheckResult;
    try {
      // Always asynchronous, so checkPromise is assigned before this settles.
      result = await Promise.resolve().then(deps.check);
    } catch (e) {
      result = { status: "error", message: errorMessage(e) };
    }
    const previous = current;
    if (result.status === "error" && previous) {
      // A failed re-check says nothing about the update we already have: keep it (and any
      // downloaded bytes) instead of losing the install option to a network hiccup.
      const { update, downloaded } = previous;
      if (surfaceErrors) set({ status: "error", message: result.message, during: "check", update, downloaded });
      else {
        warn("Background update check failed:", result.message);
        set({ status: "available", update, downloaded });
      }
      return state;
    }
    current = null;
    if (previous) release(previous.handle);
    if (result.status === "available") {
      const { status: _status, download, install, close, ...update } = result;
      current = { update, handle: { download, install, close }, downloaded: false };
      set({ status: "available", update, downloaded: false });
    } else if (result.status === "up-to-date") {
      set({ status: "up-to-date", currentVersion: result.currentVersion });
    } else if (surfaceErrors) {
      set({ status: "error", message: result.message, during: "check" });
    } else {
      warn("Background update check failed:", result.message);
      set({ status: "idle" });
    }
    return state;
  };

  const withTimeout = async (p: Promise<void>, ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([p, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    check(options) {
      if (!options?.silent) surfaceErrors = true;
      if (checkPromise) return checkPromise;
      if (installing || isUpdateInProgress(state)) return Promise.resolve(state);
      surfaceErrors = !options?.silent;
      checkPromise = runCheck().finally(() => {
        checkPromise = null;
      });
      return checkPromise;
    },
    async install() {
      const target = current;
      if (!target || installing || busy || checkPromise) return;
      installing = true;
      const { update, handle } = target;
      try {
        if (!target.downloaded) {
          set({ status: "downloading", update, progress: NO_PROGRESS });
          try {
            await handle.download((progress) => {
              if (current === target && state.status === "downloading") set({ status: "downloading", update, progress });
            });
          } catch (e) {
            warn("Update download failed:", e);
            if (current === target) set({ status: "error", message: updateErrorMessage(e, "download"), during: "download", update });
            return;
          }
          target.downloaded = true;
        }
        if (current !== target) return;
        if (busy) {
          // A scan or sync started during the download: install once it has finished.
          set({ status: "available", update, downloaded: true });
          return;
        }
        set({ status: "installing", update });
        if (deps.beforeInstall) {
          try {
            await withTimeout(deps.beforeInstall(), deps.beforeInstallTimeoutMs ?? 3000);
          } catch (e) {
            warn("Preparing the update failed:", e);
          }
        }
        if (busy) {
          set({ status: "available", update, downloaded: true });
          return;
        }
        try {
          // On Windows the app exits here; the installer restarts it.
          await handle.install();
        } catch (e) {
          warn("Update install failed:", e);
          set({ status: "error", message: updateErrorMessage(e, "install"), during: "install", update });
        }
      } finally {
        installing = false;
      }
    },
    setBusy(value) {
      busy = value;
    },
  };
}
