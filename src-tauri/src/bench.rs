//! Thread-count benchmark on a Unity-like fixture (not part of the app, never run by default).
//!
//! ```text
//! cargo test --release --lib -- --ignored --nocapture bench_threads
//! ```
//!
//! Builds ~30k small files (1–20 KB, with `.meta` siblings, in nested folders) plus 20 large
//! files (20–80 MB) in a temporary directory (`UPS_BENCH_DIR` overrides the parent folder), then
//! measures, for threads = 1 and Auto: the scan into an empty target, the full sync, an unchanged
//! rescan (both sides walked), a verify-heavy resync (every target mtime touched, so every file
//! is compared byte by byte), the same resync once more (every target file has been opened once
//! since it was written, see the comment there) and the deletion of the whole target. The fixture is removed at the
//! end. `UPS_BENCH_THREADS` (e.g. `16,1,4`) replaces the thread counts and their order. Note: the
//! OS file cache is warm for all runs (the fixture was just written).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant, SystemTime};

use rayon::prelude::*;

use crate::model::{ScanProgress, SyncProgress, SyncReport, SyncScope};
use crate::scan::{ScanOutput, scan};
use crate::sync::execute;

const MODULES: usize = 10;
const SUBS: usize = 10;
const LEAVES: usize = 6;
/// Assets per leaf folder (each with a `.meta`): 10 × 10 × 6 × 25 × 2 = 30 000 small files.
const ASSETS_PER_LEAF: usize = 25;
const BIG_FILES: usize = 20;

/// `UPS_BENCH_BIG` overrides the number of large files (0 = small files only).
fn big_files() -> usize {
    std::env::var("UPS_BENCH_BIG")
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(BIG_FILES)
}

/// xorshift64*: cheap deterministic pseudo-random bytes.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.next() % (hi - lo + 1)
    }

    fn fill(&mut self, buf: &mut [u8]) {
        for chunk in buf.chunks_mut(8) {
            let v = self.next().to_le_bytes();
            chunk.copy_from_slice(&v[..chunk.len()]);
        }
    }
}

fn build_fixture(src: &Path) -> (u64, u64) {
    let leaves: Vec<(usize, usize, usize)> = (0..MODULES)
        .flat_map(|m| (0..SUBS).flat_map(move |s| (0..LEAVES).map(move |l| (m, s, l))))
        .collect();
    let small: (u64, u64) = leaves
        .par_iter()
        .map(|&(m, s, l)| {
            let dir = src.join(format!("Assets/Module{m}/Sub{s}/Leaf{l}"));
            fs::create_dir_all(&dir).unwrap();
            let mut rng = Rng(0x9E37_79B9_7F4A_7C15 ^ ((m * 1000 + s * 10 + l) as u64 + 1));
            let (mut files, mut bytes) = (0u64, 0u64);
            for i in 0..ASSETS_PER_LEAF {
                let size = rng.range(1024, 20 * 1024) as usize;
                let mut buf = vec![0u8; size];
                rng.fill(&mut buf);
                fs::write(dir.join(format!("asset{i}.asset")), &buf).unwrap();
                let meta = format!("fileFormatVersion: 2\nguid: {:032x}\n", rng.next());
                fs::write(dir.join(format!("asset{i}.asset.meta")), meta.as_bytes()).unwrap();
                files += 2;
                bytes += (size + meta.len()) as u64;
            }
            (files, bytes)
        })
        .reduce(|| (0, 0), |a, b| (a.0 + b.0, a.1 + b.1));
    let big_dir = src.join("Assets/Big");
    fs::create_dir_all(&big_dir).unwrap();
    let big: u64 = (0..big_files())
        .into_par_iter()
        .map(|i| {
            let mut rng = Rng(0xDEAD_BEEF ^ (i as u64 + 1));
            let size = rng.range(20, 80) * 1024 * 1024;
            let mut buf = vec![0u8; size as usize];
            rng.fill(&mut buf);
            fs::write(big_dir.join(format!("video{i}.mp4")), &buf).unwrap();
            size
        })
        .sum();
    fs::create_dir_all(src.join("Packages")).unwrap();
    fs::write(src.join("Packages/manifest.json"), b"{}").unwrap();
    fs::create_dir_all(src.join("ProjectSettings")).unwrap();
    fs::write(
        src.join("ProjectSettings/ProjectVersion.txt"),
        b"m_EditorVersion: 6000.0.1f1",
    )
    .unwrap();
    (small.0 + big_files() as u64 + 2, small.1 + big + 2)
}

fn run_scan(src: &Path, tgt: &Path, threads: usize) -> (ScanOutput, Duration) {
    let started = Instant::now();
    let out = scan(
        src.to_str().unwrap(),
        tgt.to_str().unwrap(),
        &SyncScope::default(),
        threads,
        &AtomicBool::new(false),
        &|_: ScanProgress| {},
    )
    .unwrap();
    (out, started.elapsed())
}

fn run_sync(out: &ScanOutput, threads: usize) -> (SyncReport, Duration) {
    let started = Instant::now();
    let report = execute(
        &out.plan,
        &AtomicBool::new(false),
        threads,
        &|_: SyncProgress| {},
    );
    assert_eq!(report.error_count, 0, "{:?}", report.errors);
    (report, started.elapsed())
}

/// Sets every file below `dir` one hour back (not timed).
fn touch_all(dir: &Path) {
    let files: Vec<PathBuf> = walkdir::WalkDir::new(dir)
        .into_iter()
        .flatten()
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .collect();
    let old = SystemTime::now() - Duration::from_secs(3600);
    files
        .par_iter()
        .for_each(|p| crate::fsutil::set_mtime(p, old).unwrap());
}

struct Row {
    threads: usize,
    scan_empty: Duration,
    full_sync: Duration,
    rescan: Duration,
    verify_scan: Duration,
    verify_sync: Duration,
    verify_warm: Duration,
    delete_scan: Duration,
    delete_sync: Duration,
}

fn secs(d: Duration) -> String {
    format!("{:.2} s", d.as_secs_f64())
}

#[test]
#[ignore = "benchmark: builds a ~1.3 GB fixture; run in release with --ignored --nocapture"]
fn bench_threads() {
    let parent = std::env::var_os("UPS_BENCH_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = tempfile::Builder::new()
        .prefix("ups-bench-")
        .tempdir_in(parent)
        .unwrap();
    let src = dir.path().join("src");
    let tgt = dir.path().join("tgt");
    // Deleting everything: a source with empty scope folders and no root files.
    let empty = dir.path().join("empty");
    for f in ["Assets", "Packages", "ProjectSettings"] {
        fs::create_dir_all(empty.join(f)).unwrap();
    }

    let started = Instant::now();
    let (files, bytes) = build_fixture(&src);
    eprintln!(
        "fixture: {files} files, {:.2} GiB in {} ({:.1} s)",
        bytes as f64 / (1u64 << 30) as f64,
        dir.path().display(),
        started.elapsed().as_secs_f64()
    );

    let auto = crate::threads::auto_threads();
    let mut rows = Vec::new();
    let counts: Vec<usize> = match std::env::var("UPS_BENCH_THREADS") {
        Ok(list) => list
            .split(',')
            .map(|n| n.trim().parse().expect("UPS_BENCH_THREADS: numbers"))
            .collect(),
        Err(_) => vec![1, auto],
    };
    for threads in counts {
        let (out, scan_empty) = run_scan(&src, &tgt, threads);
        assert_eq!(out.summary.copy.files, files);
        let (report, full_sync) = run_sync(&out, threads);
        assert_eq!(report.copied, files);

        let (out, rescan) = run_scan(&src, &tgt, threads);
        assert_eq!(out.summary.total_entries, 0);

        touch_all(&tgt.join("Assets"));
        let (out, verify_scan) = run_scan(&src, &tgt, threads);
        assert!(
            out.summary.verify.files >= files - 2,
            "{:?}",
            out.summary.verify
        );
        let (report, verify_sync) = run_sync(&out, threads);
        assert_eq!(report.verified_identical, out.summary.verify.files);

        // Again, now that every target file has been opened once since it was written: the
        // first open of a freshly written file can carry a fixed, thread-independent cost
        // (measured ~12 s per 30k files on a Dev Drive, likely the deferred antivirus scan).
        touch_all(&tgt.join("Assets"));
        let (out, _) = run_scan(&src, &tgt, threads);
        let (report, verify_warm) = run_sync(&out, threads);
        assert_eq!(report.verified_identical, out.summary.verify.files);

        let (out, delete_scan) = run_scan(&empty, &tgt, threads);
        assert!(out.summary.delete.files >= files - 2);
        let (_, delete_sync) = run_sync(&out, threads);
        assert!(fs::read_dir(tgt.join("Assets")).unwrap().next().is_none());

        rows.push(Row {
            threads,
            scan_empty,
            full_sync,
            rescan,
            verify_scan,
            verify_sync,
            verify_warm,
            delete_scan,
            delete_sync,
        });
    }

    println!();
    println!(
        "| threads | scan (empty target) | full sync | rescan (no changes) | verify-heavy scan | verify-heavy sync | verify-heavy sync (warm) | delete-all scan | delete-all sync |"
    );
    println!("|---|---|---|---|---|---|---|---|---|");
    for r in &rows {
        println!(
            "| {} | {} | {} | {} | {} | {} | {} | {} | {} |",
            r.threads,
            secs(r.scan_empty),
            secs(r.full_sync),
            secs(r.rescan),
            secs(r.verify_scan),
            secs(r.verify_sync),
            secs(r.verify_warm),
            secs(r.delete_scan),
            secs(r.delete_sync),
        );
    }
    let cleanup = Instant::now();
    dir.close().unwrap();
    eprintln!("fixture removed ({:.1} s)", cleanup.elapsed().as_secs_f64());
}
