//! Exclusion patterns of a sync scope: case-insensitive globs (`*` = any run of characters,
//! `?` = one character) matched against the NAME of an entry (file or folder) at any depth inside
//! the scope. An excluded entry, everything below an excluded folder and the Unity sidecar
//! `<name>.meta` of an excluded name are ignored on both sides: never copied, never deleted.

/// Most patterns a scope may have.
pub const MAX_EXCLUDE_PATTERNS: usize = 100;
/// Longest pattern, in characters.
pub const MAX_EXCLUDE_PATTERN_LEN: usize = 255;

// Already folded; compared against the folded name as a char slice (no per-call allocation).
const META_SUFFIX: [char; 5] = ['.', 'm', 'e', 't', 'a'];

/// Compiled exclusion patterns (case-folded once, matched per entry name while walking).
#[derive(Debug, Clone, Default)]
pub struct Excludes {
    patterns: Vec<Vec<char>>,
}

impl Excludes {
    pub fn new(patterns: &[String]) -> Self {
        Self {
            patterns: patterns
                .iter()
                .map(|p| p.trim())
                .filter(|p| !p.is_empty())
                .map(fold)
                .collect(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.patterns.is_empty()
    }

    /// True when the entry `name` matches a pattern, or is the `.meta` sidecar of a name that does.
    pub fn matches(&self, name: &str) -> bool {
        if self.patterns.is_empty() {
            return false;
        }
        let name = fold(name);
        if self.any(&name) {
            return true;
        }
        name.len() > META_SUFFIX.len()
            && name.ends_with(&META_SUFFIX)
            && self.any(&name[..name.len() - META_SUFFIX.len()])
    }

    /// True when any of the given path components (entry names) is excluded.
    pub fn matches_any_part<'a>(&self, mut parts: impl Iterator<Item = &'a str>) -> bool {
        !self.patterns.is_empty() && parts.any(|p| self.matches(p))
    }

    fn any(&self, name: &[char]) -> bool {
        self.patterns.iter().any(|p| glob(p, name))
    }
}

/// Lowercases like `fsutil::key_of` (`str::to_lowercase`, incl. the final-sigma rule), so every
/// name that shares a matching key is excluded the same way.
fn fold(s: &str) -> Vec<char> {
    s.to_lowercase().chars().collect()
}

/// Wildcard match with single-star backtracking (linear in practice, no recursion).
fn glob(p: &[char], s: &[char]) -> bool {
    let (mut pi, mut si) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while si < s.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == s[si]) {
            pi += 1;
            si += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some((pi, si));
            pi += 1;
        } else if let Some((sp, ss)) = star {
            // Let the last star swallow one more character and retry.
            pi = sp + 1;
            si = ss + 1;
            star = Some((sp, ss + 1));
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&c| c == '*')
}

/// Normalizes the patterns of a scope: trimmed, empty ones dropped, duplicates removed
/// (case-insensitively, first spelling kept). Rejects paths, control characters and too many or
/// too long patterns with a message for the UI.
pub fn normalize_patterns(raw: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for p in raw {
        let p = p.trim();
        if p.is_empty() {
            continue;
        }
        if p.contains(['/', '\\']) {
            return Err(format!(
                "Invalid exclusion pattern \"{p}\": patterns match file or folder names, so they cannot contain / or \\."
            ));
        }
        if p.chars().any(char::is_control) {
            return Err(format!(
                "Invalid exclusion pattern \"{}\": control characters are not allowed.",
                p.escape_debug()
            ));
        }
        if p.chars().count() > MAX_EXCLUDE_PATTERN_LEN {
            return Err(format!(
                "Exclusion pattern too long (at most {MAX_EXCLUDE_PATTERN_LEN} characters)."
            ));
        }
        if !out.iter().any(|o| o.to_lowercase() == p.to_lowercase()) {
            out.push(p.to_string());
        }
    }
    if out.len() > MAX_EXCLUDE_PATTERNS {
        return Err(format!(
            "Too many exclusion patterns (at most {MAX_EXCLUDE_PATTERNS})."
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ex(patterns: &[&str]) -> Excludes {
        Excludes::new(&patterns.iter().map(|p| p.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn globs_match_names_case_insensitively() {
        let e = ex(&["*.log", "crash_??.dmp", "Build*Cache"]);
        for name in [
            "Editor.log",
            "EDITOR.LOG",
            ".log",
            "a.b.log",
            "crash_01.dmp",
            "CRASH_ab.DMP",
            "BuildCache",
            "build-x-cache",
        ] {
            assert!(e.matches(name), "{name}");
        }
        for name in [
            "Editor.log.txt",
            "log",
            "crash_1.dmp",
            "crash_123.dmp",
            "MyBuildCache",
        ] {
            assert!(!e.matches(name), "{name}");
        }
        assert!(ex(&["*"]).matches("anything"));
        assert!(ex(&["a*b*c"]).matches("aXXbYYbZc"));
        assert!(!ex(&["a*b*c"]).matches("aXXbYY"));
        assert!(!ex(&[]).matches("x.log"));
        assert!(ex(&["ÄRGER.txt"]).matches("ärger.TXT"));
        assert!(ex(&["**"]).matches("x"));
        assert!(ex(&["**.log"]).matches("a.log"));
        assert!(ex(&["*?"]).matches("a"));
        assert!(!ex(&["*?"]).matches(""));
        assert!(ex(&["Build*"]).matches("BuildCache"));
        assert!(!ex(&["Build*"]).matches("MyBuild"));
        // "İ" lowercases to two characters ("i" + combining dot), so `?` alone does not match it.
        assert!(ex(&["İ"]).matches("İ"));
        assert!(ex(&["??"]).matches("İ"));
        assert!(!ex(&["?"]).matches("İ"));
    }

    /// Folds like `fsutil::key_of` (final sigma included): names sharing a key match alike.
    #[test]
    fn names_sharing_a_key_are_excluded_alike() {
        let e = ex(&["*σ"]);
        assert_eq!(e.matches("aΣ"), e.matches("aς"));
        assert_eq!(
            crate::fsutil::key_of("aΣ", true),
            crate::fsutil::key_of("aς", true)
        );
    }

    #[test]
    fn meta_sidecars_follow_their_entry() {
        let e = ex(&["*.unitypackage", "Generated"]);
        assert!(e.matches("Tools.unitypackage.meta"));
        assert!(e.matches("Tools.UnityPackage.META"));
        assert!(e.matches("Generated.meta"));
        assert!(!e.matches("Other.meta"));
        assert!(!e.matches(".meta"));
        assert!(e.matches_any_part("Assets/Generated/x.cs".split('/').skip(1)));
        assert!(!e.matches_any_part("Assets/Code/x.cs".split('/').skip(1)));
    }

    #[test]
    fn normalizes_and_validates_patterns() {
        let raw = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            normalize_patterns(&raw(&[" *.log ", "", "  ", "*.LOG", "*.tmp"])).unwrap(),
            vec!["*.log".to_string(), "*.tmp".to_string()]
        );
        for bad in ["Logs/*.log", "a\\b", "x\ty"] {
            assert!(normalize_patterns(&raw(&[bad])).is_err(), "{bad}");
        }
        let long = "x".repeat(MAX_EXCLUDE_PATTERN_LEN + 1);
        assert!(normalize_patterns(&[long]).is_err());
        let many: Vec<String> = (0..=MAX_EXCLUDE_PATTERNS)
            .map(|i| format!("*.{i}"))
            .collect();
        assert!(normalize_patterns(&many).is_err());
    }
}
