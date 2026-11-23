//! Executes a [`Plan`]: deletions, case renames, directory creation, then parallel
//! copy/update/verify.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use crate::fsutil::{
    Removed, TreeRemove, join_rel, key_of, last_rel, make_writable, mtime_of, parent_rel,
    rel_string, remove_dir_parallel, remove_dir_robust, remove_file_robust, self_and_ancestors,
    set_mtime,
};
use crate::model::{MAX_REPORTED_ERRORS, SyncError, SyncPhase, SyncProgress, SyncReport};
use crate::scan::{CaseRename, DirDelete, FileDelete, Plan, Transfer, TransferKind};

/// Per-file cost overhead used for the ETA (keeps estimates sane for many small files).
pub const OVERHEAD_PER_FILE: u64 = 64 * 1024;
/// Files at least this large are copied in chunks (mid-file progress + cancel).
const CHUNKED_THRESHOLD: u64 = 8 * 1024 * 1024;
const CHUNK: usize = 4 * 1024 * 1024;
const TMP_SUFFIX: &str = ".ups-tmp";
const REPORT_INTERVAL: Duration = Duration::from_millis(100);
/// Time constant of the exponentially smoothed rates.
const RATE_TAU_SECS: f64 = 3.0;
/// Minimum amount of copy-phase data before an ETA is reported.
const ETA_WARMUP_SECS: f64 = 1.5;
/// The byte speed is published only after this much copy time (≈3 readings), so one noisy first
/// 100 ms interval does not show up as a spike at the start of every project.
const SPEED_WARMUP_SECS: f64 = 0.3;
/// ETAs above this (100 h) are meaningless: reported as unknown.
const MAX_ETA_SECS: f64 = 360_000.0;
/// `set_current` is updated every this many entries while a folder tree is deleted.
const DELETE_CURRENT_EVERY: u64 = 64;

enum OpError {
    Cancelled,
    Failed(String),
    /// The target cannot take any more data (disk full): the whole run stops.
    Fatal(String),
}

/// Source-side or generic failure.
fn fail(what: &'static str) -> impl Fn(io::Error) -> OpError {
    move |e| OpError::Failed(format!("{what}: {e}"))
}

fn is_storage_full(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded
    ) || (cfg!(windows) && matches!(e.raw_os_error(), Some(39 | 112)))
}

/// Failure of a write to the target; a full disk is fatal.
fn fail_tgt(what: &'static str) -> impl Fn(io::Error) -> OpError {
    move |e| {
        let msg = format!("{what}: {e}");
        if is_storage_full(&e) {
            OpError::Fatal(msg)
        } else {
            OpError::Failed(msg)
        }
    }
}

/// Refuses target paths that go through a symbolic link / junction (sync-time check: the plan
/// may be minutes or hours old). Directories found to be real are cached.
#[derive(Default)]
struct LinkGuard {
    real_dirs: Mutex<HashSet<PathBuf>>,
}

impl LinkGuard {
    /// Checks `root` and every directory between it and `rel` (and `rel` itself when
    /// `include_leaf`, which may be missing or any non-link entry). Missing directories are
    /// fine: nothing below them can be a link yet.
    fn check(&self, root: &Path, rel: &str, include_leaf: bool) -> Result<(), String> {
        let parts: Vec<&str> = if rel.is_empty() {
            Vec::new()
        } else {
            rel.split('/').collect()
        };
        let last_dir = if include_leaf {
            parts.len()
        } else {
            parts.len().saturating_sub(1)
        };
        let mut p = root.to_path_buf();
        for i in 0..=last_dir {
            if i > 0 {
                p.push(parts[i - 1]);
            }
            let is_leaf = include_leaf && i > 0 && i == parts.len();
            if !is_leaf
                && self
                    .real_dirs
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .contains(&p)
            {
                continue;
            }
            match fs::symlink_metadata(&p) {
                Ok(m) if m.file_type().is_symlink() => {
                    return Err(format!(
                        "Refusing to go through a symbolic link / junction (created after the scan?): {}",
                        p.display()
                    ));
                }
                Ok(_) if is_leaf => return Ok(()),
                Ok(m) if !m.is_dir() => {
                    return Err(format!("{} is no longer a folder", p.display()));
                }
                Ok(_) => {
                    self.real_dirs
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(p.clone());
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(e) => return Err(format!("Cannot inspect {}: {e}", p.display())),
            }
        }
        Ok(())
    }
}

struct Shared<'a> {
    cancel: &'a AtomicBool,
    /// Set on a fatal error (disk full, target gone): stops the run without "cancelled".
    aborted: AtomicBool,
    abort_reason: Mutex<Option<String>>,
    phase: AtomicU8,
    done_bytes: AtomicU64,
    done_files: AtomicU64,
    delete_done: AtomicU64,
    error_count: AtomicU64,
    errors: Mutex<Vec<SyncError>>,
    current: Mutex<Option<String>>,
    copied: AtomicU64,
    updated: AtomicU64,
    verified_identical: AtomicU64,
    verified_changed: AtomicU64,
    deleted_files: AtomicU64,
    deleted_dirs: AtomicU64,
    bytes_written: AtomicU64,
    links: LinkGuard,
    /// Debug builds only: `UPS_DEBUG_THROTTLE_MBPS` caps the total transfer rate (demo / QA).
    #[cfg(debug_assertions)]
    throttle: Option<debug_throttle::Throttle>,
}

impl<'a> Shared<'a> {
    fn new(cancel: &'a AtomicBool) -> Self {
        Self {
            cancel,
            aborted: AtomicBool::new(false),
            abort_reason: Mutex::new(None),
            phase: AtomicU8::new(0),
            done_bytes: AtomicU64::new(0),
            done_files: AtomicU64::new(0),
            delete_done: AtomicU64::new(0),
            error_count: AtomicU64::new(0),
            errors: Mutex::new(Vec::new()),
            current: Mutex::new(None),
            copied: AtomicU64::new(0),
            updated: AtomicU64::new(0),
            verified_identical: AtomicU64::new(0),
            verified_changed: AtomicU64::new(0),
            deleted_files: AtomicU64::new(0),
            deleted_dirs: AtomicU64::new(0),
            bytes_written: AtomicU64::new(0),
            links: LinkGuard::default(),
            // Never throttle `cargo test` (also a debug build), even if the variable is set in the shell.
            #[cfg(debug_assertions)]
            throttle: if cfg!(test) {
                None
            } else {
                debug_throttle::Throttle::from_env()
            },
        }
    }

    /// Debug builds: waits until `bytes` more fit into the throttled rate (if one is set).
    #[cfg(debug_assertions)]
    fn throttle(&self, bytes: u64) {
        if let Some(t) = &self.throttle {
            t.consume(bytes, || self.stopped());
        }
    }

    #[cfg(not(debug_assertions))]
    #[inline(always)]
    fn throttle(&self, _bytes: u64) {}

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    /// Cancelled by the user or aborted by a fatal error.
    fn stopped(&self) -> bool {
        self.cancelled() || self.aborted.load(Ordering::Relaxed)
    }

    fn abort(&self, reason: &str) {
        let mut slot = self.abort_reason.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_none() {
            *slot = Some(reason.to_string());
        }
        self.aborted.store(true, Ordering::Relaxed);
    }

    fn set_phase(&self, phase: SyncPhase) {
        let v = match phase {
            SyncPhase::Deleting => 0,
            SyncPhase::Copying => 1,
            SyncPhase::Finalizing => 2,
        };
        self.phase.store(v, Ordering::Relaxed);
    }

    fn phase(&self) -> SyncPhase {
        match self.phase.load(Ordering::Relaxed) {
            0 => SyncPhase::Deleting,
            1 => SyncPhase::Copying,
            _ => SyncPhase::Finalizing,
        }
    }

    fn set_current(&self, rel: &str) {
        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = Some(rel.to_string());
    }

    /// Records an error; only the first `MAX_REPORTED_ERRORS` are kept (all are counted).
    fn error(&self, path: &str, message: String) {
        self.error_count.fetch_add(1, Ordering::Relaxed);
        let mut errors = self.errors.lock().unwrap_or_else(|e| e.into_inner());
        if errors.len() < MAX_REPORTED_ERRORS {
            errors.push(SyncError {
                path: path.to_string(),
                message,
            });
        }
    }

    /// Records an error that is always listed (the cap does not apply).
    fn error_always(&self, path: &str, message: String) {
        self.error_count.fetch_add(1, Ordering::Relaxed);
        self.errors
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(SyncError {
                path: path.to_string(),
                message,
            });
    }
}

/// Credits a file's bytes to the global progress monotonically (verify + copy never double count).
struct FileProgress<'s, 'a> {
    shared: &'s Shared<'a>,
    size: u64,
    credited: u64,
}

impl FileProgress<'_, '_> {
    fn advance_to(&mut self, pos: u64) {
        let pos = pos.min(self.size);
        if pos > self.credited {
            let delta = pos - self.credited;
            self.shared.throttle(delta);
            self.shared.done_bytes.fetch_add(delta, Ordering::Relaxed);
            self.credited = pos;
        }
    }

    fn finish(&mut self) {
        self.advance_to(self.size);
    }

    /// Credits the rest of a failed file (never throttled: nothing is transferred).
    fn skip_rest(&mut self) {
        if self.size > self.credited {
            self.shared
                .done_bytes
                .fetch_add(self.size - self.credited, Ordering::Relaxed);
            self.credited = self.size;
        }
    }
}

/// `UPS_DEBUG_THROTTLE_MBPS=<MiB per second>`: caps the total transfer rate of a sync (all workers
/// together) so the progress chart can be watched on fast disks. Compiled into debug builds only.
#[cfg(debug_assertions)]
mod debug_throttle {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    pub const ENV: &str = "UPS_DEBUG_THROTTLE_MBPS";
    /// Sleeps are sliced so that a cancel is noticed quickly.
    const SLICE: Duration = Duration::from_millis(50);

    /// Shared token bucket in "virtual time" form (GCRA): every transfer reserves its slot after the
    /// previous reservations and waits for it.
    pub struct Throttle {
        bytes_per_sec: f64,
        next_free: Mutex<Option<Instant>>,
    }

    impl Throttle {
        pub fn from_env() -> Option<Self> {
            let mbps = std::env::var(ENV).ok()?.trim().parse::<f64>().ok()?;
            let t = Self::new(mbps)?;
            eprintln!("[debug] {ENV}: copy throughput limited to {mbps} MiB/s");
            Some(t)
        }

        pub fn new(mbps: f64) -> Option<Self> {
            (mbps.is_finite() && mbps > 0.0).then(|| Self {
                bytes_per_sec: mbps * 1024.0 * 1024.0,
                next_free: Mutex::new(None),
            })
        }

        /// Blocks until `bytes` fit into the rate; returns early when `stopped()` turns true.
        pub fn consume(&self, bytes: u64, stopped: impl Fn() -> bool) {
            let cost = Duration::from_secs_f64(bytes as f64 / self.bytes_per_sec);
            let due = {
                let mut next = self.next_free.lock().unwrap_or_else(|e| e.into_inner());
                let now = Instant::now();
                // Idle time earns no burst: after a pause (between projects, after the deletion
                // phase) the rate starts at the limit instead of spiking above it.
                let start = next.map_or(now, |t| t.max(now));
                let end = start + cost;
                *next = Some(end);
                end
            };
            loop {
                let now = Instant::now();
                if now >= due || stopped() {
                    return;
                }
                std::thread::sleep((due - now).min(SLICE));
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn rejects_invalid_rates() {
            assert!(Throttle::new(0.0).is_none());
            assert!(Throttle::new(-5.0).is_none());
            assert!(Throttle::new(f64::NAN).is_none());
            assert!(Throttle::new(10.0).is_some());
        }

        #[test]
        fn limits_the_total_rate_across_threads() {
            // 100 MiB/s, no burst: 4 threads move 4 × 5 MiB = 20 MiB = 20 reservations of 10 ms,
            // chained from the first, so at least 200 ms.
            let t = Throttle::new(100.0).unwrap();
            let started = Instant::now();
            std::thread::scope(|s| {
                for _ in 0..4 {
                    s.spawn(|| {
                        for _ in 0..5 {
                            t.consume(1024 * 1024, || false);
                        }
                    });
                }
            });
            let elapsed = started.elapsed();
            // The 5 ms margin only covers f64 → Duration rounding; scheduling only adds time.
            assert!(elapsed >= Duration::from_millis(195), "{elapsed:?}");
            assert!(elapsed < Duration::from_secs(10), "{elapsed:?}");
        }

        #[test]
        fn returns_early_when_stopped() {
            let t = Throttle::new(1.0).unwrap(); // 1 MiB/s: 100 MiB would take 100 s
            let started = Instant::now();
            t.consume(100 * 1024 * 1024, || true);
            assert!(started.elapsed() < Duration::from_secs(1));
        }
    }
}

/// Exponential moving average with bias correction (no ramp-up from zero).
struct Ema {
    sum: f64,
    weight: f64,
}

impl Ema {
    fn new() -> Self {
        Self {
            sum: 0.0,
            weight: 0.0,
        }
    }

    fn update(&mut self, value: f64, dt: f64) {
        let a = 1.0 - (-dt / RATE_TAU_SECS).exp();
        self.sum = self.sum * (1.0 - a) + a * value;
        self.weight = self.weight * (1.0 - a) + a;
    }

    fn value(&self) -> f64 {
        if self.weight > 0.0 {
            self.sum / self.weight
        } else {
            0.0
        }
    }
}

#[derive(Clone, Copy)]
struct Totals {
    bytes: u64,
    /// Transfers + type-conflict file deletions + counted case renames.
    files: u64,
    /// Items (files + folders) the deletion phase removes.
    deletes: u64,
    /// Most worker threads any phase of the run starts (see [`used_threads`]).
    threads: u32,
}

/// Runs the plan. Never panics on I/O errors: they are collected per file in the report.
/// `threads` (clamped to 1..=32) bounds the deletion, copy and verify workers; 1 runs every
/// phase sequentially. `progress` is called ~10x per second and once at the end.
pub fn execute(
    plan: &Plan,
    cancel: &AtomicBool,
    threads: usize,
    progress: &(dyn Fn(SyncProgress) + Sync),
) -> SyncReport {
    let started = Instant::now();
    let threads = crate::threads::clamp(threads);
    // Reported (progress + report): the workers actually started, not the setting.
    let used = used_threads(plan, threads) as u32;
    let shared = Shared::new(cancel);
    let totals = Totals {
        bytes: plan.total_bytes(),
        files: plan.transfers.len() as u64
            + plan.delete_files.iter().filter(|f| f.conflict).count() as u64
            + plan.case_renames.iter().filter(|r| r.counted).count() as u64,
        deletes: plan.delete_files.len() as u64
            + plan
                .delete_dirs
                .iter()
                .map(|d| 1 + d.nested_files + d.nested_dirs)
                .sum::<u64>(),
        threads: used,
    };

    let (tx, rx) = mpsc::channel::<()>();
    thread::scope(|s| {
        let sh = &shared;
        s.spawn(move || reporter(sh, rx, started, totals, progress));
        work(plan, sh, threads);
        drop(tx);
    });

    let errors = shared
        .errors
        .into_inner()
        .unwrap_or_else(|e| e.into_inner());
    SyncReport {
        copied: shared.copied.into_inner(),
        updated: shared.updated.into_inner(),
        verified_identical: shared.verified_identical.into_inner(),
        verified_changed: shared.verified_changed.into_inner(),
        deleted_files: shared.deleted_files.into_inner(),
        deleted_dirs: shared.deleted_dirs.into_inner(),
        bytes_written: shared.bytes_written.into_inner(),
        duration_ms: started.elapsed().as_millis() as u64,
        cancelled: cancel.load(Ordering::Relaxed),
        errors,
        error_count: shared.error_count.into_inner(),
        threads: used,
    }
}

/// The byte speed a progress event carries: 0 ("no reading yet") during the first
/// `SPEED_WARMUP_SECS` of the copy phase, the smoothed rate otherwise. The last event (and any
/// finalizing one) always carries the real rate, so a very short project does not end on a 0.
fn published_speed(rate: f64, copy_elapsed: f64, phase: SyncPhase, finished: bool) -> f64 {
    if !finished && phase == SyncPhase::Copying && copy_elapsed < SPEED_WARMUP_SECS {
        0.0
    } else {
        rate
    }
}

fn reporter(
    sh: &Shared,
    rx: mpsc::Receiver<()>,
    started: Instant,
    totals: Totals,
    progress: &(dyn Fn(SyncProgress) + Sync),
) {
    let total_cost = totals.bytes + OVERHEAD_PER_FILE * totals.files;
    let mut cost_rate = Ema::new();
    let mut byte_rate = Ema::new();
    // (when the copy phase started, done cost at that moment)
    let mut copy_start: Option<(Instant, u64)> = None;
    let mut prev: Option<(Instant, u64, u64)> = None;
    loop {
        let finished = !matches!(
            rx.recv_timeout(REPORT_INTERVAL),
            Err(mpsc::RecvTimeoutError::Timeout)
        );
        let now = Instant::now();
        let phase = sh.phase();
        let done_bytes = sh.done_bytes.load(Ordering::Relaxed);
        let done_files = sh.done_files.load(Ordering::Relaxed);
        let done_cost = done_bytes + OVERHEAD_PER_FILE * done_files;

        if phase != SyncPhase::Deleting {
            match prev {
                None => {
                    copy_start = Some((now, done_cost));
                }
                Some((t, c, b)) => {
                    let dt = now.duration_since(t).as_secs_f64();
                    if dt > 0.0 {
                        cost_rate.update(done_cost.saturating_sub(c) as f64 / dt, dt);
                        byte_rate.update(done_bytes.saturating_sub(b) as f64 / dt, dt);
                    }
                }
            }
            prev = Some((now, done_cost, done_bytes));
        }

        let copy_elapsed = copy_start
            .map(|(t, _)| now.duration_since(t).as_secs_f64())
            .unwrap_or(0.0);
        let warm = copy_elapsed >= ETA_WARMUP_SECS;
        let avg_rate = match copy_start {
            Some((_, c0)) if copy_elapsed > 0.0 => {
                done_cost.saturating_sub(c0) as f64 / copy_elapsed
            }
            _ => 0.0,
        };
        // The EMA tracks recent speed, but a stall (no small file finishing for a while) must not
        // drive it toward 0: floor it at half the average of the whole copy phase.
        let rate = cost_rate.value().max(0.5 * avg_rate);
        let eta_secs = if finished {
            Some(0.0)
        } else if warm && rate > 0.0 {
            let eta = total_cost.saturating_sub(done_cost) as f64 / rate;
            (eta.is_finite() && eta < MAX_ETA_SECS).then_some(eta)
        } else {
            None
        };
        let current_file = sh.current.lock().unwrap_or_else(|e| e.into_inner()).clone();
        progress(SyncProgress {
            phase: if finished {
                SyncPhase::Finalizing
            } else {
                phase
            },
            done_bytes,
            total_bytes: totals.bytes,
            done_files,
            total_files: totals.files,
            bytes_per_sec: published_speed(byte_rate.value(), copy_elapsed, phase, finished),
            cost_per_sec: if warm { rate } else { 0.0 },
            eta_secs,
            elapsed_ms: started.elapsed().as_millis() as u64,
            current_file,
            errors: sh.error_count.load(Ordering::Relaxed),
            delete_done: sh.delete_done.load(Ordering::Relaxed),
            delete_total: totals.deletes,
            threads: totals.threads,
        });
        if finished {
            break;
        }
    }
}

fn work(plan: &Plan, sh: &Shared, threads: usize) {
    sh.set_phase(SyncPhase::Deleting);
    if let Err(e) = fs::create_dir_all(&plan.target) {
        sh.error("", format!("Cannot create the target folder: {e}"));
        sh.set_phase(SyncPhase::Finalizing);
        return;
    }
    if let Err(msg) = sh.links.check(&plan.target, "", false) {
        sh.error("", msg);
        sh.set_phase(SyncPhase::Finalizing);
        return;
    }

    // 1) Deletions: the roots are independent (never nested), so files and folder trees are
    //    removed by `threads` workers; a large tree is split across them by its children.
    if !plan.delete_files.is_empty() || !plan.delete_dirs.is_empty() {
        let pool = match crate::threads::pool(threads, "delete") {
            Ok(pool) => pool,
            Err(e) => {
                sh.error("", format!("Cannot start the worker threads: {e}"));
                sh.set_phase(SyncPhase::Finalizing);
                return;
            }
        };
        pool.install(|| delete_all(plan, sh));
        if sh.stopped() {
            return;
        }
    }

    sh.set_phase(SyncPhase::Copying);

    // 2) Case-only renames, parents before children.
    let mut failed: HashSet<String> = HashSet::new();
    for r in &plan.case_renames {
        if sh.stopped() {
            return;
        }
        let key = key_of(&r.to, plan.fold);
        let parent_failed =
            parent_rel(&key).is_some_and(|p| self_and_ancestors(p).any(|a| failed.contains(a)));
        if parent_failed {
            // Already reported for the parent; the entry still resolves case-insensitively.
            failed.insert(key);
        } else {
            sh.set_current(&r.to);
            match rename_case(plan, r, sh) {
                Ok(()) if r.counted => {
                    sh.updated.fetch_add(1, Ordering::Relaxed);
                }
                Ok(()) => {}
                Err(msg) => {
                    sh.error(&r.to, msg);
                    failed.insert(key);
                }
            }
        }
        if r.counted {
            sh.done_files.fetch_add(1, Ordering::Relaxed);
        }
    }

    // 3) Directories.
    for rel in &plan.create_dirs {
        if sh.stopped() {
            return;
        }
        if !plan.in_scope(rel) {
            continue;
        }
        if let Err(msg) = sh.links.check(&plan.target, rel, true) {
            sh.error(rel, msg);
            continue;
        }
        if let Err(e) = fs::create_dir_all(join_rel(&plan.target, rel)) {
            sh.error(rel, format!("Cannot create folder: {e}"));
        }
    }

    // 4) Files, largest first, pulled from a shared queue by a bounded set of workers.
    let next = AtomicUsize::new(0);
    let workers = copy_workers(threads, plan.transfers.len());
    thread::scope(|s| {
        for _ in 0..workers {
            s.spawn(|| {
                while !sh.stopped() {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(t) = plan.transfers.get(i) else {
                        break;
                    };
                    run_transfer(plan, t, sh);
                }
            });
        }
    });
    let reason = sh
        .abort_reason
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if let Some(reason) = reason {
        let not_processed = plan
            .transfers
            .len()
            .saturating_sub(next.load(Ordering::Relaxed));
        sh.error_always(
            "",
            format!("Sync stopped: {reason} ({not_processed} files not processed)"),
        );
    }
    sh.set_phase(SyncPhase::Finalizing);
}

/// Runs the deletion phase on the current rayon pool.
fn delete_all(plan: &Plan, sh: &Shared) {
    use rayon::prelude::*;

    plan.delete_files.par_iter().for_each(|f| {
        if sh.stopped() {
            return;
        }
        delete_file(plan, f, sh);
        sh.delete_done.fetch_add(1, Ordering::Relaxed);
        if f.conflict {
            sh.done_files.fetch_add(1, Ordering::Relaxed);
        }
    });
    // One task per tree, so a big tree never waits behind small ones in the same chunk.
    plan.delete_dirs.par_iter().with_max_len(1).for_each(|d| {
        if sh.stopped() {
            return;
        }
        let planned = 1 + d.nested_files + d.nested_dirs;
        // Reconcile planned and actual counts so the deletion bar always reaches its total.
        if let Some(done) = delete_dir(plan, d, sh)
            && done < planned
        {
            sh.delete_done.fetch_add(planned - done, Ordering::Relaxed);
        }
    });
}

fn delete_file(plan: &Plan, f: &FileDelete, sh: &Shared) {
    if !plan.in_scope(&f.rel) {
        sh.error(
            &f.rel,
            "Refusing to delete a path outside the sync scope".into(),
        );
        return;
    }
    if let Err(msg) = sh.links.check(&plan.target, &f.rel, false) {
        sh.error(&f.rel, msg);
        return;
    }
    sh.set_current(&f.rel);
    match remove_file_robust(&join_rel(&plan.target, &f.rel)) {
        // A file replaced by a folder (type conflict) counts as one update, like in the plan.
        Ok(()) if f.conflict => {
            sh.updated.fetch_add(1, Ordering::Relaxed);
        }
        Ok(()) => {
            sh.deleted_files.fetch_add(1, Ordering::Relaxed);
        }
        Err(e) => sh.error(&f.rel, format!("Delete failed: {e}")),
    }
}

/// What [`delete_dir`] does once the entry-by-entry removal of a tree has returned.
#[derive(Debug)]
enum AfterTree {
    Done,
    Stopped,
    /// Part of the tree failed and the run was stopped (user cancel / fatal abort).
    StoppedWithError(io::Error),
    /// Part of the tree failed: retry the rest with the robust (uncancellable) removal.
    Fallback,
}

/// `stopped` is the run's own stop flag, checked after the walk: an `Err` wins over sibling
/// `Stopped` results (see `fsutil::combine`), so the result alone cannot tell a cancel apart.
fn after_tree_removal(result: io::Result<TreeRemove>, stopped: bool) -> AfterTree {
    match result {
        Ok(TreeRemove::Done) => AfterTree::Done,
        Ok(TreeRemove::Stopped) => AfterTree::Stopped,
        Err(e) if stopped => AfterTree::StoppedWithError(e),
        Err(_) => AfterTree::Fallback,
    }
}

/// Copy/verify workers [`work`] starts for `transfers` files (never more than there are files;
/// 0 when there is nothing to transfer).
fn copy_workers(threads: usize, transfers: usize) -> usize {
    threads.max(1).min(transfers)
}

/// The most worker threads any phase of the run starts: the delete pool (only built when there
/// is something to delete) has `threads` workers, the copy phase [`copy_workers`]; a run with
/// nothing to do still counts the calling thread.
fn used_threads(plan: &Plan, threads: usize) -> usize {
    let has_deletes = !plan.delete_files.is_empty() || !plan.delete_dirs.is_empty();
    let copy = copy_workers(threads, plan.transfers.len());
    if has_deletes { threads.max(copy) } else { copy }.max(1)
}

/// Deletes one planned folder tree entry by entry (its subtrees in parallel on the current
/// rayon pool). Returns the number of entries it reported to `delete_done`, or `None` when the
/// run was stopped.
fn delete_dir(plan: &Plan, d: &DirDelete, sh: &Shared) -> Option<u64> {
    if !plan.in_scope(&d.rel) {
        sh.error(
            &d.rel,
            "Refusing to delete a path outside the sync scope".into(),
        );
        return Some(0);
    }
    if let Err(msg) = sh.links.check(&plan.target, &d.rel, false) {
        sh.error(&d.rel, msg);
        return Some(0);
    }
    sh.set_current(&d.rel);
    let path = join_rel(&plan.target, &d.rel);
    // The root of a type-conflict dir is replaced by a file (counted as an update).
    let (planned_files, planned_dirs) = (d.nested_files, d.nested_dirs + u64::from(!d.conflict));
    let (files, dirs, seen) = (AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0));
    let result = remove_dir_parallel(&path, &|| sh.stopped(), &|p, kind| {
        sh.delete_done.fetch_add(1, Ordering::Relaxed);
        let n = seen.fetch_add(1, Ordering::Relaxed) + 1;
        if n % DELETE_CURRENT_EVERY == 0
            && let Some(rel) = rel_string(&plan.target, p)
        {
            sh.set_current(&rel);
        }
        match kind {
            Removed::File => {
                files.fetch_add(1, Ordering::Relaxed);
                sh.deleted_files.fetch_add(1, Ordering::Relaxed);
            }
            Removed::Dir if d.conflict && p == path => {}
            Removed::Dir => {
                dirs.fetch_add(1, Ordering::Relaxed);
                sh.deleted_dirs.fetch_add(1, Ordering::Relaxed);
            }
            Removed::Link => {}
        }
    });
    let seen = seen.into_inner();
    match after_tree_removal(result, sh.stopped()) {
        AfterTree::Done => Some(seen),
        AfterTree::Stopped => None,
        AfterTree::StoppedWithError(e) => {
            // Cancelled while (or after) part of the tree failed: keep the error, but never run
            // the uncancellable remove_dir_all fallback and never reconcile the bar to 100%.
            sh.error(&d.rel, format!("Delete failed: {e}"));
            None
        }
        AfterTree::Fallback => {
            if let Err(e) = remove_dir_robust(&path) {
                sh.error(&d.rel, format!("Delete failed: {e}"));
            } else {
                sh.deleted_files.fetch_add(
                    planned_files.saturating_sub(files.into_inner()),
                    Ordering::Relaxed,
                );
                sh.deleted_dirs.fetch_add(
                    planned_dirs.saturating_sub(dirs.into_inner()),
                    Ordering::Relaxed,
                );
            }
            Some(seen)
        }
    }
}

static RENAME_SEQ: AtomicU64 = AtomicU64::new(0);

/// Renames the target entry `r.from` to the source casing `r.to` (its parent has already been
/// renamed). Goes through a temporary name: Windows ignores some direct case-only renames.
fn rename_case(plan: &Plan, r: &CaseRename, sh: &Shared) -> Result<(), String> {
    if !plan.in_scope(&r.to) || !plan.in_scope(&r.from) {
        return Err("Refusing to rename a path outside the sync scope".into());
    }
    sh.links.check(&plan.target, &r.to, false)?;
    let new_path = join_rel(&plan.target, &r.to);
    let dir = new_path
        .parent()
        .ok_or_else(|| "Invalid path".to_string())?;
    let old_name = last_rel(&r.from);
    let current = dir.join(old_name);
    let tmp = dir.join(format!(
        ".{old_name}.ups-case-{}-{}",
        std::process::id(),
        RENAME_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    fs::rename(&current, &tmp).map_err(|e| format!("Cannot fix the letter case: {e}"))?;
    if let Err(e) = fs::rename(&tmp, &new_path) {
        let _ = fs::rename(&tmp, &current);
        return Err(format!("Cannot fix the letter case: {e}"));
    }
    Ok(())
}

enum Outcome {
    Copied(u64),
    Updated(u64),
    Identical,
    Changed(u64),
}

fn run_transfer(plan: &Plan, t: &Transfer, sh: &Shared) {
    sh.set_current(&t.src_rel);
    let src = join_rel(&plan.source, &t.src_rel);
    let dst = join_rel(&plan.target, &t.dst_rel);
    let mut fp = FileProgress {
        shared: sh,
        size: t.size,
        credited: 0,
    };
    let result = if !plan.in_scope(&t.dst_rel) {
        Err(OpError::Failed("Path is outside the sync scope".into()))
    } else if let Err(msg) = sh.links.check(&plan.target, &t.dst_rel, true) {
        Err(OpError::Failed(msg))
    } else {
        // The target folder may have been removed after the scan (e.g. a checkout there).
        if let Some(parent) = dst.parent()
            && fs::symlink_metadata(parent).is_err()
        {
            let _ = fs::create_dir_all(parent);
        }
        match t.kind {
            TransferKind::Copy => copy_file(&src, &dst, sh.cancel, &mut fp).map(Outcome::Copied),
            TransferKind::Update => copy_file(&src, &dst, sh.cancel, &mut fp).map(Outcome::Updated),
            TransferKind::Verify => verify(&src, &dst, sh.cancel, &mut fp),
        }
    };
    match result {
        Ok(outcome) => {
            fp.finish();
            sh.done_files.fetch_add(1, Ordering::Relaxed);
            let (counter, written) = match outcome {
                Outcome::Copied(n) => (&sh.copied, n),
                Outcome::Updated(n) => (&sh.updated, n),
                Outcome::Identical => (&sh.verified_identical, 0),
                Outcome::Changed(n) => (&sh.verified_changed, n),
            };
            counter.fetch_add(1, Ordering::Relaxed);
            sh.bytes_written.fetch_add(written, Ordering::Relaxed);
        }
        Err(OpError::Cancelled) => {}
        Err(OpError::Failed(msg)) => {
            fp.skip_rest();
            sh.done_files.fetch_add(1, Ordering::Relaxed);
            sh.error(&t.src_rel, msg);
            if fs::metadata(&plan.target).is_err() {
                sh.abort("the target folder is no longer available");
            }
        }
        Err(OpError::Fatal(msg)) => {
            fp.skip_rest();
            sh.done_files.fetch_add(1, Ordering::Relaxed);
            sh.error(&t.src_rel, msg);
            sh.abort("the target disk is full");
        }
    }
}

fn verify(
    src: &Path,
    dst: &Path,
    cancel: &AtomicBool,
    fp: &mut FileProgress,
) -> Result<Outcome, OpError> {
    // Never open (and stamp) through a leaf that is no longer a regular file.
    if let Ok(m) = fs::symlink_metadata(dst)
        && (m.file_type().is_symlink() || !m.is_file())
    {
        return Err(OpError::Failed(
            "The target is no longer a regular file".into(),
        ));
    }
    match same_content(src, dst, cancel, fp)? {
        // Stamp the mtime captured before the compare, never one read afterwards.
        Some(mtime) => {
            set_mtime_robust(dst, mtime).map_err(fail("Cannot set modification time"))?;
            Ok(Outcome::Identical)
        }
        None => copy_file(src, dst, cancel, fp).map(Outcome::Changed),
    }
}

/// Reads until `buf` is full or EOF.
fn read_full(f: &mut File, buf: &mut [u8]) -> io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match f.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(n)
}

/// Streams both files chunk by chunk and stops at the first difference.
/// `Some(source mtime)` when the contents are identical AND the source did not change while it
/// was compared; `None` when they differ, the target is missing or the source changed.
fn same_content(
    a: &Path,
    b: &Path,
    cancel: &AtomicBool,
    fp: &mut FileProgress,
) -> Result<Option<SystemTime>, OpError> {
    let mut fa = File::open(a).map_err(fail("Cannot open source"))?;
    let mut fb = match File::open(b) {
        Ok(f) => f,
        // Removed after the scan: just copy it.
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(fail("Cannot open target")(e)),
    };
    let ma = fa.metadata().map_err(fail("Cannot read source"))?;
    let (la, mtime_before) = (ma.len(), mtime_of(&ma));
    let lb = fb.metadata().map_err(fail("Cannot read target"))?.len();
    if la != lb {
        return Ok(None);
    }
    let cap = (la as usize).clamp(4096, CHUNK);
    let mut ba = vec![0u8; cap];
    let mut bb = vec![0u8; cap];
    let mut pos = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(OpError::Cancelled);
        }
        let na = read_full(&mut fa, &mut ba).map_err(fail("Cannot read source"))?;
        let nb = read_full(&mut fb, &mut bb).map_err(fail("Cannot read target"))?;
        if na != nb || ba[..na] != bb[..nb] {
            return Ok(None);
        }
        if na == 0 {
            // Re-check the open handle and the path (the path catches a save-by-rename).
            let h = fa.metadata().map_err(fail("Cannot read source"))?;
            let p = fs::metadata(a).map_err(fail("Cannot read source"))?;
            let unchanged = h.len() == la
                && mtime_of(&h) == mtime_before
                && p.len() == la
                && mtime_of(&p) == mtime_before;
            return Ok(unchanged.then_some(mtime_before));
        }
        pos += na as u64;
        fp.advance_to(pos);
    }
}

fn tmp_path(dst: &Path) -> PathBuf {
    let mut name = dst.file_name().unwrap_or_default().to_os_string();
    name.push(TMP_SUFFIX);
    dst.with_file_name(name)
}

/// Copies `src` over `dst` via a temporary sibling, then sets the source mtime on `dst`.
/// Returns the number of bytes written.
fn copy_file(
    src: &Path,
    dst: &Path,
    cancel: &AtomicBool,
    fp: &mut FileProgress,
) -> Result<u64, OpError> {
    if cancel.load(Ordering::Relaxed) {
        return Err(OpError::Cancelled);
    }
    let tmp = tmp_path(dst);
    if fs::symlink_metadata(&tmp).is_ok() {
        let _ = remove_file_robust(&tmp);
    }
    let result = copy_to_tmp(src, &tmp, cancel, fp).and_then(|(n, mtime)| {
        replace(&tmp, dst).map_err(fail_tgt("Cannot replace target file"))?;
        set_mtime_robust(dst, mtime).map_err(fail("Cannot set modification time"))?;
        Ok(n)
    });
    if result.is_err() && fs::symlink_metadata(&tmp).is_ok() {
        let _ = remove_file_robust(&tmp);
    }
    result
}

fn copy_to_tmp(
    src: &Path,
    tmp: &Path,
    cancel: &AtomicBool,
    fp: &mut FileProgress,
) -> Result<(u64, SystemTime), OpError> {
    let meta = fs::metadata(src).map_err(fail("Cannot read source"))?;
    if !meta.is_file() {
        return Err(OpError::Failed("Source is no longer a file".into()));
    }
    let mtime = mtime_of(&meta);
    let written = if meta.len() >= CHUNKED_THRESHOLD {
        let mut r = File::open(src).map_err(fail("Cannot open source"))?;
        let mut w = File::create(tmp).map_err(fail_tgt("Cannot create temporary file"))?;
        let mut buf = vec![0u8; CHUNK];
        let mut done = 0u64;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(OpError::Cancelled);
            }
            let n = read_full(&mut r, &mut buf).map_err(fail("Cannot read source"))?;
            if n == 0 {
                break;
            }
            w.write_all(&buf[..n])
                .map_err(fail_tgt("Cannot write target"))?;
            done += n as u64;
            fp.advance_to(done);
        }
        w.flush().map_err(fail_tgt("Cannot write target"))?;
        drop(w);
        // Match fs::copy: carry over the source permissions (Unix mode bits such as +x; the
        // read-only flag on Windows, which make_writable clears below).
        fs::set_permissions(tmp, meta.permissions()).map_err(fail_tgt("Cannot set permissions"))?;
        done
    } else {
        let n = fs::copy(src, tmp).map_err(fail_tgt("Copy failed"))?;
        fp.advance_to(n);
        n
    };
    // fs::copy may carry over a read-only attribute; the target copy is always left writable.
    make_writable(tmp).map_err(fail("Cannot clear read-only attribute"))?;
    Ok((written, mtime))
}

/// Renames `tmp` over `dst`, clearing a read-only `dst` (or removing it) if needed.
fn replace(tmp: &Path, dst: &Path) -> io::Result<()> {
    let first = match fs::rename(tmp, dst) {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    match fs::symlink_metadata(dst) {
        Ok(m) if m.is_file() => {
            let _ = make_writable(dst);
            if fs::rename(tmp, dst).is_ok() {
                return Ok(());
            }
            remove_file_robust(dst)?;
            fs::rename(tmp, dst)
        }
        _ => Err(first),
    }
}

fn set_mtime_robust(path: &Path, mtime: SystemTime) -> io::Result<()> {
    match set_mtime(path, mtime) {
        Ok(()) => Ok(()),
        Err(first) => {
            if make_writable(path).is_err() {
                return Err(first);
            }
            set_mtime(path, mtime)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_list_is_capped_but_counted() {
        let cancel = AtomicBool::new(false);
        let sh = Shared::new(&cancel);
        for i in 0..5000 {
            sh.error(&format!("f{i}"), "Copy failed: disk full".into());
        }
        sh.error_always("", "Sync stopped".into());
        let errors = sh.errors.into_inner().unwrap();
        assert_eq!(errors.len(), MAX_REPORTED_ERRORS + 1);
        assert_eq!(errors.last().unwrap().message, "Sync stopped");
        assert_eq!(sh.error_count.into_inner(), 5001);
    }

    /// A tree that failed during a cancel is never handed to the uncancellable fallback.
    #[test]
    fn a_cancel_after_a_tree_error_skips_the_fallback() {
        let err = || Err(io::Error::from(io::ErrorKind::PermissionDenied));
        assert!(matches!(
            after_tree_removal(err(), true),
            AfterTree::StoppedWithError(_)
        ));
        assert!(matches!(
            after_tree_removal(err(), false),
            AfterTree::Fallback
        ));
        assert!(matches!(
            after_tree_removal(Ok(TreeRemove::Stopped), true),
            AfterTree::Stopped
        ));
        assert!(matches!(
            after_tree_removal(Ok(TreeRemove::Done), true),
            AfterTree::Done
        ));
    }

    #[test]
    fn worker_count_never_exceeds_the_work() {
        assert_eq!(copy_workers(16, 2), 2);
        assert_eq!(copy_workers(4, 100), 4);
        assert_eq!(copy_workers(0, 100), 1);
        assert_eq!(copy_workers(8, 0), 0);
    }

    #[test]
    fn storage_full_is_fatal_only_for_target_writes() {
        let full = || io::Error::from(io::ErrorKind::StorageFull);
        assert!(matches!(fail_tgt("Copy failed")(full()), OpError::Fatal(_)));
        assert!(matches!(
            fail("Cannot read source")(full()),
            OpError::Failed(_)
        ));
        let other = io::Error::from(io::ErrorKind::PermissionDenied);
        assert!(matches!(fail_tgt("Copy failed")(other), OpError::Failed(_)));
    }

    #[test]
    fn eta_stays_bounded_during_a_stall() {
        // 10 MB/s for 10 s, then a 60 s stall: the floor keeps the rate at >= half the average.
        let mut ema = Ema::new();
        for _ in 0..100 {
            ema.update(10e6, 0.1);
        }
        let avg_before_stall = 10e6 * 10.0 / 70.0;
        for _ in 0..600 {
            ema.update(0.0, 0.1);
        }
        let rate = ema.value().max(0.5 * avg_before_stall);
        let eta = 3e9 / rate;
        assert!(eta.is_finite() && eta < MAX_ETA_SECS, "{eta}");
    }

    #[test]
    fn speed_is_published_after_the_warm_up() {
        let copying = SyncPhase::Copying;
        // The first noisy readings of the copy phase are held back ("no reading yet").
        assert_eq!(published_speed(5e8, 0.0, copying, false), 0.0);
        assert_eq!(published_speed(5e8, 0.1, copying, false), 0.0);
        assert_eq!(
            published_speed(5e8, SPEED_WARMUP_SECS - 0.01, copying, false),
            0.0
        );
        assert_eq!(published_speed(5e8, SPEED_WARMUP_SECS, copying, false), 5e8);
        // The last event and finalizing events always carry the rate (a short project).
        assert_eq!(published_speed(5e8, 0.1, copying, true), 5e8);
        assert_eq!(published_speed(5e8, 0.1, SyncPhase::Finalizing, false), 5e8);
    }
}
