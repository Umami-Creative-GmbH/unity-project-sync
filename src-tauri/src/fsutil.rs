//! Small filesystem helpers shared by scan and sync.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
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

/// What [`remove_dir_cancellable`] removed.
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

/// Deletes a directory tree entry by entry (children first), never following links (not even
/// a link at `path` itself). `stop` is checked before every entry; `on_removed` is called after
/// each entry that was removed. A missing `path` counts as done.
pub fn remove_dir_cancellable(
    path: &Path,
    stop: &dyn Fn() -> bool,
    mut on_removed: impl FnMut(&Path, Removed),
) -> io::Result<TreeRemove> {
    let walk = walkdir::WalkDir::new(path)
        .follow_links(false)
        .follow_root_links(false)
        .contents_first(true);
    for entry in walk {
        if stop() {
            return Ok(TreeRemove::Stopped);
        }
        let entry = match entry {
            Ok(e) => e,
            Err(e)
                if e.io_error()
                    .is_some_and(|io| io.kind() == io::ErrorKind::NotFound) =>
            {
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        let p = entry.path();
        let ft = entry.file_type();
        let kind = if ft.is_symlink() {
            remove_link(p)?;
            Removed::Link
        } else if ft.is_dir() {
            remove_empty_dir(p)?;
            Removed::Dir
        } else {
            remove_file_robust(p)?;
            Removed::File
        };
        on_removed(p, kind);
    }
    Ok(TreeRemove::Done)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellable_tree_removal() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("tree");
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::write(root.join("a/b/x.txt"), b"x").unwrap();
        fs::write(root.join("a/y.txt"), b"y").unwrap();

        // Stopped before the first entry: nothing is removed.
        let mut seen = 0;
        let r = remove_dir_cancellable(&root, &|| true, |_, _| seen += 1).unwrap();
        assert_eq!(r, TreeRemove::Stopped);
        assert_eq!(seen, 0);
        assert!(root.join("a/b/x.txt").exists());

        // Stopped after two entries: the rest stays.
        let count = std::cell::Cell::new(0);
        let r = remove_dir_cancellable(&root, &|| count.get() >= 2, |_, _| {
            count.set(count.get() + 1)
        })
        .unwrap();
        assert_eq!(r, TreeRemove::Stopped);
        assert!(root.exists());

        let (mut files, mut dirs) = (0, 0);
        let r = remove_dir_cancellable(&root, &|| false, |_, k| match k {
            Removed::File => files += 1,
            Removed::Dir => dirs += 1,
            Removed::Link => {}
        })
        .unwrap();
        assert_eq!(r, TreeRemove::Done);
        assert!(!root.exists());
        assert_eq!(files + dirs, 5 - 2);
        // Missing root: done, nothing reported.
        let r =
            remove_dir_cancellable(&root, &|| false, |_, _| panic!("nothing to remove")).unwrap();
        assert_eq!(r, TreeRemove::Done);
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
