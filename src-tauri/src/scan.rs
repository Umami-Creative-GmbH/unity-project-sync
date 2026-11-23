//! Scanning: validate the request, walk source and target scope, diff them into a [`Plan`].

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::fsutil::{
    is_case_insensitive, key_of, last_rel, mtime_of, parent_rel, self_and_ancestors, time_diff,
};
use crate::model::{
    CountBytes, DeleteCounts, MAX_UI_ENTRIES, PlanAction, PlanEntry, PlanReason, PlanSummary,
    ScanPhase, ScanProgress, SyncScope, is_alias_prone, is_never_sync,
};

/// Files whose mtimes differ by at most this much are considered unchanged (FAT/SMB granularity).
const MTIME_TOLERANCE: Duration = Duration::from_secs(2);
const MAX_WARNINGS: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScanError {
    Invalid(String),
    Cancelled,
}

impl fmt::Display for ScanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ScanError::Invalid(msg) => f.write_str(msg),
            ScanError::Cancelled => f.write_str("Cancelled"),
        }
    }
}

impl std::error::Error for ScanError {}

fn invalid<T>(msg: impl Into<String>) -> Result<T, ScanError> {
    Err(ScanError::Invalid(msg.into()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferKind {
    Copy,
    Update,
    Verify,
}

/// A directory (tree) to delete in the target.
#[derive(Debug, Clone)]
pub struct DirDelete {
    pub rel: String,
    /// Files / directories below `rel` (for the report; the dir itself is not included).
    pub nested_files: u64,
    pub nested_dirs: u64,
    /// Pre-deletion for a type conflict: the dir itself is replaced by a file (counted as an
    /// update), its contents are counted as deletions.
    pub conflict: bool,
}

/// A single file to delete in the target.
#[derive(Debug, Clone)]
pub struct FileDelete {
    pub rel: String,
    /// Pre-deletion for a type conflict (counted as part of the update, not as a delete).
    pub conflict: bool,
}

/// A target entry whose name differs from the source only in letter case.
#[derive(Debug, Clone)]
pub struct CaseRename {
    /// Current relative path in the target (its ancestors may be renamed first).
    pub from: String,
    /// Relative path in the source (the final path in the target).
    pub to: String,
    /// True when no transfer covers this path, so the rename itself counts as one "update".
    pub counted: bool,
}

#[derive(Debug, Clone)]
pub struct Transfer {
    /// Relative path in the source (forward slashes).
    pub src_rel: String,
    /// Relative path in the target (source casing; case renames run before transfers).
    pub dst_rel: String,
    pub kind: TransferKind,
    pub size: u64,
}

/// The full, executable plan (kept in app state; never capped).
#[derive(Debug, Clone)]
pub struct Plan {
    pub source: PathBuf,
    pub target: PathBuf,
    pub scope: SyncScope,
    /// Paths are matched case-insensitively (see [`key_of`]).
    pub fold: bool,
    /// Target files to delete (extra files and type-conflict files).
    pub delete_files: Vec<FileDelete>,
    /// Target directories to delete recursively (extra dirs and type-conflict dirs).
    pub delete_dirs: Vec<DirDelete>,
    /// Case-only renames in the target, parents before children.
    pub case_renames: Vec<CaseRename>,
    /// Directories to create in the target, parents before children.
    pub create_dirs: Vec<String>,
    /// Files to copy / update / verify, largest first.
    pub transfers: Vec<Transfer>,
}

impl Plan {
    pub fn total_bytes(&self) -> u64 {
        self.transfers.iter().map(|t| t.size).sum()
    }

    /// True when `rel` lies inside the plan's scope (defensive check before touching the target).
    pub fn in_scope(&self, rel: &str) -> bool {
        if rel.is_empty()
            || rel
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
        {
            return false;
        }
        let top = rel.split('/').next().unwrap_or(rel);
        if is_never_sync(top) {
            return false;
        }
        let is_scope_folder = |name: &str| {
            !is_alias_prone(name)
                && self
                    .scope
                    .folders
                    .iter()
                    .any(|f| key_of(f, self.fold) == key_of(name, self.fold))
        };
        if top == rel {
            // Root entries come from a real directory listing, so they are never aliases; a
            // name that looks like one (GIT~1, "Library.") is refused anyway.
            let alias_like = rel.ends_with('.')
                || rel.ends_with(' ')
                || rel
                    .split('~')
                    .skip(1)
                    .any(|after| after.starts_with(|c: char| c.is_ascii_digit()));
            !alias_like && (self.scope.include_root_files || is_scope_folder(rel))
        } else {
            is_scope_folder(top)
        }
    }
}

pub struct ScanOutput {
    pub plan: Plan,
    /// Summary with `plan_id` = 0 (assigned by the caller).
    pub summary: PlanSummary,
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

pub struct Validated {
    pub source: PathBuf,
    pub target: PathBuf,
    pub scope: SyncScope,
}

const INVALID_NAME_CHARS: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];

pub fn validate_scope(scope: &SyncScope) -> Result<SyncScope, ScanError> {
    let mut folders: Vec<String> = Vec::new();
    for name in &scope.folders {
        if name.is_empty() || name.trim().is_empty() {
            return invalid("The sync scope contains an empty folder name.");
        }
        if name.trim() != name {
            return invalid(format!(
                "Invalid folder name in sync scope: \"{name}\" (leading/trailing spaces)."
            ));
        }
        if name.chars().all(|c| c == '.') {
            return invalid(format!("Invalid folder name in sync scope: \"{name}\"."));
        }
        if name.contains(INVALID_NAME_CHARS) || name.chars().any(|c| c.is_control()) {
            return invalid(format!(
                "Invalid folder name in sync scope: \"{name}\" (only top-level folder names are allowed, no paths)."
            ));
        }
        if is_never_sync(name) {
            return invalid(format!(
                "\"{name}\" is regenerated by Unity/IDE/VCS and can never be synced."
            ));
        }
        // 8.3 short names (GIT~1) and trailing dots/spaces can resolve to another folder.
        if is_alias_prone(name) {
            return invalid(format!(
                "Invalid folder name in sync scope: \"{name}\" (names with '~' or a trailing dot or space are not allowed)."
            ));
        }
        if !folders.iter().any(|f| f.eq_ignore_ascii_case(name)) {
            folders.push(name.clone());
        }
    }
    if folders.is_empty() && !scope.include_root_files {
        return invalid("Nothing to sync: the scope has no folders and root files are excluded.");
    }
    Ok(SyncScope {
        include_root_files: scope.include_root_files,
        folders,
    })
}

fn absolute(p: &Path) -> PathBuf {
    std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Canonicalizes a path that may not exist yet (canonical nearest existing ancestor + rest).
pub(crate) fn canonicalize_lenient(p: &Path) -> PathBuf {
    let abs = absolute(p);
    let mut existing: &Path = &abs;
    let mut rest = Vec::new();
    loop {
        if let Ok(c) = fs::canonicalize(existing) {
            let mut out = c;
            for part in rest.iter().rev() {
                out.push(part);
            }
            return out;
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_os_string());
                existing = parent;
            }
            _ => return abs,
        }
    }
}

/// `p` itself if it exists, otherwise its nearest existing ancestor.
fn nearest_existing(p: &Path) -> &Path {
    let mut cur = p;
    while fs::metadata(cur).is_err() {
        match cur.parent() {
            Some(parent) => cur = parent,
            None => break,
        }
    }
    cur
}

/// The form of `p` used to compare folders across projects: canonical (junctions, symlinks,
/// mapped drives and `..` resolved through the nearest existing ancestor), without a verbatim
/// prefix and lowercase on Windows. Empty for a blank input.
pub(crate) fn comparison_path(p: &str) -> String {
    if p.trim().is_empty() {
        return String::new();
    }
    compare_form(&canonicalize_lenient(Path::new(p)))
        .to_string_lossy()
        .into_owned()
}

/// Form used only for comparing paths (no verbatim prefix; lowercase on Windows).
pub(crate) fn compare_form(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if cfg!(windows) {
        let s = if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{rest}")
        } else if let Some(rest) = s.strip_prefix(r"\\?\") {
            rest.to_string()
        } else {
            s.into_owned()
        };
        PathBuf::from(s.to_lowercase())
    } else {
        PathBuf::from(s.into_owned())
    }
}

pub fn validate(source: &str, target: &str, scope: &SyncScope) -> Result<Validated, ScanError> {
    if source.trim().is_empty() {
        return invalid("Please choose a source folder.");
    }
    if target.trim().is_empty() {
        return invalid("Please choose a target folder.");
    }
    let src_path = Path::new(source);
    match fs::metadata(src_path) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return invalid(format!("The source is not a folder: {source}")),
        Err(_) => return invalid(format!("The source folder does not exist: {source}")),
    }
    let tgt_path = Path::new(target);
    if let Ok(m) = fs::metadata(tgt_path)
        && !m.is_dir()
    {
        return invalid(format!("The target is a file, not a folder: {target}"));
    }

    let src = fs::canonicalize(src_path).unwrap_or_else(|_| absolute(src_path));
    let tgt = canonicalize_lenient(tgt_path);
    let (src_cmp, tgt_cmp) = (compare_form(&src), compare_form(&tgt));

    if tgt.parent().is_none() || tgt_cmp.parent().is_none() {
        return invalid(format!(
            "The target cannot be the root of a drive or filesystem: {target}"
        ));
    }
    if src_cmp == tgt_cmp {
        return invalid("Source and target are the same folder.");
    }
    if tgt_cmp.starts_with(&src_cmp) {
        return invalid("The target folder is inside the source folder.");
    }
    if src_cmp.starts_with(&tgt_cmp) {
        return invalid("The source folder is inside the target folder.");
    }
    let scope = validate_scope(scope)?;
    Ok(Validated {
        source: src,
        target: tgt,
        scope,
    })
}

// ---------------------------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    File,
    Dir,
}

#[derive(Debug, Clone)]
struct Node {
    rel: String,
    kind: Kind,
    size: u64,
    mtime: SystemTime,
}

#[derive(Default)]
struct Tree {
    /// key -> node (regular files and real directories only).
    nodes: HashMap<String, Node>,
    /// key -> rel of symlinks / junctions / special files (never followed or touched).
    links: HashMap<String, String>,
    /// keys of entries whose contents could not be read completely.
    errors: HashSet<String>,
    /// keys shared by several entries that differ only in letter case (case-sensitive volume
    /// scanned with case-insensitive keys): skipped and protected, with everything below them.
    collisions: HashSet<String>,
    /// keys of out-of-scope top-level directories (only collected with root files enabled).
    other_root: HashSet<String>,
    warnings: Vec<String>,
}

impl Tree {
    /// Reserves `key` for a new entry. Returns false (and marks a collision) when another entry
    /// with the same key already exists.
    fn claim(&mut self, key: &str, rel: &str, side: &str) -> bool {
        if self.collisions.contains(key) {
            return false;
        }
        let taken = self.nodes.remove(key).is_some() | self.links.remove(key).is_some();
        if taken {
            self.collisions.insert(key.to_string());
            self.warnings.push(format!(
                "Skipped {side} entry {rel}: another entry has the same name in a different letter case"
            ));
        }
        !taken
    }
}

#[derive(Clone, Copy)]
enum Side {
    Source,
    Target,
}

impl Side {
    fn label(self) -> &'static str {
        match self {
            Side::Source => "source",
            Side::Target => "target",
        }
    }
}

/// Progress throttle: at most one event per 100 ms, shared between threads.
struct Throttle {
    start: Instant,
    last_ms: AtomicU64,
}

impl Throttle {
    fn new() -> Self {
        Self {
            start: Instant::now(),
            last_ms: AtomicU64::new(0),
        }
    }

    fn ready(&self) -> bool {
        let now = self.start.elapsed().as_millis() as u64;
        let last = self.last_ms.load(Ordering::Relaxed);
        now >= last + 100
            && self
                .last_ms
                .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
    }
}

struct WalkCtx<'a> {
    side: Side,
    fold: bool,
    cancel: &'a AtomicBool,
    /// Set when the other side failed: stop early (reported as `Cancelled`, never shown).
    abort: &'a AtomicBool,
    counter: &'a AtomicU64,
    tick: &'a (dyn Fn() + Sync),
}

impl WalkCtx<'_> {
    fn visit(&self) -> Result<(), ScanError> {
        if self.cancel.load(Ordering::Relaxed) || self.abort.load(Ordering::Relaxed) {
            return Err(ScanError::Cancelled);
        }
        self.counter.fetch_add(1, Ordering::Relaxed);
        (self.tick)();
        Ok(())
    }

    fn key(&self, rel: &str) -> String {
        key_of(rel, self.fold)
    }
}

fn file_node(rel: String, meta: &fs::Metadata) -> Node {
    Node {
        rel,
        kind: Kind::File,
        size: meta.len(),
        mtime: mtime_of(meta),
    }
}

fn dir_node(rel: String) -> Node {
    Node {
        rel,
        kind: Kind::Dir,
        size: 0,
        mtime: UNIX_EPOCH,
    }
}

fn build_tree(root: &Path, scope: &SyncScope, ctx: &WalkCtx) -> Result<Tree, ScanError> {
    let mut tree = Tree::default();
    let side = ctx.side.label();
    match fs::metadata(root) {
        Ok(m) if m.is_dir() => {}
        // A missing target is treated as empty (created by the sync).
        _ if matches!(ctx.side, Side::Target) => return Ok(tree),
        _ => return invalid(format!("Cannot read the source folder: {}", root.display())),
    }
    let cannot_read = |e: io::Error| {
        ScanError::Invalid(format!(
            "Cannot read the {side} folder {}: {e}",
            root.display()
        ))
    };

    // The real root listing. Scope folders are resolved against it, so an alias such as an
    // 8.3 short name can never be walked, and a missing folder is only "missing" when the
    // complete listing says so (an incomplete listing fails the scan instead of planning the
    // deletion of a whole target folder).
    let mut root_entries = Vec::new();
    for entry in fs::read_dir(root).map_err(cannot_read)? {
        ctx.visit()?;
        root_entries.push(entry.map_err(cannot_read)?);
    }

    let folder_keys: HashSet<String> = scope.folders.iter().map(|f| ctx.key(f)).collect();
    let mut real_names: HashMap<String, Vec<String>> = HashMap::new();
    for entry in &root_entries {
        if let Some(name) = entry.file_name().to_str() {
            let key = ctx.key(name);
            if folder_keys.contains(&key) {
                real_names.entry(key).or_default().push(name.to_string());
            }
        }
    }

    if scope.include_root_files {
        for entry in &root_entries {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                tree.warnings.push(format!(
                    "Skipped {side} root entry with an unsupported name: {}",
                    entry.file_name().to_string_lossy()
                ));
                continue;
            };
            let key = ctx.key(&name);
            if folder_keys.contains(&key) {
                continue; // handled by the folder walk below
            }
            // Library/, Temp/, .git (a directory, or the file of a git worktree/submodule), ...
            // are never synced, whatever their type, on either side.
            if is_never_sync(&name) {
                continue;
            }
            let Ok(ft) = entry.file_type() else {
                tree.warnings
                    .push(format!("Cannot read {side} root entry: {name}"));
                tree.errors.insert(key);
                continue;
            };
            if ft.is_dir() {
                tree.other_root.insert(key);
                continue;
            }
            if !tree.claim(&key, &name, side) {
                continue;
            }
            if ft.is_file() {
                match entry.metadata() {
                    Ok(m) => {
                        tree.nodes.insert(key, file_node(name, &m));
                    }
                    Err(e) => {
                        tree.warnings
                            .push(format!("Cannot read {side} file {name}: {e}"));
                        tree.errors.insert(key);
                    }
                }
            } else if ft.is_symlink() {
                // A link to a directory is just another out-of-scope root folder.
                let points_to_file = fs::metadata(entry.path())
                    .map(|m| m.is_file())
                    .unwrap_or(false);
                if points_to_file {
                    tree.links.insert(key, name);
                } else {
                    tree.other_root.insert(key);
                }
            } else {
                tree.links.insert(key, name);
            }
        }
    }

    // Top-level folders are checked here; their contents are walked in parallel below.
    let mut walks: Vec<(PathBuf, String)> = Vec::new();
    for folder in &scope.folders {
        let key = ctx.key(folder);
        match real_names.get(&key).map(Vec::as_slice) {
            None | Some([]) => {} // missing on this side
            Some([real]) => {
                if let Some(base) = top_folder(root, real, ctx, &mut tree)? {
                    walks.push((base, real.clone()));
                }
            }
            Some(several) => {
                tree.warnings.push(format!(
                    "Skipped {side} folder {folder}: several folders differ only in letter case ({})",
                    several.join(", ")
                ));
                tree.collisions.insert(key);
            }
        }
    }
    let items = walk_parallel(walks, ctx)?;
    merge_items(items, ctx, &mut tree);
    Ok(tree)
}

/// Checks one top-level scope folder; `real` is its name as listed in `root`. Returns its path
/// when it is a real directory whose contents must be walked.
fn top_folder(
    root: &Path,
    real: &str,
    ctx: &WalkCtx,
    tree: &mut Tree,
) -> Result<Option<PathBuf>, ScanError> {
    let side = ctx.side.label();
    if is_never_sync(real) || is_alias_prone(real) {
        return invalid(format!("\"{real}\" can never be synced."));
    }
    let base = root.join(real);
    let top_key = ctx.key(real);
    ctx.visit()?;
    match fs::symlink_metadata(&base) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => {
            tree.warnings
                .push(format!("Cannot read {side} folder {real}: {e}"));
            tree.errors.insert(top_key);
            Ok(None)
        }
        Ok(m) if m.file_type().is_symlink() => {
            tree.links.insert(top_key, real.to_string());
            Ok(None)
        }
        Ok(m) if m.is_file() => {
            tree.nodes.insert(top_key, file_node(real.to_string(), &m));
            Ok(None)
        }
        Ok(m) if m.is_dir() => {
            tree.nodes.insert(top_key, dir_node(real.to_string()));
            Ok(Some(base))
        }
        Ok(_) => {
            tree.links.insert(top_key, real.to_string());
            Ok(None)
        }
    }
}

/// One entry found by the parallel walk (merged into the [`Tree`] afterwards, in sorted order).
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
enum ItemKind {
    /// The directory at `rel` (or one of its entries) could not be read: protected.
    ReadError(String),
    /// An entry of the directory at `rel` has a name that is not valid Unicode: protected.
    BadName(String),
    Dir,
    File {
        size: u64,
        mtime: SystemTime,
    },
    /// The file's metadata could not be read: protected.
    FileError(String),
    /// Symbolic link / junction / special file: never followed or touched.
    Link,
}

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Item {
    rel: String,
    kind: ItemKind,
}

/// Parallel directory walk: one task per directory on the current rayon pool (the scan's pool,
/// bounded by the thread setting). Links / junctions are never followed.
struct Walker<'a> {
    ctx: &'a WalkCtx<'a>,
    items: Mutex<Vec<Item>>,
    stopped: AtomicBool,
}

impl<'a> Walker<'a> {
    fn walk_dir<'s>(&'s self, s: &rayon::Scope<'s>, dir: PathBuf, dir_rel: String)
    where
        'a: 's,
    {
        if self.stopped.load(Ordering::Relaxed) {
            return;
        }
        let side = self.ctx.side.label();
        let mut out = Vec::new();
        match fs::read_dir(&dir) {
            Err(e) => out.push(Item {
                kind: ItemKind::ReadError(format!("Cannot read {side} entry {dir_rel}: {e}")),
                rel: dir_rel,
            }),
            Ok(rd) => {
                for entry in rd {
                    if self.ctx.visit().is_err() {
                        self.stopped.store(true, Ordering::Relaxed);
                        break;
                    }
                    let entry = match entry {
                        Ok(e) => e,
                        Err(e) => {
                            out.push(Item {
                                kind: ItemKind::ReadError(format!(
                                    "Cannot read {side} entry {dir_rel}: {e}"
                                )),
                                rel: dir_rel.clone(),
                            });
                            continue;
                        }
                    };
                    let name = entry.file_name();
                    let Some(name) = name.to_str() else {
                        // Protect whatever is there in the target and don't descend.
                        out.push(Item {
                            kind: ItemKind::BadName(format!(
                                "Skipped {side} entry with an unsupported name: {}",
                                entry.path().display()
                            )),
                            rel: dir_rel.clone(),
                        });
                        continue;
                    };
                    let rel = format!("{dir_rel}/{name}");
                    let ft = match entry.file_type() {
                        Ok(ft) => ft,
                        Err(e) => {
                            out.push(Item {
                                kind: ItemKind::ReadError(format!(
                                    "Cannot read {side} entry {rel}: {e}"
                                )),
                                rel,
                            });
                            continue;
                        }
                    };
                    let kind = if ft.is_symlink() {
                        ItemKind::Link
                    } else if ft.is_dir() {
                        let path = entry.path();
                        let child_rel = rel.clone();
                        s.spawn(move |s| self.walk_dir(s, path, child_rel));
                        ItemKind::Dir
                    } else if ft.is_file() {
                        // Never follows a link (DirEntry metadata is the entry's own).
                        match entry.metadata() {
                            Ok(m) => ItemKind::File {
                                size: m.len(),
                                mtime: mtime_of(&m),
                            },
                            Err(e) => {
                                ItemKind::FileError(format!("Cannot read {side} file {rel}: {e}"))
                            }
                        }
                    } else {
                        // Sockets, devices, ... : never touched.
                        ItemKind::Link
                    };
                    out.push(Item { rel, kind });
                }
            }
        }
        self.items
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .extend(out);
    }
}

/// Walks the contents of the given top-level folders (`(path, rel)`) in parallel on the current
/// rayon pool and returns everything found, sorted by path (deterministic for any thread count).
fn walk_parallel(dirs: Vec<(PathBuf, String)>, ctx: &WalkCtx) -> Result<Vec<Item>, ScanError> {
    let walker = Walker {
        ctx,
        items: Mutex::new(Vec::new()),
        stopped: AtomicBool::new(false),
    };
    rayon::scope(|s| {
        let w = &walker;
        for (path, rel) in dirs {
            s.spawn(move |s| w.walk_dir(s, path, rel));
        }
    });
    if walker.stopped.into_inner() {
        return Err(ScanError::Cancelled);
    }
    let mut items = walker.items.into_inner().unwrap_or_else(|e| e.into_inner());
    items.sort_unstable();
    Ok(items)
}

/// Adds the walked entries to `tree` (in sorted order, so collisions and warnings never depend
/// on thread timing).
fn merge_items(items: Vec<Item>, ctx: &WalkCtx, tree: &mut Tree) {
    let side = ctx.side.label();
    for Item { rel, kind } in items {
        let key = ctx.key(&rel);
        match kind {
            ItemKind::ReadError(msg) | ItemKind::BadName(msg) => {
                tree.warnings.push(msg);
                tree.errors.insert(key);
            }
            _ if !tree.claim(&key, &rel, side) => {}
            ItemKind::Dir => {
                tree.nodes.insert(key, dir_node(rel));
            }
            ItemKind::File { size, mtime } => {
                let node = Node {
                    rel,
                    kind: Kind::File,
                    size,
                    mtime,
                };
                tree.nodes.insert(key, node);
            }
            ItemKind::FileError(msg) => {
                tree.warnings.push(msg);
                tree.errors.insert(key);
            }
            ItemKind::Link => {
                tree.links.insert(key, rel);
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------------------------

fn mtime_differs(a: SystemTime, b: SystemTime) -> bool {
    time_diff(a, b) > MTIME_TOLERANCE
}

#[derive(Default)]
struct Diff {
    entries: Vec<(String, PlanEntry)>,
    copy: CountBytes,
    update: CountBytes,
    verify: CountBytes,
    delete: DeleteCounts,
    unchanged: CountBytes,
    delete_files: Vec<FileDelete>,
    delete_dirs: Vec<DirDelete>,
    case_renames: Vec<CaseRename>,
    create_dirs: Vec<String>,
    transfers: Vec<Transfer>,
    warnings: Vec<String>,
}

impl Diff {
    fn entry(
        &mut self,
        key: &str,
        path: &str,
        action: PlanAction,
        reason: PlanReason,
        size: u64,
        is_dir: bool,
    ) {
        self.entries.push((
            key.to_string(),
            PlanEntry {
                path: path.to_string(),
                action,
                reason,
                size,
                is_dir,
            },
        ));
    }

    /// Plans a transfer to the source path (target casing is fixed by the case renames first).
    fn transfer(&mut self, key: &str, s: &Node, kind: TransferKind, reason: PlanReason) {
        let action = match kind {
            TransferKind::Copy => {
                self.copy.add(s.size);
                PlanAction::Copy
            }
            TransferKind::Update => {
                self.update.add(s.size);
                PlanAction::Update
            }
            TransferKind::Verify => {
                self.verify.add(s.size);
                PlanAction::Verify
            }
        };
        self.entry(key, &s.rel, action, reason, s.size, false);
        self.transfers.push(Transfer {
            src_rel: s.rel.clone(),
            dst_rel: s.rel.clone(),
            kind,
            size: s.size,
        });
    }

    /// Plans a case-only rename of target entry `t` to the source name of `s`.
    fn case_rename(&mut self, key: &str, s: &Node, t: &Node, transferred: bool) {
        self.case_renames.push(CaseRename {
            from: t.rel.clone(),
            to: s.rel.clone(),
            counted: !transferred,
        });
        if !transferred {
            self.update.add(0);
            self.entry(
                key,
                &s.rel,
                PlanAction::Update,
                PlanReason::Case,
                s.size,
                s.kind == Kind::Dir,
            );
        }
    }
}

fn diff(src: &Tree, tgt: &Tree, ctx: &WalkCtx) -> Result<Diff, ScanError> {
    let mut d = Diff::default();

    // Source directories that have at least one child (others are listed as "create dir" entries).
    let mut non_empty: HashSet<&str> = HashSet::new();
    for k in src
        .nodes
        .keys()
        .chain(src.links.keys())
        .chain(src.errors.iter())
    {
        if let Some(p) = parent_rel(k) {
            non_empty.insert(p);
        }
    }

    let collided = |key: &str| {
        self_and_ancestors(key).any(|a| src.collisions.contains(a) || tgt.collisions.contains(a))
    };

    let mut blocked_links: HashSet<&str> = HashSet::new();
    // key of a target dir replaced by a source file -> index into d.delete_dirs
    let mut conflict_dirs: HashMap<&str, usize> = HashMap::new();

    let mut src_keys: Vec<&String> = src.nodes.keys().collect();
    src_keys.sort_unstable(); // parents before children (case renames rely on it)
    for key in src_keys {
        ctx.visit()?;
        let s = &src.nodes[key];
        if collided(key) {
            continue;
        }
        if let Some(link) = self_and_ancestors(key).find(|a| tgt.links.contains_key(*a)) {
            blocked_links.insert(link);
            continue;
        }
        if parent_rel(key).is_none() && tgt.other_root.contains(key.as_str()) {
            d.warnings.push(format!(
                "Skipped {}: the target has a folder with that name outside the sync scope.",
                s.rel
            ));
            continue;
        }
        match (s.kind, tgt.nodes.get(key)) {
            (Kind::File, None) => d.transfer(key, s, TransferKind::Copy, PlanReason::New),
            (Kind::Dir, None) => {
                d.create_dirs.push(s.rel.clone());
                if !non_empty.contains(key.as_str()) {
                    d.entry(key, &s.rel, PlanAction::Copy, PlanReason::New, 0, true);
                }
            }
            (Kind::File, Some(t)) if t.kind == Kind::File => {
                let transferred = if s.size != t.size {
                    d.transfer(key, s, TransferKind::Update, PlanReason::Size);
                    true
                } else if mtime_differs(s.mtime, t.mtime) {
                    d.transfer(key, s, TransferKind::Verify, PlanReason::Mtime);
                    true
                } else {
                    d.unchanged.add(s.size);
                    false
                };
                if last_rel(&t.rel) != last_rel(&s.rel) {
                    d.case_rename(key, s, t, transferred);
                }
            }
            (Kind::Dir, Some(t)) if t.kind == Kind::Dir => {
                if last_rel(&t.rel) != last_rel(&s.rel) {
                    d.case_rename(key, s, t, false);
                }
            }
            (Kind::File, Some(t)) => {
                // Target has a directory where the source has a file.
                conflict_dirs.insert(key.as_str(), d.delete_dirs.len());
                d.delete_dirs.push(DirDelete {
                    rel: t.rel.clone(),
                    nested_files: 0,
                    nested_dirs: 0,
                    conflict: true,
                });
                d.transfer(key, s, TransferKind::Update, PlanReason::Type);
            }
            (Kind::Dir, Some(t)) => {
                // Target has a file where the source has a directory.
                d.delete_files.push(FileDelete {
                    rel: t.rel.clone(),
                    conflict: true,
                });
                d.create_dirs.push(s.rel.clone());
                d.update.add(0);
                d.entry(key, &s.rel, PlanAction::Update, PlanReason::Type, 0, true);
            }
        }
    }

    let protected = |key: &str| {
        self_and_ancestors(key).any(|a| {
            src.links.contains_key(a)
                || src.errors.contains(a)
                || src.collisions.contains(a)
                || tgt.collisions.contains(a)
        }) || (parent_rel(key).is_none() && src.other_root.contains(key))
    };

    // key of a deleted directory root -> index into d.delete_dirs. The contents of type-conflict
    // dirs are deleted too, so they are counted (and confirmed) like any other deletion.
    let mut delete_roots: HashMap<&str, usize> = conflict_dirs.clone();
    let mut tgt_keys: Vec<&String> = tgt.nodes.keys().collect();
    tgt_keys.sort_unstable(); // ancestors always sort before their descendants
    for key in tgt_keys {
        ctx.visit()?;
        if src.nodes.contains_key(key) || protected(key) {
            continue;
        }
        let t = &tgt.nodes[key];
        let parent_is_src_dir = match parent_rel(key) {
            None => true,
            Some(p) => src.nodes.get(p).is_some_and(|n| n.kind == Kind::Dir),
        };
        if parent_is_src_dir {
            match t.kind {
                Kind::File => {
                    d.delete.files += 1;
                    d.delete.bytes += t.size;
                    d.delete_files.push(FileDelete {
                        rel: t.rel.clone(),
                        conflict: false,
                    });
                    d.entry(
                        key,
                        &t.rel,
                        PlanAction::Delete,
                        PlanReason::Extra,
                        t.size,
                        false,
                    );
                }
                Kind::Dir => {
                    d.delete.dirs += 1;
                    delete_roots.insert(key.as_str(), d.delete_dirs.len());
                    d.delete_dirs.push(DirDelete {
                        rel: t.rel.clone(),
                        nested_files: 0,
                        nested_dirs: 0,
                        conflict: false,
                    });
                    d.entry(key, &t.rel, PlanAction::Delete, PlanReason::Extra, 0, true);
                }
            }
        } else if let Some(&idx) = self_and_ancestors(key).find_map(|a| delete_roots.get(a)) {
            // Inside a directory that is deleted as a whole: counted, not listed.
            let root = &mut d.delete_dirs[idx];
            match t.kind {
                Kind::File => {
                    d.delete.files += 1;
                    d.delete.bytes += t.size;
                    root.nested_files += 1;
                }
                Kind::Dir => {
                    d.delete.dirs += 1;
                    root.nested_dirs += 1;
                }
            }
        }
    }

    // Warnings for links (never followed, never deleted individually).
    let mut src_links: Vec<&String> = src.links.values().collect();
    src_links.sort_unstable_by_key(|r| key_of(r, ctx.fold));
    for rel in src_links {
        d.warnings.push(format!(
            "Skipped symbolic link / junction in source (not followed): {rel}"
        ));
    }
    let mut tgt_links: Vec<(&String, &String)> = tgt.links.iter().collect();
    tgt_links.sort_unstable();
    for (key, rel) in tgt_links {
        let removed_with_parent = parent_rel(key)
            .is_some_and(|p| self_and_ancestors(p).any(|a| delete_roots.contains_key(a)));
        if removed_with_parent {
            d.warnings.push(format!(
                "Symbolic link / junction in a target folder being deleted: {rel} (only the link itself is removed, its destination is not touched)"
            ));
        } else if blocked_links.contains(key.as_str()) {
            d.warnings.push(format!(
                "Skipped symbolic link / junction in target: {rel} (left untouched; the source content at this path is not synced)"
            ));
        } else {
            d.warnings.push(format!(
                "Skipped symbolic link / junction in target: {rel} (left untouched)"
            ));
        }
    }
    Ok(d)
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

/// Scans `source` and `target` within `scope` and builds the full plan.
/// `threads` (clamped to 1..=32) bounds the parallel directory walk: both sides share one pool
/// of that many threads; 1 walks everything sequentially on a single thread.
/// `progress` is called at most ~10 times per second.
pub fn scan(
    source: &str,
    target: &str,
    scope: &SyncScope,
    threads: usize,
    cancel: &AtomicBool,
    progress: &(dyn Fn(ScanProgress) + Sync),
) -> Result<ScanOutput, ScanError> {
    let started = Instant::now();
    let v = validate(source, target, scope)?;
    let threads = crate::threads::clamp(threads);
    let pool = crate::threads::pool(threads, "scan")
        .map_err(|e| ScanError::Invalid(format!("Cannot start the scan worker threads: {e}")))?;
    // Case-insensitive keys when either side matches names case-insensitively (Windows, the
    // default macOS volumes, ...): a differently cased name is the same entry there.
    let fold = is_case_insensitive(&v.source, false)
        || is_case_insensitive(nearest_existing(&v.target), true);

    let throttle = Throttle::new();
    let src_count = AtomicU64::new(0);
    let tgt_count = AtomicU64::new(0);
    let cmp_count = AtomicU64::new(0);
    let src_done = AtomicBool::new(false);
    let comparing = AtomicBool::new(false);
    let abort = AtomicBool::new(false);
    let tick = || {
        if throttle.ready() {
            let p = if comparing.load(Ordering::Relaxed) {
                ScanProgress {
                    phase: ScanPhase::Compare,
                    entries: cmp_count.load(Ordering::Relaxed),
                }
            } else if !src_done.load(Ordering::Relaxed) {
                ScanProgress {
                    phase: ScanPhase::Source,
                    entries: src_count.load(Ordering::Relaxed),
                }
            } else {
                ScanProgress {
                    phase: ScanPhase::Target,
                    entries: tgt_count.load(Ordering::Relaxed),
                }
            };
            progress(p);
        }
    };
    progress(ScanProgress {
        phase: ScanPhase::Source,
        entries: 0,
    });

    let src_ctx = WalkCtx {
        side: Side::Source,
        fold,
        cancel,
        abort: &abort,
        counter: &src_count,
        tick: &tick,
    };
    let tgt_ctx = WalkCtx {
        side: Side::Target,
        fold,
        cancel,
        abort: &abort,
        counter: &tgt_count,
        tick: &tick,
    };
    // A real error on one side stops the other side right away.
    let stop_other_on_error = |r: Result<Tree, ScanError>| {
        if matches!(r, Err(ScanError::Invalid(_))) {
            abort.store(true, Ordering::Relaxed);
        }
        r
    };
    // Both walks share the pool (work stealing balances them); with 1 thread they run one after
    // the other.
    let (src_r, tgt_r) = pool.install(|| {
        rayon::join(
            || {
                let r = build_tree(&v.source, &v.scope, &src_ctx);
                src_done.store(true, Ordering::Relaxed);
                stop_other_on_error(r)
            },
            || stop_other_on_error(build_tree(&v.target, &v.scope, &tgt_ctx)),
        )
    });
    drop(pool);
    // Report the real error first: the other side's `Cancelled` may only come from `abort`.
    let (src_tree, tgt_tree) = match (src_r, tgt_r) {
        (Ok(s), Ok(t)) => (s, t),
        (Err(e @ ScanError::Invalid(_)), _) | (_, Err(e @ ScanError::Invalid(_))) => return Err(e),
        (Err(e), _) | (_, Err(e)) => return Err(e),
    };

    comparing.store(true, Ordering::Relaxed);
    let cmp_ctx = WalkCtx {
        side: Side::Source,
        fold,
        cancel,
        abort: &abort,
        counter: &cmp_count,
        tick: &tick,
    };
    let mut d = diff(&src_tree, &tgt_tree, &cmp_ctx)?;
    progress(ScanProgress {
        phase: ScanPhase::Compare,
        entries: cmp_count.load(Ordering::Relaxed),
    });

    let mut warnings = src_tree.warnings;
    warnings.extend(tgt_tree.warnings);
    warnings.append(&mut d.warnings);
    if warnings.len() > MAX_WARNINGS {
        let more = warnings.len() - MAX_WARNINGS;
        warnings.truncate(MAX_WARNINGS);
        warnings.push(format!("... and {more} more warnings"));
    }

    // Deletions survive the UI cap first (the destructive part must always be reviewable),
    // then the kept entries are shown sorted by path.
    d.entries.sort_unstable_by(|a, b| {
        let da = a.1.action != PlanAction::Delete;
        let db = b.1.action != PlanAction::Delete;
        da.cmp(&db)
            .then_with(|| a.0.cmp(&b.0))
            .then_with(|| a.1.path.cmp(&b.1.path))
    });
    let total_entries = d.entries.len();
    let entries_truncated = total_entries > MAX_UI_ENTRIES;
    d.entries.truncate(MAX_UI_ENTRIES);
    d.entries
        .sort_unstable_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.path.cmp(&b.1.path)));
    let entries: Vec<PlanEntry> = d.entries.into_iter().map(|(_, e)| e).collect();

    d.create_dirs.sort_unstable_by_key(|r| key_of(r, fold));
    d.transfers
        .sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.src_rel.cmp(&b.src_rel)));

    let total_bytes = d.copy.bytes + d.update.bytes + d.verify.bytes;
    let summary = PlanSummary {
        plan_id: 0,
        source: source.to_string(),
        target: target.to_string(),
        scope: v.scope.clone(),
        copy: d.copy,
        update: d.update,
        verify: d.verify,
        delete: d.delete,
        unchanged: d.unchanged,
        total_bytes,
        entries,
        entries_truncated,
        total_entries: total_entries as u64,
        warnings,
        scan_ms: started.elapsed().as_millis() as u64,
        scan_threads: threads as u32,
    };
    let plan = Plan {
        source: v.source,
        target: v.target,
        scope: v.scope,
        fold,
        delete_files: d.delete_files,
        delete_dirs: d.delete_dirs,
        case_renames: d.case_renames,
        create_dirs: d.create_dirs,
        transfers: d.transfers,
    };
    Ok(ScanOutput { plan, summary })
}
