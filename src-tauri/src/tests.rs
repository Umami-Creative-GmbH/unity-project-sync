//! End-to-end engine tests (scan + execute) on temporary directories, no AppHandle needed.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;

use std::time::{Duration, UNIX_EPOCH};

use crate::model::{
    PlanAction, PlanEntry, PlanReason, ScanProgress, SyncProgress, SyncReport, SyncScope,
};
use crate::scan::{ScanError, ScanOutput, scan};
use crate::sync::execute;

const T0: i64 = 1_700_000_000;

struct Env {
    _dir: tempfile::TempDir,
    src: PathBuf,
    tgt: PathBuf,
}

impl Env {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        let tgt = dir.path().join("tgt");
        fs::create_dir_all(&src).unwrap();
        Self {
            _dir: dir,
            src,
            tgt,
        }
    }

    fn s(&self, rel: &str) -> PathBuf {
        self.src.join(rel)
    }

    fn t(&self, rel: &str) -> PathBuf {
        self.tgt.join(rel)
    }

    fn scan(&self, scope: &SyncScope) -> ScanOutput {
        try_scan(&self.src, &self.tgt, scope).unwrap()
    }

    fn sync(&self, out: &ScanOutput) -> SyncReport {
        execute(&out.plan, &AtomicBool::new(false), 4, &|_: SyncProgress| {})
    }
}

fn try_scan(src: &Path, tgt: &Path, scope: &SyncScope) -> Result<ScanOutput, ScanError> {
    scan_with(src, tgt, scope, 4)
}

fn scan_with(
    src: &Path,
    tgt: &Path,
    scope: &SyncScope,
    threads: usize,
) -> Result<ScanOutput, ScanError> {
    scan(
        src.to_str().unwrap(),
        tgt.to_str().unwrap(),
        scope,
        threads,
        &AtomicBool::new(false),
        &|_: ScanProgress| {},
    )
}

fn write(path: &Path, content: &[u8], mtime: i64) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
    set_mtime(path, mtime);
}

fn set_mtime(path: &Path, secs: i64) {
    crate::fsutil::set_mtime(path, UNIX_EPOCH + Duration::from_secs(secs as u64)).unwrap();
}

fn mtime(path: &Path) -> i64 {
    crate::fsutil::mtime_of(&fs::metadata(path).unwrap())
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn entry<'a>(out: &'a ScanOutput, path: &str) -> Option<&'a PlanEntry> {
    out.summary.entries.iter().find(|e| e.path == path)
}

fn assert_entry(out: &ScanOutput, path: &str, action: PlanAction, reason: PlanReason) {
    let e = entry(out, path)
        .unwrap_or_else(|| panic!("no entry for {path}: {:#?}", out.summary.entries));
    assert_eq!((e.action, e.reason), (action, reason), "entry {path}");
}

fn assert_fully_unchanged(env: &Env, scope: &SyncScope) {
    let again = env.scan(scope);
    assert_eq!(
        again.summary.total_entries, 0,
        "{:#?}",
        again.summary.entries
    );
    assert_eq!(again.summary.total_bytes, 0);
    assert!(again.plan.transfers.is_empty());
    assert!(again.plan.delete_files.is_empty() && again.plan.delete_dirs.is_empty());
}

#[test]
fn classifies_new_size_mtime_and_unchanged() {
    let env = Env::new();
    write(&env.s("Assets/new.cs"), b"new", T0);
    write(&env.s("Assets/size.cs"), b"longer", T0);
    write(&env.t("Assets/size.cs"), b"short", T0);
    write(&env.s("Assets/mtime.cs"), b"same", T0);
    write(&env.t("Assets/mtime.cs"), b"same", T0 - 10);
    write(&env.s("Assets/same.cs"), b"same", T0);
    write(&env.t("Assets/same.cs"), b"same", T0 - 1); // within 2 s tolerance
    fs::create_dir_all(env.s("Assets/EmptyDir")).unwrap();

    let out = env.scan(&SyncScope::default());
    assert_entry(&out, "Assets/new.cs", PlanAction::Copy, PlanReason::New);
    assert_entry(&out, "Assets/size.cs", PlanAction::Update, PlanReason::Size);
    assert_entry(
        &out,
        "Assets/mtime.cs",
        PlanAction::Verify,
        PlanReason::Mtime,
    );
    assert_entry(&out, "Assets/EmptyDir", PlanAction::Copy, PlanReason::New);
    assert!(entry(&out, "Assets/EmptyDir").unwrap().is_dir);
    assert!(entry(&out, "Assets/same.cs").is_none());
    let s = &out.summary;
    assert_eq!((s.copy.files, s.copy.bytes), (1, 3));
    assert_eq!((s.update.files, s.update.bytes), (1, 6));
    assert_eq!((s.verify.files, s.verify.bytes), (1, 4));
    assert_eq!((s.unchanged.files, s.unchanged.bytes), (1, 4));
    assert_eq!(s.total_bytes, 13);
    assert_eq!(s.total_entries, 4);
    assert!(!s.entries_truncated);
    let paths: Vec<_> = s.entries.iter().map(|e| e.path.as_str()).collect();
    let mut sorted = paths.clone();
    sorted.sort_by_key(|p| p.to_lowercase());
    assert_eq!(paths, sorted);

    let report = env.sync(&out);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.copied, 1);
    assert_eq!(report.updated, 1);
    assert_eq!(report.verified_identical, 1);
    assert!(env.t("Assets/EmptyDir").is_dir());
    assert_eq!(fs::read(env.t("Assets/size.cs")).unwrap(), b"longer");
    assert_eq!(mtime(&env.t("Assets/new.cs")), T0);
    assert_eq!(mtime(&env.t("Assets/size.cs")), T0);
    assert_fully_unchanged(&env, &SyncScope::default());
}

#[test]
fn deletes_only_inside_scope() {
    let env = Env::new();
    write(&env.s("Assets/keep.cs"), b"k", T0);
    write(&env.s("ProjectSettings/a.asset"), b"a", T0);
    write(&env.s("readme.md"), b"r", T0);
    fs::create_dir_all(env.s("Other")).unwrap();

    write(&env.t("Assets/keep.cs"), b"k", T0);
    write(&env.t("Assets/extra.cs"), b"xx", T0);
    write(&env.t("Assets/Gone/deep/a.txt"), b"aaa", T0);
    write(&env.t("Assets/Gone/b.txt"), b"bbbb", T0);
    write(&env.t("Library/cache.bin"), b"lib", T0);
    write(&env.t("Temp/t.tmp"), b"tmp", T0);
    write(&env.t("Other/o.txt"), b"o", T0);
    write(&env.t("Unrelated/u.txt"), b"u", T0);
    write(&env.t("readme.md"), b"r", T0);
    write(&env.t("old.sln"), b"sln", T0);

    let out = env.scan(&SyncScope::default());
    assert_entry(
        &out,
        "Assets/extra.cs",
        PlanAction::Delete,
        PlanReason::Extra,
    );
    assert_entry(&out, "Assets/Gone", PlanAction::Delete, PlanReason::Extra);
    assert!(entry(&out, "Assets/Gone").unwrap().is_dir);
    assert!(
        entry(&out, "Assets/Gone/b.txt").is_none(),
        "children of deleted dirs are not listed"
    );
    assert_entry(&out, "old.sln", PlanAction::Delete, PlanReason::Extra);
    for p in ["Library", "Temp", "Other", "Unrelated"] {
        assert!(
            !out.summary.entries.iter().any(|e| e.path.starts_with(p)),
            "{p} must not be touched"
        );
    }
    // extra.cs + a.txt + b.txt + old.sln ; Gone + Gone/deep
    assert_eq!(out.summary.delete.files, 4);
    assert_eq!(out.summary.delete.bytes, 2 + 3 + 4 + 3);
    assert_eq!(out.summary.delete.dirs, 2);

    let events = Mutex::new(Vec::new());
    let report = execute(&out.plan, &AtomicBool::new(false), 2, &|p: SyncProgress| {
        events.lock().unwrap().push(p)
    });
    // Deletion progress: extra.cs + old.sln + Gone (1 + 2 files + 1 dir).
    let last = events.into_inner().unwrap().pop().unwrap();
    assert_eq!((last.delete_done, last.delete_total), (6, 6));
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.error_count, 0);
    assert_eq!(report.deleted_files, 4);
    assert_eq!(report.deleted_dirs, 2);
    assert!(!env.t("Assets/extra.cs").exists());
    assert!(!env.t("Assets/Gone").exists());
    assert!(!env.t("old.sln").exists());
    assert!(env.t("Assets/keep.cs").exists());
    assert!(env.t("Library/cache.bin").exists());
    assert!(env.t("Temp/t.tmp").exists());
    assert!(env.t("Other/o.txt").exists());
    assert!(env.t("Unrelated/u.txt").exists());
    assert_fully_unchanged(&env, &SyncScope::default());
}

#[test]
fn root_files_are_left_alone_when_excluded() {
    let env = Env::new();
    write(&env.s("Assets/a.cs"), b"a", T0);
    write(&env.t("old.sln"), b"sln", T0);
    write(&env.s("new.txt"), b"n", T0);
    let scope = SyncScope {
        include_root_files: false,
        folders: vec!["Assets".into()],
    };
    let out = env.scan(&scope);
    assert!(entry(&out, "old.sln").is_none());
    assert!(entry(&out, "new.txt").is_none());
    let report = env.sync(&out);
    assert!(report.errors.is_empty());
    assert!(env.t("old.sln").exists());
    assert!(!env.t("new.txt").exists());

    // With root files on, the extra root file is deleted and the new one copied.
    let out = env.scan(&SyncScope::default());
    assert_entry(&out, "old.sln", PlanAction::Delete, PlanReason::Extra);
    assert_entry(&out, "new.txt", PlanAction::Copy, PlanReason::New);
    env.sync(&out);
    assert!(!env.t("old.sln").exists());
    assert_eq!(fs::read(env.t("new.txt")).unwrap(), b"n");
}

#[test]
fn folder_missing_in_source_deletes_target_folder() {
    let env = Env::new();
    write(&env.s("Assets/a.cs"), b"a", T0);
    write(&env.t("Packages/manifest.json"), b"{}", T0);
    write(&env.t("Packages/sub/x.txt"), b"x", T0);
    let out = env.scan(&SyncScope::default());
    assert_entry(&out, "Packages", PlanAction::Delete, PlanReason::Extra);
    assert_eq!(out.summary.delete.files, 2);
    assert_eq!(out.summary.delete.dirs, 2);
    // ProjectSettings is missing on both sides: nothing to do.
    assert!(entry(&out, "ProjectSettings").is_none());
    let report = env.sync(&out);
    assert!(report.errors.is_empty());
    assert!(!env.t("Packages").exists());
    assert!(!env.t("ProjectSettings").exists());
    assert_fully_unchanged(&env, &SyncScope::default());
}

#[test]
fn type_conflicts_are_replaced() {
    let env = Env::new();
    write(&env.s("Assets/a"), b"file-in-source", T0);
    write(&env.t("Assets/a/child.txt"), b"c", T0);
    write(&env.s("Assets/b/inner.txt"), b"inner", T0);
    write(&env.t("Assets/b"), b"file-in-target", T0);

    let out = env.scan(&SyncScope::default());
    assert_entry(&out, "Assets/a", PlanAction::Update, PlanReason::Type);
    assert!(!entry(&out, "Assets/a").unwrap().is_dir);
    assert_entry(&out, "Assets/b", PlanAction::Update, PlanReason::Type);
    assert!(entry(&out, "Assets/b").unwrap().is_dir);
    assert_entry(
        &out,
        "Assets/b/inner.txt",
        PlanAction::Copy,
        PlanReason::New,
    );
    assert!(entry(&out, "Assets/a/child.txt").is_none());

    let events = Mutex::new(Vec::new());
    let report = execute(&out.plan, &AtomicBool::new(false), 2, &|p: SyncProgress| {
        events.lock().unwrap().push(p)
    });
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    // Plan, progress and report agree on the two type conflicts (file->dir has no transfer).
    assert_eq!(out.summary.update.files, 2);
    assert_eq!(report.updated, 2);
    let last = events.into_inner().unwrap().pop().unwrap();
    assert_eq!((last.done_files, last.total_files), (3, 3));
    assert!(env.t("Assets/a").is_file());
    assert_eq!(fs::read(env.t("Assets/a")).unwrap(), b"file-in-source");
    assert!(env.t("Assets/b").is_dir());
    assert_eq!(fs::read(env.t("Assets/b/inner.txt")).unwrap(), b"inner");
    assert_fully_unchanged(&env, &SyncScope::default());
}

#[test]
fn verify_identical_only_sets_mtime() {
    let env = Env::new();
    write(&env.s("Assets/big.bin"), &[7u8; 5000], T0);
    // The target file is a hard link to a probe outside the project: if the sync rewrote the
    // target (temp file + rename) the probe would keep its old mtime.
    let probe = env.tgt.parent().unwrap().join("probe.bin");
    write(&probe, &[7u8; 5000], T0 - 100);
    fs::create_dir_all(env.t("Assets")).unwrap();
    fs::hard_link(&probe, env.t("Assets/big.bin")).unwrap();

    let out = env.scan(&SyncScope::default());
    assert_entry(
        &out,
        "Assets/big.bin",
        PlanAction::Verify,
        PlanReason::Mtime,
    );
    let report = env.sync(&out);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.verified_identical, 1);
    assert_eq!(report.verified_changed, 0);
    assert_eq!(report.bytes_written, 0);
    assert_eq!(mtime(&env.t("Assets/big.bin")), T0);
    assert_eq!(mtime(&probe), T0, "target must not be rewritten");
    assert_fully_unchanged(&env, &SyncScope::default());
}

#[test]
fn verify_different_copies() {
    let env = Env::new();
    write(&env.s("Assets/a.txt"), b"abcdef", T0);
    write(&env.t("Assets/a.txt"), b"abcxyz", T0 - 100);
    let out = env.scan(&SyncScope::default());
    assert_entry(&out, "Assets/a.txt", PlanAction::Verify, PlanReason::Mtime);
    let report = env.sync(&out);
    assert!(report.errors.is_empty());
    assert_eq!(report.verified_changed, 1);
    assert_eq!(report.bytes_written, 6);
    assert_eq!(fs::read(env.t("Assets/a.txt")).unwrap(), b"abcdef");
    assert_eq!(mtime(&env.t("Assets/a.txt")), T0);
    assert_fully_unchanged(&env, &SyncScope::default());
}

#[test]
fn large_files_are_chunk_copied_with_progress() {
    let env = Env::new();
    let data: Vec<u8> = (0..(9 * 1024 * 1024 + 123))
        .map(|i| (i % 251) as u8)
        .collect();
    write(&env.s("Assets/large.bin"), &data, T0);
    write(&env.s("Assets/small.txt"), b"s", T0);
    // A different large file of the same size forces a verify -> copy.
    let mut other = data.clone();
    *other.last_mut().unwrap() ^= 0xff;
    write(&env.s("Assets/large2.bin"), &data, T0);
    write(&env.t("Assets/large2.bin"), &other, T0 - 50);

    let out = env.scan(&SyncScope::default());
    let events = Mutex::new(Vec::new());
    let report = execute(&out.plan, &AtomicBool::new(false), 2, &|p: SyncProgress| {
        events.lock().unwrap().push(p)
    });
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.copied, 2);
    assert_eq!(report.verified_changed, 1);
    assert_eq!(fs::read(env.t("Assets/large.bin")).unwrap(), data);
    assert_eq!(fs::read(env.t("Assets/large2.bin")).unwrap(), data);
    assert!(!env.t("Assets/large.bin.ups-tmp").exists());
    let events = events.into_inner().unwrap();
    let last = events.last().unwrap();
    assert_eq!(last.done_bytes, last.total_bytes);
    assert_eq!(last.done_files, 3);
    assert_eq!(last.total_files, 3);
    assert!(
        events
            .windows(2)
            .all(|w| w[0].done_bytes <= w[1].done_bytes)
    );
    assert_fully_unchanged(&env, &SyncScope::default());
}

#[test]
fn missing_target_is_created_and_read_only_targets_are_updated() {
    let env = Env::new();
    write(&env.s("Assets/a.txt"), b"one", T0);
    write(&env.s("ProjectSettings/p.asset"), b"p", T0);
    let out = env.scan(&SyncScope::default());
    assert_eq!(out.summary.copy.files, 2);
    let report = env.sync(&out);
    assert!(report.errors.is_empty());
    assert!(env.t("Assets/a.txt").is_file());

    // Read-only target file must still be updated / deleted.
    let p = env.t("Assets/a.txt");
    let mut perms = fs::metadata(&p).unwrap().permissions();
    perms.set_readonly(true);
    fs::set_permissions(&p, perms.clone()).unwrap();
    write(&env.t("Assets/ro_extra.txt"), b"x", T0);
    fs::set_permissions(env.t("Assets/ro_extra.txt"), perms).unwrap();
    write(&env.s("Assets/a.txt"), b"three", T0 + 10);

    let out = env.scan(&SyncScope::default());
    let report = env.sync(&out);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(fs::read(&p).unwrap(), b"three");
    assert!(!env.t("Assets/ro_extra.txt").exists());
    assert_fully_unchanged(&env, &SyncScope::default());
}

#[test]
fn cancelled_scan_and_sync() {
    let env = Env::new();
    write(&env.s("Assets/a.txt"), b"a", T0);
    let cancel = AtomicBool::new(true);
    let r = scan(
        env.src.to_str().unwrap(),
        env.tgt.to_str().unwrap(),
        &SyncScope::default(),
        1,
        &cancel,
        &|_: ScanProgress| {},
    );
    assert!(matches!(r, Err(ScanError::Cancelled)));
    assert_eq!(ScanError::Cancelled.to_string(), "Cancelled");

    let out = env.scan(&SyncScope::default());
    let report = execute(&out.plan, &cancel, 2, &|_: SyncProgress| {});
    assert!(report.cancelled);
    assert_eq!(report.copied, 0);
    assert!(!env.t("Assets/a.txt").exists());
}

/// True when the temp volume matches names case-insensitively (Windows, default macOS).
fn temp_is_case_insensitive(env: &Env) -> bool {
    crate::fsutil::is_case_insensitive(env.tgt.parent().unwrap(), true)
}

fn names_in(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    v.sort();
    v
}

#[test]
fn case_only_differences_match() {
    let env = Env::new();
    if !temp_is_case_insensitive(&env) {
        return;
    }
    write(&env.s("Assets/Foo.cs"), b"x", T0);
    write(&env.t("assets/foo.cs"), b"x", T0);
    let out = env.scan(&SyncScope::default());
    // Same entries (no copy / delete), but both names are renamed to the source casing.
    assert_eq!(out.summary.unchanged.files, 1);
    assert_eq!(out.summary.total_entries, 2, "{:#?}", out.summary.entries);
    assert_entry(&out, "Assets", PlanAction::Update, PlanReason::Case);
    assert_entry(&out, "Assets/Foo.cs", PlanAction::Update, PlanReason::Case);
    assert!(out.plan.transfers.is_empty());
    assert!(out.plan.delete_files.is_empty() && out.plan.delete_dirs.is_empty());
    let report = env.sync(&out);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.updated, 2);
    assert_eq!(names_in(&env.tgt), vec!["Assets"]);
    assert_eq!(names_in(&env.t("Assets")), vec!["Foo.cs"]);
    assert_fully_unchanged(&env, &SyncScope::default());
}

#[test]
fn case_only_renames_reach_the_target() {
    let env = Env::new();
    if !temp_is_case_insensitive(&env) {
        return;
    }
    write(
        &env.s("Assets/Scripts/PlayerController.cs"),
        b"class PlayerController {}",
        T0,
    );
    write(
        &env.t("Assets/scripts/playercontroller.cs"),
        b"class PlayerController {}",
        T0,
    );
    // Renamed and changed: one update (the transfer), the rename is not counted twice.
    write(&env.s("Assets/Scripts/Readme.TXT"), b"new longer text", T0);
    write(&env.t("Assets/scripts/readme.txt"), b"old", T0);
    write(&env.s("README.md"), b"r", T0);
    write(&env.t("readme.md"), b"r", T0);

    let out = env.scan(&SyncScope::default());
    assert_entry(&out, "Assets/Scripts", PlanAction::Update, PlanReason::Case);
    assert_entry(
        &out,
        "Assets/Scripts/PlayerController.cs",
        PlanAction::Update,
        PlanReason::Case,
    );
    assert_entry(
        &out,
        "Assets/Scripts/Readme.TXT",
        PlanAction::Update,
        PlanReason::Size,
    );
    assert_entry(&out, "README.md", PlanAction::Update, PlanReason::Case);
    assert_eq!(out.summary.update.files, 4);
    assert_eq!(out.summary.total_entries, 4, "{:#?}", out.summary.entries);

    let events = Mutex::new(Vec::new());
    let report = execute(&out.plan, &AtomicBool::new(false), 2, &|p: SyncProgress| {
        events.lock().unwrap().push(p)
    });
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.updated, out.summary.update.files);
    let last = events.into_inner().unwrap().pop().unwrap();
    assert_eq!(last.done_files, last.total_files);
    assert_eq!(names_in(&env.t("Assets")), vec!["Scripts"]);
    assert_eq!(
        names_in(&env.t("Assets/Scripts")),
        vec!["PlayerController.cs", "Readme.TXT"]
    );
    assert!(names_in(&env.tgt).contains(&"README.md".to_string()));
    assert_eq!(
        fs::read(env.t("Assets/Scripts/Readme.TXT")).unwrap(),
        b"new longer text"
    );
    assert_fully_unchanged(&env, &SyncScope::default());
}

#[test]
fn root_never_sync_entries_are_never_touched() {
    let scope = SyncScope::default();

    // (a) Source is a normal repo (.git dir), target a worktree (.git file).
    let env = Env::new();
    write(&env.s("Assets/a.cs"), b"a", T0);
    write(&env.s(".git/HEAD"), b"ref: refs/heads/main", T0);
    write(&env.t(".git"), b"gitdir: C:/main/.git/worktrees/tgt", T0);
    let out = env.scan(&scope);
    assert!(
        !out.summary
            .entries
            .iter()
            .any(|e| e.path.starts_with(".git")),
        "{:#?}",
        out.summary.entries
    );
    let report = env.sync(&out);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(
        fs::read(env.t(".git")).unwrap(),
        b"gitdir: C:/main/.git/worktrees/tgt"
    );

    // (b) Both are worktrees with different pointers.
    let env = Env::new();
    write(&env.s("Assets/a.cs"), b"a", T0);
    write(&env.s(".git"), b"gitdir: C:/main/.git/worktrees/src", T0);
    write(
        &env.t(".git"),
        b"gitdir: C:/main/.git/worktrees/target",
        T0 - 100,
    );
    let out = env.scan(&scope);
    assert!(entry(&out, ".git").is_none(), "{:#?}", out.summary.entries);
    env.sync(&out);
    assert_eq!(
        fs::read(env.t(".git")).unwrap(),
        b"gitdir: C:/main/.git/worktrees/target"
    );

    // (c) Source worktree, no .git in the target: nothing is copied.
    let env = Env::new();
    write(&env.s("Assets/a.cs"), b"a", T0);
    write(&env.s(".git"), b"gitdir: C:/main/.git/worktrees/src", T0);
    let out = env.scan(&scope);
    assert!(entry(&out, ".git").is_none());
    let report = env.sync(&out);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert!(!env.t(".git").exists());

    // (d) Root FILES named like never-synced folders, on either side.
    let env = Env::new();
    write(&env.s("Assets/a.cs"), b"a", T0);
    write(&env.s("Library"), b"source file", T0);
    write(&env.s("Temp"), b"source temp", T0);
    write(&env.t("obj"), b"target file", T0);
    write(&env.t("Temp"), b"target temp file", T0);
    write(&env.t("LOGS"), b"target logs file", T0);
    let out = env.scan(&scope);
    for name in ["Library", "Temp", "obj", "LOGS"] {
        assert!(
            entry(&out, name).is_none(),
            "{name}: {:#?}",
            out.summary.entries
        );
    }
    let report = env.sync(&out);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert!(!env.t("Library").exists());
    assert_eq!(fs::read(env.t("obj")).unwrap(), b"target file");
    assert_eq!(fs::read(env.t("Temp")).unwrap(), b"target temp file");
    assert_eq!(fs::read(env.t("LOGS")).unwrap(), b"target logs file");

    // The plan itself refuses never-synced and alias-prone top-level names.
    let mut plan = out.plan.clone();
    plan.scope.folders = vec!["GIT~1".into(), ".git".into(), "Library.".into()];
    for rel in [
        "GIT~1/objects",
        "GIT~1",
        ".git/HEAD",
        ".git",
        ".GIT",
        "Library./x",
        "library/x",
        "obj",
    ] {
        assert!(!plan.in_scope(rel), "{rel}");
    }
    assert!(plan.in_scope("notes.txt~"));
}

#[test]
fn type_conflict_dir_contents_are_counted_and_confirmed() {
    let env = Env::new();
    write(&env.s("Assets/Foo"), b"now a file", T0);
    write(&env.t("Assets/Foo/sub/a.txt"), b"aa", T0);
    write(&env.t("Assets/Foo/sub/b.txt"), b"bbb", T0);
    let out = env.scan(&SyncScope::default());
    assert_entry(&out, "Assets/Foo", PlanAction::Update, PlanReason::Type);
    let s = &out.summary;
    assert_eq!((s.delete.files, s.delete.dirs, s.delete.bytes), (2, 1, 5));
    let conflict = out.plan.delete_dirs.iter().find(|d| d.conflict).unwrap();
    assert_eq!((conflict.nested_files, conflict.nested_dirs), (2, 1));
    let report = env.sync(&out);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!((report.deleted_files, report.deleted_dirs), (2, 1));
    assert_eq!(report.updated, 1);
    assert_eq!(fs::read(env.t("Assets/Foo")).unwrap(), b"now a file");
    assert_fully_unchanged(&env, &SyncScope::default());
}

#[test]
fn links_created_after_the_scan_are_not_followed() {
    let env = Env::new();
    let outside = env.tgt.parent().unwrap().join("outside");
    write(&outside.join("old.txt"), b"precious old", T0);
    write(&outside.join("new.txt"), b"precious new", T0);
    write(&outside.join("Gone/x.txt"), b"precious x", T0);
    write(&env.s("Assets/Shared/new.txt"), b"from source", T0 + 100);
    write(&env.s("Assets/Shared/Fresh/f.txt"), b"f", T0);
    write(&env.t("Assets/Shared/old.txt"), b"stale", T0);
    write(&env.t("Assets/Shared/new.txt"), b"stale target", T0);
    write(&env.t("Assets/Shared/Gone/x.txt"), b"x", T0);
    let out = env.scan(&SyncScope::default());
    assert_entry(
        &out,
        "Assets/Shared/old.txt",
        PlanAction::Delete,
        PlanReason::Extra,
    );
    assert_entry(
        &out,
        "Assets/Shared/Gone",
        PlanAction::Delete,
        PlanReason::Extra,
    );
    assert_entry(
        &out,
        "Assets/Shared/new.txt",
        PlanAction::Update,
        PlanReason::Size,
    );

    // Replaced by a link to another folder between preview and "Start sync".
    fs::remove_dir_all(env.t("Assets/Shared")).unwrap();
    if !dir_link(&outside, &env.t("Assets/Shared")) {
        eprintln!("link creation not permitted here; skipping");
        return;
    }
    let report = env.sync(&out);
    assert!(report.error_count >= 3, "{:?}", report.errors);
    assert!(
        report
            .errors
            .iter()
            .all(|e| e.message.contains("symbolic link")),
        "{:?}",
        report.errors
    );
    assert_eq!(fs::read(outside.join("old.txt")).unwrap(), b"precious old");
    assert_eq!(fs::read(outside.join("new.txt")).unwrap(), b"precious new");
    assert_eq!(fs::read(outside.join("Gone/x.txt")).unwrap(), b"precious x");
    assert!(!outside.join("Fresh").exists());
}

#[test]
fn differently_cased_target_link_is_never_written_through() {
    let env = Env::new();
    if !temp_is_case_insensitive(&env) {
        return;
    }
    let outside = env.tgt.parent().unwrap().join("shared-pkg");
    write(&outside.join("x"), b"outside content", T0);
    write(&env.s("Assets/Shared/x"), b"source content!", T0 + 100);
    fs::create_dir_all(env.t("Assets")).unwrap();
    if !dir_link(&outside, &env.t("Assets/shared")) {
        eprintln!("link creation not permitted here; skipping");
        return;
    }
    let out = env.scan(&SyncScope::default());
    let report = env.sync(&out);
    assert_eq!(fs::read(outside.join("x")).unwrap(), b"outside content");
    assert!(
        report.error_count > 0
            || out
                .summary
                .warnings
                .iter()
                .any(|w| w.contains("symbolic link")),
        "{:?} {:?}",
        out.summary.warnings,
        report.errors
    );
}

#[test]
fn verify_target_removed_after_scan_is_copied() {
    let env = Env::new();
    write(&env.s("Assets/a.txt"), b"abc", T0);
    write(&env.t("Assets/a.txt"), b"abc", T0 - 100);
    write(&env.s("Assets/Dir/b.txt"), b"bbb", T0);
    write(&env.t("Assets/Dir/b.txt"), b"bbb", T0 - 100);
    let out = env.scan(&SyncScope::default());
    assert_eq!(out.summary.verify.files, 2);
    fs::remove_file(env.t("Assets/a.txt")).unwrap();
    fs::remove_dir_all(env.t("Assets/Dir")).unwrap();
    let report = env.sync(&out);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.verified_changed, 2);
    assert_eq!(fs::read(env.t("Assets/a.txt")).unwrap(), b"abc");
    assert_eq!(fs::read(env.t("Assets/Dir/b.txt")).unwrap(), b"bbb");
    assert_fully_unchanged(&env, &SyncScope::default());
}

/// Creates a directory symlink, falling back to a junction on Windows (no privilege needed).
fn dir_link(target: &Path, link: &Path) -> bool {
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_dir(target, link).is_ok() {
            return true;
        }
        std::process::Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(link.to_str().unwrap().replace('/', "\\"))
            .arg(target.to_str().unwrap().replace('/', "\\"))
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
}

#[test]
fn symlinks_are_skipped_and_never_followed() {
    let env = Env::new();
    let outside = env.tgt.parent().unwrap().join("outside");
    write(&outside.join("precious.txt"), b"keep me", T0);
    write(&env.s("Assets/Linked/new.txt"), b"n", T0);
    fs::create_dir_all(env.t("Assets")).unwrap();
    if !dir_link(&outside, &env.t("Assets/Linked")) {
        eprintln!("link creation not permitted here; skipping");
        return;
    }
    // A link in the source: skipped, and the real target folder at that path is not deleted.
    assert!(dir_link(&outside, &env.s("Assets/SrcLink")));
    write(&env.t("Assets/SrcLink/mine.txt"), b"m", T0);
    // A link in the target where the source has content: skipped with a warning.
    let out = env.scan(&SyncScope::default());
    assert!(
        out.summary
            .warnings
            .iter()
            .any(|w| w.contains("Assets/Linked"))
    );
    assert!(
        out.summary
            .warnings
            .iter()
            .any(|w| w.contains("Assets/SrcLink"))
    );
    assert!(entry(&out, "Assets/Linked/new.txt").is_none());
    assert!(entry(&out, "Assets/SrcLink").is_none());
    assert!(entry(&out, "Assets/SrcLink/mine.txt").is_none());
    let report = env.sync(&out);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert!(!outside.join("new.txt").exists());
    assert!(env.t("Assets/SrcLink/mine.txt").exists());
    assert!(!outside.join("mine.txt").exists());

    // A link inside a target folder that is deleted: only the link goes.
    fs::remove_dir_all(env.s("Assets/Linked")).unwrap();
    fs::create_dir_all(env.t("Assets/Gone")).unwrap();
    assert!(dir_link(&outside, &env.t("Assets/Gone/link")));
    let out = env.scan(&SyncScope::default());
    assert_entry(&out, "Assets/Gone", PlanAction::Delete, PlanReason::Extra);
    let report = env.sync(&out);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert!(!env.t("Assets/Gone").exists());
    assert!(outside.join("precious.txt").exists());
}

#[test]
fn comparison_path_resolves_aliases() {
    use crate::scan::comparison_path;
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("Real");
    fs::create_dir_all(real.join("Sub")).unwrap();
    let real_cmp = comparison_path(real.to_str().unwrap());
    assert!(!real_cmp.is_empty());
    assert_eq!(comparison_path(""), "");
    assert_eq!(comparison_path("   "), "");

    // `..` segments and (missing) children resolve through the nearest existing ancestor.
    let dotted = real.join("Sub").join("..");
    assert_eq!(comparison_path(dotted.to_str().unwrap()), real_cmp);
    let missing = comparison_path(real.join("NotYet").join("Deeper").to_str().unwrap());
    assert!(
        Path::new(&missing).starts_with(Path::new(&real_cmp)),
        "{missing}"
    );
    assert!(missing.ends_with("deeper") || missing.ends_with("Deeper"));

    #[cfg(windows)]
    {
        // No verbatim prefix, lowercase, and the `\\?\` spelling compares equal.
        assert!(!real_cmp.starts_with(r"\\?\"));
        assert_eq!(real_cmp, real_cmp.to_lowercase());
        let verbatim = format!(r"\\?\{}", real.to_str().unwrap());
        assert_eq!(comparison_path(&verbatim), real_cmp);
        let upper = real.to_str().unwrap().to_uppercase();
        assert_eq!(comparison_path(&upper), real_cmp);
    }

    // A junction/symlink to the folder (and a missing child of it) compares equal to the real one.
    let alias = dir.path().join("Alias");
    if !dir_link(&real, &alias) {
        eprintln!("link creation not permitted here; skipping the link part");
        return;
    }
    assert_eq!(comparison_path(alias.to_str().unwrap()), real_cmp);
    assert_eq!(
        comparison_path(alias.join("NotYet").join("Deeper").to_str().unwrap()),
        missing
    );
    let info = crate::project::inspect_project(alias.to_str().unwrap());
    assert_eq!(info.compare_path, real_cmp);
}

#[test]
fn validation_errors() {
    let env = Env::new();
    write(&env.s("Assets/a.txt"), b"a", T0);
    let scope = SyncScope::default();
    let err = |r: Result<ScanOutput, ScanError>| match r {
        Err(ScanError::Invalid(m)) => m,
        Err(e) => panic!("unexpected {e}"),
        Ok(_) => panic!("expected an error"),
    };

    let m = err(try_scan(&env.src, &env.src, &scope));
    assert!(m.contains("same folder"), "{m}");
    let m = err(try_scan(
        &env.src,
        &env.src.join("Sub").join("Deeper"),
        &scope,
    ));
    assert!(m.contains("inside the source"), "{m}");
    let m = err(try_scan(&env.src.join("Assets"), &env.src, &scope));
    assert!(m.contains("inside the target"), "{m}");
    let m = err(try_scan(&env.src.join("nope"), &env.tgt, &scope));
    assert!(m.contains("does not exist"), "{m}");

    #[cfg(windows)]
    let root = PathBuf::from(format!(
        "{}\\",
        env.src.to_str().unwrap().split('\\').next().unwrap()
    ));
    #[cfg(not(windows))]
    let root = PathBuf::from("/");
    let m = err(try_scan(&env.src, &root, &scope));
    assert!(m.contains("root"), "{m}");

    for bad in [
        "Library", "library", ".git", "Temp", "obj", "Logs", ".vs", ".utmp",
    ] {
        let s = SyncScope {
            include_root_files: true,
            folders: vec!["Assets".into(), bad.into()],
        };
        let m = err(try_scan(&env.src, &env.tgt, &s));
        assert!(m.contains("never be synced"), "{bad}: {m}");
    }
    for bad in [
        "Assets/Sub",
        "Assets\\Sub",
        "..",
        ".",
        "",
        "GIT~1",
        "VS~1",
        "UTMP~1",
        "Library.",
        "Assets.",
        "Foo~",
    ] {
        let s = SyncScope {
            include_root_files: true,
            folders: vec![bad.into()],
        };
        err(try_scan(&env.src, &env.tgt, &s));
    }
    let empty = SyncScope {
        include_root_files: false,
        folders: vec![],
    };
    let m = err(try_scan(&env.src, &env.tgt, &empty));
    assert!(m.contains("Nothing to sync"), "{m}");

    // Root files only is a valid scope.
    let roots_only = SyncScope {
        include_root_files: true,
        folders: vec![],
    };
    assert!(try_scan(&env.src, &env.tgt, &roots_only).is_ok());
    // Target does not have to exist.
    assert!(!env.tgt.exists());
    assert!(try_scan(&env.src, &env.tgt, &scope).is_ok());
}

// ---------------------------------------------------------------------------------------------
// Full end-to-end run on a realistic fake Unity project.
// ---------------------------------------------------------------------------------------------

/// What a snapshot records for one path: `None` for a directory, `(len, content hash, mtime secs)`
/// for a file.
type Snap = std::collections::BTreeMap<String, Option<(usize, u64, i64)>>;

fn content_hash(bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

/// Asserts two snapshots are equal (mtimes may differ by up to `tolerance` seconds, like the
/// scanner allows), listing only the differing paths on failure.
fn assert_snap_eq(left: &Snap, right: &Snap, tolerance: i64, what: &str) {
    let mut diffs = Vec::new();
    for k in left
        .keys()
        .chain(right.keys().filter(|k| !left.contains_key(*k)))
    {
        let same = match (left.get(k), right.get(k)) {
            (Some(Some((la, lh, lm))), Some(Some((ra, rh, rm)))) => {
                la == ra && lh == rh && (lm - rm).abs() <= tolerance
            }
            (l, r) => l == r,
        };
        if !same {
            diffs.push(format!("{k}: {:?} vs {:?}", left.get(k), right.get(k)));
        }
    }
    assert!(diffs.is_empty(), "{what} differs:\n{}", diffs.join("\n"));
}

/// Recursively records every file/dir under `root` (links not followed), keyed by relative path.
/// `filter(rel, is_dir)` decides by relative path (forward slashes) whether an entry is included.
fn snapshot(root: &Path, filter: &dyn Fn(&str, bool) -> bool) -> Snap {
    let mut out = Snap::new();
    if !root.exists() {
        return out;
    }
    for e in walkdir::WalkDir::new(root).min_depth(1).follow_links(false) {
        let e = e.unwrap();
        let rel = e
            .path()
            .strip_prefix(root)
            .unwrap()
            .to_str()
            .unwrap()
            .replace('\\', "/");
        if !filter(&rel, e.file_type().is_dir()) {
            continue;
        }
        let value = if e.file_type().is_dir() {
            None
        } else {
            let bytes = fs::read(e.path()).unwrap();
            Some((bytes.len(), content_hash(&bytes), mtime(e.path())))
        };
        out.insert(rel, value);
    }
    out
}

fn top_level(rel: &str) -> &str {
    rel.split('/').next().unwrap()
}

/// True when `rel` lies inside `scope` (root files or one of the scope folders, case-insensitive).
fn in_scope(scope: &SyncScope, rel: &str, is_dir: bool) -> bool {
    let top = top_level(rel);
    if top == rel && !is_dir {
        return scope.include_root_files;
    }
    scope.folders.iter().any(|f| f.eq_ignore_ascii_case(top))
}

#[test]
fn end_to_end_unity_project_mirror() {
    let env = Env::new();
    let big: Vec<u8> = (0..(2 * 1024 * 1024 + 7))
        .map(|i| (i % 253) as u8)
        .collect();

    // ---- source: a Unity 6 project ----
    let s = |rel: &str, content: &[u8]| write(&env.s(rel), content, T0);
    s("Assets/Scenes.meta", b"guid: scenes");
    s(
        "Assets/Scenes/Main.unity",
        b"%YAML 1.1\n--- !u!29 &1\nOcclusionCullingSettings: new",
    );
    s("Assets/Scenes/Main.unity.meta", b"guid: main");
    s("Assets/Scripts.meta", b"guid: scripts");
    s("Assets/Scripts/Player.meta", b"guid: player-dir");
    s(
        "Assets/Scripts/Player/Player.cs",
        b"class Player { int hp = 100; }",
    );
    s("Assets/Scripts/Player/Player.cs.meta", b"guid: player");
    s("Assets/Scripts/Player/Enemy.cs", b"class Enemy {}");
    s("Assets/Scripts/Player/Enemy.cs.meta", b"guid: enemy");
    s("Assets/Textures/Hero.png", &big);
    s("Assets/Textures/Hero.png.meta", b"guid: hero");
    s("Assets/Textures.meta", b"guid: textures");
    s("Assets/Empty.meta", b"guid: empty");
    fs::create_dir_all(env.s("Assets/Empty")).unwrap();
    s(
        "Packages/manifest.json",
        br#"{"dependencies":{"com.unity.inputsystem":"1.11.2"}}"#,
    );
    s("Packages/packages-lock.json", br#"{"dependencies":{}}"#);
    s(
        "ProjectSettings/ProjectVersion.txt",
        b"m_EditorVersion: 6000.0.23f1\nm_EditorVersionWithRevision: 6000.0.23f1 (1c4764c07fb4)\n",
    );
    s(
        "ProjectSettings/ProjectSettings.asset",
        b"PlayerSettings: v2",
    );
    s("ProjectSettings/TagManager.asset", b"tags: [Enemy]");
    s(".gitignore", b"/[Ll]ibrary/\n/[Tt]emp/\n/[Ll]ogs/\n");
    s(
        ".vsconfig",
        br#"{"components":["Microsoft.VisualStudio.Workload.ManagedGame"]}"#,
    );
    // Regenerable / out-of-scope junk in the source: must never be copied.
    s("Library/ArtifactDB", b"source-artifacts");
    s("Library/PackageCache/com.unity.x/a.cs", b"cache");
    s("Temp/UnityLockfile", b"");
    s("Logs/AssetImportWorker0.log", b"log");
    s("UserSettings/EditorUserSettings.asset", b"user: source");

    // ---- target: an older copy with stale and extra content ----
    let t = |rel: &str, content: &[u8], secs: i64| write(&env.t(rel), content, secs);
    t("Assets/Scenes.meta", b"guid: scenes", T0); // unchanged
    t("Assets/Scenes/Main.unity", b"%YAML 1.1\nold", T0 - 3600); // update (size)
    t("Assets/Scenes/Main.unity.meta", b"guid: main", T0 - 3600); // verify -> identical
    t("Assets/Scripts.meta", b"guid: scripts", T0);
    t("Assets/Scripts/Player.meta", b"guid: player-dir", T0);
    t(
        "Assets/Scripts/Player/Player.cs",
        b"class Player { int hp = 999; }",
        T0 - 60,
    ); // verify -> changed
    t(
        "Assets/Scripts/Player/Player.cs.meta",
        b"guid: player",
        T0 + 1,
    ); // within tolerance
    t("Assets/Scripts/Player/Unused.cs", b"class Unused {}", T0); // delete
    t("Assets/Scripts/Player/Unused.cs.meta", b"guid: unused", T0); // delete
    t("Assets/Textures/Hero.png", &big, T0); // unchanged (large)
    t("Assets/Old.meta", b"guid: old", T0); // delete
    t("Assets/Old/Removed.cs", b"class Removed {}", T0); // dir delete
    t("Assets/Old/Deep/Removed.prefab", b"prefab", T0);
    t(
        "Packages/manifest.json",
        br#"{"dependencies":{"com.unity.inputsystem":"1.11.2"}}"#,
        T0,
    );
    t("Packages/com.local.tool/package.json", b"{}", T0); // dir delete
    t(
        "ProjectSettings/ProjectVersion.txt",
        b"m_EditorVersion: 6000.0.10f1\n",
        T0 - 86400,
    );
    t(".gitignore", b"/Library/\n", T0 - 10); // update (size)
    t("OldGame.sln", b"Microsoft Visual Studio Solution File", T0); // root file delete
    // Outside the scope: must be left exactly as is.
    t(
        "Library/ArtifactDB",
        b"target-artifacts-are-different",
        T0 - 5,
    );
    t("Library/Bee/huge.dag", b"bee", T0 - 5);
    t("Temp/UnityLockfile", b"lock", T0 - 5);
    t("Logs/Editor.log", b"editor log", T0 - 5);
    t("obj/Debug/x.dll", b"dll", T0 - 5);
    t(".git/HEAD", b"ref: refs/heads/main", T0 - 5);
    t("Builds/Win64/Game.exe", b"MZ", T0 - 5);
    t(
        "UserSettings/EditorUserSettings.asset",
        b"user: target",
        T0 - 5,
    );
    fs::create_dir_all(env.t("Recordings/Empty")).unwrap();

    let scope = SyncScope::default();
    let everything = |_: &str, _: bool| true;
    let source_before = snapshot(&env.src, &everything);
    let outside_before = snapshot(&env.tgt, &|rel, d| !in_scope(&scope, rel, d));
    assert!(outside_before.contains_key("Library/ArtifactDB"));
    assert!(outside_before.contains_key("Recordings/Empty"));

    // inspect_project sees a Unity 6 project.
    let info = crate::project::inspect_project(env.src.to_str().unwrap());
    assert!(info.exists && info.is_unity_project && !info.is_empty);
    assert_eq!(info.unity_version.as_deref(), Some("6000.0.23f1"));
    assert!(info.root_dirs.iter().any(|d| d == "Assets"));

    // ---- scan ----
    let out = env.scan(&scope);
    let sm = &out.summary;
    assert!(sm.warnings.is_empty(), "{:?}", sm.warnings);
    use PlanAction::*;
    use PlanReason::*;
    assert_entry(&out, "Assets/Scenes/Main.unity", Update, Size);
    assert_entry(&out, "Assets/Scenes/Main.unity.meta", Verify, Mtime);
    assert_entry(&out, "Assets/Scripts/Player/Player.cs", Verify, Mtime);
    assert_entry(&out, "Assets/Scripts/Player/Enemy.cs", Copy, New);
    assert_entry(&out, "Assets/Scripts/Player/Unused.cs", Delete, Extra);
    assert_entry(&out, "Assets/Old", Delete, Extra);
    assert_entry(&out, "Assets/Old.meta", Delete, Extra);
    assert_entry(&out, "Assets/Empty", Copy, New);
    assert_entry(&out, "Packages/com.local.tool", Delete, Extra);
    assert_entry(&out, "Packages/packages-lock.json", Copy, New);
    assert_entry(&out, "ProjectSettings/ProjectVersion.txt", Update, Size);
    assert_entry(&out, ".gitignore", Update, Size);
    assert_entry(&out, ".vsconfig", Copy, New);
    assert_entry(&out, "OldGame.sln", Delete, Extra);
    assert!(entry(&out, "Assets/Textures/Hero.png").is_none());
    assert!(entry(&out, "Assets/Scripts/Player/Player.cs.meta").is_none());
    for e in &sm.entries {
        assert!(
            in_scope(&scope, &e.path, e.is_dir),
            "out-of-scope entry {e:?}"
        );
    }
    assert_eq!(sm.verify.files, 2);
    assert_eq!(sm.delete.dirs, 3); // Old, Old/Deep, com.local.tool
    // Unused.cs, Unused.cs.meta, Old.meta, Old/Removed.cs, Old/Deep/Removed.prefab,
    // com.local.tool/package.json, OldGame.sln
    assert_eq!(sm.delete.files, 7);
    assert_eq!(
        sm.total_bytes,
        sm.copy.bytes + sm.update.bytes + sm.verify.bytes
    );
    assert_eq!(sm.total_entries as usize, sm.entries.len());

    // ---- sync ----
    let report = env.sync(&out);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert!(!report.cancelled);
    assert_eq!(report.verified_identical, 1);
    assert_eq!(report.verified_changed, 1);
    assert_eq!(report.deleted_files, sm.delete.files);
    assert_eq!(report.deleted_dirs, sm.delete.dirs);
    assert_eq!(report.copied, sm.copy.files);
    assert_eq!(report.updated, sm.update.files);

    // The mirror is exact inside the scope (paths, empty dirs, contents and mtimes) ...
    let src_scoped = snapshot(&env.src, &|rel, d| in_scope(&scope, rel, d));
    let tgt_scoped = snapshot(&env.tgt, &|rel, d| in_scope(&scope, rel, d));
    // Player.cs.meta keeps its target mtime (1 s off, inside the 2 s tolerance, never touched).
    assert_snap_eq(&src_scoped, &tgt_scoped, 2, "in-scope mirror");
    assert_eq!(
        mtime(&env.t("Assets/Scripts/Player/Player.cs.meta")),
        T0 + 1
    );
    assert!(tgt_scoped.contains_key("Assets/Empty"));
    // ... everything outside the scope is untouched ...
    assert_snap_eq(
        &snapshot(&env.tgt, &|rel, d| !in_scope(&scope, rel, d)),
        &outside_before,
        0,
        "target outside scope",
    );
    assert!(!env.t("Library/PackageCache").exists());
    // ... and the source was never modified.
    assert_snap_eq(
        &snapshot(&env.src, &everything),
        &source_before,
        0,
        "source",
    );

    // ---- rescan: nothing left to do ----
    let again = env.scan(&scope);
    assert_eq!(
        again.summary.total_entries, 0,
        "{:#?}",
        again.summary.entries
    );
    assert_eq!(again.summary.total_bytes, 0);
    assert_eq!(
        again.summary.unchanged.files as usize,
        src_scoped.values().filter(|v| v.is_some()).count()
    );

    // ---- widen the scope with UserSettings: it is mirrored, the rest stays untouched ----
    let wide = SyncScope {
        include_root_files: true,
        folders: vec![
            "Assets".into(),
            "Packages".into(),
            "ProjectSettings".into(),
            "UserSettings".into(),
        ],
    };
    let outside_wide = snapshot(&env.tgt, &|rel, d| !in_scope(&wide, rel, d));
    let out = env.scan(&wide);
    // Same length ("user: source" / "user: target"), different mtime -> verify, content differs.
    assert_entry(&out, "UserSettings/EditorUserSettings.asset", Verify, Mtime);
    assert_eq!(out.summary.total_entries, 1);
    let report = env.sync(&out);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.verified_changed, 1);
    assert_eq!(
        fs::read(env.t("UserSettings/EditorUserSettings.asset")).unwrap(),
        b"user: source"
    );
    assert_snap_eq(
        &snapshot(&env.tgt, &|rel, d| !in_scope(&wide, rel, d)),
        &outside_wide,
        0,
        "target outside widened scope",
    );
    assert_fully_unchanged(&env, &wide);

    // ---- root files off: a new root file in the source is ignored, extra target root files stay ----
    write(&env.s("NewRoot.txt"), b"new", T0);
    write(&env.t("TargetOnly.txt"), b"keep", T0);
    let no_root = SyncScope {
        include_root_files: false,
        folders: wide.folders.clone(),
    };
    let out = env.scan(&no_root);
    assert_eq!(out.summary.total_entries, 0, "{:#?}", out.summary.entries);
    env.sync(&out);
    assert!(!env.t("NewRoot.txt").exists());
    assert!(env.t("TargetOnly.txt").exists());
}

/// The JSON sent to the UI has exactly the field names of `src/lib/types.ts`.
#[test]
fn wire_payloads_match_types_ts() {
    fn keys(v: &serde_json::Value) -> Vec<String> {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    }
    fn expect(v: &serde_json::Value, names: &[&str]) {
        let mut want: Vec<String> = names.iter().map(|s| s.to_string()).collect();
        want.sort();
        assert_eq!(keys(v), want);
    }
    let env = Env::new();
    write(&env.s("Assets/a.cs"), b"a", T0);
    write(&env.t("Assets/old.cs"), b"o", T0);
    let out = env.scan(&SyncScope::default());
    let summary = serde_json::to_value(&out.summary).unwrap();
    expect(
        &summary,
        &[
            "planId",
            "source",
            "target",
            "scope",
            "copy",
            "update",
            "verify",
            "delete",
            "unchanged",
            "totalBytes",
            "entries",
            "entriesTruncated",
            "totalEntries",
            "warnings",
            "scanMs",
            "scanThreads",
        ],
    );
    expect(&summary["scope"], &["includeRootFiles", "folders"]);
    expect(&summary["copy"], &["files", "bytes"]);
    expect(&summary["delete"], &["files", "bytes", "dirs"]);
    expect(
        &summary["entries"][0],
        &["path", "action", "reason", "size", "isDir"],
    );
    let report = serde_json::to_value(env.sync(&out)).unwrap();
    expect(
        &report,
        &[
            "copied",
            "updated",
            "verifiedIdentical",
            "verifiedChanged",
            "deletedFiles",
            "deletedDirs",
            "bytesWritten",
            "durationMs",
            "cancelled",
            "errors",
            "errorCount",
            "threads",
        ],
    );
    let info = serde_json::to_value(crate::project::inspect_project("")).unwrap();
    expect(
        &info,
        &[
            "path",
            "exists",
            "isEmpty",
            "isUnityProject",
            "unityVersion",
            "rootDirs",
            "comparePath",
        ],
    );
    assert_eq!(info["comparePath"], "");
    assert!(info["unityVersion"].is_null());
    let progress = SyncProgress {
        phase: crate::model::SyncPhase::Finalizing,
        done_bytes: 0,
        total_bytes: 0,
        done_files: 0,
        total_files: 0,
        bytes_per_sec: 0.0,
        cost_per_sec: 0.0,
        eta_secs: None,
        elapsed_ms: 0,
        current_file: None,
        errors: 0,
        delete_done: 0,
        delete_total: 0,
        threads: 1,
    };
    let progress = serde_json::to_value(progress).unwrap();
    expect(
        &progress,
        &[
            "phase",
            "doneBytes",
            "totalBytes",
            "doneFiles",
            "totalFiles",
            "bytesPerSec",
            "costPerSec",
            "etaSecs",
            "elapsedMs",
            "currentFile",
            "errors",
            "deleteDone",
            "deleteTotal",
            "threads",
        ],
    );
    assert_eq!(progress["phase"], "finalizing");
}

#[test]
fn ui_entries_are_capped() {
    let env = Env::new();
    let dir = env.s("Assets/Many");
    fs::create_dir_all(&dir).unwrap();
    for i in 0..20_005 {
        fs::write(dir.join(format!("f{i:05}.txt")), b"").unwrap();
    }
    // Sorts after all the copies, but deletions always survive the cap.
    write(&env.s("Packages/manifest.json"), b"{}", T0);
    write(&env.t("Packages/manifest.json"), b"{}", T0);
    write(&env.t("Packages/zz_stale.txt"), b"x", T0);
    let out = env.scan(&SyncScope::default());
    assert!(out.summary.entries_truncated);
    assert_eq!(out.summary.entries.len(), 20_000);
    assert_eq!(out.summary.total_entries, 20_006);
    assert_eq!(out.plan.transfers.len(), 20_005);
    assert_entry(
        &out,
        "Packages/zz_stale.txt",
        PlanAction::Delete,
        PlanReason::Extra,
    );
    let paths: Vec<String> = out
        .summary
        .entries
        .iter()
        .map(|e| e.path.to_lowercase())
        .collect();
    assert!(
        paths.windows(2).all(|w| w[0] <= w[1]),
        "entries sorted by path"
    );
}

// ---------------------------------------------------------------------------------------------
// Thread count: plans and results never depend on it.
// ---------------------------------------------------------------------------------------------

/// xorshift64*: deterministic pseudo-random choices for generated trees.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    fn below(&mut self, n: usize) -> usize {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        (self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 33) as usize % n
    }

    fn bytes(&mut self, max: usize) -> Vec<u8> {
        let n = self.below(max + 1);
        (0..n).map(|_| self.below(256) as u8).collect()
    }
}

fn set_read_only(path: &Path) {
    let mut perms = fs::metadata(path).unwrap().permissions();
    perms.set_readonly(true);
    fs::set_permissions(path, perms).unwrap();
}

/// Clears read-only flags below `root` (so the temp dir can be removed).
fn clear_read_only(root: &Path) {
    for e in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .flatten()
    {
        if !e.file_type().is_symlink() {
            let _ = crate::fsutil::make_writable(e.path());
        }
    }
}

/// Builds a pseudo-random source/target pair: nested folders, new / unchanged / verify / update
/// files, case-only differences, type conflicts, read-only files, extra target files and trees,
/// and (when the OS allows it) links in both trees. Entries named `LNK*` are links.
fn random_pair(env: &Env, seed: u64) {
    let mut rng = Rng::new(seed);
    let outside = env.tgt.parent().unwrap().join("outside");
    write(&outside.join("precious.txt"), b"never touched", T0);

    let mut dirs: Vec<String> = vec!["Assets".into(), "Packages".into(), "ProjectSettings".into()];
    for i in 0..40 {
        let parent = dirs[rng.below(dirs.len())].clone();
        if parent.matches('/').count() < 4 {
            dirs.push(format!("{parent}/D{i}"));
        }
    }
    for (i, d) in dirs.iter().enumerate() {
        for j in 0..rng.below(7) {
            let rel = format!("{d}/f{i}_{j}.txt");
            let content = rng.bytes(64);
            write(&env.s(&rel), &content, T0);
            match rng.below(9) {
                0 => {} // new
                1 => write(&env.t(&rel), &content, T0),
                2 => write(&env.t(&rel), &content, T0 - 100), // verify
                3 => write(&env.t(&rel), &[b'u'; 100], T0),   // update
                4 => {
                    // Case-only difference (a rename on case-insensitive volumes).
                    let upper = format!("{d}/F{i}_{j}.TXT");
                    write(&env.t(&upper), &content, T0);
                }
                5 => write(&env.t(&format!("{rel}/inner.txt")), b"dir here", T0), // type
                6 => {
                    write(&env.t(&rel), &content, T0 - 100);
                    set_read_only(&env.t(&rel));
                    set_read_only(&env.s(&rel));
                }
                7 => {
                    write(&env.t(&rel), b"stale", T0 - 5000);
                    set_read_only(&env.t(&rel));
                }
                _ => write(&env.t(&rel), &content, T0 + 1), // within the mtime tolerance
            }
        }
    }
    // Extra target files and trees (deleted), some read-only.
    for i in 0..20 {
        let parent = dirs[rng.below(dirs.len())].clone();
        if rng.below(2) == 0 {
            let p = env.t(&format!("{parent}/extra{i}.bin"));
            write(&p, &rng.bytes(32), T0);
            if i % 3 == 0 {
                set_read_only(&p);
            }
        } else {
            for k in 0..rng.below(5) + 1 {
                let p = env.t(&format!("{parent}/X{i}/y{}/z{k}.txt", k % 2));
                write(&p, b"z", T0);
                if k == 0 {
                    set_read_only(&p);
                }
            }
        }
    }
    // A source folder where the target has a file, and a differently cased target folder.
    write(&env.s("Assets/TypeDir/a.txt"), b"a", T0);
    write(&env.t("Assets/TypeDir"), b"file", T0);
    write(&env.s("Assets/CaseDir/Inner/x.txt"), b"x", T0);
    write(&env.t("Assets/casedir/inner/x.txt"), b"x", T0);
    write(&env.s("README.md"), b"readme", T0);
    write(&env.t("old-root.txt"), b"old", T0);
    // Links: in the source (skipped), in the target (left alone), inside a deleted tree.
    fs::create_dir_all(env.t("Assets/X_links")).unwrap();
    if dir_link(&outside, &env.s("Assets/LNK_src")) {
        write(&env.t("Assets/LNK_src/mine.txt"), b"protected", T0);
        assert!(dir_link(&outside, &env.t("Assets/LNK_tgt")));
        assert!(dir_link(&outside, &env.t("Assets/X_links/LNK_in")));
    }
}

/// The plan and summary of two scans of the same trees, ignoring timing and thread count.
fn assert_same_plan(a: &ScanOutput, b: &ScanOutput, what: &str) {
    assert_eq!(format!("{:#?}", a.plan), format!("{:#?}", b.plan), "{what}");
    let (mut sa, mut sb) = (a.summary.clone(), b.summary.clone());
    sa.scan_ms = 0;
    sb.scan_ms = 0;
    sa.scan_threads = 0;
    sb.scan_threads = 0;
    assert_eq!(sa, sb, "{what}");
}

#[test]
fn plans_and_results_do_not_depend_on_the_thread_count() {
    let scope = SyncScope::default();
    let no_links = |rel: &str, _: bool| !rel.contains("LNK");
    for seed in 1..=5 {
        let one_env = Env::new();
        random_pair(&one_env, seed);
        let one = scan_with(&one_env.src, &one_env.tgt, &scope, 1).unwrap();
        assert_eq!(one.summary.scan_threads, 1);
        assert!(
            one.summary.total_entries > 20,
            "seed {seed}: a meaningful plan"
        );
        assert!(!one.plan.case_renames.is_empty() || !temp_is_case_insensitive(&one_env));
        if fs::symlink_metadata(one_env.s("Assets/LNK_src")).is_ok() {
            for name in ["LNK_src", "LNK_tgt", "LNK_in"] {
                assert!(
                    one.summary.warnings.iter().any(|w| w.contains(name)),
                    "seed {seed}: {name}: {:?}",
                    one.summary.warnings
                );
            }
        } else {
            eprintln!("link creation not permitted here; links not covered");
        }
        for threads in [2, 8, 32] {
            let many = scan_with(&one_env.src, &one_env.tgt, &scope, threads).unwrap();
            assert_eq!(many.summary.scan_threads as usize, threads);
            assert_same_plan(&one, &many, &format!("seed {seed}, {threads} threads"));
        }
        // Out-of-range requests are clamped.
        let clamped = scan_with(&one_env.src, &one_env.tgt, &scope, 500).unwrap();
        assert_eq!(clamped.summary.scan_threads, 32);
        let clamped = scan_with(&one_env.src, &one_env.tgt, &scope, 0).unwrap();
        assert_eq!(clamped.summary.scan_threads, 1);

        // Executing with 1 or 8 threads reaches the same target state.
        let many_env = Env::new();
        random_pair(&many_env, seed);
        let many = scan_with(&many_env.src, &many_env.tgt, &scope, 8).unwrap();
        let r1 = execute(&one.plan, &AtomicBool::new(false), 1, &|_: SyncProgress| {});
        let r8 = execute(
            &many.plan,
            &AtomicBool::new(false),
            8,
            &|_: SyncProgress| {},
        );
        assert!(r1.errors.is_empty(), "seed {seed}: {:?}", r1.errors);
        assert!(r8.errors.is_empty(), "seed {seed}: {:?}", r8.errors);
        assert_eq!((r1.threads, r8.threads), (1, 8));
        let strip = |mut r: SyncReport| {
            r.duration_ms = 0;
            r.threads = 0;
            r
        };
        assert_eq!(strip(r1), strip(r8), "seed {seed}");
        assert_snap_eq(
            &snapshot(&one_env.tgt, &no_links),
            &snapshot(&many_env.tgt, &no_links),
            0,
            &format!("seed {seed}: target after 1 vs 8 threads"),
        );
        assert_snap_eq(
            &snapshot(&one_env.src, &no_links),
            &snapshot(&one_env.tgt, &|rel, is_dir| {
                no_links(rel, is_dir) && rel != "old-root.txt"
            }),
            2,
            &format!("seed {seed}: mirror"),
        );
        assert!(
            one_env
                .tgt
                .parent()
                .unwrap()
                .join("outside/precious.txt")
                .exists()
        );
        assert_fully_unchanged(&one_env, &scope);
        assert_fully_unchanged(&many_env, &scope);
        for env in [&one_env, &many_env] {
            clear_read_only(&env.src);
            clear_read_only(&env.tgt);
        }
    }
}

/// Builds `n` extra target trees (with read-only files and nested folders) for deletion tests.
fn extra_trees(env: &Env, n: usize) -> u64 {
    let mut files = 0;
    for i in 0..n {
        for j in 0..20 {
            let p = env.t(&format!("Assets/Gone{i}/a{}/b{}/f{j}.txt", j % 3, j % 2));
            write(&p, b"gone", T0);
            if j % 7 == 0 {
                set_read_only(&p);
            }
            files += 1;
        }
        let p = env.t(&format!("Assets/gone-file{i}.txt"));
        write(&p, b"gone", T0);
        files += 1;
    }
    files
}

fn count_files(root: &Path) -> u64 {
    walkdir::WalkDir::new(root)
        .into_iter()
        .flatten()
        .filter(|e| e.file_type().is_file())
        .count() as u64
}

#[test]
fn parallel_deletion_is_complete_and_accurate() {
    let env = Env::new();
    write(&env.s("Assets/keep.txt"), b"keep", T0);
    write(&env.t("Assets/keep.txt"), b"keep", T0);
    let files = extra_trees(&env, 40);
    // One huge tree: split across the workers by its children.
    for k in 0..400 {
        write(
            &env.t(&format!("Assets/Huge/d{}/f{k}.txt", k % 25)),
            b"h",
            T0,
        );
    }
    let files = files + 400;
    let out = env.scan(&SyncScope::default());
    assert_eq!(out.summary.delete.files, files);
    assert_eq!(out.plan.delete_dirs.len(), 41);
    assert_eq!(out.plan.delete_files.len(), 40);

    let events = Mutex::new(Vec::new());
    let report = execute(&out.plan, &AtomicBool::new(false), 8, &|p: SyncProgress| {
        events.lock().unwrap().push(p)
    });
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.threads, 8);
    assert_eq!(report.deleted_files, files);
    assert_eq!(report.deleted_dirs, out.summary.delete.dirs);
    let events = events.into_inner().unwrap();
    let last = events.last().unwrap();
    assert_eq!(last.threads, 8);
    assert_eq!(last.delete_done, last.delete_total);
    assert_eq!(
        last.delete_total,
        out.summary.delete.files + out.summary.delete.dirs
    );
    assert!(
        events
            .windows(2)
            .all(|w| w[0].delete_done <= w[1].delete_done)
    );
    assert!(events.iter().all(|e| e.delete_done <= e.delete_total));
    assert_eq!(names_in(&env.t("Assets")), ["keep.txt"]);
    assert_fully_unchanged(&env, &SyncScope::default());
}

/// `threads` reports the workers actually started, not the requested setting.
#[test]
fn reports_the_worker_threads_actually_used() {
    let env = Env::new();
    write(&env.s("Assets/a.txt"), b"a", T0);
    write(&env.s("Assets/b.txt"), b"b", T0);
    let out = env.scan(&SyncScope::default());
    assert_eq!(out.plan.transfers.len(), 2);
    assert!(out.plan.delete_files.is_empty() && out.plan.delete_dirs.is_empty());
    let last = Mutex::new(None);
    let report = execute(
        &out.plan,
        &AtomicBool::new(false),
        16,
        &|p: SyncProgress| *last.lock().unwrap() = Some(p),
    );
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.threads, 2);
    assert_eq!(last.into_inner().unwrap().unwrap().threads, 2);

    // Something to delete: the delete pool has every requested worker.
    write(&env.t("Assets/gone.txt"), b"x", T0);
    let out = env.scan(&SyncScope::default());
    assert!(out.plan.transfers.is_empty());
    let report = execute(&out.plan, &AtomicBool::new(false), 6, &|_: SyncProgress| {});
    assert_eq!(report.threads, 6);

    // Nothing to do: the calling thread only.
    let out = env.scan(&SyncScope::default());
    let report = execute(
        &out.plan,
        &AtomicBool::new(false),
        16,
        &|_: SyncProgress| {},
    );
    assert_eq!(report.threads, 1);
}

#[test]
fn parallel_deletion_can_be_cancelled() {
    let env = Env::new();
    write(&env.s("Assets/new.txt"), b"new", T0);
    let files = extra_trees(&env, 60);
    let out = env.scan(&SyncScope::default());
    assert_eq!(out.summary.delete.files, files);

    // Cancelled before the start: nothing is removed.
    let report = execute(&out.plan, &AtomicBool::new(true), 8, &|_: SyncProgress| {});
    assert!(report.cancelled);
    assert_eq!(
        (report.deleted_files, report.deleted_dirs, report.copied),
        (0, 0, 0)
    );
    assert_eq!(count_files(&env.t("Assets")), files);

    // Cancelled from the first progress event: the report matches what is gone.
    let cancel = AtomicBool::new(false);
    let report = execute(&out.plan, &cancel, 8, &|p: SyncProgress| {
        assert!(p.delete_done <= p.delete_total);
        cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    });
    assert!(report.cancelled);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(
        report.deleted_files + count_files(&env.t("Assets")) - report.copied,
        files
    );
    assert!(!env.t("Assets/new.txt").exists() || report.copied == 1);

    // A later run finishes the job.
    let out = env.scan(&SyncScope::default());
    let report = execute(&out.plan, &AtomicBool::new(false), 8, &|_: SyncProgress| {});
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(names_in(&env.t("Assets")), ["new.txt"]);
}
