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
        // local date-times; the `T` forms are what Obsidian's "Date & time" property writes
        .or_else(|| ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M"].iter().find_map(|f| NaiveDateTime::parse_from_str(v, f).ok()))?;
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

fn tag_key(s: &str) -> String {
    crate::text::fold(unquote(s).trim_start_matches('#'))
}

/// Adds/removes tags (matched with `fold`, a leading `#` ignored) by editing only the `tags:` key; the form the note
/// uses stays (flow or block list). A new key is a flow list `tags: [a, b]`; with no block at all one is created only
/// if `create_block`. `None` when nothing changes.
pub fn set_tags(text: &str, add: &[String], remove: &[String], create_block: bool) -> Option<String> {
    let rm: Vec<String> = remove.iter().map(|t| tag_key(t)).collect();
    let mut adds: Vec<&str> = vec![];
    for t in add.iter().map(|t| t.trim().trim_start_matches('#')).filter(|t| !t.is_empty()) {
        if !adds.iter().any(|a| tag_key(a) == tag_key(t)) { adds.push(t); }
    }
    let Some((close, _)) = block(text) else {
        if adds.is_empty() || !create_block { return None; }
        return Some(format!("---\ntags: [{}]\n---\n{text}", adds.join(", ")));
    };
    let first = text.find('\n').map_or(0, |i| i + 1);
    let nl = if text[..first].ends_with("\r\n") { "\r\n" } else { "\n" };
    let rows: Vec<&str> = text[first..close].split_inclusive('\n').collect();
    let strip = |r: &str| r.trim_end_matches(['\n', '\r']).to_string();
    let Some(k) = rows.iter().position(|r| r.starts_with("tags:")) else {
        if adds.is_empty() { return None; }
        return Some(format!("{}tags: [{}]{nl}{}", &text[..close], adds.join(", "), &text[close..]));
    };
    let v = strip(rows[k]).trim_start_matches("tags:").trim().to_string();
    let (mut items, end, flow): (Vec<&str>, usize, bool) = if v.starts_with('[') && v.ends_with(']') {
        (v[1..v.len() - 1].split(',').map(str::trim).filter(|s| !s.is_empty()).collect(), k + 1, true)
    } else if !v.is_empty() {
        (vec![v.as_str()], k + 1, true)
    } else {
        let n = rows[k + 1..].iter().take_while(|l| l.trim_start().starts_with('-') && l.starts_with([' ', '-'])).count();
        (rows[k + 1..k + 1 + n].iter().map(|l| l.trim().trim_start_matches('-').trim()).collect(), k + 1 + n, false)
    };
    let before = items.len();
    let keep: Vec<bool> = items.iter().map(|i| !rm.contains(&tag_key(i))).collect();
    let mut kept_rows: Vec<&str> = rows[k + 1..end].iter().zip(&keep).filter(|(_, k)| **k).map(|(r, _)| *r).collect();
    let mut it = keep.iter();
    items.retain(|_| *it.next().unwrap());
    let fresh: Vec<&str> = adds.into_iter().filter(|a| !items.iter().any(|i| tag_key(i) == tag_key(a))).collect();
    if items.len() == before && fresh.is_empty() { return None; }
    let eol = if rows[k].ends_with("\r\n") { "\r\n" } else if rows[k].ends_with('\n') { "\n" } else { nl };
    let mut out = String::new();
    if flow || (items.is_empty() && fresh.is_empty()) {
        items.extend(fresh);
        out.push_str(&format!("tags: [{}]{eol}", items.join(", ")));
    } else {
        out.push_str(rows[k]);
        let indent: String = rows.get(k + 1).map_or("  ".into(), |l| l.chars().take_while(|c| *c == ' ').collect());
        let owned: Vec<String> = fresh.iter().map(|t| format!("{indent}- {t}{eol}")).collect();
        kept_rows.extend(owned.iter().map(String::as_str));
        kept_rows.iter().for_each(|r| out.push_str(r));
    }
    let first_end = first + rows[..k].iter().map(|r| r.len()).sum::<usize>();
    let rest = first + rows[..end].iter().map(|r| r.len()).sum::<usize>();
    Some(format!("{}{out}{}", &text[..first_end], &text[rest..]))
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
        let d = parse_date("2024-01-05T14:30").unwrap(); // Obsidian "Date & time": local, no offset
        assert_eq!(d.with_timezone(&Local).format("%F %T").to_string(), "2024-01-05 14:30:00");
        let d = parse_date("2024-01-05T14:30:07").unwrap();
        assert_eq!(d.with_timezone(&Local).format("%F %T").to_string(), "2024-01-05 14:30:07");
        for j in ["", "junk", "2023-13-01", "yesterday", "2023-01-05 25:00", "2023-01-05T25:00"] { assert!(parse_date(j).is_none(), "{j}"); }
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

    #[test]
    fn stamp_edge_cases() {
        let (now, fb) = (dt("2026-10-27T09:14:05+01:00"), dt("2020-01-01T00:00:00+01:00"));
        let n = "2026-10-27T09:14:05+01:00";
        // CRLF: rewritten and inserted lines keep CRLF
        let t = "---\r\ncreated: c\r\nmodified: old\r\n---\r\nbody\r\n";
        assert_eq!(stamp(t, now, fb), format!("---\r\ncreated: c\r\nmodified: {n}\r\n---\r\nbody\r\n"));
        let out = stamp("---\r\na: 1\r\n---\r\nx", now, fb);
        assert!(!out.replace("\r\n", "").contains('\n'), "{out:?}");
        // multi-byte before and inside the block
        let t = "---\ntitle: caffè ☕\nmodified: vecchio\n---\nÅ body ☕";
        assert_eq!(stamp(t, now, fb), format!("---\ntitle: caffè ☕\nmodified: {n}\ncreated: 2020-01-01T00:00:00+01:00\n---\nÅ body ☕"));
        assert_eq!(stamp("é☕", now, fb), format!("---\ncreated: 2020-01-01T00:00:00+01:00\nmodified: {n}\n---\né☕"));
        // block-only, no trailing newline at EOF after closing ---
        assert_eq!(stamp("---\ncreated: c\n---", now, fb), format!("---\ncreated: c\nmodified: {n}\n---"));
        assert_eq!(stamp("---\n---", now, fb), format!("---\ncreated: 2020-01-01T00:00:00+01:00\nmodified: {n}\n---"));
        // unterminated last line inside is impossible (closing ---), but no newline after closer + body-less
        let once = stamp("---\nmodified: x\n---", now, fb);
        assert_eq!(stamp(&once, now, fb), once);
    }

    #[test]
    fn set_tags_flow_and_block_lists_preserve_bytes() {
        let flow = "---\ncreated: x\ntags: [a, B]\nother: 1\n---\nbody";
        assert_eq!(set_tags(flow, &["c".into()], &["b".into()], true).unwrap(), "---\ncreated: x\ntags: [a, c]\nother: 1\n---\nbody");
        assert_eq!(set_tags(flow, &["A".into()], &[], true), None);
        assert_eq!(set_tags(flow, &[], &["zz".into()], true), None);
        let block = "---\r\ntags:\r\n  - a\r\n  - \"b\"\r\nother: 1\r\n---\r\nbody";
        assert_eq!(set_tags(block, &["c".into()], &["A".into()], true).unwrap(), "---\r\ntags:\r\n  - \"b\"\r\n  - c\r\nother: 1\r\n---\r\nbody");
        assert_eq!(set_tags(block, &[], &["a".into(), "b".into()], true).unwrap(), "---\r\ntags: []\r\nother: 1\r\n---\r\nbody");
        assert_eq!(set_tags("---\ntags: solo\n---\n", &["x".into()], &[], true).unwrap(), "---\ntags: [solo, x]\n---\n");
    }

    #[test]
    fn set_tags_creates_block_when_allowed() {
        assert_eq!(set_tags("body", &["a".into(), "b".into()], &[], true).unwrap(), "---\ntags: [a, b]\n---\nbody");
        assert_eq!(set_tags("body", &["a".into()], &[], false), None);
        assert_eq!(set_tags("---\ncreated: x\n---\nbody", &["a".into()], &[], false).unwrap(), "---\ncreated: x\ntags: [a]\n---\nbody");
    }
}
