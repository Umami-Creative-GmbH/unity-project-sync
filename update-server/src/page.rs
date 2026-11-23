//! Server-rendered HTML: the landing page and the 404 page.
//!
//! Every value that comes from release.json or a request is escaped with [`esc`]; release
//! notes go through [`render_markdown`], which turns raw HTML into text and drops unsafe links
//! and images (images would be third-party requests).

use std::fmt::Write;

use pulldown_cmark::{Event, HeadingLevel, LinkType, Options, Parser, Tag, TagEnd, html};

use crate::assets;
use crate::releases::Release;
use crate::routes::file_path;
use crate::util::{current_year, display_date, display_size, esc};

const APP_NAME: &str = "Unity Project Sync";
const TAGLINE: &str = "Mirror the non-regenerable parts of Unity projects";
const DESCRIPTION: &str = "A small Windows app that mirrors Assets, Packages and \
    ProjectSettings of a Unity project from a source to a target folder. Free download.";

pub struct PageCtx<'a> {
    /// Absolute base URL (no trailing slash), used for canonical/Open Graph URLs.
    pub base_url: String,
    pub imprint_url: Option<&'a str>,
    pub privacy_url: Option<&'a str>,
}

pub enum NotFound {
    NoRelease,
}

// ---------------------------------------------------------------------------------------------
// Icons (Tabler Icons, MIT, outline style - the icon set the app uses)
// ---------------------------------------------------------------------------------------------

fn icon(paths: &str) -> String {
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">{paths}</svg>"#
    )
}

const I_WINDOWS: &str = r#"<path d="M17.8 20l-12 -1.5c-1 -.1 -1.8 -.9 -1.8 -1.9v-9.2c0 -1 .8 -1.8 1.8 -1.9l12 -1.5c1.2 -.1 2.2 .8 2.2 1.9v12.1c0 1.2 -1.1 2.1 -2.2 1.9z"/><path d="M12 5l0 14"/><path d="M4 12l16 0"/>"#;
const I_DOWNLOAD: &str = r#"<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/>"#;
const I_USER_CHECK: &str = r#"<path d="M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0"/><path d="M6 21v-2a4 4 0 0 1 4 -4h4"/><path d="M15 19l2 2l4 -4"/>"#;
const I_FOLDERS: &str = r#"<path d="M9 3h3l2 2h5a2 2 0 0 1 2 2v7a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-9a2 2 0 0 1 2 -2"/><path d="M17 16v2a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-9a2 2 0 0 1 2 -2h2"/>"#;
const I_ZOOM_CHECK: &str = r#"<path d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M21 21l-6 -6"/><path d="M7 10l2 2l4 -4"/>"#;
const I_SHIELD_CHECK: &str = r#"<path d="M11.46 20.846a12 12 0 0 1 -7.96 -14.846a12 12 0 0 0 8.5 -3a12 12 0 0 0 8.5 3a12 12 0 0 1 -.09 7.06"/><path d="M15 19l2 2l4 -4"/>"#;
const I_STACK: &str =
    r#"<path d="M12 4l-8 4l8 4l8 -4l-8 -4"/><path d="M4 12l8 4l8 -4"/><path d="M4 16l8 4l8 -4"/>"#;
const I_CHART: &str = r#"<path d="M4 19l16 0"/><path d="M4 15l4 -6l4 2l4 -5l4 4"/>"#;
const I_POWER: &str = r#"<path d="M7 6a7.75 7.75 0 1 0 10 0"/><path d="M12 4l0 8"/>"#;
const I_COPY: &str = r#"<path d="M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667z"/><path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1"/>"#;
const I_CHECK: &str = r#"<path d="M5 12l5 5l10 -10"/>"#;
const I_CHEVRON_DOWN: &str = r#"<path d="M6 9l6 6l6 -6"/>"#;
const I_FINGERPRINT: &str = r#"<path d="M18.9 7a8 8 0 0 1 1.1 5v1a6 6 0 0 0 .8 3"/><path d="M8 11a4 4 0 0 1 8 0v1a10 10 0 0 0 2 6"/><path d="M12 11v2a14 14 0 0 0 2.5 8"/><path d="M8 15a18 18 0 0 0 1.8 6"/><path d="M4.9 19a22 22 0 0 1 -.9 -7v-1a8 8 0 0 1 12 -6.95"/>"#;
const I_ARROW_LEFT: &str = r#"<path d="M5 12l14 0"/><path d="M5 12l6 6"/><path d="M5 12l6 -6"/>"#;

const FEATURES: [(&str, &str, &str); 6] = [
    (
        I_FOLDERS,
        "The source is the truth",
        "The target ends up identical to the source. Files that are gone are removed, but only \
         inside the sync scope. Library, Temp, Logs and .git are never touched.",
    ),
    (
        I_ZOOM_CHECK,
        "Smart change detection",
        "Size and timestamps decide first, contents are compared only when needed. Identical \
         files just get their timestamp fixed, so the next scan is fast.",
    ),
    (
        I_SHIELD_CHECK,
        "Safe writes, cancel anytime",
        "Every file lands in a temporary file first and is then renamed into place. Cancel \
         whenever you like, even in the middle of a large file.",
    ),
    (
        I_STACK,
        "Projects and batch sync",
        "Save your source and target pairs once. Scan several projects in one go, review one \
         combined preview, confirm deletions, then sync.",
    ),
    (
        I_CHART,
        "Live transfer chart",
        "A Windows-style speed chart doubles as the progress bar, with current and average \
         speed, files, bytes and the time left.",
    ),
    (
        I_POWER,
        "Shut down when done",
        "Start a long sync and walk away. The PC only shuts down if every project synced \
         cleanly, after a 60-second countdown you can still cancel.",
    ),
];

// ---------------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------------

fn is_safe_link(url: &str) -> bool {
    let l = url.trim().to_ascii_lowercase();
    l.starts_with("https://")
        || l.starts_with("http://")
        || l.starts_with("mailto:")
        || l.starts_with('#')
        || (l.starts_with('/') && !l.starts_with("//"))
}

/// Notes headings start at h3 (the notes sit under an h2). `#` and `##` both become h3, so
/// the usual "## Fixes" style does not skip a level.
fn shift_heading(level: HeadingLevel) -> HeadingLevel {
    match level {
        HeadingLevel::H1 | HeadingLevel::H2 => HeadingLevel::H3,
        HeadingLevel::H3 => HeadingLevel::H4,
        HeadingLevel::H4 => HeadingLevel::H5,
        _ => HeadingLevel::H6,
    }
}

/// Markdown to HTML for release notes. Raw HTML is rendered as escaped text, images are
/// reduced to their alt text, and links other than http(s)/mailto/relative become plain text.
pub fn render_markdown(md: &str) -> String {
    let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let mut unsafe_link_open = false;
    let events = Parser::new_ext(md, opts).filter_map(|ev| match ev {
        Event::Html(s) | Event::InlineHtml(s) => Some(Event::Text(s)),
        Event::Start(Tag::HtmlBlock) => Some(Event::Start(Tag::Paragraph)),
        Event::End(TagEnd::HtmlBlock) => Some(Event::End(TagEnd::Paragraph)),
        Event::Start(Tag::Image { .. }) | Event::End(TagEnd::Image) => None,
        Event::Start(Tag::Link {
            link_type,
            dest_url,
            title,
            id,
        }) => {
            // Email autolinks carry the bare address; push_html adds "mailto:" itself.
            if link_type == LinkType::Email || is_safe_link(&dest_url) {
                unsafe_link_open = false;
                Some(Event::Start(Tag::Link {
                    link_type,
                    dest_url,
                    title,
                    id,
                }))
            } else {
                unsafe_link_open = true;
                None
            }
        }
        Event::End(TagEnd::Link) if unsafe_link_open => {
            unsafe_link_open = false;
            None
        }
        Event::Start(Tag::Heading {
            level,
            id,
            classes,
            attrs,
        }) => Some(Event::Start(Tag::Heading {
            level: shift_heading(level),
            id,
            classes,
            attrs,
        })),
        Event::End(TagEnd::Heading(level)) => {
            Some(Event::End(TagEnd::Heading(shift_heading(level))))
        }
        other => Some(other),
    });
    let mut out = String::new();
    html::push_html(&mut out, events);
    out
}

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

fn layout(ctx: &PageCtx, title: &str, header_cta: bool, main: &str) -> String {
    let icon_url = assets::url("app-icon.svg");
    let base = esc(&ctx.base_url);
    let mut s = String::with_capacity(main.len() + 4096);
    let _ = write!(
        s,
        r##"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0a0a0a">
<link rel="icon" href="{icon}" type="image/svg+xml">
<link rel="canonical" href="{base}/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="{app}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{base}/">
<link rel="preload" href="/assets/geist-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="{css}">
<script src="{js}" defer></script>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<div class="page">
<header class="site-header">
<div class="container header-inner">
<a class="brand" href="/"><img src="{icon}" alt="" width="28" height="28"><span>{app}</span></a>
"##,
        title = esc(title),
        desc = esc(DESCRIPTION),
        icon = esc(&icon_url),
        app = APP_NAME,
        css = esc(&assets::url("site.css")),
        js = esc(&assets::url("site.js")),
    );
    if header_cta {
        let _ = writeln!(
            s,
            r#"<a class="btn btn-outline btn-sm" href="/download">{}Download</a>"#,
            icon(I_DOWNLOAD)
        );
    }
    s.push_str("</div>\n</header>\n<main id=\"main\" tabindex=\"-1\">\n");
    s.push_str(main);
    let _ = write!(
        s,
        r#"</main>
<footer class="site-footer">
<div class="container footer-inner">
<p>&copy; {year} Umami Creative GmbH</p>
<nav aria-label="Legal and licences">
<ul class="footer-links" role="list">
"#,
        year = current_year()
    );
    if let Some(u) = ctx.imprint_url {
        let _ = writeln!(s, r#"<li><a href="{}">Imprint</a></li>"#, esc(u));
    }
    if let Some(u) = ctx.privacy_url {
        let _ = writeln!(s, r#"<li><a href="{}">Privacy</a></li>"#, esc(u));
    }
    s.push_str(
        r#"<li><a href="/assets/Geist-OFL.txt">Font licence</a></li>
</ul>
</nav>
</div>
</footer>
</div>
</body>
</html>
"#,
    );
    s
}

// ---------------------------------------------------------------------------------------------
// Landing page
// ---------------------------------------------------------------------------------------------

fn meta_items(r: &Release) -> String {
    let mut s = String::new();
    let _ = write!(s, "<li>Version {}</li>", esc(&r.version_str));
    let _ = write!(s, "<li>{}</li>", display_size(r.size));
    if let Some(d) = &r.pub_date {
        let _ = write!(
            s,
            r#"<li><time datetime="{}">{}</time></li>"#,
            esc(d),
            esc(&display_date(d))
        );
    }
    s.push_str("<li>Windows 10/11 · x64</li>");
    s
}

fn hero(latest: Option<&Release>) -> String {
    let mut s = String::new();
    let _ = write!(
        s,
        r#"<section class="hero" aria-labelledby="hero-title">
<div class="container hero-inner">
<img class="hero-icon" src="{icon}" alt="" width="104" height="104">
<h1 id="hero-title">{app}</h1>
<p class="tagline">{tagline}</p>
<p class="lede">A small Windows app that copies <code>Assets</code>, <code>Packages</code>, <code>ProjectSettings</code> and the project’s root files from a source to a target folder, removes what’s gone and leaves everything Unity can rebuild alone.</p>
"#,
        icon = esc(&assets::url("app-icon.svg")),
        app = APP_NAME,
        tagline = TAGLINE,
    );
    match latest {
        Some(r) => {
            let _ = write!(
                s,
                r#"<div class="cta">
<a class="btn btn-primary btn-lg" href="/download">{win}Download for Windows</a>
<ul class="meta" role="list" aria-label="Download details">{meta}</ul>
<p class="note">{user}No admin rights needed. Updates install from inside the app.</p>
</div>
"#,
                win = icon(I_WINDOWS),
                meta = meta_items(r),
                user = icon(I_USER_CHECK),
            );
        }
        None => {
            s.push_str(
                r#"<div class="cta">
<div class="empty" role="status">
<p class="empty-title">No release yet</p>
<p>The first version is on its way. Check back soon.</p>
</div>
</div>
"#,
            );
        }
    }
    s.push_str("</div>\n</section>\n");
    s
}

fn whats_new(r: &Release) -> String {
    if r.notes.trim().is_empty() {
        return String::new();
    }
    let date = r
        .pub_date
        .as_ref()
        .map(|d| {
            format!(
                r#"<time class="notes-date" datetime="{}">{}</time>"#,
                esc(d),
                esc(&display_date(d))
            )
        })
        .unwrap_or_default();
    format!(
        r#"<section class="section section-tight" id="whats-new" aria-labelledby="whats-new-title">
<div class="container">
<article class="card notes-card">
<header class="notes-header">
<h2 id="whats-new-title">What’s new in {version}</h2>
<span class="badge badge-success">Latest</span>
{date}
</header>
<div class="prose">
{notes}</div>
</article>
</div>
</section>
"#,
        version = esc(&r.version_str),
        notes = render_markdown(&r.notes),
    )
}

fn features() -> String {
    let mut s = String::from(
        r#"<section class="section" id="features" aria-labelledby="features-title">
<div class="container">
<div class="section-head">
<p class="eyebrow">Why it exists</p>
<h2 id="features-title">Copy what matters, skip what Unity rebuilds</h2>
<p class="section-lede">Library folders are huge and regenerate on their own. Unity Project Sync moves only the parts you can’t get back, and does it carefully.</p>
</div>
<ul class="feature-grid" role="list">
"#,
    );
    for (paths, title, text) in FEATURES {
        let _ = write!(
            s,
            r#"<li class="card feature">
<span class="feature-icon">{}</span>
<h3>{}</h3>
<p>{}</p>
</li>
"#,
            icon(paths),
            esc(title),
            esc(text)
        );
    }
    s.push_str("</ul>\n</div>\n</section>\n");
    s
}

fn install(latest: Option<&Release>) -> String {
    let file_hint = match latest {
        Some(r) => format!("Use the button above to get <code>{}</code>.", esc(&r.file)),
        None => "Use the download button once the first version is published.".to_string(),
    };
    let verify = latest.and_then(|r| r.sha256.as_ref().map(|h| (r, h)));
    let mut s = String::new();
    let _ = write!(
        s,
        r#"<section class="section" id="install" aria-labelledby="install-title">
<div class="container">
<div class="section-head">
<p class="eyebrow">Get started</p>
<h2 id="install-title">Installing</h2>
</div>
<div class="install-grid{grid_class}">
<ol class="card steps" role="list">
<li><span class="step-num" aria-hidden="true">1</span><div><h3>Download the setup</h3><p>{file_hint}</p></div></li>
<li><span class="step-num" aria-hidden="true">2</span><div><h3>Run it</h3><p>It installs for your Windows user into <code>%LOCALAPPDATA%</code>, with a Start menu entry and an uninstaller. No admin rights needed.</p></div></li>
<li><span class="step-num" aria-hidden="true">3</span><div><h3>Get past SmartScreen</h3><p>The installer isn’t code-signed, so Windows may show “Windows protected your PC”. Click <strong>More info</strong>, then <strong>Run anyway</strong>.</p></div></li>
<li><span class="step-num" aria-hidden="true">4</span><div><h3>Updates come to you</h3><p>When a new version is out, the app offers it and installs it for you. Your projects and settings are kept.</p></div></li>
</ol>
"#,
        grid_class = if verify.is_some() { " has-verify" } else { "" },
    );
    if let Some((r, hash)) = verify {
        let _ = write!(
            s,
            r#"<aside class="card verify" aria-labelledby="verify-title">
<h3 id="verify-title">{fp}Verify the download</h3>
<p>SHA-256 of <code>{file}</code></p>
<div class="hash-row">
<code class="hash" id="sha256">{hash}</code>
<button type="button" class="btn btn-ghost btn-icon copy-btn" data-copy="sha256" aria-label="Copy SHA-256 checksum" title="Copy" hidden><span class="icon-copy">{copy}</span><span class="icon-check">{check}</span></button>
</div>
<p class="small">In PowerShell: <code>Get-FileHash .\{file}</code></p>
<p class="sr-only" id="copy-status" aria-live="polite"></p>
</aside>
"#,
            fp = icon(I_FINGERPRINT),
            file = esc(&r.file),
            hash = esc(hash),
            copy = icon(I_COPY),
            check = icon(I_CHECK),
        );
    }
    s.push_str("</div>\n</div>\n</section>\n");
    s
}

fn previous_versions(older: &[Release]) -> String {
    if older.is_empty() {
        return String::new();
    }
    let count = if older.len() == 1 {
        "1 older release".to_string()
    } else {
        format!("{} older releases", older.len())
    };
    let mut s = String::new();
    let _ = write!(
        s,
        r#"<section class="section section-tight" id="previous" aria-label="Previous versions">
<div class="container">
<details class="card disclosure">
<summary><h2 class="disclosure-title">Previous versions</h2><span class="count">{count}</span><span class="chevron">{chev}</span></summary>
<ul class="version-list" role="list">
"#,
        chev = icon(I_CHEVRON_DOWN),
    );
    for r in older {
        let date = r
            .pub_date
            .as_ref()
            .map(|d| {
                format!(
                    r#"<time datetime="{}">{}</time>"#,
                    esc(d),
                    esc(&display_date(d))
                )
            })
            .unwrap_or_default();
        let _ = writeln!(
            s,
            r#"<li><span class="v">{v}</span><span class="vmeta">{date}<span>{size}</span></span><a class="btn btn-outline btn-sm" href="{href}">{dl}Download<span class="sr-only"> version {v}</span></a></li>"#,
            v = esc(&r.version_str),
            size = display_size(r.size),
            href = esc(&file_path(r)),
            dl = icon(I_DOWNLOAD),
        );
    }
    s.push_str("</ul>\n</details>\n</div>\n</section>\n");
    s
}

/// `releases` must be sorted newest first (as returned by `releases::scan`).
pub fn render_landing(ctx: &PageCtx, releases: &[Release]) -> String {
    let latest = releases.first();
    let mut main = hero(latest);
    if let Some(r) = latest {
        main.push_str(&whats_new(r));
    }
    main.push_str(&features());
    main.push_str(&install(latest));
    if releases.len() > 1 {
        main.push_str(&previous_versions(&releases[1..]));
    }
    let title = format!("{APP_NAME} – {TAGLINE}");
    layout(ctx, &title, latest.is_some(), &main)
}

// ---------------------------------------------------------------------------------------------
// 404
// ---------------------------------------------------------------------------------------------

pub fn render_not_found(ctx: &PageCtx, kind: Option<NotFound>) -> String {
    let (code, title, text) = match kind {
        Some(NotFound::NoRelease) => (
            "Soon",
            "No release yet",
            "There is no version to download yet. The first one is on its way, check back soon.",
        ),
        None => (
            "404",
            "Page not found",
            "This page doesn’t exist or has moved. The download is on the start page.",
        ),
    };
    let main = format!(
        r#"<section class="hero hero-compact" aria-labelledby="hero-title">
<div class="container hero-inner">
<p class="big-code" aria-hidden="true">{code}</p>
<h1 id="hero-title">{title}</h1>
<p class="tagline">{text}</p>
<div class="cta"><a class="btn btn-primary btn-lg" href="/">{back}Back to the start page</a></div>
</div>
</section>
"#,
        back = icon(I_ARROW_LEFT),
    );
    layout(ctx, &format!("{title} – {APP_NAME}"), false, &main)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_basics() {
        let h = render_markdown(
            "# Title\n\n- **bold** and `code`\n- ~~old~~\n\n| a | b |\n|---|---|\n| 1 | 2 |",
        );
        assert!(h.contains("<h3>Title</h3>"), "{h}");
        assert!(h.contains("<strong>bold</strong>"));
        assert!(h.contains("<code>code</code>"));
        assert!(h.contains("<del>old</del>"));
        assert!(h.contains("<table>"));
    }

    #[test]
    fn markdown_raw_html_is_text() {
        let h = render_markdown(
            "<b>x</b> <iframe src=\"https://evil\"></iframe>\n\n<div>\nblock\n</div>",
        );
        assert!(!h.contains("<b>"));
        assert!(!h.contains("<iframe"));
        assert!(!h.contains("<div>"));
        assert!(h.contains("&lt;b&gt;x&lt;/b&gt;"));
        assert!(h.contains("&lt;div&gt;"));
    }

    #[test]
    fn markdown_links_and_images() {
        let h = render_markdown(
            "[a](javascript:alert(1)) [b](JaVaScRiPt:x) [c](data:text/html,x) [d](//evil.example) \
             [e](https://ok.example) [f](/releases) [g](#x) ![img](https://img.example/x.png)",
        );
        assert!(!h.to_ascii_lowercase().contains("javascript"));
        assert!(!h.contains("data:"));
        assert!(!h.contains("evil.example"));
        assert!(!h.contains("img.example"));
        assert!(!h.contains("<img"));
        assert!(h.contains(r#"<a href="https://ok.example">e</a>"#));
        assert!(h.contains(r#"<a href="/releases">f</a>"#));
        assert!(h.contains(r##"<a href="#x">g</a>"##));
        for t in ["a", "b", "c", "d", "img"] {
            assert!(h.contains(t));
        }
    }

    #[test]
    fn markdown_headings_start_at_h3_without_gaps() {
        let h = render_markdown("## Fixes\n\n### Details\n\n#### Deep");
        assert!(h.contains("<h3>Fixes</h3>"), "{h}");
        assert!(h.contains("<h4>Details</h4>"), "{h}");
        assert!(h.contains("<h5>Deep</h5>"), "{h}");
    }

    #[test]
    fn markdown_email_autolink_keeps_its_link() {
        let h = render_markdown("Mail <support@example.com> now");
        assert!(
            h.contains(r#"<a href="mailto:support@example.com">support@example.com</a>"#),
            "{h}"
        );
    }
}
