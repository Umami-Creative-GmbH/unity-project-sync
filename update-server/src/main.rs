//! Update server and download page for Unity Project Sync.
//!
//! Serves the Tauri updater endpoint, a landing page and the release files from a directory of
//! manually uploaded release folders (see README.md).

mod assets;
mod page;
mod releases;
mod routes;
mod util;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use crate::releases::ScanLog;

/// Runtime configuration, read once from the environment.
#[derive(Debug, Clone, Default)]
pub struct Config {
    pub releases_dir: PathBuf,
    /// Absolute base URL without a trailing slash, e.g. `https://ups.umami-creative.app`.
    /// When `None`, the base URL is derived from the request headers.
    pub public_url: Option<String>,
    pub imprint_url: Option<String>,
    pub privacy_url: Option<String>,
}

pub struct AppState {
    pub config: Config,
    pub scan_log: ScanLog,
}

pub type SharedState = Arc<AppState>;

impl AppState {
    pub fn new(config: Config) -> SharedState {
        Arc::new(AppState {
            config,
            scan_log: ScanLog::default(),
        })
    }
}

/// Accepts only absolute http(s) URLs made of visible ASCII, so they are safe in HTML
/// attributes (after escaping) and in a `Location` header. With `base_url`, trailing slashes
/// are removed (the value is used as a prefix); other URLs are kept exactly as configured.
pub fn clean_http_url(name: &str, value: Option<String>, base_url: bool) -> Option<String> {
    let v = value?.trim().to_string();
    let v = if base_url {
        v.trim_end_matches('/').to_string()
    } else {
        v
    };
    if v.is_empty() {
        return None;
    }
    let scheme_ok = v.starts_with("https://") || v.starts_with("http://");
    let chars_ok = v.bytes().all(|b| b.is_ascii_graphic());
    let host_ok = v
        .split_once("://")
        .is_some_and(|(_, rest)| !rest.is_empty());
    if scheme_ok && chars_ok && host_ok {
        Some(v)
    } else {
        warn!("{name}={v:?} is not an absolute http(s) URL, ignoring it");
        None
    }
}

impl Config {
    fn from_env() -> Result<(Config, u16), String> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let port = match var("PORT") {
            Some(p) => p
                .trim()
                .parse::<u16>()
                .map_err(|_| format!("PORT={p:?} is not a valid port"))?,
            None => 8080,
        };
        let config = Config {
            releases_dir: var("RELEASES_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/data/releases")),
            public_url: clean_http_url("PUBLIC_URL", var("PUBLIC_URL"), true),
            imprint_url: clean_http_url("IMPRINT_URL", var("IMPRINT_URL"), false),
            privacy_url: clean_http_url("PRIVACY_URL", var("PRIVACY_URL"), false),
        };
        Ok((config, port))
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    info!("shutdown signal received, finishing open requests");
}

#[tokio::main]
async fn main() {
    let (config, port) = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            warn!("{e}");
            std::process::exit(2);
        }
    };
    info!(
        "ups-update-server {} starting: RELEASES_DIR={}, PUBLIC_URL={}",
        env!("CARGO_PKG_VERSION"),
        config.releases_dir.display(),
        config
            .public_url
            .as_deref()
            .unwrap_or("(from request headers)")
    );
    if !config.releases_dir.is_dir() {
        warn!(
            "RELEASES_DIR {} does not exist (yet); serving the \"no release\" state",
            config.releases_dir.display()
        );
    }

    let app = routes::router(AppState::new(config));
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            warn!("cannot listen on {addr}: {e}");
            std::process::exit(1);
        }
    };
    info!("listening on http://{addr}");
    if let Err(e) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        warn!("server error: {e}");
        std::process::exit(1);
    }
    info!("stopped");
}

#[cfg(test)]
mod tests {
    use super::clean_http_url;

    #[test]
    fn cleans_urls() {
        let c = |v: &str| clean_http_url("X", Some(v.to_string()), true);
        assert_eq!(
            c("https://ups.umami-creative.app/"),
            Some("https://ups.umami-creative.app".into())
        );
        assert_eq!(
            c(" http://localhost:8080 "),
            Some("http://localhost:8080".into())
        );
        assert_eq!(
            c("https://example.com/imprint"),
            Some("https://example.com/imprint".into())
        );
        assert_eq!(c("javascript:alert(1)"), None);
        assert_eq!(c("ftp://x"), None);
        assert_eq!(c("https://"), None);
        assert_eq!(c("https://exa mple.com"), None);
        assert_eq!(c("https://exämple.com"), None);
        assert_eq!(c(""), None);
        assert_eq!(c("https:///"), None);
        // Footer links keep their trailing slash (a strict host may 404 without it).
        assert_eq!(
            clean_http_url("X", Some("https://example.com/impressum/".into()), false),
            Some("https://example.com/impressum/".into())
        );
    }
}
