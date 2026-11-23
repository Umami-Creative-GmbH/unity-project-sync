//! Static assets compiled into the binary. Nothing is loaded from third-party hosts.

use std::sync::OnceLock;

use axum::extract::Path;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};

use crate::util::fnv1a;

pub struct Asset {
    pub name: &'static str,
    pub content_type: &'static str,
    pub bytes: &'static [u8],
}

pub const ASSETS: &[Asset] = &[
    Asset {
        name: "site.css",
        content_type: "text/css; charset=utf-8",
        bytes: include_bytes!("../static/site.css"),
    },
    Asset {
        name: "site.js",
        content_type: "text/javascript; charset=utf-8",
        bytes: include_bytes!("../static/site.js"),
    },
    Asset {
        name: "app-icon.svg",
        content_type: "image/svg+xml",
        bytes: include_bytes!("../static/app-icon.svg"),
    },
    Asset {
        name: "geist-latin.woff2",
        content_type: "font/woff2",
        bytes: include_bytes!("../static/geist-latin-wght-normal.woff2"),
    },
    Asset {
        name: "geist-latin-ext.woff2",
        content_type: "font/woff2",
        bytes: include_bytes!("../static/geist-latin-ext-wght-normal.woff2"),
    },
    Asset {
        name: "Geist-OFL.txt",
        content_type: "text/plain; charset=utf-8",
        bytes: include_bytes!("../static/Geist-OFL.txt"),
    },
];

pub fn find(name: &str) -> Option<&'static Asset> {
    ASSETS.iter().find(|a| a.name == name)
}

/// `/assets/<name>?v=<hash of all assets>`: the query changes whenever any embedded asset
/// changes, so the HTML always references fresh CSS/JS while the files themselves can be
/// cached for a long time.
pub fn url(name: &str) -> String {
    static VERSION: OnceLock<String> = OnceLock::new();
    let v = VERSION.get_or_init(|| {
        let h = ASSETS
            .iter()
            .fold(0u64, |acc, a| acc.rotate_left(7) ^ fnv1a(a.bytes));
        format!("{:08x}", h & 0xffff_ffff)
    });
    format!("/assets/{name}?v={v}")
}

fn serve(asset: &'static Asset) -> Response {
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static(asset.content_type),
            ),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=604800"),
            ),
        ],
        asset.bytes,
    )
        .into_response()
}

pub async fn asset(Path(name): Path<String>) -> Response {
    match find(&name) {
        Some(a) => serve(a),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

pub async fn favicon() -> Response {
    serve(find("app-icon.svg").expect("icon is embedded"))
}
