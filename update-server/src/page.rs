//! Server-rendered HTML: the landing page and the 404 page.
//!
//! Every value that comes from release.json or a request is escaped with [`esc`]; release
//! notes go through [`render_markdown`], which turns raw HTML into text and drops unsafe links
//! and images (images would be third-party requests).

use std::fmt::Write;

use pulldown_cmark::{Event, HeadingLevel, LinkType, Options, Parser, Tag, TagEnd, html};

use crate::assets;
use crate::github::{RepoStats, format_count};
use crate::releases::Release;
use crate::routes::file_path;
use crate::util::{current_year, display_date, display_size, esc};

const APP_NAME: &str = "Unity Project Sync";
const TAGLINE: &str = "Mirror the non-regenerable parts of Unity projects";
const DESCRIPTION: &str = "A small Windows app that mirrors Assets, Packages and \
    ProjectSettings of a Unity project from a source to a target folder. Free download.";
/// Describes static/og-image.png (made from seo/og-image.html); keep the two in sync.
const OG_IMAGE_ALT: &str = "Unity Project Sync: mirror the parts of your Unity projects you \
    can't rebuild. Free for Windows, MIT licensed, no telemetry. Next to it, the app copying a \
    batch of projects with a live speed chart.";

pub struct PageCtx<'a> {
    /// Absolute base URL (no trailing slash), used for canonical/Open Graph URLs.
    pub base_url: String,
    pub imprint_url: Option<&'a str>,
    pub privacy_url: Option<&'a str>,
    pub github: Option<GitHubLink<'a>>,
}

pub struct GitHubLink<'a> {
    /// `owner/name`, validated by [`crate::github::valid_repo`].
    pub repo: &'a str,
    /// `None` until the counts were fetched once; the links are shown without counts then.
    pub stats: Option<RepoStats>,
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
const I_GITHUB: &str = r#"<path d="M9 19c-4.3 1.4 -4.3 -2.5 -6 -3m12 5v-3.5c0 -1 .1 -1.4 -.5 -2c2.8 -.3 5.5 -1.4 5.5 -6a4.6 4.6 0 0 0 -1.3 -3.2a4.2 4.2 0 0 0 -.1 -3.2s-1.1 -.3 -3.5 1.3a12.3 12.3 0 0 0 -6.2 0c-2.4 -1.6 -3.5 -1.3 -3.5 -1.3a4.2 4.2 0 0 0 -.1 3.2a4.6 4.6 0 0 0 -1.3 3.2c0 4.6 2.7 5.7 5.5 6c-.6 .6 -.6 1.2 -.5 2v3.5"/>"#;
const I_SUN: &str = r#"<path d="M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"/><path d="M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7"/>"#;
const I_MOON: &str =
    r#"<path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454z"/>"#;
const I_INFO: &str = r#"<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"/><path d="M12 9h.01"/><path d="M11 12h1v4h1"/>"#;
const I_LICENSE: &str = r#"<path d="M15 21h-9a3 3 0 0 1 -3 -3v-1h10v2a2 2 0 0 0 4 0v-14a2 2 0 1 1 2 2h-2m2 -4h-11a3 3 0 0 0 -3 3v11"/><path d="M9 7l4 0"/><path d="M9 11l4 0"/>"#;
const I_SHIELD_LOCK: &str = r#"<path d="M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3"/><path d="M11 11a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M12 12l0 2.5"/>"#;
const I_EYE_OFF: &str = r#"<path d="M10.585 10.587a2 2 0 0 0 2.829 2.828"/><path d="M16.681 16.673a8.717 8.717 0 0 1 -4.681 1.327c-3.6 0 -6.6 -2 -9 -6c1.272 -2.12 2.712 -3.678 4.32 -4.674m2.86 -1.146a9.055 9.055 0 0 1 1.82 -.18c3.6 0 6.6 2 9 6c-.666 1.11 -1.379 2.067 -2.138 2.87"/><path d="M3 3l18 18"/>"#;
const I_GIT_FORK: &str = r#"<path d="M10 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M5 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M15 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M7 8v2a2 2 0 0 0 2 2h6a2 2 0 0 0 2 -2v-2"/><path d="M12 12l0 4"/>"#;

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

/// Gallery below the features: (screenshot, title, text, alt text). The hero shows "transfer".
const SHOTS: [(&str, &str, &str, &str); 4] = [
    (
        "overview",
        "All projects in one list",
        "Every source and target pair with its Unity version, folder status and last sync. \
         Problems show up before you start, not halfway through.",
        "Project list with four Unity projects, their source and target folders, Unity \
         versions, last sync times and one project that needs attention",
    ),
    (
        "filelist",
        "See every file first",
        "A scan lists each file it will copy, update, verify or delete. Filter by action or \
         path, untick projects you want to skip, then start the sync.",
        "Scan preview with totals for new, changed, to verify, delete and unchanged files, and \
         the expanded file list of one project",
    ),
    (
        "editor",
        "Choose what gets mirrored",
        "Assets, Packages and ProjectSettings by default. Add folders like UserSettings; \
         Library, Temp and friends are never offered.",
        "Project editor with source and target folders, detected Unity versions and the sync \
         scope with an Add folder menu",
    ),
    (
        "report",
        "A clear report at the end",
        "Files written, items deleted, bytes and time for the whole batch and for each \
         project, so you know the backup is complete.",
        "Sync report: three projects in sync with files written, items deleted, bytes written \
         and duration",
    ),
];

const HERO_SHOT_ALT: &str = "Unity Project Sync copying a batch of three projects: a live \
    speed chart with a tooltip, transferred bytes, files, time left and the status of each \
    project";

/// A screenshot that follows the page's colour scheme. The link opens the full-size image (a
/// lightbox with JavaScript, see site.js).
fn shot(name: &str, alt: &str, lazy: bool) -> String {
    let light = esc(&assets::url(&format!("shot-{name}-light.png")));
    let dark = esc(&assets::url(&format!("shot-{name}-dark.png")));
    format!(
        r#"<a class="shot-link" href="{light}" data-lightbox><picture><source srcset="{dark}" media="(prefers-color-scheme: dark)" data-scheme="dark"><img src="{light}" width="980" height="760" alt="{alt}"{loading} decoding="async"></picture></a>"#,
        alt = esc(alt),
        loading = if lazy { r#" loading="lazy""# } else { "" },
    )
}

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

fn plural(n: u64, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
}

/// "Star" and "Fork" buttons in the GitHub style, each with its count when known. Starring
/// happens on the repository page (GitHub has no direct star URL); forking has its own page.
fn github_buttons(gh: &GitHubLink) -> String {
    let repo_url = format!("https://github.com/{}", gh.repo);
    let button = |class: &str,
                  href: &str,
                  ic: &str,
                  label: &str,
                  title: &str,
                  count: Option<(u64, String)>| {
        let (count_html, aria) = match count {
            Some((n, spoken)) => (
                format!(r#"<span class="gh-count">{}</span>"#, format_count(n)),
                format!("{title} ({spoken})"),
            ),
            None => (String::new(), title.to_string()),
        };
        format!(
            r#"<a class="btn btn-outline btn-sm gh-btn{class}" href="{href}" title="{title}" aria-label="{aria}">{icon}<span class="gh-label">{label}</span>{count_html}</a>
"#,
            href = esc(href),
            title = esc(title),
            aria = esc(&aria),
            icon = icon(ic),
        )
    };
    let mut s = button(
        "",
        &repo_url,
        I_GITHUB,
        "Star",
        &format!("Star {APP_NAME} on GitHub"),
        gh.stats
            .map(|st| (st.stars, plural(st.stars, "star", "stars"))),
    );
    s.push_str(&button(
        " gh-fork",
        &format!("{repo_url}/fork"),
        I_GIT_FORK,
        "Fork",
        &format!("Fork {APP_NAME} on GitHub"),
        gh.stats
            .map(|st| (st.forks, plural(st.forks, "fork", "forks"))),
    ));
    s
}

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
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff" data-scheme="light">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0a0a0a" data-scheme="dark">
<script src="{theme_js}"></script>
<link rel="icon" href="{favicon}" sizes="16x16 32x32 48x48">
<link rel="icon" href="{icon}" type="image/svg+xml">
<link rel="apple-touch-icon" href="{touch_icon}">
<link rel="manifest" href="{manifest}">
<link rel="canonical" href="{base}/">
<meta property="og:type" content="website">
<meta property="og:locale" content="en_US">
<meta property="og:site_name" content="{app}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{base}/">
<meta property="og:image" content="{base}{og_image}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="{og_alt}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="{base}{og_image}">
<meta name="twitter:image:alt" content="{og_alt}">
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
        favicon = esc(&assets::url("favicon.ico")),
        touch_icon = esc(&assets::url("apple-touch-icon.png")),
        manifest = esc(&assets::url("site.webmanifest")),
        og_image = esc(&assets::url("og-image.png")),
        og_alt = esc(OG_IMAGE_ALT),
        app = APP_NAME,
        css = esc(&assets::url("site.css")),
        js = esc(&assets::url("site.js")),
        theme_js = esc(&assets::url("theme.js")),
    );
    s.push_str("<div class=\"header-actions\">\n");
    if let Some(gh) = &ctx.github {
        s.push_str(&github_buttons(gh));
    }
    if header_cta {
        let _ = writeln!(
            s,
            r#"<a class="btn btn-outline btn-sm" href="/download">{}Download</a>"#,
            icon(I_DOWNLOAD)
        );
    }
    // Shown by site.js (it does nothing without JavaScript); theme.js sets the label.
    let _ = writeln!(
        s,
        r#"<button type="button" class="btn btn-outline btn-icon theme-toggle" data-theme-toggle aria-label="Switch theme" title="Switch theme" hidden><span class="icon-moon">{}</span><span class="icon-sun">{}</span></button>"#,
        icon(I_MOON),
        icon(I_SUN)
    );
    s.push_str("</div>\n</div>\n</header>\n<main id=\"main\" tabindex=\"-1\">\n");
    s.push_str(main);
    let _ = write!(
        s,
        r#"</main>
<footer class="site-footer">
<div class="container footer-inner">
<p>&copy; {year} Umami Creative GmbH</p>
<nav aria-label="Source, legal and licences">
<ul class="footer-links" role="list">
"#,
        year = current_year()
    );
    if let Some(gh) = &ctx.github {
        let _ = writeln!(
            s,
            r#"<li><a href="https://github.com/{}">Source code</a></li>"#,
            esc(gh.repo)
        );
    }
    if let Some(gh) = &ctx.github {
        let _ = writeln!(
            s,
            r#"<li><a href="https://github.com/{}/blob/main/LICENSE">MIT licence</a></li>"#,
            esc(gh.repo)
        );
    }
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
<p class="lede">A small Windows app that copies <code>Assets</code>, <code>Packages</code>, <code>ProjectSettings</code> and the project’s root files to another drive, a backup folder or a server share, removes what’s gone and leaves everything Unity can rebuild alone.</p>
<p class="scope-note">{info}<span><strong>Not a replacement for version control.</strong> It keeps no history and no older versions; the target simply mirrors the source as it is now. Keep Git, Unity Version Control or Perforce for that. This is a helper for getting projects copied fast and efficiently.</span></p>
"#,
        icon = esc(&assets::url("app-icon.svg")),
        app = APP_NAME,
        tagline = TAGLINE,
        info = icon(I_INFO),
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
    let _ = write!(
        s,
        "<figure class=\"hero-shot\">{}</figure>\n</div>\n</section>\n",
        shot("transfer", HERO_SHOT_ALT, false)
    );
    s
}

fn screenshots() -> String {
    let mut s = String::from(
        r#"<section class="section" id="screenshots" aria-labelledby="screenshots-title">
<div class="container">
<div class="section-head">
<p class="eyebrow">A closer look</p>
<h2 id="screenshots-title">From scan to report</h2>
<p class="section-lede">Light or dark, the app follows your Windows theme.</p>
</div>
<ul class="shot-grid" role="list">
"#,
    );
    for (name, title, text, alt) in SHOTS {
        let _ = write!(
            s,
            r#"<li class="card shot-card">
{}
<div class="shot-text">
<h3>{}</h3>
<p>{}</p>
</div>
</li>
"#,
            shot(name, alt, true),
            esc(title),
            esc(text)
        );
    }
    s.push_str("</ul>\n</div>\n</section>\n");
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

/// Licence and privacy promises. Keep the telemetry text in line with what the app really sends:
/// its only request is the update check (src-tauri/tauri.conf.json > plugins > updater).
fn open_and_private(ctx: &PageCtx) -> String {
    let licence = match &ctx.github {
        Some(gh) => format!(
            r#"<a href="https://github.com/{}/blob/main/LICENSE">MIT licence</a>"#,
            esc(gh.repo)
        ),
        None => "MIT licence".to_string(),
    };
    let source = match &ctx.github {
        Some(gh) => format!(
            r#" The full source code is <a href="https://github.com/{}">on GitHub</a>."#,
            esc(gh.repo)
        ),
        None => String::new(),
    };
    format!(
        r#"<section class="section" id="open" aria-labelledby="open-title">
<div class="container">
<div class="section-head">
<p class="eyebrow">Open and private</p>
<h2 id="open-title">Free software that minds its own business</h2>
</div>
<ul class="feature-grid" role="list">
<li class="card feature">
<span class="feature-icon">{i_licence}</span>
<h3>MIT licensed</h3>
<p>Free to use, change and share, at home or at work, under the {licence}.{source}</p>
</li>
<li class="card feature">
<span class="feature-icon">{i_shield}</span>
<h3>No hidden trackers</h3>
<p>No ads, no analytics, no tracking code in the app. This site sets no cookies and loads nothing from other servers.</p>
</li>
<li class="card feature">
<span class="feature-icon">{i_eye_off}</span>
<h3>No telemetry</h3>
<p>The app never reports what you sync or how you use it. Its only network request is the update check, which sends just its version and the Windows architecture.</p>
</li>
</ul>
</div>
</section>
"#,
        i_licence = icon(I_LICENSE),
        i_shield = icon(I_SHIELD_LOCK),
        i_eye_off = icon(I_EYE_OFF),
    )
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
    main.push_str(&screenshots());
    main.push_str(&open_and_private(ctx));
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

    fn ctx(stats: Option<RepoStats>) -> PageCtx<'static> {
        PageCtx {
            base_url: "https://ups.example".into(),
            imprint_url: None,
            privacy_url: None,
            github: Some(GitHubLink {
                repo: "acme/tool",
                stats,
            }),
        }
    }

    #[test]
    fn github_buttons_with_counts() {
        let h = render_landing(
            &ctx(Some(RepoStats {
                stars: 1_234,
                forks: 1,
            })),
            &[],
        );
        assert!(h.contains(r#"href="https://github.com/acme/tool""#), "{h}");
        assert!(h.contains(r#"href="https://github.com/acme/tool/fork""#));
        assert!(h.contains(r#"<span class="gh-count">1.2k</span>"#));
        assert!(h.contains(r#"<span class="gh-count">1</span>"#));
        assert!(h.contains("Star Unity Project Sync on GitHub (1234 stars)"));
        assert!(h.contains("Fork Unity Project Sync on GitHub (1 fork)"));
        assert!(h.contains(">Source code</a>"));
    }

    #[test]
    fn github_buttons_without_counts_or_repo() {
        let h = render_landing(&ctx(None), &[]);
        assert!(h.contains(r#"href="https://github.com/acme/tool/fork""#));
        assert!(!h.contains("gh-count"));
        assert!(h.contains(r#"aria-label="Star Unity Project Sync on GitHub""#));

        let mut c = ctx(None);
        c.github = None;
        let h = render_not_found(&c, None);
        assert!(!h.contains("github.com"));
        assert!(!h.contains("gh-btn"));
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
