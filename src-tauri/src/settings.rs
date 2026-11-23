//! Protects the settings file (`settings.json`, owned by tauri-plugin-store) from being wiped.
//!
//! The store plugin ignores a file it can't parse (the store just starts empty) and saves every
//! store on exit, so a hand-edited file with one stray comma would be overwritten with an empty
//! project list. Before the UI loads the store, an unreadable file is therefore moved aside to
//! `settings.json.bak-<epoch ms>`; the UI tells the user where it is.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// File name used by the UI (`load("settings.json")`), relative to the app data folder.
pub const SETTINGS_FILE: &str = "settings.json";

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn backup_path(file: &Path, stamp: u128) -> PathBuf {
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| SETTINGS_FILE.to_string());
    let mut path = file.with_file_name(format!("{name}.bak-{stamp}"));
    let mut n = 1;
    while path.exists() {
        path = file.with_file_name(format!("{name}.bak-{stamp}-{n}"));
        n += 1;
    }
    path
}

/// The plugin's default format: a JSON object at the top level.
fn parses_like_the_store(bytes: &[u8]) -> bool {
    serde_json::from_slice::<HashMap<String, serde_json::Value>>(bytes).is_ok()
}

/// Moves `file` aside when it exists, has content and the store plugin couldn't parse it.
/// Returns the backup path in that case.
pub fn quarantine_unreadable(file: &Path) -> io::Result<Option<PathBuf>> {
    let bytes = match fs::read(file) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    if bytes.iter().all(|b| b.is_ascii_whitespace()) || parses_like_the_store(&bytes) {
        return Ok(None);
    }
    let backup = backup_path(file, now_ms());
    fs::rename(file, &backup)?;
    Ok(Some(backup))
}

/// Copies `file` to a timestamped backup next to it (for content the UI can't use).
pub fn backup(file: &Path) -> io::Result<PathBuf> {
    let backup = backup_path(file, now_ms());
    fs::copy(file, &backup)?;
    Ok(backup)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readable_or_missing_files_stay() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(SETTINGS_FILE);
        assert_eq!(quarantine_unreadable(&file).unwrap(), None);
        fs::write(&file, br#"{"projects":[]}"#).unwrap();
        assert_eq!(quarantine_unreadable(&file).unwrap(), None);
        fs::write(&file, b"  \n").unwrap();
        assert_eq!(quarantine_unreadable(&file).unwrap(), None);
        assert!(file.exists());
    }

    #[test]
    fn unreadable_files_are_moved_aside() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(SETTINGS_FILE);
        let broken = br#"{"projects":[{"id":"a",},]}"#;
        fs::write(&file, broken).unwrap();
        let moved = quarantine_unreadable(&file).unwrap().expect("moved");
        assert!(!file.exists());
        assert_eq!(fs::read(&moved).unwrap(), broken);
        assert!(
            moved
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("settings.json.bak-")
        );
        // A top-level array is valid JSON but not a store either.
        fs::write(&file, b"[1,2]").unwrap();
        let second = quarantine_unreadable(&file).unwrap().expect("moved");
        assert_ne!(second, moved);
        assert!(moved.exists() && second.exists());
    }

    #[test]
    fn backup_copies_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(SETTINGS_FILE);
        fs::write(&file, br#"{"projects":{"nope":true}}"#).unwrap();
        let b = backup(&file).unwrap();
        assert!(file.exists());
        assert_eq!(fs::read(&b).unwrap(), fs::read(&file).unwrap());
    }
}
