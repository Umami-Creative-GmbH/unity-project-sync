//! `inspect_project`: cheap look at a folder the user picked.

use std::fs;
use std::path::Path;

use crate::model::ProjectInfo;

pub fn inspect_project(path: &str) -> ProjectInfo {
    let root = Path::new(path);
    let mut info = ProjectInfo {
        path: path.to_string(),
        exists: false,
        is_empty: false,
        is_unity_project: false,
        unity_version: None,
        root_dirs: Vec::new(),
        // Also for missing folders: resolved through their nearest existing ancestor.
        compare_path: crate::scan::comparison_path(path),
    };
    if path.trim().is_empty() || !root.is_dir() {
        return info;
    }
    info.exists = true;

    match fs::read_dir(root) {
        Ok(rd) => {
            let mut any_entry = false;
            for entry in rd {
                any_entry = true; // an unreadable entry is still an entry
                let Ok(entry) = entry else { continue };
                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                if is_dir && let Some(name) = entry.file_name().to_str() {
                    info.root_dirs.push(name.to_string());
                }
            }
            info.is_empty = !any_entry;
        }
        // Unknown contents: treat as non-empty so the UI asks for an acknowledgement.
        Err(_) => info.is_empty = false,
    }
    info.root_dirs.sort_by(|a, b| {
        a.to_lowercase()
            .cmp(&b.to_lowercase())
            .then_with(|| a.cmp(b))
    });

    info.is_unity_project = root.join("Assets").is_dir() && root.join("ProjectSettings").is_dir();
    info.unity_version =
        fs::read_to_string(root.join("ProjectSettings").join("ProjectVersion.txt"))
            .ok()
            .and_then(|text| parse_unity_version(&text));
    info
}

pub fn parse_unity_version(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let v = line.trim().strip_prefix("m_EditorVersion:")?.trim();
        (!v.is_empty()).then(|| v.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_version() {
        let txt = "m_EditorVersion: 6000.0.23f1\nm_EditorVersionWithRevision: 6000.0.23f1 (1c4764c07fb4)\n";
        assert_eq!(parse_unity_version(txt).as_deref(), Some("6000.0.23f1"));
        assert_eq!(parse_unity_version("nothing"), None);
    }

    #[test]
    fn inspects_folders() {
        let missing = inspect_project("Z:/definitely/not/here/xyz");
        assert!(!missing.exists);

        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().to_str().unwrap();
        let empty = inspect_project(p);
        assert!(empty.exists && empty.is_empty && !empty.is_unity_project);

        fs::create_dir_all(dir.path().join("Assets")).unwrap();
        fs::create_dir_all(dir.path().join("ProjectSettings")).unwrap();
        fs::create_dir_all(dir.path().join("library")).unwrap();
        fs::write(
            dir.path().join("ProjectSettings/ProjectVersion.txt"),
            "m_EditorVersion: 6000.0.23f1\n",
        )
        .unwrap();
        fs::write(dir.path().join("x.sln"), "x").unwrap();
        let info = inspect_project(p);
        assert!(info.exists && !info.is_empty && info.is_unity_project);
        assert_eq!(info.unity_version.as_deref(), Some("6000.0.23f1"));
        assert_eq!(info.root_dirs, vec!["Assets", "library", "ProjectSettings"]);
    }
}
