# Unity Project Sync

A small Tauri 2 desktop app (React, Tailwind v4, shadcn/ui and Tabler icons) that mirrors the non-regenerable parts of a Unity 6+ project from a **source** folder into a **target** folder.

- **The source is the truth.** Files that are missing in the source are deleted from the target, but only inside the sync scope.
- **Default scope:** the loose files in the project root, plus `Assets/`, `Packages/` and `ProjectSettings/`. You can add other top-level folders (for example `UserSettings/`). `Library/`, `Temp/`, `Logs/`, `obj/`, `.git/`, `.vs/` and `.utmp/` are never synced or touched.
- **Change detection:** a file is overwritten when its size differs. When the size is the same but the modification time differs by more than 2 s, the contents are compared. If they turn out identical, only the target's timestamp is updated, so the next scan is fast.
- **Safe writes:** every file is written to a `*.ups-tmp` file first and then renamed into place. Copies run in parallel and can be cancelled, including in the middle of a large file. Links and junctions are never followed.
- **Projects:** the home screen is a saved list of projects. A project is a source → target pair with its own sync scope; its name defaults to the source folder's name. Each row shows the folder status (Unity version, missing, not a Unity project, will be created) and the last sync (time, outcome, files written, errors). Rows can be synced on their own, edited, duplicated or deleted. Projects with a problem (missing or non-Unity source, overlapping folders, empty scope, an unconfirmed non-Unity target) can be saved but are marked *Needs attention* and are not synced until fixed.
- **Batch flow:** *Scan selected* / *Scan all* (nothing selected means all) checks every chosen project, scans them one after another and then shows **one combined preview** with totals and an expandable file list per project. You can untick projects before *Start sync*, and all deletions are confirmed per target. *Sync now* skips the preview and syncs every scanned project that has work. Projects that fail the pre-flight check are skipped with a reason, as are two projects whose targets are the same or nested. A project whose source is another project's target in the same batch gets a "rescan afterwards" warning.
- **Running:** projects sync one after another and the batch continues when one fails. You see the overall progress and ETA, the current project's own progress and a status list. *Cancel* stops the current project and skips the rest. The report lists every project's result and updates its *last sync*.
- **Progress:** a transfer card in the style of the Windows copy dialog: the speed chart *is* the progress bar (x = overall progress, y = speed, the rest of the run as a quiet track), with the percentage above and speed (current and average), bytes, files and time left below. Hover or focus the chart and use the arrow keys to read the speed, elapsed time and project at any point. The window title shows the overall percentage.
- **Shut down after:** off by default and never saved. It only shuts down when every chosen project synced without errors and nothing was cancelled, skipped or failed, with a 60 s countdown you can cancel.
- **Migration:** the source, target and scope saved by the single-project version become the first project.

## Development

```powershell
pnpm install
pnpm tauri dev                          # run the app
pnpm build                              # type-check and build the frontend
pnpm test                               # frontend unit tests (vitest)
cd src-tauri; cargo test                # sync engine tests
pnpm tauri build                        # release build and installer
```

## Installer

`pnpm tauri build` produces one self-contained setup file:

```
src-tauri\target\release\bundle\nsis\Unity Project Sync_<version>_x64-setup.exe
```

Copy that file to a coworker's PC and run it. There is nothing else to ship.

- **No admin rights needed.** It installs for the current user into `%LOCALAPPDATA%\Unity Project Sync` and adds a Start menu entry and an uninstaller (*Settings → Apps*).
- **WebView2:** Windows 11 and current Windows 10 already have it. If it is missing, the bundled bootstrapper installs it silently, which needs internet access once.
- **Language:** English or German, picked from the Windows display language.
- **Updating:** run the newer setup file over the old install; saved projects and settings are kept. Bump `version` in `src-tauri/tauri.conf.json` (and `package.json`/`Cargo.toml`) for each release. There is no auto-update.
- **Unsigned:** the installer is not code-signed, so SmartScreen may show "Windows protected your PC". Click *More info → Run anyway*.

**Debug throttle.** To watch the transfer chart on a fast disk, set `UPS_DEBUG_THROTTLE_MBPS` to a rate in MiB/s before `pnpm tauri dev`; it caps the total copy/verify throughput of a sync (all workers together):

```powershell
$env:UPS_DEBUG_THROTTLE_MBPS = "40"; pnpm tauri dev; Remove-Item env:UPS_DEBUG_THROTTLE_MBPS
```

It is only compiled into debug builds (`#[cfg(debug_assertions)]`); release builds ignore it, and so does `cargo test`.

The pure frontend logic is unit-tested: `src/lib/projects.ts` (naming, validation, cross-project conflicts), `src/lib/store.ts` (persistence and migration), `src/lib/batch.ts` (batch state machine, overall progress and ETA, outcomes, shutdown rule), `src/lib/speed-history.ts` (the binned speed history behind the transfer chart, kept in the batch state) and `src/lib/format.ts`. The batch side effects (sequential scans/syncs, opIds, cancel, discarding unused plans) live in `src/hooks/use-batch-runner.ts`.

The shared TypeScript and Rust contract is in `src/lib/types.ts`, mirrored by `src-tauri/src/model.rs`.
The sync engine is in `src-tauri/src/scan.rs` (walk and diff) and `src-tauri/src/sync.rs` (executor and progress).
