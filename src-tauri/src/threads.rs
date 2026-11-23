//! Worker thread budget of a scan / sync (the "Multi-threaded sync" setting).
//!
//! The UI sends `threads: number | null`: `null` means "Auto", `1` is the single-threaded mode
//! (HDDs, network shares), anything else is a fixed count. The same budget bounds every phase:
//! the parallel directory walk of a scan, and the deletion, copy and verify phases of a sync.

use std::io;
use std::thread;

use crate::model::ThreadInfo;

/// Largest thread count the backend accepts (larger requests are clamped).
pub const MAX_THREADS: usize = 32;
/// Upper bound of "Auto" (more threads rarely help file I/O, even on big CPUs).
pub const MAX_AUTO_THREADS: usize = 16;

/// Logical CPUs of this machine (at least 1).
pub fn logical_cpus() -> usize {
    thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .max(1)
}

/// The thread count "Auto" resolves to: the logical CPUs, clamped to `1..=MAX_AUTO_THREADS`.
pub fn auto_threads() -> usize {
    logical_cpus().clamp(1, MAX_AUTO_THREADS)
}

/// Clamps an explicit thread count to `1..=MAX_THREADS`.
pub fn clamp(n: usize) -> usize {
    n.clamp(1, MAX_THREADS)
}

/// Resolves a requested thread count from the UI: `None` = auto, anything else clamped to
/// `1..=MAX_THREADS` (0 and negative values mean 1).
pub fn resolve(requested: Option<i64>) -> usize {
    match requested {
        None => auto_threads(),
        Some(n) => n.clamp(1, MAX_THREADS as i64) as usize,
    }
}

pub fn thread_info() -> ThreadInfo {
    ThreadInfo {
        logical_cpus: logical_cpus() as u32,
        auto_threads: auto_threads() as u32,
        max_threads: MAX_THREADS as u32,
    }
}

/// A dedicated rayon pool with exactly `n` (clamped) threads. A pool of 1 runs everything
/// sequentially on its single worker.
pub fn pool(n: usize, name: &'static str) -> io::Result<rayon::ThreadPool> {
    rayon::ThreadPoolBuilder::new()
        .num_threads(clamp(n))
        .thread_name(move |i| format!("ups-{name}-{i}"))
        // The parallel tree removal recurses per directory level (plus stolen jobs on top).
        .stack_size(8 * 1024 * 1024)
        .build()
        .map_err(io::Error::other)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_are_clamped() {
        let auto = auto_threads();
        assert!((1..=MAX_AUTO_THREADS).contains(&auto));
        assert_eq!(resolve(None), auto);
        assert_eq!(resolve(Some(1)), 1);
        assert_eq!(resolve(Some(8)), 8);
        assert_eq!(resolve(Some(32)), 32);
        assert_eq!(resolve(Some(33)), 32);
        assert_eq!(resolve(Some(10_000)), 32);
        assert_eq!(resolve(Some(i64::MAX)), 32);
        assert_eq!(resolve(Some(0)), 1);
        assert_eq!(resolve(Some(-4)), 1);
        assert_eq!(resolve(Some(i64::MIN)), 1);
        assert_eq!(clamp(0), 1);
        assert_eq!(clamp(64), 32);
    }

    #[test]
    fn thread_info_is_consistent() {
        let info = thread_info();
        assert!(info.logical_cpus >= 1);
        assert_eq!(
            info.auto_threads as usize,
            (info.logical_cpus as usize).clamp(1, MAX_AUTO_THREADS)
        );
        assert_eq!(info.max_threads, 32);
        let v = serde_json::to_value(info).unwrap();
        let mut keys: Vec<&String> = v.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["autoThreads", "logicalCpus", "maxThreads"]);
    }

    #[test]
    fn pools_have_the_requested_size() {
        assert_eq!(pool(1, "t").unwrap().current_num_threads(), 1);
        assert_eq!(pool(3, "t").unwrap().current_num_threads(), 3);
        assert_eq!(pool(0, "t").unwrap().current_num_threads(), 1);
        assert_eq!(pool(99, "t").unwrap().current_num_threads(), MAX_THREADS);
    }
}
