//! Unity Project Sync backend: Tauri commands, app state and wiring.

mod fsutil;
mod model;
mod project;
mod scan;
mod settings;
mod shutdown;
mod sync;

#[cfg(test)]
mod tests;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use model::{PlanSummary, ProjectInfo, ScanProgress, SyncProgress, SyncReport, SyncScope};
use scan::Plan;

/// Maximum number of scan plans kept at once; the oldest (lowest id) is evicted beyond that.
/// Only a guard against leaks (the UI discards plans it won't run): a batch scans every chosen
/// project before the first one runs, so this must stay above any realistic project count.
const MAX_PLANS: usize = 256;

const STALE_PLAN: &str = "This scan result is no longer valid. Please scan again.";

/// Operation ids chosen by the UI: which operation runs, and which one was last cancelled.
#[derive(Default)]
struct OpIds {
    /// Id of the running scan/sync (0 = none).
    current: u64,
    /// Id passed to the last `cancel_operation`.
    cancelled: u64,
}

#[derive(Default)]
struct Inner {
    /// Scan plans waiting to run, by plan id (ids increase, so the first key is the oldest).
    plans: Mutex<BTreeMap<u64, Plan>>,
    next_plan_id: AtomicU64,
    busy: AtomicBool,
    cancel: AtomicBool,
    op: Mutex<OpIds>,
}

impl Inner {
    fn plans(&self) -> MutexGuard<'_, BTreeMap<u64, Plan>> {
        self.plans.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Stores a new plan and returns its id; evicts the oldest plans beyond [`MAX_PLANS`].
    fn store_plan(&self, plan: Plan) -> u64 {
        let id = self.next_plan_id.fetch_add(1, Ordering::SeqCst) + 1;
        let mut plans = self.plans();
        plans.insert(id, plan);
        while plans.len() > MAX_PLANS {
            plans.pop_first();
        }
        id
    }

    /// Removes and returns plan `id`: each plan runs at most once.
    fn take_plan(&self, id: u64) -> Result<Plan, String> {
        self.plans()
            .remove(&id)
            .ok_or_else(|| STALE_PLAN.to_string())
    }

    fn discard_plans(&self, ids: &[u64]) {
        let mut plans = self.plans();
        for id in ids {
            plans.remove(id);
        }
    }

    fn op(&self) -> MutexGuard<'_, OpIds> {
        self.op.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Cancels operation `op_id`, also when it has not started yet (IPC calls may be handled
    /// in any order); a cancel for an older operation has no effect.
    fn request_cancel(&self, op_id: u64) {
        let mut op = self.op();
        op.cancelled = op_id;
        if op.current == op_id {
            self.cancel.store(true, Ordering::SeqCst);
        }
    }
}

#[derive(Default)]
struct AppState(Arc<Inner>);

/// Marks the app busy for one scan/sync; released on drop.
struct BusyGuard(Arc<Inner>);

impl BusyGuard {
    fn acquire(inner: &Arc<Inner>, op_id: u64) -> Result<Self, String> {
        inner
            .busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "Another scan or sync is already running.".to_string())?;
        let mut op = inner.op();
        op.current = op_id;
        // Keeps a cancel that arrived before this operation started; drops stale ones.
        inner
            .cancel
            .store(op_id != 0 && op.cancelled == op_id, Ordering::SeqCst);
        drop(op);
        Ok(Self(inner.clone()))
    }
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.op().current = 0;
        self.0.cancel.store(false, Ordering::SeqCst);
        self.0.busy.store(false, Ordering::Release);
    }
}

/// A progress event payload tagged with the operation it belongs to, so the UI can drop late
/// events of a finished operation (events and command results are not ordered).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Tagged<T> {
    op_id: u64,
    #[serde(flatten)]
    progress: T,
}

#[tauri::command]
async fn inspect_project(path: String) -> Result<ProjectInfo, String> {
    tauri::async_runtime::spawn_blocking(move || project::inspect_project(&path))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn default_scope() -> SyncScope {
    SyncScope::default()
}

#[tauri::command]
async fn scan(
    app: AppHandle,
    state: State<'_, AppState>,
    source: String,
    target: String,
    scope: SyncScope,
    op_id: u64,
) -> Result<PlanSummary, String> {
    let inner = state.0.clone();
    let guard = BusyGuard::acquire(&inner, op_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let emit = |p: ScanProgress| {
            let _ = app.emit("scan-progress", Tagged { op_id, progress: p });
        };
        let out = scan::scan(&source, &target, &scope, &inner.cancel, &emit)
            .map_err(|e| e.to_string())?;
        let mut summary = out.summary;
        summary.plan_id = inner.store_plan(out.plan);
        Ok(summary)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn run_sync(
    app: AppHandle,
    state: State<'_, AppState>,
    plan_id: u64,
    op_id: u64,
) -> Result<SyncReport, String> {
    let inner = state.0.clone();
    let guard = BusyGuard::acquire(&inner, op_id)?;
    // Released after this run: a new scan is required for the next sync of this project.
    let plan = inner.take_plan(plan_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let emit = |p: SyncProgress| {
            let _ = app.emit("sync-progress", Tagged { op_id, progress: p });
        };
        sync::execute(&plan, &inner.cancel, sync::default_threads(), &emit)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Drops scan plans the UI no longer needs (unknown ids are ignored).
#[tauri::command]
fn discard_plans(state: State<'_, AppState>, plan_ids: Vec<u64>) {
    state.0.discard_plans(&plan_ids);
}

#[tauri::command]
fn cancel_operation(state: State<'_, AppState>, op_id: u64) {
    state.0.request_cancel(op_id);
}

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(settings::SETTINGS_FILE))
}

/// Called before the UI loads the settings store: moves an unreadable settings file aside (the
/// store plugin would silently start empty and overwrite it). Returns the backup path, if any.
#[tauri::command]
async fn prepare_settings(app: AppHandle) -> Result<Option<String>, String> {
    let file = settings_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || settings::quarantine_unreadable(&file))
        .await
        .map_err(|e| e.to_string())?
        .map(|b| b.map(|p| p.to_string_lossy().into_owned()))
        .map_err(|e| format!("Couldn't check the settings file: {e}"))
}

/// Copies the settings file to a timestamped backup (its content can't be used); returns the path.
#[tauri::command]
async fn backup_settings(app: AppHandle) -> Result<String, String> {
    let file = settings_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || settings::backup(&file))
        .await
        .map_err(|e| e.to_string())?
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("Couldn't back up the settings file: {e}"))
}

#[tauri::command]
async fn shutdown_system() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(shutdown::shutdown_system)
        .await
        .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            inspect_project,
            default_scope,
            scan,
            run_sync,
            discard_plans,
            cancel_operation,
            prepare_settings,
            backup_settings,
            shutdown_system
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod op_tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn cancel_is_tied_to_one_operation() {
        let inner = Arc::new(Inner::default());

        // A cancel that arrives before its operation starts is kept.
        inner.request_cancel(1);
        let g = BusyGuard::acquire(&inner, 1).unwrap();
        assert!(inner.cancel.load(Ordering::SeqCst));
        drop(g);
        assert!(!inner.cancel.load(Ordering::SeqCst));

        // A stale cancel (older operation) does not cancel the next one.
        let g = BusyGuard::acquire(&inner, 2).unwrap();
        assert!(!inner.cancel.load(Ordering::SeqCst));
        assert!(BusyGuard::acquire(&inner, 3).is_err(), "busy");
        inner.request_cancel(1);
        assert!(!inner.cancel.load(Ordering::SeqCst));
        // A cancel for the running operation applies immediately.
        inner.request_cancel(2);
        assert!(inner.cancel.load(Ordering::SeqCst));
        drop(g);

        let _g = BusyGuard::acquire(&inner, 3).unwrap();
        assert!(!inner.cancel.load(Ordering::SeqCst));
    }

    fn plan(name: &str) -> Plan {
        Plan {
            source: format!("S/{name}").into(),
            target: format!("T/{name}").into(),
            scope: SyncScope::default(),
            fold: false,
            delete_files: Vec::new(),
            delete_dirs: Vec::new(),
            case_renames: Vec::new(),
            create_dirs: Vec::new(),
            transfers: Vec::new(),
        }
    }

    #[test]
    fn progress_events_carry_their_op_id() {
        let v = serde_json::to_value(Tagged {
            op_id: 7,
            progress: ScanProgress {
                phase: model::ScanPhase::Target,
                entries: 3,
            },
        })
        .unwrap();
        assert_eq!(v["opId"], 7);
        assert_eq!(v["phase"], "target");
        assert_eq!(v["entries"], 3);
        assert_eq!(v.as_object().unwrap().len(), 3);
    }

    #[test]
    fn plans_coexist_and_each_runs_once() {
        let inner = Inner::default();
        let a = inner.store_plan(plan("a"));
        let b = inner.store_plan(plan("b"));
        assert_ne!(a, b);
        assert_eq!(inner.plans().len(), 2);

        // Taking one plan leaves the other in place.
        assert_eq!(inner.take_plan(b).unwrap().source, Path::new("S/b"));
        assert_eq!(inner.take_plan(b).unwrap_err(), STALE_PLAN);
        // A newer scan does not invalidate an older plan.
        let c = inner.store_plan(plan("c"));
        assert_eq!(inner.take_plan(a).unwrap().source, Path::new("S/a"));
        assert_eq!(inner.take_plan(a).unwrap_err(), STALE_PLAN);
        assert_eq!(inner.take_plan(c).unwrap().source, Path::new("S/c"));
        assert!(inner.plans().is_empty());
    }

    #[test]
    fn unknown_plan_ids_are_rejected() {
        let inner = Inner::default();
        assert_eq!(inner.take_plan(0).unwrap_err(), STALE_PLAN);
        assert_eq!(inner.take_plan(1).unwrap_err(), STALE_PLAN);
        let a = inner.store_plan(plan("a"));
        assert_eq!(inner.take_plan(a + 1).unwrap_err(), STALE_PLAN);
        assert!(inner.take_plan(a).is_ok());
    }

    #[test]
    fn discard_drops_only_the_given_plans() {
        let inner = Inner::default();
        let a = inner.store_plan(plan("a"));
        let b = inner.store_plan(plan("b"));
        let c = inner.store_plan(plan("c"));
        // Unknown ids are ignored.
        inner.discard_plans(&[a, c, 999]);
        assert_eq!(inner.take_plan(a).unwrap_err(), STALE_PLAN);
        assert_eq!(inner.take_plan(c).unwrap_err(), STALE_PLAN);
        assert_eq!(inner.take_plan(b).unwrap().source, Path::new("S/b"));
        inner.discard_plans(&[]);
        assert!(inner.plans().is_empty());
    }

    #[test]
    fn plan_cap_evicts_the_oldest() {
        let inner = Inner::default();
        let ids: Vec<u64> = (0..MAX_PLANS + 3)
            .map(|i| inner.store_plan(plan(&i.to_string())))
            .collect();
        assert_eq!(inner.plans().len(), MAX_PLANS);
        for &id in &ids[..3] {
            assert_eq!(inner.take_plan(id).unwrap_err(), STALE_PLAN);
        }
        for (i, &id) in ids.iter().enumerate().skip(3) {
            let p = inner.take_plan(id).unwrap();
            assert_eq!(p.source, Path::new(&format!("S/{i}")));
        }
    }
}
