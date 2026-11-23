//! Scanning and validating the release folders in `RELEASES_DIR`.
//!
//! Layout (one folder per release, uploaded by hand):
//!
//! ```text
//! RELEASES_DIR/
//!   0.2.0/
//!     Unity-Project-Sync_0.2.0_x64-setup.exe
//!     release.json
//! ```
//!
//! The directory is scanned again on every request. It holds a handful of folders, so this is
//! cheap, and an upload, edit or delete takes effect immediately without any cache to invalidate.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use semver::Version;
use serde::Deserialize;

use crate::util::is_rfc3339;
use crate::warn;

pub const RELEASE_JSON: &str = "release.json";
/// release.json is a few KB; anything bigger is not ours.
const MAX_RELEASE_JSON_BYTES: u64 = 1024 * 1024;

/// A release that passed every validity check.
#[derive(Debug, Clone)]
pub struct Release {
    pub version: Version,
    /// The folder name, identical to the `version` string in release.json.
    pub version_str: String,
    /// RFC 3339 publish date; `None` when missing or not RFC 3339.
    pub pub_date: Option<String>,
    pub notes: String,
    /// Plain file name of the setup exe inside the release folder.
    pub file: String,
    pub size: u64,
    /// Lowercase hex; `None` when missing or malformed.
    pub sha256: Option<String>,
    pub signature: String,
    /// Absolute path of the setup exe.
    pub path: PathBuf,
}

#[derive(Deserialize)]
struct ReleaseJson {
    version: String,
    #[serde(default)]
    pub_date: Option<String>,
    #[serde(default)]
    notes: Option<String>,
    file: String,
    size: u64,
    #[serde(default)]
    sha256: Option<String>,
    signature: String,
}

/// A plain file name: not empty, no path separators, no "..", not hidden, no control characters.
pub fn is_plain_file_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && !name.starts_with('.')
        && !name.chars().any(char::is_control)
}

/// Remembers which problems were already logged, so a half-finished upload is reported once
/// and not on every page view. Problems that went away are forgotten (and logged again if they
/// come back).
#[derive(Default)]
pub struct ScanLog {
    seen: Mutex<HashSet<String>>,
}

impl ScanLog {
    fn report(&self, current: HashSet<String>) {
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        for msg in current.difference(&seen) {
            warn!("{msg}");
        }
        *seen = current;
    }
}

/// Validates one release folder. `Err` carries a log message; `Ok(None)` means "silently
/// ignored" (hidden folders).
fn load_release(
    dir: &Path,
    dir_name: &str,
    notices: &mut HashSet<String>,
) -> Result<Option<Release>, String> {
    if dir_name.starts_with('.') || dir_name.starts_with('_') {
        return Ok(None);
    }
    let skip = |why: String| format!("release {dir_name:?} skipped: {why}");

    let json_path = dir.join(RELEASE_JSON);
    let meta = fs::metadata(&json_path).map_err(|e| skip(format!("{RELEASE_JSON}: {e}")))?;
    if !meta.is_file() || meta.len() > MAX_RELEASE_JSON_BYTES {
        return Err(skip(format!("{RELEASE_JSON} is not a small regular file")));
    }
    let raw = fs::read(&json_path).map_err(|e| skip(format!("{RELEASE_JSON}: {e}")))?;
    // Tolerate a UTF-8 BOM (Windows PowerShell 5.1 writes one by default).
    let raw = raw.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&raw);
    let json: ReleaseJson = serde_json::from_slice(raw)
        .map_err(|e| skip(format!("{RELEASE_JSON} does not parse: {e}")))?;

    let version = Version::parse(&json.version)
        .map_err(|e| skip(format!("version {:?} is not semver: {e}", json.version)))?;
    if json.version != dir_name {
        return Err(skip(format!(
            "version {:?} does not match the folder name",
            json.version
        )));
    }
    if !is_plain_file_name(&json.file) {
        return Err(skip(format!(
            "file {:?} is not a plain file name",
            json.file
        )));
    }
    let signature = json.signature.trim().to_string();
    if signature.is_empty() {
        return Err(skip("signature is empty".into()));
    }
    let path = dir.join(&json.file);
    let actual = match fs::metadata(&path) {
        Ok(m) if m.is_file() => m.len(),
        Ok(_) => return Err(skip(format!("{:?} is not a regular file", json.file))),
        Err(_) => {
            return Err(skip(format!(
                "{:?} is missing (upload incomplete?)",
                json.file
            )));
        }
    };
    if actual != json.size {
        return Err(skip(format!(
            "{:?} size does not match release.json (upload incomplete?)",
            json.file
        )));
    }
    // metadata() needs no read permission on the file itself. Prove the server can actually
    // open it (e.g. an upload with mode 600 owned by another user), otherwise the release
    // would be offered with a URL that 404s.
    fs::File::open(&path).map_err(|e| {
        skip(format!(
            "{:?} cannot be opened (check file permissions): {e}",
            json.file
        ))
    })?;

    let pub_date = json
        .pub_date
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty());
    let pub_date = match pub_date {
        Some(d) if is_rfc3339(&d) => Some(d),
        Some(d) => {
            notices.insert(format!(
                "release {dir_name:?}: pub_date {d:?} is not RFC 3339, ignoring it"
            ));
            None
        }
        None => None,
    };
    let sha256 = json
        .sha256
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty());
    let sha256 = match sha256 {
        Some(s) if s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()) => Some(s),
        Some(s) => {
            notices.insert(format!(
                "release {dir_name:?}: sha256 {s:?} is not 64 hex digits, ignoring it"
            ));
            None
        }
        None => None,
    };

    Ok(Some(Release {
        version,
        version_str: json.version,
        pub_date,
        notes: json.notes.unwrap_or_default(),
        file: json.file,
        size: json.size,
        sha256,
        signature,
        path,
    }))
}

/// All valid releases, newest (highest semver) first. Never fails: unreadable or invalid
/// entries are skipped and logged.
pub fn scan(root: &Path, log: &ScanLog) -> Vec<Release> {
    let mut problems = HashSet::new();
    let mut out = Vec::new();
    match fs::read_dir(root) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                // Follows symlinks on purpose (bind mounts); plain files are ignored.
                if !path.is_dir() {
                    continue;
                }
                let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                    problems.insert(format!("skipping non UTF-8 folder {:?}", entry.file_name()));
                    continue;
                };
                match load_release(&path, &name, &mut problems) {
                    Ok(Some(r)) => out.push(r),
                    Ok(None) => {}
                    Err(msg) => {
                        problems.insert(msg);
                    }
                }
            }
        }
        Err(e) => {
            problems.insert(format!("cannot read RELEASES_DIR {}: {e}", root.display()));
        }
    }
    log.report(problems);
    out.sort_by(|a, b| b.version.cmp(&a.version));
    out
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use serde_json::json;

    /// Writes `<root>/<version>/` with an exe of `content` and a matching release.json.
    /// `patch` can override or remove (`null`) release.json fields.
    pub fn write_release(
        root: &Path,
        version: &str,
        content: &[u8],
        patch: serde_json::Value,
    ) -> PathBuf {
        let dir = root.join(version);
        fs::create_dir_all(&dir).unwrap();
        let file = format!("Unity-Project-Sync_{version}_x64-setup.exe");
        fs::write(dir.join(&file), content).unwrap();
        let mut j = json!({
            "version": version,
            "pub_date": "2026-11-23T14:05:00Z",
            "notes": format!("Notes for {version}"),
            "file": file,
            "size": content.len(),
            "sha256": "AB".repeat(32),
            "signature": "c2lnbmF0dXJl\n",
        });
        if let serde_json::Value::Object(p) = patch {
            for (k, v) in p {
                if v.is_null() {
                    j.as_object_mut().unwrap().remove(&k);
                } else {
                    j[k] = v;
                }
            }
        }
        fs::write(
            dir.join(RELEASE_JSON),
            serde_json::to_vec_pretty(&j).unwrap(),
        )
        .unwrap();
        dir
    }

    fn versions(root: &Path) -> Vec<String> {
        scan(root, &ScanLog::default())
            .into_iter()
            .map(|r| r.version_str)
            .collect()
    }

    #[test]
    fn valid_release_is_loaded() {
        let tmp = tempfile::tempdir().unwrap();
        write_release(tmp.path(), "0.2.0", b"exe-bytes", json!({}));
        let rs = scan(tmp.path(), &ScanLog::default());
        assert_eq!(rs.len(), 1);
        let r = &rs[0];
        assert_eq!(r.version, Version::new(0, 2, 0));
        assert_eq!(r.file, "Unity-Project-Sync_0.2.0_x64-setup.exe");
        assert_eq!(r.size, 9);
        assert_eq!(r.signature, "c2lnbmF0dXJl", "signature is trimmed");
        assert_eq!(r.sha256.as_deref(), Some("ab".repeat(32).as_str()));
        assert_eq!(r.pub_date.as_deref(), Some("2026-11-23T14:05:00Z"));
        assert_eq!(r.notes, "Notes for 0.2.0");
    }

    #[test]
    fn missing_or_empty_dir_gives_no_releases() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(versions(tmp.path()).is_empty());
        assert!(versions(&tmp.path().join("does-not-exist")).is_empty());
    }

    #[test]
    fn optional_fields_may_be_missing() {
        let tmp = tempfile::tempdir().unwrap();
        write_release(
            tmp.path(),
            "1.0.0",
            b"x",
            json!({"notes": null, "pub_date": null, "sha256": null}),
        );
        let r = &scan(tmp.path(), &ScanLog::default())[0];
        assert_eq!(r.notes, "");
        assert_eq!(r.pub_date, None);
        assert_eq!(r.sha256, None);
    }

    #[test]
    fn bad_pub_date_and_sha_are_dropped_not_fatal() {
        let tmp = tempfile::tempdir().unwrap();
        write_release(
            tmp.path(),
            "1.0.0",
            b"x",
            json!({"pub_date": "23.11.2026", "sha256": "xyz"}),
        );
        let r = &scan(tmp.path(), &ScanLog::default())[0];
        assert_eq!(r.pub_date, None);
        assert_eq!(r.sha256, None);
    }

    #[test]
    fn bom_is_tolerated() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = write_release(tmp.path(), "1.0.0", b"x", json!({}));
        let mut raw = b"\xEF\xBB\xBF".to_vec();
        raw.extend(fs::read(dir.join(RELEASE_JSON)).unwrap());
        fs::write(dir.join(RELEASE_JSON), raw).unwrap();
        assert_eq!(versions(tmp.path()), ["1.0.0"]);
    }

    #[test]
    fn invalid_releases_are_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_release(root, "1.0.0", b"good", json!({}));
        // hidden / underscore folders
        write_release(root, ".1.1.0", b"x", json!({"version": ".1.1.0"}));
        write_release(root, "_1.2.0", b"x", json!({"version": "_1.2.0"}));
        // folder name mismatch
        write_release(root, "1.3.0", b"x", json!({"version": "1.3.1"}));
        // "v" prefix is not semver and not the folder name
        write_release(root, "v1.4.0", b"x", json!({"version": "v1.4.0"}));
        // not semver
        write_release(root, "1.5", b"x", json!({"version": "1.5"}));
        // incomplete upload: size mismatch
        write_release(root, "1.6.0", b"short", json!({"size": 999_999}));
        // empty / whitespace signature
        write_release(root, "1.7.0", b"x", json!({"signature": "  \n"}));
        // missing exe
        let dir = write_release(root, "1.8.0", b"x", json!({}));
        fs::remove_file(dir.join("Unity-Project-Sync_1.8.0_x64-setup.exe")).unwrap();
        // broken json
        let dir = root.join("1.9.0");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(RELEASE_JSON), "{ not json").unwrap();
        // no release.json at all
        fs::create_dir_all(root.join("2.0.0")).unwrap();
        // missing required field
        write_release(root, "2.1.0", b"x", json!({"signature": null}));
        // the "file" is a directory
        let dir = write_release(root, "2.2.0", b"x", json!({"file": "sub", "size": 0}));
        fs::create_dir_all(dir.join("sub")).unwrap();
        // a stray file in the root
        fs::write(root.join("README.txt"), "hi").unwrap();

        assert_eq!(versions(root), ["1.0.0"]);
    }

    #[test]
    fn unsafe_file_names_are_rejected() {
        for bad in [
            "../evil.exe",
            "..",
            "a..b.exe",
            "sub/evil.exe",
            "sub\\evil.exe",
            ".hidden.exe",
            "",
            "line\nbreak.exe",
            "release.json/../x",
        ] {
            assert!(!is_plain_file_name(bad), "{bad:?}");
        }
        assert!(is_plain_file_name("Unity-Project-Sync_0.2.0_x64-setup.exe"));
        assert!(is_plain_file_name("My App 1.0.exe"));

        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // A real file outside the release folder that a traversal would reach.
        fs::write(root.join("outside.exe"), b"x").unwrap();
        write_release(
            root,
            "1.0.0",
            b"x",
            json!({"file": "../outside.exe", "size": 1}),
        );
        write_release(root, "1.1.0", b"x", json!({"file": ".hidden", "size": 1}));
        assert!(versions(root).is_empty());
    }

    #[test]
    fn semver_ordering_including_prereleases() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        for v in [
            "0.9.0",
            "0.10.0",
            "1.0.0-beta.2",
            "1.0.0-beta.11",
            "1.0.0-alpha",
            "1.0.0",
            "0.10.1-rc.1",
        ] {
            write_release(root, v, b"x", json!({}));
        }
        assert_eq!(
            versions(root),
            [
                "1.0.0",
                "1.0.0-beta.11",
                "1.0.0-beta.2",
                "1.0.0-alpha",
                "0.10.1-rc.1",
                "0.10.0",
                "0.9.0"
            ]
        );
    }

    #[test]
    fn prerelease_above_latest_stable_is_latest() {
        let tmp = tempfile::tempdir().unwrap();
        write_release(tmp.path(), "1.0.0", b"x", json!({}));
        write_release(tmp.path(), "1.1.0-beta.1", b"x", json!({}));
        assert_eq!(versions(tmp.path())[0], "1.1.0-beta.1");
    }

    #[test]
    fn scan_log_reports_each_problem_once() {
        let log = ScanLog::default();
        let a: HashSet<String> = ["a".to_string()].into();
        log.report(a.clone());
        assert!(log.seen.lock().unwrap().contains("a"));
        log.report(HashSet::new());
        assert!(log.seen.lock().unwrap().is_empty());
    }
}
