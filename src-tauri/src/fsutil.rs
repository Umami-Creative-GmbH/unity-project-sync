//! Small filesystem helpers shared by scan and sync.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Matching key for a relative path: lowercased when the filesystems are case-insensitive
/// (`fold`, decided per scan by [`is_case_insensitive`]).
pub fn key_of(rel: &str, fold: bool) -> String {
    if fold {
        rel.to_lowercase()
    } else {
        rel.to_string()
    }
}

/// True when names in `dir` are matched case-insensitively (Windows; macOS APFS/HFS+ default).
///
/// Looks up an upper/lower-cased variant of an existing entry first (no writes). When the
/// directory has no usable entry and `allow_probe` is set, a uniquely named probe file is created
/// and removed again. Falls back to the platform default when nothing can be determined.
pub fn is_case_insensitive(dir: &Path, allow_probe: bool) -> bool {
    if cfg!(windows) {
        return true;
    }
    if let Ok(rd) = fs::read_dir(dir) {
        let names: Vec<String> = rd
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        let set: HashSet<&str> = names.iter().map(String::as_str).collect();
        for name in &names {
            for variant in [name.to_ascii_uppercase(), name.to_ascii_lowercase()] {
                if variant != *name && !set.contains(variant.as_str()) {
                    return fs::symlink_metadata(dir.join(&variant)).is_ok();
                }
            }
        }
    }
    if allow_probe {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let name = format!(".ups-case-probe-{}-{nanos}", std::process::id());
        let probe = dir.join(&name);
        if fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)
            .is_ok()
        {
            let folds = fs::symlink_metadata(dir.join(name.to_ascii_uppercase())).is_ok();
            let _ = fs::remove_file(&probe);
            return folds;
        }
    }
    cfg!(target_os = "macos")
}

/// Last component of a relative (forward-slash) path.
pub fn last_rel(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

/// Parent of a relative (forward-slash) path, `None` for top-level entries.
pub fn parent_rel(rel: &str) -> Option<&str> {
    rel.rfind('/').map(|i| &rel[..i])
}

/// Iterates over `rel` itself and all of its ancestors (deepest first).
pub fn self_and_ancestors(rel: &str) -> impl Iterator<Item = &str> {
    std::iter::successors(Some(rel), |r| parent_rel(r))
}

/// Joins a forward-slash relative path onto `root` using native separators
/// (required for verbatim `\\?\` paths on Windows).
pub fn join_rel(root: &Path, rel: &str) -> PathBuf {
    let mut p = root.to_path_buf();
    for part in rel.split('/') {
        p.push(part);
    }
    p
}

/// Converts the path of `full` relative to `base` into a forward-slash string.
/// Returns `None` for names that are not valid Unicode.
pub fn rel_string(base: &Path, full: &Path) -> Option<String> {
    let rest = full.strip_prefix(base).ok()?;
    let mut out = String::new();
    for c in rest.components() {
        if !out.is_empty() {
            out.push('/');
        }
        out.push_str(c.as_os_str().to_str()?);
    }
    Some(out)
}

/// Last modification time from metadata (epoch if the platform cannot provide it).
pub fn mtime_of(meta: &fs::Metadata) -> SystemTime {
    meta.modified().unwrap_or(UNIX_EPOCH)
}

/// Absolute difference between two times.
pub fn time_diff(a: SystemTime, b: SystemTime) -> Duration {
    a.duration_since(b)
        .or_else(|_| b.duration_since(a))
        .unwrap_or_default()
}

/// Sets only the modification time of a file.
pub fn set_mtime(path: &Path, mtime: SystemTime) -> io::Result<()> {
    let mut opts = fs::OpenOptions::new();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_WRITE_ATTRIBUTES: u32 = 0x0100;
        // Attribute access only: works for read-only files and needs no data write access.
        opts.access_mode(FILE_WRITE_ATTRIBUTES);
    }
    // futimens with explicit times only needs ownership, not write access: a read-only fd
    // keeps this working for read-only (0444) target files too.
    #[cfg(not(windows))]
    opts.read(true);
    opts.open(path)?.set_modified(mtime)
}

/// Clears the read-only flag (Windows) / adds owner write permission (Unix).
pub fn make_writable(path: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    let mut perms = meta.permissions();
    if !perms.readonly() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(perms.mode() | 0o200);
    }
    #[cfg(not(unix))]
    {
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
    }
    fs::set_permissions(path, perms)
}

/// Removes a file; clears the read-only flag and retries on failure. Missing files are fine.
pub fn remove_file_robust(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(first) => {
            if make_writable(path).is_err() {
                return Err(first);
            }
            match fs::remove_file(path) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
                r => r,
            }
        }
    }
}

/// Removes a directory tree (never follows links); clears read-only flags and retries on failure.
pub fn remove_dir_robust(path: &Path) -> io::Result<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => {
            for entry in walkdir::WalkDir::new(path)
                .follow_links(false)
                .into_iter()
                .flatten()
            {
                if !entry.file_type().is_symlink() {
                    let _ = make_writable(entry.path());
                }
            }
            match fs::remove_dir_all(path) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
                r => r,
            }
        }
    }
}

/// What [`remove_dir_parallel`] removed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Removed {
    File,
    Dir,
    /// A symbolic link / junction (only the link itself, never its destination).
    Link,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TreeRemove {
    Done,
    Stopped,
}

/// Removes a link itself (on Windows a directory symlink / junction needs `remove_dir`).
fn remove_link(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) if cfg!(windows) => match fs::remove_dir(path) {
            Ok(()) => Ok(()),
            Err(e2) if e2.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(e),
        },
        Err(e) => Err(e),
    }
}

/// Removes an empty directory; clears the read-only flag and retries on failure.
fn remove_empty_dir(path: &Path) -> io::Result<()> {
    match fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(first) => {
            if make_writable(path).is_err() {
                return Err(first);
            }
            match fs::remove_dir(path) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
                r => r,
            }
        }
    }
}

/// Combines the outcomes of sibling removals: the first error wins, then `Stopped`.
///
/// `Err` intentionally wins over `Stopped`: after the first error the walk stops by itself (see
/// [`remove_dir_parallel`]), so its siblings typically report `Stopped`. A caller that needs to
/// tell a user cancel apart from an error-triggered stop must check its own stop flag.
fn combine(a: io::Result<TreeRemove>, b: io::Result<TreeRemove>) -> io::Result<TreeRemove> {
    match (a, b) {
        (Err(e), _) | (_, Err(e)) => Err(e),
        (Ok(TreeRemove::Stopped), _) | (_, Ok(TreeRemove::Stopped)) => Ok(TreeRemove::Stopped),
        _ => Ok(TreeRemove::Done),
    }
}

fn is_not_found(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::NotFound
}

/// Deletes a directory tree entry by entry (children first), never following links (not even
/// a link at `path` itself). The children of every directory are removed in parallel on the
/// current rayon pool (so a single large tree is split across its workers; a pool of 1 removes
/// everything sequentially). `stop` is checked before every entry; `on_removed` is called after
/// each entry that was removed (from any worker). A missing `path` counts as done.
///
/// The first error also stops the walk (the other workers start no new entry) and is returned
/// even when siblings report `Stopped`; whatever is left of the tree stays in place.
pub fn remove_dir_parallel(
    path: &Path,
    stop: &(dyn Fn() -> bool + Sync),
    on_removed: &(dyn Fn(&Path, Removed) + Sync),
) -> io::Result<TreeRemove> {
    if stop() {
        return Ok(TreeRemove::Stopped);
    }
    let ft = match fs::symlink_metadata(path) {
        Ok(m) => m.file_type(),
        Err(e) if is_not_found(&e) => return Ok(TreeRemove::Done),
        Err(e) => return Err(e),
    };
    let failed = AtomicBool::new(false);
    let walk = Walk {
        stop: &|| stop() || failed.load(Ordering::Relaxed),
        failed: &failed,
        on_removed,
    };
    remove_entry(path, ft, &walk)
}

/// Shared state of one [`remove_dir_parallel`] walk.
struct Walk<'a> {
    /// The caller's stop predicate, or an earlier error anywhere in the tree.
    stop: &'a (dyn Fn() -> bool + Sync),
    failed: &'a AtomicBool,
    on_removed: &'a (dyn Fn(&Path, Removed) + Sync),
}

/// Removes one entry of known type: a link itself, a file, or a directory tree.
fn remove_entry(path: &Path, ft: fs::FileType, walk: &Walk) -> io::Result<TreeRemove> {
    let kind = if ft.is_symlink() {
        remove_link(path)?;
        Removed::Link
    } else if ft.is_dir() {
        return remove_tree(path, walk);
    } else {
        remove_file_robust(path)?;
        Removed::File
    };
    (walk.on_removed)(path, kind);
    Ok(TreeRemove::Done)
}

/// Removes the contents of the real directory `dir` in parallel, then `dir` itself.
fn remove_tree(dir: &Path, walk: &Walk) -> io::Result<TreeRemove> {
    use rayon::prelude::*;

    // The listing is read completely (and its handle closed) before anything is removed.
    let mut children: Vec<(PathBuf, fs::FileType)> = Vec::new();
    match fs::read_dir(dir) {
        Ok(rd) => {
            for entry in rd {
                match entry.and_then(|e| Ok((e.path(), e.file_type()?))) {
                    Ok(child) => children.push(child),
                    Err(e) if is_not_found(&e) => {}
                    Err(e) => return Err(e),
                }
            }
        }
        Err(e) if is_not_found(&e) => return Ok(TreeRemove::Done),
        Err(e) => return Err(e),
    }
    let r = children
        .par_iter()
        .map(|(p, ft)| {
            if (walk.stop)() {
                return Ok(TreeRemove::Stopped);
            }
            let r = remove_entry(p, *ft, walk);
            if r.is_err() {
                // Start no new entry anywhere in the tree (the error is returned to the caller).
                walk.failed.store(true, Ordering::Relaxed);
            }
            r
        })
        .reduce(|| Ok(TreeRemove::Done), combine)?;
    if r == TreeRemove::Stopped || (walk.stop)() {
        return Ok(TreeRemove::Stopped);
    }
    remove_empty_dir(dir)?;
    (walk.on_removed)(dir, Removed::Dir);
    Ok(TreeRemove::Done)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn cancellable_tree_removal() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("tree");
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::write(root.join("a/b/x.txt"), b"x").unwrap();
        fs::write(root.join("a/y.txt"), b"y").unwrap();

        // Stopped before the first entry: nothing is removed.
        let seen = AtomicUsize::new(0);
        let r = remove_dir_parallel(&root, &|| true, &|_, _| {
            seen.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        assert_eq!(r, TreeRemove::Stopped);
        assert_eq!(seen.load(Ordering::SeqCst), 0);
        assert!(root.join("a/b/x.txt").exists());

        // Stopped after two entries: the rest stays.
        let pool = crate::threads::pool(1, "test").unwrap();
        let count = AtomicUsize::new(0);
        let r = pool
            .install(|| {
                remove_dir_parallel(&root, &|| count.load(Ordering::SeqCst) >= 2, &|_, _| {
                    count.fetch_add(1, Ordering::SeqCst);
                })
            })
            .unwrap();
        assert_eq!(r, TreeRemove::Stopped);
        assert_eq!(count.load(Ordering::SeqCst), 2);
        assert!(root.exists());

        let (files, dirs) = (AtomicUsize::new(0), AtomicUsize::new(0));
        let r = remove_dir_parallel(&root, &|| false, &|_, k| match k {
            Removed::File => {
                files.fetch_add(1, Ordering::SeqCst);
            }
            Removed::Dir => {
                dirs.fetch_add(1, Ordering::SeqCst);
            }
            Removed::Link => {}
        })
        .unwrap();
        assert_eq!(r, TreeRemove::Done);
        assert!(!root.exists());
        assert_eq!(files.into_inner() + dirs.into_inner(), 5 - 2);
        // Missing root: done, nothing reported.
        let r = remove_dir_parallel(&root, &|| false, &|_, _| panic!("nothing to remove")).unwrap();
        assert_eq!(r, TreeRemove::Done);
        // A file at the root is removed as a file.
        let file = dir.path().join("file.txt");
        fs::write(&file, b"f").unwrap();
        let kinds = Mutex::new(Vec::new());
        let r = remove_dir_parallel(&file, &|| false, &|_, k| kinds.lock().unwrap().push(k));
        assert_eq!(r.unwrap(), TreeRemove::Done);
        assert_eq!(kinds.into_inner().unwrap(), [Removed::File]);
        assert!(!file.exists());
    }

    /// A wide and deep tree (read-only files included) removed by 8 workers: every entry is
    /// reported exactly once; a stop mid-way leaves a consistent, partially removed tree.
    #[test]
    fn parallel_tree_removal() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        fn build(root: &Path) -> usize {
            let mut entries = 1; // root
            for a in 0..6 {
                for b in 0..5 {
                    let d = root.join(format!("d{a}/e{b}/f"));
                    fs::create_dir_all(&d).unwrap();
                    for i in 0..12 {
                        let p = d.join(format!("x{i}.txt"));
                        fs::write(&p, b"x").unwrap();
                        if i % 4 == 0 {
                            let mut perms = fs::metadata(&p).unwrap().permissions();
                            perms.set_readonly(true);
                            fs::set_permissions(&p, perms).unwrap();
                        }
                    }
                    entries += 2 + 12; // e{b}, f, files
                }
                entries += 1; // d{a}
            }
            entries
        }

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("tree");
        let total = build(&root);
        let pool = crate::threads::pool(8, "test").unwrap();

        // Stop after ~100 removals.
        let count = AtomicUsize::new(0);
        let r = pool
            .install(|| {
                remove_dir_parallel(&root, &|| count.load(Ordering::SeqCst) >= 100, &|_, _| {
                    count.fetch_add(1, Ordering::SeqCst);
                })
            })
            .unwrap();
        assert_eq!(r, TreeRemove::Stopped);
        let removed = count.into_inner();
        // Workers already past their stop check may finish one entry each.
        assert!((100..100 + 8).contains(&removed), "{removed}");
        let left = walkdir::WalkDir::new(&root).into_iter().count();
        assert_eq!(left, total - removed);

        // Then everything, each entry reported exactly once.
        let seen = Mutex::new(HashSet::new());
        let r = pool
            .install(|| {
                remove_dir_parallel(&root, &|| false, &|p, _| {
                    assert!(seen.lock().unwrap().insert(p.to_path_buf()), "twice: {p:?}");
                })
            })
            .unwrap();
        assert_eq!(r, TreeRemove::Done);
        assert_eq!(seen.into_inner().unwrap().len(), left);
        assert!(!root.exists());
    }

    /// Makes `path` impossible to remove while the guard lives (Windows: an open handle without
    /// delete sharing; Unix: a read-only parent folder). `None` when the platform/user (e.g.
    /// root) cannot simulate the failure.
    #[cfg(windows)]
    fn undeletable(path: &Path) -> Option<Box<dyn std::any::Any>> {
        use std::os::windows::fs::OpenOptionsExt;
        fs::write(path, b"locked").unwrap();
        let f = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(path)
            .unwrap();
        Some(Box::new(f))
    }

    #[cfg(unix)]
    fn undeletable(path: &Path) -> Option<Box<dyn std::any::Any>> {
        use std::os::unix::fs::PermissionsExt;
        struct Restore(PathBuf);
        impl Drop for Restore {
            fn drop(&mut self) {
                let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o755));
            }
        }
        fs::write(path, b"locked").unwrap();
        let parent = path.parent().unwrap().to_path_buf();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o555)).unwrap();
        let guard = Restore(parent);
        // Root ignores the permission: nothing to simulate.
        let probe = path.with_extension("probe");
        if fs::write(&probe, b"p").is_ok() {
            let _ = fs::remove_file(&probe);
            return None;
        }
        Some(Box::new(guard))
    }

    /// The first error stops the whole walk (no other entry is started) and wins over `Stopped`.
    #[test]
    fn first_error_stops_the_tree_removal() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("tree");
        fs::create_dir_all(root.join("a_locked")).unwrap();
        for i in 0..50 {
            fs::write(root.join(format!("b{i:02}.txt")), b"b").unwrap();
        }
        let Some(guard) = undeletable(&root.join("a_locked/x.txt")) else {
            eprintln!("cannot simulate an undeletable file here; skipped");
            return;
        };

        // One worker, entries in listing order: the error comes first, nothing after it runs.
        let pool = crate::threads::pool(1, "test").unwrap();
        let removed = Mutex::new(Vec::new());
        let r = pool.install(|| {
            remove_dir_parallel(&root, &|| false, &|p, _| {
                removed.lock().unwrap().push(p.to_path_buf())
            })
        });
        assert!(r.is_err(), "{r:?}");
        if cfg!(windows) {
            // NTFS lists names in order: "a_locked" comes before every "b" file.
            assert!(removed.lock().unwrap().is_empty(), "{removed:?}");
            assert_eq!(fs::read_dir(&root).unwrap().count(), 51);
        }

        // Many workers: the error still wins over the siblings that saw the stop.
        let pool = crate::threads::pool(8, "test").unwrap();
        let r = pool.install(|| remove_dir_parallel(&root, &|| false, &|_, _| {}));
        assert!(r.is_err(), "{r:?}");
        assert!(root.join("a_locked/x.txt").exists());

        drop(guard);
        let r = pool.install(|| remove_dir_parallel(&root, &|| false, &|_, _| {}));
        assert_eq!(r.unwrap(), TreeRemove::Done);
        assert!(!root.exists());
    }

    #[test]
    fn case_probe() {
        let dir = tempfile::tempdir().unwrap();
        // Empty dir: probe file (and it is cleaned up again).
        let folds = is_case_insensitive(dir.path(), true);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
        fs::write(dir.path().join("Probe.txt"), b"x").unwrap();
        assert_eq!(is_case_insensitive(dir.path(), false), folds);
        if cfg!(windows) {
            assert!(folds);
        }
        assert_eq!(last_rel("a/b/C.txt"), "C.txt");
        assert_eq!(last_rel("top"), "top");
        assert_eq!(key_of("A/b", true), "a/b");
        assert_eq!(key_of("A/b", false), "A/b");
    }

    #[test]
    fn rel_helpers() {
        assert_eq!(parent_rel("a/b/c"), Some("a/b"));
        assert_eq!(parent_rel("a"), None);
        let v: Vec<_> = self_and_ancestors("a/b/c").collect();
        assert_eq!(v, vec!["a/b/c", "a/b", "a"]);
        let p = join_rel(Path::new("root"), "a/b");
        assert_eq!(p, Path::new("root").join("a").join("b"));
        assert_eq!(
            rel_string(Path::new("root"), &Path::new("root").join("x").join("y")).as_deref(),
            Some("x/y")
        );
    }
}
