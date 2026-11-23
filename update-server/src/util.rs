//! Small helpers: HTML escaping, timestamps/dates without a time crate, logging, URL encoding.

use std::time::{SystemTime, UNIX_EPOCH};

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};

/// Everything except the RFC 3986 "unreserved" characters is encoded, so a value is always
/// safe as a single path segment (no '/', '?', '#', '%', spaces, quotes, ...).
const PATH_SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

pub fn encode_segment(s: &str) -> String {
    utf8_percent_encode(s, PATH_SEGMENT).to_string()
}

/// Escapes text for HTML element content and double- or single-quoted attribute values.
pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// Days since 1970-01-01 to (year, month, day) in the proleptic Gregorian calendar
/// (Howard Hinnant's civil_from_days).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Current UTC time as RFC 3339 (second precision), used for log lines.
pub fn timestamp() -> String {
    let secs = now_secs();
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

pub fn current_year() -> i64 {
    civil_from_days(now_secs().div_euclid(86_400)).0
}

#[macro_export]
macro_rules! info {
    ($($arg:tt)*) => {
        println!("{} INFO  {}", $crate::util::timestamp(), format_args!($($arg)*))
    };
}

#[macro_export]
macro_rules! warn {
    ($($arg:tt)*) => {
        eprintln!("{} WARN  {}", $crate::util::timestamp(), format_args!($($arg)*))
    };
}

fn digits(b: &[u8]) -> bool {
    !b.is_empty() && b.iter().all(u8::is_ascii_digit)
}

fn num(b: &[u8]) -> u32 {
    b.iter().fold(0, |acc, c| acc * 10 + u32::from(c - b'0'))
}

fn days_in_month(y: u32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (y.is_multiple_of(4) && !y.is_multiple_of(100)) || y.is_multiple_of(400) => 29,
        2 => 28,
        _ => 0,
    }
}

/// Strict RFC 3339 `date-time` check (`YYYY-MM-DDTHH:MM:SS[.frac](Z|+HH:MM|-HH:MM)`).
/// The Tauri updater rejects the whole response when `pub_date` is not RFC 3339, so the
/// server only forwards dates that pass this check.
pub fn is_rfc3339(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 20 {
        return false;
    }
    let ok_shape = digits(&b[0..4])
        && b[4] == b'-'
        && digits(&b[5..7])
        && b[7] == b'-'
        && digits(&b[8..10])
        && matches!(b[10], b'T' | b't')
        && digits(&b[11..13])
        && b[13] == b':'
        && digits(&b[14..16])
        && b[16] == b':'
        && digits(&b[17..19]);
    if !ok_shape {
        return false;
    }
    let (y, mo, d) = (num(&b[0..4]), num(&b[5..7]), num(&b[8..10]));
    let (h, mi, sec) = (num(&b[11..13]), num(&b[14..16]), num(&b[17..19]));
    if !(1..=12).contains(&mo)
        || d == 0
        || d > days_in_month(y, mo)
        || h > 23
        || mi > 59
        // RFC 3339 allows second 60 (leap second), but the Tauri client's parser only accepts
        // it at the end of a UTC month and then rejects the whole response. Never needed here.
        || sec > 59
    {
        return false;
    }
    let mut rest = &b[19..];
    if rest.first() == Some(&b'.') {
        let n = rest[1..].iter().take_while(|c| c.is_ascii_digit()).count();
        if n == 0 {
            return false;
        }
        rest = &rest[1 + n..];
    }
    match rest {
        [b'Z' | b'z'] => true,
        [b'+' | b'-', h1, h2, b':', m1, m2] => {
            let (oh, om) = ([*h1, *h2], [*m1, *m2]);
            digits(&oh) && digits(&om) && num(&oh) <= 23 && num(&om) <= 59
        }
        _ => false,
    }
}

/// "2026-11-23T14:05:00Z" -> "23 Nov 2026". Expects a string that passed [`is_rfc3339`].
pub fn display_date(rfc3339: &str) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let b = rfc3339.as_bytes();
    if b.len() < 10 {
        return rfc3339.to_string();
    }
    let (y, m, d) = (num(&b[0..4]), num(&b[5..7]), num(&b[8..10]));
    let month = MONTHS
        .get((m as usize).wrapping_sub(1))
        .copied()
        .unwrap_or("?");
    format!("{d} {month} {y}")
}

/// Bytes as Windows Explorer would show them ("4.4 MB", binary units).
pub fn display_size(bytes: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    let mb = bytes as f64 / MB;
    if bytes < 1024 * 1024 {
        format!("{:.0} KB", (bytes as f64 / 1024.0).ceil())
    } else if mb < 100.0 {
        format!("{mb:.1} MB")
    } else {
        format!("{mb:.0} MB")
    }
}

/// Cheap stable hash (FNV-1a) used for cache-busting asset URLs.
pub fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, b| {
        (h ^ u64::from(*b)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_html() {
        assert_eq!(
            esc(r#"<a href="x">'&'</a>"#),
            "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;"
        );
    }

    #[test]
    fn encodes_segments() {
        assert_eq!(encode_segment("0.2.0"), "0.2.0");
        assert_eq!(encode_segment("1.0.0+build.5"), "1.0.0%2Bbuild.5");
        assert_eq!(encode_segment("My App 1.exe"), "My%20App%201.exe");
        assert_eq!(encode_segment("a/b?c#d%"), "a%2Fb%3Fc%23d%25");
        assert_eq!(encode_segment("Über.exe"), "%C3%9Cber.exe");
    }

    #[test]
    fn civil_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_415), (2025, 11, 23));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
    }

    #[test]
    fn rfc3339() {
        for ok in [
            "2026-11-23T14:05:00Z",
            "2026-11-23t14:05:00z",
            "2026-11-23T14:05:00.123Z",
            "2026-11-23T14:05:00+01:00",
            "2024-02-29T00:00:00-05:30",
        ] {
            assert!(is_rfc3339(ok), "{ok}");
        }
        for bad in [
            "",
            "2026-11-23",
            "2026-11-23 14:05:00Z",
            "2026-11-23T14:05:00",
            "2026-13-01T00:00:00Z",
            "2025-02-29T00:00:00Z",
            "2026-11-23T24:00:00Z",
            "2026-11-23T14:05:60Z",
            "2026-12-31T23:59:60Z",
            "2026-11-23T14:05:00.Z",
            "2026-11-23T14:05:00+0100",
            "23.11.2026",
        ] {
            assert!(!is_rfc3339(bad), "{bad}");
        }
    }

    #[test]
    fn formats() {
        assert_eq!(display_date("2026-11-23T14:05:00Z"), "23 Nov 2026");
        assert_eq!(display_date("2026-01-05T00:00:00Z"), "5 Jan 2026");
        assert_eq!(display_size(4_567_890), "4.4 MB");
        assert_eq!(display_size(500), "1 KB");
        assert_eq!(display_size(150 * 1024 * 1024), "150 MB");
    }
}
