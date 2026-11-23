//! The GitHub repository behind the page: header links to star and fork it, with counts.
//!
//! The counts come from the GitHub REST API. The server fetches them in the background and
//! caches them in memory; the visitor's browser never talks to GitHub, so the page still makes
//! no third-party requests and the strict CSP stays as it is. Until the first fetch succeeds
//! (or when GitHub is unreachable) the links are shown without counts.

use std::time::Duration;

use reqwest::header::ACCEPT;
use serde::Deserialize;

use crate::{SharedState, info, warn};

pub const DEFAULT_REPO: &str = "Umami-Creative-GmbH/unity-project-sync";

/// Unauthenticated API calls are limited to 60 per hour and IP; this uses 2.
const REFRESH_EVERY: Duration = Duration::from_secs(30 * 60);
const RETRY_AFTER: Duration = Duration::from_secs(5 * 60);
const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct RepoStats {
    #[serde(rename = "stargazers_count")]
    pub stars: u64,
    #[serde(rename = "forks_count")]
    pub forks: u64,
}

/// `owner/name` with GitHub's allowed characters. Validated because it ends up in URLs.
pub fn valid_repo(s: &str) -> bool {
    let part = |p: &str| {
        !p.is_empty()
            && p.len() <= 100
            && p != "."
            && p != ".."
            && p.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    };
    s.split_once('/')
        .is_some_and(|(owner, name)| part(owner) && part(name))
}

/// GitHub-style short count: `999`, `1k`, `1.2k`, `12.3k`, `123k`, `1.2m`. Truncates, so a
/// count is never shown higher than it is.
pub fn format_count(n: u64) -> String {
    let short = |unit: u64, suffix: &str| {
        if n >= unit * 100 {
            format!("{}{suffix}", n / unit)
        } else {
            let tenths = n / (unit / 10);
            if tenths.is_multiple_of(10) {
                format!("{}{suffix}", tenths / 10)
            } else {
                format!("{}.{}{suffix}", tenths / 10, tenths % 10)
            }
        }
    };
    match n {
        0..1_000 => n.to_string(),
        1_000..1_000_000 => short(1_000, "k"),
        _ => short(1_000_000, "m"),
    }
}

async fn fetch(client: &reqwest::Client, url: &str) -> Result<RepoStats, reqwest::Error> {
    client
        .get(url)
        .header(ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
}

/// Starts the background refresh when a repository is configured.
pub fn spawn_refresh(state: SharedState) {
    let Some(repo) = state.config.github_repo.clone() else {
        return;
    };
    // reqwest is built without a bundled crypto provider; use ring (small, builds on musl).
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = match reqwest::Client::builder()
        .user_agent(concat!("ups-update-server/", env!("CARGO_PKG_VERSION")))
        .timeout(TIMEOUT)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            warn!("GitHub counts disabled, cannot create HTTP client: {e}");
            return;
        }
    };
    let url = format!("https://api.github.com/repos/{repo}");
    tokio::spawn(async move {
        // Log only changes between working and failing, not every retry.
        let mut failing = false;
        loop {
            let wait = match fetch(&client, &url).await {
                Ok(stats) => {
                    if failing {
                        info!("GitHub counts for {repo} are available again");
                    }
                    failing = false;
                    *state.repo_stats.write().unwrap_or_else(|e| e.into_inner()) = Some(stats);
                    REFRESH_EVERY
                }
                Err(e) => {
                    if !failing {
                        warn!("cannot fetch GitHub counts for {repo} (retrying): {e}");
                    }
                    failing = true;
                    RETRY_AFTER
                }
            };
            tokio::time::sleep(wait).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_names() {
        assert!(valid_repo(DEFAULT_REPO));
        assert!(valid_repo("a/b.c_d-e"));
        for bad in [
            "", "a", "a/", "/b", "a/b/c", "a/..", "../b", "a/b c", "a/b\"", "a/<b>",
        ] {
            assert!(!valid_repo(bad), "{bad}");
        }
    }

    #[test]
    fn counts() {
        let cases = [
            (0, "0"),
            (999, "999"),
            (1_000, "1k"),
            (1_049, "1k"),
            (1_234, "1.2k"),
            (9_999, "9.9k"),
            (12_345, "12.3k"),
            (99_999, "99.9k"),
            (100_000, "100k"),
            (123_456, "123k"),
            (999_999, "999k"),
            (1_000_000, "1m"),
            (1_250_000, "1.2m"),
        ];
        for (n, s) in cases {
            assert_eq!(format_count(n), s, "{n}");
        }
    }

    #[test]
    fn parses_api_response() {
        let s: RepoStats = serde_json::from_str(
            r#"{"full_name":"a/b","stargazers_count":42,"forks_count":7,"watchers_count":42}"#,
        )
        .unwrap();
        assert_eq!(
            s,
            RepoStats {
                stars: 42,
                forks: 7
            }
        );
    }
}
