// Update check — PREPARED, NOT WIRED YET. The About page shows a disabled "Check for updates"
// button ("Coming soon") while UPDATES_ENABLED is false.
//
// TODO(updates): wire this up with the Tauri updater plugin:
//   1. `pnpm tauri add updater` (adds tauri-plugin-updater to src-tauri/Cargo.toml, registers
//      `.plugin(tauri_plugin_updater::Builder::new().build())` in src-tauri/src/lib.rs and adds
//      @tauri-apps/plugin-updater to package.json).
//   2. Generate a signing key (`pnpm tauri signer generate`), put the public key and the endpoint
//      (e.g. a `latest.json` published with the GitHub releases of
//      https://github.com/Umami-Creative-GmbH/unity-project-sync) into tauri.conf.json under
//      `plugins.updater`, and set `bundle.createUpdaterArtifacts: true`.
//   3. Add "updater:default" to src-tauri/capabilities/default.json.
//   4. Replace the body of checkForUpdates() with:
//        const { check } = await import("@tauri-apps/plugin-updater");
//        const update = await check();
//        if (!update) return { status: "up-to-date", currentVersion };
//        return { status: "available", currentVersion, version: update.version, notes: update.body,
//                 date: update.date, install: () => update.downloadAndInstall() };
//      and flip UPDATES_ENABLED. Don't install while a sync is running (relaunch kills it).

export type UpdateCheckResult =
  /** Update checks aren't available in this build yet. */
  | { status: "unavailable" }
  | { status: "up-to-date"; currentVersion: string }
  | {
      status: "available";
      currentVersion: string;
      version: string;
      notes?: string;
      date?: string;
      /** Downloads and installs the update (the app restarts afterwards). */
      install: () => Promise<void>;
    }
  | { status: "error"; message: string };

/** False until the updater plugin is wired up (see the TODO above). */
export const UPDATES_ENABLED = false;

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  return { status: "unavailable" };
}
