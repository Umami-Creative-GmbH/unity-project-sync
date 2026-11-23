import { useSyncExternalStore } from "react";

import { flushSettings } from "@/lib/store";
import { createUpdateStore, type UpdateState } from "@/lib/update-store";
import { checkForUpdates } from "@/lib/updates";

/** The app's update state (one instance for the app's lifetime). */
export const updates = createUpdateStore({
  check: checkForUpdates,
  // The installer exits the app right away: write pending settings first.
  beforeInstall: flushSettings,
});

/** Current update state; re-renders on every change (incl. download progress). */
export function useUpdateState(): UpdateState {
  return useSyncExternalStore(updates.subscribe, updates.get);
}
