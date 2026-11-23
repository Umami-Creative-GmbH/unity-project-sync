//! Serde types mirroring `src/lib/types.ts` (the shared contract with the UI).
//! Field names are camelCase on the wire; enums serialize as lowercase strings.

use serde::{Deserialize, Serialize};

/// Top-level folders that Unity/IDEs/VCS regenerate or own. Never allowed in a scope.
pub const NEVER_SYNC: [&str; 7] = ["Library", "Temp", "Logs", "obj", ".git", ".vs", ".utmp"];

/// Maximum number of plan entries returned to the UI (the full list stays in the backend).
pub const MAX_UI_ENTRIES: usize = 20_000;

/// Maximum number of sync errors returned in a report (the total is in `error_count`).
pub const MAX_REPORTED_ERRORS: usize = 1000;

pub fn is_never_sync(name: &str) -> bool {
    NEVER_SYNC.iter().any(|n| n.eq_ignore_ascii_case(name))
}

/// Names that Windows may resolve to a different entry: 8.3 short names (`GIT~1`) and names
/// with a trailing dot or space (stripped by Win32 path normalization).
pub fn is_alias_prone(name: &str) -> bool {
    name.contains('~') || name.ends_with('.') || name.ends_with(' ')
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub path: String,
    pub exists: bool,
    pub is_empty: bool,
    pub is_unity_project: bool,
    pub unity_version: Option<String>,
    pub root_dirs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncScope {
    pub include_root_files: bool,
    pub folders: Vec<String>,
}

impl Default for SyncScope {
    fn default() -> Self {
        Self {
            include_root_files: true,
            folders: vec![
                "Assets".to_string(),
                "Packages".to_string(),
                "ProjectSettings".to_string(),
            ],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanAction {
    Copy,
    Update,
    Verify,
    Delete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanReason {
    New,
    Size,
    Mtime,
    Type,
    Extra,
    /// Same entry on both sides, but the name differs only in letter case: renamed in the target.
    Case,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    pub path: String,
    pub action: PlanAction,
    pub reason: PlanReason,
    pub size: u64,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CountBytes {
    pub files: u64,
    pub bytes: u64,
}

impl CountBytes {
    pub fn add(&mut self, bytes: u64) {
        self.files += 1;
        self.bytes += bytes;
    }
}

/// `CountBytes & { dirs: number }`
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteCounts {
    pub files: u64,
    pub bytes: u64,
    pub dirs: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanSummary {
    pub plan_id: u64,
    pub source: String,
    pub target: String,
    pub scope: SyncScope,
    pub copy: CountBytes,
    pub update: CountBytes,
    pub verify: CountBytes,
    pub delete: DeleteCounts,
    pub unchanged: CountBytes,
    pub total_bytes: u64,
    pub entries: Vec<PlanEntry>,
    pub entries_truncated: bool,
    pub total_entries: u64,
    pub warnings: Vec<String>,
    pub scan_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScanPhase {
    Source,
    Target,
    Compare,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub phase: ScanPhase,
    pub entries: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncPhase {
    Deleting,
    Copying,
    Finalizing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    pub phase: SyncPhase,
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub done_files: u64,
    pub total_files: u64,
    pub bytes_per_sec: f64,
    pub eta_secs: Option<f64>,
    pub elapsed_ms: u64,
    pub current_file: Option<String>,
    pub errors: u64,
    /// Items (files + folders) removed so far in the deletion phase.
    pub delete_done: u64,
    /// Items (files + folders) the plan deletes.
    pub delete_total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncError {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub copied: u64,
    pub updated: u64,
    pub verified_identical: u64,
    pub verified_changed: u64,
    pub deleted_files: u64,
    pub deleted_dirs: u64,
    pub bytes_written: u64,
    pub duration_ms: u64,
    pub cancelled: bool,
    /// At most `MAX_REPORTED_ERRORS` errors; `error_count` has the real number.
    pub errors: Vec<SyncError>,
    pub error_count: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_camel_case_and_lowercase_enums() {
        let e = PlanEntry {
            path: "Assets/A.cs".into(),
            action: PlanAction::Verify,
            reason: PlanReason::Mtime,
            size: 3,
            is_dir: false,
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["action"], "verify");
        assert_eq!(v["reason"], "mtime");
        assert_eq!(v["isDir"], false);

        let p = ScanProgress {
            phase: ScanPhase::Compare,
            entries: 1,
        };
        assert_eq!(serde_json::to_value(p).unwrap()["phase"], "compare");

        let s: SyncScope =
            serde_json::from_str(r#"{"includeRootFiles":false,"folders":["Assets"]}"#).unwrap();
        assert!(!s.include_root_files);

        let d = serde_json::to_value(DeleteCounts::default()).unwrap();
        assert!(d.get("dirs").is_some() && d.get("files").is_some() && d.get("bytes").is_some());

        let prog = SyncProgress {
            phase: SyncPhase::Copying,
            done_bytes: 0,
            total_bytes: 0,
            done_files: 0,
            total_files: 0,
            bytes_per_sec: 0.0,
            eta_secs: None,
            elapsed_ms: 0,
            current_file: None,
            errors: 0,
            delete_done: 0,
            delete_total: 0,
        };
        let v = serde_json::to_value(prog).unwrap();
        assert_eq!(v["phase"], "copying");
        assert!(v["etaSecs"].is_null());
        assert!(v.get("bytesPerSec").is_some());
    }
}
