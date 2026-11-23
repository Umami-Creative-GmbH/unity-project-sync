//! Unity Project Sync backend: Tauri commands, app state and wiring.

mod fsutil;
mod model;
mod project;
mod scan;
mod shutdown;
mod sync;

#[cfg(test)]
mod tests;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use tauri::{AppHandle, Emitter, State};

use model::{PlanSummary, ProjectInfo, ScanProgress, SyncProgress, SyncReport, SyncScope};
use scan::Plan;

struct StoredPlan {
    id: u64,
    plan: Plan,
}

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
    plan: Mutex<Option<StoredPlan>>,
    next_plan_id: AtomicU64,
    busy: AtomicBool,
    cancel: AtomicBool,
    op: Mutex<OpIds>,
}

impl Inner {
    fn plan(&self) -> MutexGuard<'_, Option<StoredPlan>> {
        self.plan.lock().unwrap_or_else(|e| e.into_inner())
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
    // Any previous plan is stale from now on.
    *inner.plan() = None;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let emit = |p: ScanProgress| {
            let _ = app.emit("scan-progress", p);
        };
        let out = scan::scan(&source, &target, &scope, &inner.cancel, &emit)
            .map_err(|e| e.to_string())?;
        let id = inner.next_plan_id.fetch_add(1, Ordering::SeqCst) + 1;
        let mut summary = out.summary;
        summary.plan_id = id;
        *inner.plan() = Some(StoredPlan { id, plan: out.plan });
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
    let plan = {
        let mut slot = inner.plan();
        if slot.as_ref().is_some_and(|s| s.id == plan_id) {
            // Released after this run: a new scan is required for the next sync.
            slot.take().map(|s| s.plan)
        } else {
            None
        }
    }
    .ok_or_else(|| "This scan result is no longer valid. Please scan again.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let emit = |p: SyncProgress| {
            let _ = app.emit("sync-progress", p);
        };
        sync::execute(&plan, &inner.cancel, sync::default_threads(), &emit)
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn cancel_operation(state: State<'_, AppState>, op_id: u64) {
    state.0.request_cancel(op_id);
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
            cancel_operation,
            shutdown_system
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod op_tests {
    use super::*;

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
}
