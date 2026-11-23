//! HTTP routes. See README.md for the contract.

use axum::Router;
use axum::body::Body;
use axum::extract::rejection::PathRejection;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use semver::Version;
use serde_json::json;
use tower_http::services::ServeFile;

use crate::page::{self, PageCtx};
use crate::releases::{self, Release};
use crate::util::encode_segment;
use crate::{Config, SharedState, assets, warn};

/// Target and arch of the only build that is published (NSIS setup, Windows x64).
const UPDATE_TARGET: &str = "windows";
const UPDATE_ARCH: &str = "x86_64";

const NO_CACHE: HeaderValue = HeaderValue::from_static("no-cache");
const CSP: HeaderValue = HeaderValue::from_static(
    "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; \
     font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; \
     frame-ancestors 'none'",
);

pub fn router(state: SharedState) -> Router {
    Router::new()
        .route("/", get(landing))
        .route("/healthz", get(healthz))
        .route(
            "/api/update/{target}/{arch}/{current_version}",
            get(update_check),
        )
        .route("/api/releases/latest", get(latest_release))
        .route("/download", get(download_latest))
        .route("/releases/{version}/{file}", get(release_file))
        .route("/assets/{name}", get(assets::asset))
        .route("/favicon.ico", get(assets::favicon))
        .fallback(fallback)
        .layer(middleware::map_response(common_headers))
        .with_state(state)
}

async fn common_headers(mut res: Response) -> Response {
    let h = res.headers_mut();
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    res
}

/// All valid releases, newest first. The scan runs on the blocking pool.
async fn load_releases(state: &SharedState) -> Vec<Release> {
    let st = state.clone();
    tokio::task::spawn_blocking(move || releases::scan(&st.config.releases_dir, &st.scan_log))
        .await
        .unwrap_or_else(|e| {
            warn!("release scan failed: {e}");
            Vec::new()
        })
}

fn valid_host(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 260
        && h.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b':' | b'[' | b']')
        })
}

/// Public base URL without a trailing slash: `PUBLIC_URL` if set, otherwise derived from
/// `X-Forwarded-Proto` / `X-Forwarded-Host` / `Host` (set by Coolify's Traefik or Caddy).
pub fn base_url(config: &Config, headers: &HeaderMap) -> String {
    if let Some(u) = &config.public_url {
        return u.clone();
    }
    let first = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .map(str::trim)
            .filter(|v| !v.is_empty())
    };
    let proto = match first("x-forwarded-proto") {
        Some(p) if p.eq_ignore_ascii_case("https") => "https",
        _ => "http",
    };
    let host = first("x-forwarded-host")
        .filter(|h| valid_host(h))
        .or_else(|| first("host").filter(|h| valid_host(h)))
        .unwrap_or("localhost");
    format!("{proto}://{host}")
}

/// Relative download path of a release file, percent-encoded.
pub fn file_path(r: &Release) -> String {
    format!(
        "/releases/{}/{}",
        encode_segment(&r.version_str),
        encode_segment(&r.file)
    )
}

fn file_url(base: &str, r: &Release) -> String {
    format!("{base}{}", file_path(r))
}

fn page_ctx<'a>(config: &'a Config, headers: &HeaderMap) -> PageCtx<'a> {
    PageCtx {
        base_url: base_url(config, headers),
        imprint_url: config.imprint_url.as_deref(),
        privacy_url: config.privacy_url.as_deref(),
    }
}

fn html(status: StatusCode, body: String) -> Response {
    (
        status,
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=utf-8"),
            ),
            (header::CACHE_CONTROL, NO_CACHE),
            (header::CONTENT_SECURITY_POLICY, CSP),
        ],
        body,
    )
        .into_response()
}

fn json_response(status: StatusCode, value: serde_json::Value) -> Response {
    (
        status,
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            ),
            (header::CACHE_CONTROL, NO_CACHE),
        ],
        value.to_string(),
    )
        .into_response()
}

fn not_found_page(state: &SharedState, headers: &HeaderMap) -> Response {
    let ctx = page_ctx(&state.config, headers);
    html(StatusCode::NOT_FOUND, page::render_not_found(&ctx, None))
}

async fn landing(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let releases = load_releases(&state).await;
    let ctx = page_ctx(&state.config, &headers);
    html(StatusCode::OK, page::render_landing(&ctx, &releases))
}

async fn healthz() -> Response {
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/plain; charset=utf-8"),
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
        "ok",
    )
        .into_response()
}

/// Tauri updater, dynamic server protocol: 204 = no update, 200 = JSON with the update.
async fn update_check(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path((target, arch, current_version)): Path<(String, String, String)>,
) -> Response {
    let Ok(current) = Version::parse(current_version.trim().trim_start_matches('v')) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "current_version is not a valid semver version" }),
        );
    };
    let no_update = (StatusCode::NO_CONTENT, [(header::CACHE_CONTROL, NO_CACHE)]).into_response();
    if target != UPDATE_TARGET || arch != UPDATE_ARCH {
        return no_update;
    }
    let releases = load_releases(&state).await;
    match releases.first() {
        Some(r) if r.version > current => json_response(
            StatusCode::OK,
            json!({
                "version": r.version_str,
                "notes": r.notes,
                "pub_date": r.pub_date,
                "url": file_url(&base_url(&state.config, &headers), r),
                "signature": r.signature,
            }),
        ),
        _ => no_update,
    }
}

async fn latest_release(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let releases = load_releases(&state).await;
    match releases.first() {
        Some(r) => json_response(
            StatusCode::OK,
            json!({
                "version": r.version_str,
                "pub_date": r.pub_date,
                "notes": r.notes,
                "file": r.file,
                "size": r.size,
                "sha256": r.sha256,
                "url": file_url(&base_url(&state.config, &headers), r),
            }),
        ),
        None => json_response(
            StatusCode::NOT_FOUND,
            json!({ "error": "no release has been published yet" }),
        ),
    }
}

async fn download_latest(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let releases = load_releases(&state).await;
    let Some(r) = releases.first() else {
        let ctx = page_ctx(&state.config, &headers);
        return html(
            StatusCode::NOT_FOUND,
            page::render_not_found(&ctx, Some(page::NotFound::NoRelease)),
        );
    };
    let url = file_url(&base_url(&state.config, &headers), r);
    let location = HeaderValue::from_str(&url)
        .or_else(|_| HeaderValue::from_str(&file_path(r)))
        .unwrap_or(HeaderValue::from_static("/"));
    (
        StatusCode::FOUND,
        [
            (header::LOCATION, location),
            (header::CACHE_CONTROL, NO_CACHE),
        ],
    )
        .into_response()
}

/// `Content-Disposition: attachment` with an ASCII fallback name and the exact UTF-8 name.
fn content_disposition(file: &str) -> HeaderValue {
    let ascii: String = file
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ' | '(' | ')') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let value = format!(
        "attachment; filename=\"{ascii}\"; filename*=UTF-8''{}",
        encode_segment(file)
    );
    HeaderValue::from_str(&value).unwrap_or(HeaderValue::from_static("attachment"))
}

/// Streams a release file (HEAD and Range supported), but only the file that a valid
/// release's release.json declares. Everything else is a 404.
async fn release_file(
    State(state): State<SharedState>,
    path: Result<Path<(String, String)>, PathRejection>,
    req: Request,
) -> Response {
    let headers = req.headers().clone();
    let Ok(Path((version, file))) = path else {
        return not_found_page(&state, &headers);
    };
    let releases = load_releases(&state).await;
    let Some(release) = releases
        .into_iter()
        .find(|r| r.version_str == version && r.file == file)
    else {
        return not_found_page(&state, &headers);
    };

    let res = match ServeFile::new(&release.path).try_call(req).await {
        Ok(res) => res.map(Body::new),
        Err(e) => {
            warn!("cannot serve {}: {e}", release.path.display());
            return not_found_page(&state, &headers);
        }
    };
    let (mut parts, body) = res.into_parts();
    match parts.status {
        StatusCode::OK
        | StatusCode::PARTIAL_CONTENT
        | StatusCode::NOT_MODIFIED
        | StatusCode::RANGE_NOT_SATISFIABLE => {}
        StatusCode::NOT_FOUND => {
            // The scan just found this file, so it vanished or became unreadable in between.
            warn!(
                "cannot serve {}: not found or not readable",
                release.path.display()
            );
            return not_found_page(&state, &headers);
        }
        _ => return Response::from_parts(parts, body),
    }
    let h = &mut parts.headers;
    // application/octet-stream on purpose: Coolify's Traefik gzip middleware skips this type
    // but would compress e.g. application/x-msdownload on the fly, dropping Content-Length
    // and breaking Range requests.
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    h.insert(
        header::CONTENT_DISPOSITION,
        content_disposition(&release.file),
    );
    // A published version is immutable (re-uploading the same version is not supported).
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    Response::from_parts(parts, body)
}

async fn fallback(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    not_found_page(&state, &headers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AppState;
    use crate::releases::tests::write_release;
    use axum::body::to_bytes;
    use std::path::Path as FsPath;
    use tower::ServiceExt;

    struct Got {
        status: StatusCode,
        headers: HeaderMap,
        body: String,
        bytes: Vec<u8>,
    }

    fn app(root: &FsPath, public_url: Option<&str>) -> Router {
        router(AppState::new(Config {
            releases_dir: root.to_path_buf(),
            public_url: public_url.map(str::to_string),
            imprint_url: Some("https://umami-creative.de/impressum".into()),
            privacy_url: None,
        }))
    }

    async fn send(app: Router, req: Request) -> Got {
        let res = app.oneshot(req).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let bytes = to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec();
        Got {
            status,
            headers,
            body: String::from_utf8_lossy(&bytes).into_owned(),
            bytes,
        }
    }

    async fn get_req(app: Router, uri: &str) -> Got {
        send(
            app,
            Request::builder()
                .uri(uri)
                .header("host", "internal:8080")
                .body(Body::empty())
                .unwrap(),
        )
        .await
    }

    fn hdr<'a>(g: &'a Got, name: &str) -> &'a str {
        g.headers
            .get(name)
            .map(|v| v.to_str().unwrap())
            .unwrap_or("")
    }

    const PUB: Option<&str> = Some("https://ups.umami-creative.app");

    // ---------- /healthz ----------

    #[tokio::test]
    async fn healthz_ok() {
        let tmp = tempfile::tempdir().unwrap();
        let g = get_req(app(tmp.path(), None), "/healthz").await;
        assert_eq!(g.status, StatusCode::OK);
        assert_eq!(g.body, "ok");
        assert_eq!(hdr(&g, "x-content-type-options"), "nosniff");
    }

    // ---------- update endpoint ----------

    #[tokio::test]
    async fn update_available() {
        let tmp = tempfile::tempdir().unwrap();
        write_release(tmp.path(), "0.1.0", b"old", json!({}));
        write_release(tmp.path(), "0.2.0", b"new-exe", json!({"notes": "- fixed"}));
        let g = get_req(app(tmp.path(), PUB), "/api/update/windows/x86_64/0.1.0").await;
        assert_eq!(g.status, StatusCode::OK);
        assert_eq!(hdr(&g, "cache-control"), "no-cache");
        assert!(hdr(&g, "content-type").starts_with("application/json"));
        let v: serde_json::Value = serde_json::from_str(&g.body).unwrap();
        assert_eq!(
            v,
            json!({
                "version": "0.2.0",
                "notes": "- fixed",
                "pub_date": "2026-11-23T14:05:00Z",
                "url": "https://ups.umami-creative.app/releases/0.2.0/Unity-Project-Sync_0.2.0_x64-setup.exe",
                "signature": "c2lnbmF0dXJl",
            })
        );
        assert!(v.get("platforms").is_none());
    }

    #[tokio::test]
    async fn update_not_available_when_current_or_newer() {
        let tmp = tempfile::tempdir().unwrap();
        write_release(tmp.path(), "0.2.0", b"x", json!({}));
        for current in ["0.2.0", "0.3.0", "v0.2.0", "1.0.0-alpha"] {
            let g = get_req(
                app(tmp.path(), PUB),
                &format!("/api/update/windows/x86_64/{current}"),
            )
            .await;
            assert_eq!(g.status, StatusCode::NO_CONTENT, "{current}");
            assert!(g.body.is_empty());
        }
        // A pre-release of the published version is older than the release.
        let g = get_req(
            app(tmp.path(), PUB),
            "/api/update/windows/x86_64/0.2.0-rc.1",
        )
        .await;
        assert_eq!(g.status, StatusCode::OK);
        // Build metadata arrives percent-encoded ("+" -> %2B).
        let g = get_req(
            app(tmp.path(), PUB),
            "/api/update/windows/x86_64/0.1.0%2Bdev.3",
        )
        .await;
        assert_eq!(g.status, StatusCode::OK);
    }

    #[tokio::test]
    async fn update_no_content_without_releases() {
        let tmp = tempfile::tempdir().unwrap();
        let g = get_req(app(tmp.path(), PUB), "/api/update/windows/x86_64/0.1.0").await;
        assert_eq!(g.status, StatusCode::NO_CONTENT);
        let g = get_req(
            app(&tmp.path().join("missing"), PUB),
            "/api/update/windows/x86_64/0.1.0",
        )
        .await;
        assert_eq!(g.status, StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn update_ignores_invalid_newer_release() {
        let tmp = tempfile::tempdir().unwrap();
        write_release(tmp.path(), "0.2.0", b"x", json!({}));
        write_release(tmp.path(), "0.3.0", b"partial", json!({"size": 10_000}));
        let g = get_req(app(tmp.path(), PUB), "/api/update/windows/x86_64/0.1.0").await;
        assert_eq!(g.status, StatusCode::OK);
        assert!(g.body.contains("\"version\":\"0.2.0\""));
    }

    #[tokio::test]
    async fn update_only_for_windows_x64() {
        let tmp = tempfile::tempdir().unwrap();
        write_release(tmp.path(), "0.2.0", b"x", json!({}));
        for uri in [
            "/api/update/linux/x86_64/0.1.0",
            "/api/update/darwin/aarch64/0.1.0",
            "/api/update/windows/aarch64/0.1.0",
            "/api/update/windows/i686/0.1.0",
            "/api/update/Windows/x86_64/0.1.0",
        ] {
            let g = get_req(app(tmp.path(), PUB), uri).await;
            assert_eq!(g.status, StatusCode::NO_CONTENT, "{uri}");
        }
    }

    #[tokio::test]
    async fn update_bad_version_is_400() {
        let tmp = tempfile::tempdir().unwrap();
        write_release(tmp.path(), "0.2.0", b"x", json!({}));
        for v in ["abc", "1.0", "1", "%7B%7Bcurrent_version%7D%7D", "1.0.0.0"] {
            let g = get_req(
                app(tmp.path(), PUB),
                &format!("/api/update/windows/x86_64/{v}"),
            )
            .await;
            assert_eq!(g.status, StatusCode::BAD_REQUEST, "{v}");
            assert!(g.body.contains("error"));
        }
        // even for unsupported targets
        let g = get_req(app(tmp.path(), PUB), "/api/update/linux/x86_64/nope").await;
        assert_eq!(g.status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn update_without_pub_date_sends_null() {
        let tmp = tempfile::tempdir().unwrap();
        write_release(
            tmp.path(),
            "0.2.0",
            b"x",
            json!({"pub_date": "yesterday", "notes": null}),
        );
        let g = get_req(app(tmp.path(), PUB), "/api/update/windows/x86_64/0.1.0").await;
        let v: serde_json::Value = serde_json::from_str(&g.body).unwrap();
        assert_eq!(v["pub_date"], serde_json::Value::Null);
        assert_eq!(v["notes"], "");
    }

    // ---------- URL building ----------

    #[test]
    fn base_url_from_public_url_and_headers() {
        let cfg = |p: Option<&str>| Config {
            public_url: p.map(str::to_string),
            ..Config::default()
        };
        let mut h = HeaderMap::new();
        h.insert("host", HeaderValue::from_static("internal:8080"));
        assert_eq!(base_url(&cfg(None), &h), "http://internal:8080");
        h.insert("x-forwarded-proto", HeaderValue::from_static("https"));
        h.insert(
            "x-forwarded-host",
            HeaderValue::from_static("ups.umami-creative.app, proxy.local"),
        );
        assert_eq!(base_url(&cfg(None), &h), "https://ups.umami-creative.app");
        assert_eq!(
            base_url(&cfg(Some("https://example.com")), &h),
            "https://example.com"
        );
        // garbage forwarded values fall back safely
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-proto", HeaderValue::from_static("javascript"));
        h.insert("x-forwarded-host", HeaderValue::from_static("evil\"<host>"));
        h.insert("host", HeaderValue::from_static("good.example"));
        assert_eq!(base_url(&cfg(None), &h), "http://good.example");
        assert_eq!(base_url(&cfg(None), &HeaderMap::new()), "http://localhost");
    }

    #[tokio::test]
    async fn urls_from_forwarded_headers_are_percent_encoded() {
        let tmp = tempfile::tempdir().unwrap();
        write_release(
            tmp.path(),
            "1.0.0+build.7",
            b"x",
            json!({"file": "Unity Project Sync #1.exe"}),
        );
        // write_release created the default exe name; add the declared one.
        std::fs::write(
            tmp.path()
                .join("1.0.0+build.7")
                .join("Unity Project Sync #1.exe"),
            b"x",
        )
        .unwrap();
        let req = Request::builder()
            .uri("/api/update/windows/x86_64/0.1.0")
            .header("host", "ups-container:8080")
            .header("x-forwarded-proto", "https")
            .header("x-forwarded-host", "ups.umami-creative.app")
            .body(Body::empty())
            .unwrap();
        let g = send(app(tmp.path(), None), req).await;
        assert_eq!(g.status, StatusCode::OK);
        let v: serde_json::Value = serde_json::from_str(&g.body).unwrap();
        assert_eq!(
            v["url"],
            "https://ups.umami-creative.app/releases/1.0.0%2Bbuild.7/Unity%20Project%20Sync%20%231.exe"
        );
        // and the encoded URL actually downloads
        let g = get_req(
            app(tmp.path(), None),
            "/releases/1.0.0%2Bbuild.7/Unity%20Project%20Sync%20%231.exe",
        )
        .await;
        assert_eq!(g.status, StatusCode::OK);
        assert_eq!(g.bytes, b"x");
    }

    // ---------- /api/releases/latest ----------

    #[tokio::test]
    async fn latest_json() {
        let tmp = tempfile::tempdir().unwrap();
        let g = get_req(app(tmp.path(), PUB), "/api/releases/latest").await;
        assert_eq!(g.status, StatusCode::NOT_FOUND);
        assert!(hdr(&g, "content-type").starts_with("application/json"));
        assert!(g.body.contains("error"));

        write_release(tmp.path(), "0.2.0", b"12345", json!({}));
        write_release(tmp.path(), "0.10.0", b"1234567", json!({}));
        let g = get_req(app(tmp.path(), PUB), "/api/releases/latest").await;
        assert_eq!(g.status, StatusCode::OK);
        assert_eq!(hdr(&g, "cache-control"), "no-cache");
        let v: serde_json::Value = serde_json::from_str(&g.body).unwrap();
        assert_eq!(
            v,
            json!({
                "version": "0.10.0",
                "pub_date": "2026-11-23T14:05:00Z",
                "notes": "Notes for 0.10.0",
                "file": "Unity-Project-Sync_0.10.0_x64-setup.exe",
                "size": 7,
                "sha256": "ab".repeat(32),
                "url": "https://ups.umami-creative.app/releases/0.10.0/Unity-Project-Sync_0.10.0_x64-setup.exe",
            })
        );
    }

    // ---------- /download ----------

    #[tokio::test]
    async fn download_redirects_to_latest() {
        let tmp = tempfile::tempdir().unwrap();
        let g = get_req(app(tmp.path(), PUB), "/download").await;
        assert_eq!(g.status, StatusCode::NOT_FOUND);
        assert!(hdr(&g, "content-type").starts_with("text/html"));
        assert!(g.body.contains("No release yet"));

        write_release(tmp.path(), "0.1.0", b"x", json!({}));
        write_release(tmp.path(), "0.2.0", b"x", json!({}));
        let g = get_req(app(tmp.path(), PUB), "/download").await;
        assert_eq!(g.status, StatusCode::FOUND);
        assert_eq!(
            hdr(&g, "location"),
            "https://ups.umami-creative.app/releases/0.2.0/Unity-Project-Sync_0.2.0_x64-setup.exe"
        );
        assert_eq!(hdr(&g, "cache-control"), "no-cache");
    }

    // ---------- /releases/{version}/{file} ----------

    const FILE: &str = "/releases/0.2.0/Unity-Project-Sync_0.2.0_x64-setup.exe";

    #[tokio::test]
    async fn serves_declared_file() {
        let tmp = tempfile::tempdir().unwrap();
        write_release(tmp.path(), "0.2.0", b"0123456789", json!({}));
        let g = get_req(app(tmp.path(), None), FILE).await;
        assert_eq!(g.status, StatusCode::OK);
        assert_eq!(g.bytes, b"0123456789");
        assert_eq!(hdr(&g, "content-type"), "application/octet-stream");
        assert_eq!(hdr(&g, "content-length"), "10");
        assert_eq!(hdr(&g, "accept-ranges"), "bytes");
        assert!(hdr(&g, "cache-control").contains("immutable"));
        assert_eq!(
            hdr(&g, "content-disposition"),
            "attachment; filename=\"Unity-Project-Sync_0.2.0_x64-setup.exe\"; \
             filename*=UTF-8''Unity-Project-Sync_0.2.0_x64-setup.exe"
        );
    }

    #[tokio::test]
    async fn serves_head_and_range() {
        let tmp = tempfile::tempdir().unwrap();
        write_release(tmp.path(), "0.2.0", b"0123456789", json!({}));

        let head = Request::builder()
            .method("HEAD")
            .uri(FILE)
            .body(Body::empty())
            .unwrap();
        let g = send(app(tmp.path(), None), head).await;
        assert_eq!(g.status, StatusCode::OK);
        assert_eq!(hdr(&g, "content-length"), "10");
        assert!(g.bytes.is_empty());

        let range = Request::builder()
            .uri(FILE)
            .header("range", "bytes=2-5")
            .body(Body::empty())
            .unwrap();
        let g = send(app(tmp.path(), None), range).await;
        assert_eq!(g.status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(g.bytes, b"2345");
        assert_eq!(hdr(&g, "content-range"), "bytes 2-5/10");
        assert_eq!(hdr(&g, "content-type"), "application/octet-stream");

        let range = Request::builder()
            .uri(FILE)
            .header("range", "bytes=-3")
            .body(Body::empty())
            .unwrap();
        let g = send(app(tmp.path(), None), range).await;
        assert_eq!(g.status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(g.bytes, b"789");

        let range = Request::builder()
            .uri(FILE)
            .header("range", "bytes=50-60")
            .body(Body::empty())
            .unwrap();
        let g = send(app(tmp.path(), None), range).await;
        assert_eq!(g.status, StatusCode::RANGE_NOT_SATISFIABLE);
    }

    #[tokio::test]
    async fn serves_older_valid_releases_too() {
        let tmp = tempfile::tempdir().unwrap();
        write_release(tmp.path(), "0.1.0", b"old", json!({}));
        write_release(tmp.path(), "0.2.0", b"new", json!({}));
        let g = get_req(
            app(tmp.path(), None),
            "/releases/0.1.0/Unity-Project-Sync_0.1.0_x64-setup.exe",
        )
        .await;
        assert_eq!(g.status, StatusCode::OK);
        assert_eq!(g.bytes, b"old");
    }

    #[tokio::test]
    async fn refuses_everything_but_the_declared_file() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_release(root, "0.2.0", b"x", json!({}));
        // an extra file in the release folder and a secret next to RELEASES_DIR
        std::fs::write(root.join("0.2.0").join("other.exe"), b"o").unwrap();
        std::fs::write(root.join("secret.txt"), b"s").unwrap();
        // an incomplete release
        write_release(root, "0.3.0", b"x", json!({"size": 99}));

        for uri in [
            "/releases/0.2.0/release.json",
            "/releases/0.2.0/other.exe",
            "/releases/0.2.0/",
            "/releases/0.2.0",
            "/releases/",
            "/releases",
            "/releases/0.2.0/..%2Fsecret.txt",
            "/releases/0.2.0/%2e%2e%2fsecret.txt",
            "/releases/0.2.0/%2e%2e%5csecret.txt",
            "/releases/0.2.0/..%5csecret.txt",
            "/releases/%2e%2e/secret.txt",
            "/releases/../secret.txt",
            "/releases/0.2.0/../../secret.txt",
            "/releases/0.2.0/Unity-Project-Sync_0.2.0_x64-setup.exe/x",
            "/releases/0.2.0/unity-project-sync_0.2.0_x64-setup.exe",
            "/releases/v0.2.0/Unity-Project-Sync_0.2.0_x64-setup.exe",
            "/releases/0.3.0/Unity-Project-Sync_0.3.0_x64-setup.exe",
            "/releases/0.3.0/release.json",
            "/releases/0.2.0/%ff",
            "/secret.txt",
            "/0.2.0/release.json",
        ] {
            let g = get_req(app(root, None), uri).await;
            assert_eq!(g.status, StatusCode::NOT_FOUND, "{uri}");
            assert!(hdr(&g, "content-type").starts_with("text/html"), "{uri}");
            assert!(!g.body.contains("signature"), "{uri}");
        }
    }

    // ---------- landing page ----------

    #[tokio::test]
    async fn landing_without_releases() {
        let tmp = tempfile::tempdir().unwrap();
        let g = get_req(app(tmp.path(), PUB), "/").await;
        assert_eq!(g.status, StatusCode::OK);
        assert_eq!(hdr(&g, "cache-control"), "no-cache");
        assert!(hdr(&g, "content-security-policy").contains("default-src 'none'"));
        assert!(g.body.contains("Unity Project Sync"));
        assert!(g.body.contains("No release yet"));
        assert!(!g.body.contains("href=\"/download\""));
        assert!(!g.body.contains("Previous versions"));
        assert!(g.body.contains("https://umami-creative.de/impressum"));
        assert!(!g.body.contains("Privacy"));
        assert!(!g.body.contains("src=\"http"));
    }

    #[tokio::test]
    async fn landing_with_releases() {
        let tmp = tempfile::tempdir().unwrap();
        write_release(tmp.path(), "0.1.0", b"old", json!({}));
        write_release(
            tmp.path(),
            "0.2.0",
            &vec![0u8; 4_567_890],
            json!({"notes": "## Fixes\n\n- Faster **scan**"}),
        );
        let g = get_req(app(tmp.path(), PUB), "/").await;
        assert_eq!(g.status, StatusCode::OK);
        let b = &g.body;
        assert!(b.contains("href=\"/download\""));
        assert!(b.contains("Download for Windows"));
        assert!(b.contains("Version 0.2.0"));
        assert!(b.contains("4.4 MB"));
        assert!(b.contains("23 Nov 2026"));
        assert!(b.contains("Windows 10/11"));
        assert!(b.contains("What’s new in 0.2.0"));
        assert!(b.contains("<strong>scan</strong>"));
        assert!(b.contains(&"ab".repeat(32)));
        assert!(b.contains("Previous versions"));
        assert!(b.contains("/releases/0.1.0/Unity-Project-Sync_0.1.0_x64-setup.exe"));
        // no external requests
        assert!(!b.contains("src=\"http"));
        assert!(!b.contains("href=\"//"));
        assert!(!b.contains("fonts.googleapis"));
    }

    #[tokio::test]
    async fn landing_hides_empty_notes() {
        let tmp = tempfile::tempdir().unwrap();
        write_release(tmp.path(), "0.2.0", b"x", json!({"notes": "  \n "}));
        let g = get_req(app(tmp.path(), PUB), "/").await;
        assert!(!g.body.contains("What’s new"));
        assert!(!g.body.contains("Previous versions"));
    }

    #[tokio::test]
    async fn landing_escapes_notes_and_raw_html() {
        let tmp = tempfile::tempdir().unwrap();
        write_release(
            tmp.path(),
            "0.2.0",
            b"x",
            json!({"notes": "<script>alert(1)</script>\n\nHi <img src=x onerror=alert(2)> \
                    [click](javascript:alert(3)) ![pic](https://tracker.example/p.png) \
                    [ok](https://example.com/?a=1&b=\"2\")\n\n<div onclick=\"x\">block</div>"}),
        );
        let g = get_req(app(tmp.path(), PUB), "/").await;
        let b = &g.body;
        assert!(!b.contains("<script>alert"));
        assert!(b.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        assert!(!b.contains("<img src=x"));
        assert!(b.contains("&lt;img src=x onerror=alert(2)&gt;"));
        assert!(!b.contains("javascript:"));
        assert!(!b.contains("tracker.example"));
        assert!(b.contains("pic"));
        assert!(b.contains("href=\"https://example.com/?a=1&amp;b=%222%22\""));
        assert!(!b.contains("<div onclick"));
    }

    #[tokio::test]
    async fn landing_escapes_hostile_release_fields() {
        let tmp = tempfile::tempdir().unwrap();
        // Valid on every file system, but needs escaping in HTML and encoding in URLs.
        let file = "Setup & 'Co' #1.exe";
        write_release(tmp.path(), "0.1.0", b"x", json!({}));
        let dir = write_release(tmp.path(), "0.2.0", b"x", json!({"file": file}));
        std::fs::write(dir.join(file), b"x").unwrap();
        // Make 0.2.0 the "previous" release so its link shows up in the list.
        write_release(tmp.path(), "0.3.0", b"x", json!({}));
        let g = get_req(app(tmp.path(), PUB), "/").await;
        assert!(!g.body.contains("Setup & 'Co'"));
        assert!(
            g.body
                .contains("href=\"/releases/0.2.0/Setup%20%26%20%27Co%27%20%231.exe\""),
            "{}",
            g.body
        );
    }

    #[tokio::test]
    async fn not_found_page() {
        let tmp = tempfile::tempdir().unwrap();
        let g = get_req(app(tmp.path(), PUB), "/nope%3Cscript%3E").await;
        assert_eq!(g.status, StatusCode::NOT_FOUND);
        assert!(g.body.contains("Page not found"));
        assert!(!g.body.contains("<script>"));
        assert!(hdr(&g, "content-security-policy").contains("default-src 'none'"));
    }

    #[tokio::test]
    async fn assets_are_embedded() {
        let tmp = tempfile::tempdir().unwrap();
        for (uri, ct) in [
            ("/assets/app-icon.svg", "image/svg+xml"),
            ("/favicon.ico", "image/svg+xml"),
            ("/assets/geist-latin.woff2", "font/woff2"),
            ("/assets/geist-latin-ext.woff2", "font/woff2"),
            ("/assets/site.css", "text/css; charset=utf-8"),
            ("/assets/site.js", "text/javascript; charset=utf-8"),
            ("/assets/Geist-OFL.txt", "text/plain; charset=utf-8"),
        ] {
            let g = get_req(app(tmp.path(), PUB), uri).await;
            assert_eq!(g.status, StatusCode::OK, "{uri}");
            assert_eq!(hdr(&g, "content-type"), ct, "{uri}");
            assert!(!g.bytes.is_empty());
        }
        let g = get_req(app(tmp.path(), PUB), "/assets/nope.css").await;
        assert_eq!(g.status, StatusCode::NOT_FOUND);
        // every asset the page references exists
        write_release(tmp.path(), "0.2.0", b"x", json!({}));
        let page = get_req(app(tmp.path(), PUB), "/").await.body;
        for part in page.split("\"/assets/").skip(1) {
            let path = part.split('"').next().unwrap();
            let g = get_req(app(tmp.path(), PUB), &format!("/assets/{path}")).await;
            assert_eq!(g.status, StatusCode::OK, "{path}");
        }
    }
}
