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

/// App screenshots from `static/screenshots/` (made with `pnpm demo`, see the root README), served
/// as `/assets/shot-<name>-<theme>.png`. The folder holds a few more that only the README uses.
macro_rules! screenshot {
    ($name:literal, $theme:literal) => {
        Asset {
            name: concat!("shot-", $name, "-", $theme, ".png"),
            content_type: "image/png",
            bytes: include_bytes!(concat!(
                "../static/screenshots/",
                $name,
                "-",
                $theme,
                ".png"
            )),
        }
    };
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
        name: "theme.js",
        content_type: "text/javascript; charset=utf-8",
        bytes: include_bytes!("../static/theme.js"),
    },
    Asset {
        name: "app-icon.svg",
        content_type: "image/svg+xml",
        bytes: include_bytes!("../static/app-icon.svg"),
    },
    // Social card and icons, rendered from app-icon.svg and seo/og-image.html by
    // `node seo/render.mjs` (see README.md).
    Asset {
        name: "og-image.png",
        content_type: "image/png",
        bytes: include_bytes!("../static/og-image.png"),
    },
    Asset {
        name: "apple-touch-icon.png",
        content_type: "image/png",
        bytes: include_bytes!("../static/apple-touch-icon.png"),
    },
    Asset {
        name: "icon-192.png",
        content_type: "image/png",
        bytes: include_bytes!("../static/icon-192.png"),
    },
    Asset {
        name: "icon-512.png",
        content_type: "image/png",
        bytes: include_bytes!("../static/icon-512.png"),
    },
    Asset {
        name: "icon-maskable-512.png",
        content_type: "image/png",
        bytes: include_bytes!("../static/icon-maskable-512.png"),
    },
    Asset {
        name: "favicon.ico",
        content_type: "image/x-icon",
        bytes: include_bytes!("../static/favicon.ico"),
    },
    Asset {
        name: "site.webmanifest",
        content_type: "application/manifest+json",
        bytes: include_bytes!("../static/site.webmanifest"),
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
    screenshot!("overview", "light"),
    screenshot!("overview", "dark"),
    screenshot!("filelist", "light"),
    screenshot!("filelist", "dark"),
    screenshot!("transfer", "light"),
    screenshot!("transfer", "dark"),
    screenshot!("report", "light"),
    screenshot!("report", "dark"),
    screenshot!("editor", "light"),
    screenshot!("editor", "dark"),
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

/// Root-level files that clients request without reading the page (old browsers ask for
/// `/favicon.ico`, iOS for `/apple-touch-icon.png` and its `-precomposed` twin).
pub async fn favicon() -> Response {
    serve(find("favicon.ico").expect("favicon is embedded"))
}

pub async fn apple_touch_icon() -> Response {
    serve(find("apple-touch-icon.png").expect("touch icon is embedded"))
}
