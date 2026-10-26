//! Hand-written parser/stamper for the YAML front-matter subset velo understands (spec §2).
//! Pure functions, no I/O. Block rule (mirrored in src/frontmatter.ts): line 1 is exactly `---`,
//! closed by the next line that is exactly `---` within the first 200 lines; CRLF tolerated.
use chrono::{DateTime, FixedOffset, Local, NaiveDate, NaiveDateTime};

const MAX_LINES: usize = 200;

#[derive(Debug, Clone, PartialEq)]
pub struct FrontMatter {
    /// Byte offset just past the closing `---` line, including its newline.
    pub end: usize,
    pub created: Option<DateTime<FixedOffset>>,
    pub modified: Option<DateTime<FixedOffset>>,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
}

/// (start of the closing line, end of the block) when `text` opens with a closed block.
fn block(text: &str) -> Option<(usize, usize)> {
    let mut pos = 0;
    for (i, raw) in text.split_inclusive('\n').enumerate() {
        if i >= MAX_LINES { return None; }
        let line = raw.strip_suffix('\n').unwrap_or(raw);
        let line = line.strip_suffix('\r').unwrap_or(line);
        if i == 0 && line != "---" { return None; }
        if i > 0 && line == "---" { return Some((pos, pos + raw.len())); }
        pos += raw.len();
    }
    None
}

fn unquote(v: &str) -> &str {
    let v = v.trim();
    for q in ['"', '\''] {
        if let Some(s) = v.strip_prefix(q).and_then(|s| s.strip_suffix(q)) { return s; }
    }
    v
}

fn lines(s: &str) -> impl Iterator<Item = &str> {
    s.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l))
}

/// First top-level `key:` value: the text after the colon, if the key exists.
fn value<'a>(inner: &'a str, key: &str) -> Option<&'a str> {
    lines(inner).find_map(|l| l.strip_prefix(key)?.strip_prefix(':'))
}

/// Flow list, scalar or block list under the first `key:`.
fn list(inner: &str, key: &str) -> Vec<String> {
    let Some(v) = value(inner, key) else { return vec![] };
    let v = v.trim();
    let items: Vec<&str> = if let Some(f) = v.strip_prefix('[') {
        f.split(']').next().unwrap_or("").split(',').collect()
    } else if !v.is_empty() {
        vec![v]
    } else {
        let mut it = lines(inner).skip_while(|l| l.strip_prefix(key).and_then(|r| r.strip_prefix(':')).is_none()).skip(1);
        let mut out = vec![];
        while let Some(l) = it.next() {
            match l.trim_start().strip_prefix('-') { Some(x) if l.starts_with([' ', '-']) => out.push(x), _ => break }
        }
        out
    };
    items.into_iter().map(|s| unquote(s).to_string()).filter(|s| !s.is_empty()).collect()
}

pub fn parse(text: &str) -> Option<FrontMatter> {
    let (close, end) = block(text)?;
    let first = text.find('\n')? + 1;
    let inner = &text[first..close];
    let date = |k| value(inner, k).and_then(parse_date);
    Some(FrontMatter { end, created: date("created"), modified: date("modified"), tags: list(inner, "tags"), aliases: list(inner, "aliases") })
}

/// Text after the block, or the whole text.
pub fn body(text: &str) -> &str {
    block(text).map_or(text, |(_, end)| &text[end..])
}

pub fn parse_date(v: &str) -> Option<DateTime<FixedOffset>> {
    let v = unquote(v);
    if let Ok(d) = DateTime::parse_from_rfc3339(v) { return Some(d); }
    let naive = NaiveDate::parse_from_str(v, "%Y-%m-%d").ok().and_then(|d| d.and_hms_opt(0, 0, 0))
        .or_else(|| NaiveDateTime::parse_from_str(v, "%Y-%m-%d %H:%M:%S").ok())
        .or_else(|| NaiveDateTime::parse_from_str(v, "%Y-%m-%d %H:%M").ok())?;
    // Earliest for ambiguous (DST fall-back) times; None inside a spring-forward gap.
    naive.and_local_timezone(Local).earliest().map(|d| d.fixed_offset())
}

pub fn format(dt: DateTime<FixedOffset>) -> String {
    dt.format("%Y-%m-%dT%H:%M:%S%:z").to_string()
}

pub fn stamp(text: &str, now: DateTime<FixedOffset>, created_fallback: DateTime<FixedOffset>) -> String {
    let (now, created) = (format(now), format(created_fallback));
    let Some((close, _)) = block(text) else {
        return format!("---\ncreated: {created}\nmodified: {now}\n---\n{text}");
    };
    let first = text.find('\n').map_or(0, |i| i + 1);
    let nl = if text[..first].ends_with("\r\n") { "\r\n" } else { "\n" };
    let (mut has_c, mut has_m) = (false, false);
    let mut out = String::with_capacity(text.len() + 64);
    out.push_str(&text[..first]);
    for raw in text[first..close].split_inclusive('\n') {
        let (line, eol) = match raw.strip_suffix("\r\n") { Some(l) => (l, "\r\n"), None => match raw.strip_suffix('\n') { Some(l) => (l, "\n"), None => (raw, "") } };
        if line.starts_with("modified:") && !has_m {
            has_m = true;
            out.push_str(&format!("modified: {now}{eol}"));
        } else if let Some(v) = line.strip_prefix("created:").filter(|_| !has_c) {
            has_c = true;
            if v.trim().is_empty() { out.push_str(&format!("created: {created}{eol}")); } else { out.push_str(raw); }
        } else {
            out.push_str(raw);
        }
    }
    if !has_c { out.push_str(&format!("created: {created}{nl}")); }
    if !has_m { out.push_str(&format!("modified: {now}{nl}")); }
    out.push_str(&text[close..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(s: &str) -> DateTime<FixedOffset> { DateTime::parse_from_rfc3339(s).unwrap() }

    #[test]
    fn parses_fields() {
        let t = "---\ncreated: 2026-10-27T09:14:05+01:00\nmodified: \"2026-10-28T10:00:00+01:00\"\ntags: [a, 'b']\naliases:\n  - x\n  - \"y z\"\nother: 1\n---\nbody";
        let f = parse(t).unwrap();
        assert_eq!(f.created, Some(dt("2026-10-27T09:14:05+01:00")));
        assert_eq!(f.modified, Some(dt("2026-10-28T10:00:00+01:00")));
        assert_eq!(f.tags, ["a", "b"]);
        assert_eq!(f.aliases, ["x", "y z"]);
        assert_eq!(&t[f.end..], "body");
        assert_eq!(parse("---\ntags: solo\n---\n").unwrap().tags, ["solo"]);
        assert_eq!(parse("---\ntags:\n- a\n- b\nx: 1\n---\n").unwrap().tags, ["a", "b"]);
    }

    #[test]
    fn block_rules() {
        assert!(parse("---\ncreated: x\nno close").is_none());
        assert!(parse("--- \na: 1\n---\n").is_none());
        assert!(parse("hi\n---\na: 1\n---\n").is_none());
        let far = format!("---\n{}---\n", "a: 1\n".repeat(250));
        assert!(parse(&far).is_none());
        let f = parse("---\r\ntags: [a]\r\n---\r\nbody").unwrap();
        assert_eq!(f.tags, ["a"]);
        assert_eq!(body("---\r\ntags: [a]\r\n---\r\nbody"), "body");
        assert_eq!(body("---\na: 1\n---\n"), "");
        assert_eq!(body("plain"), "plain");
    }

    #[test]
    fn dates() {
        assert!(parse_date("2026-10-27T09:14:05+01:00").is_some());
        assert!(parse_date("'2026-10-27T09:14:05Z'").is_some());
        let d = parse_date("2023-01-05").unwrap();
        assert_eq!(d.with_timezone(&Local).format("%F %T").to_string(), "2023-01-05 00:00:00");
        let d = parse_date("\"2023-01-05 14:30\"").unwrap();
        assert_eq!(d.with_timezone(&Local).format("%F %T").to_string(), "2023-01-05 14:30:00");
        assert!(parse_date("2023-01-05 14:30:59").is_some());
        for j in ["", "junk", "2023-13-01", "yesterday", "2023-01-05 25:00"] { assert!(parse_date(j).is_none(), "{j}"); }
    }

    #[test]
    fn stamping() {
        let (now, fb) = (dt("2026-10-27T09:14:05+01:00"), dt("2020-01-01T00:00:00+01:00"));
        // (a)
        assert_eq!(stamp("hi", now, fb), "---\ncreated: 2020-01-01T00:00:00+01:00\nmodified: 2026-10-27T09:14:05+01:00\n---\nhi");
        // (b)
        let t = "---\ncreated: 2023-01-05\n# comment\nmodified: old\n\ntags: [x]\n---\nbody";
        assert_eq!(stamp(t, now, fb), "---\ncreated: 2023-01-05\n# comment\nmodified: 2026-10-27T09:14:05+01:00\n\ntags: [x]\n---\nbody");
        // (c)
        assert_eq!(stamp("---\ncreated:\nmodified: m\n---\n", now, fb), "---\ncreated: 2020-01-01T00:00:00+01:00\nmodified: 2026-10-27T09:14:05+01:00\n---\n");
        // (d)
        assert_eq!(stamp("---\ncreated: c\nmodified: a\nmodified: b\n---\n", now, fb), "---\ncreated: c\nmodified: 2026-10-27T09:14:05+01:00\nmodified: b\n---\n");
        // (e) incl. CRLF and missing created
        assert_eq!(stamp("---\ncreated: c\n---\nx", now, fb), "---\ncreated: c\nmodified: 2026-10-27T09:14:05+01:00\n---\nx");
        assert_eq!(stamp("---\r\na: 1\r\n---\r\n", now, fb), "---\r\na: 1\r\ncreated: 2020-01-01T00:00:00+01:00\r\nmodified: 2026-10-27T09:14:05+01:00\r\n---\r\n");
        // unparseable created stays
        assert!(stamp("---\ncreated: junk\n---\n", now, fb).contains("created: junk\n"));
        // (f)
        for t in ["hi", "---\ncreated:\n---\n", "---\na: 1\n---\nb"] {
            let once = stamp(t, now, fb);
            assert_eq!(stamp(&once, now, fb), once);
        }
    }
}
