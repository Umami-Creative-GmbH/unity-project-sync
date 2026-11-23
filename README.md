# Unity Project Sync

A small Tauri 2 desktop app (React, Tailwind v4, shadcn/ui and Tabler icons) that mirrors the non-regenerable parts of a Unity 6+ project from a **source** folder into a **target** folder.

- **The source is the truth.** Files that are missing in the source are deleted from the target, but only inside the sync scope.
- **Default scope:** the loose files in the project root, plus `Assets/`, `Packages/` and `ProjectSettings/`. You can add other top-level folders (for example `UserSettings/`). `Library/`, `Temp/`, `Logs/`, `obj/`, `.git/`, `.vs/` and `.utmp/` are never synced or touched.
- **Change detection:** a file is overwritten when its size differs. When the size is the same but the modification time differs by more than 2 s, the contents are compared. If they turn out identical, only the target's timestamp is updated, so the next scan is fast.
- **Safe writes:** every file is written to a `*.ups-tmp` file first and then renamed into place. Copies run in parallel and can be cancelled, including in the middle of a large file. Links and junctions are never followed.
- **Flow:** *Scan* shows a preview (new, changed, to verify, delete, unchanged) and then waits for you to confirm. *Sync now* skips the preview.
- **Progress:** a progress bar with speed and ETA, also shown in the window title.
- **Shut down after:** off by default. It only shuts down after a sync with no errors, with a 60 s countdown you can cancel.

## Development

```powershell
pnpm install
pnpm tauri dev                          # run the app
pnpm build                              # type-check and build the frontend
cd src-tauri; cargo test                # sync engine tests
pnpm tauri build                        # release build and installer
```

The shared TypeScript and Rust contract is in `src/lib/types.ts`, mirrored by `src-tauri/src/model.rs`.
The sync engine is in `src-tauri/src/scan.rs` (walk and diff) and `src-tauri/src/sync.rs` (executor and progress).
