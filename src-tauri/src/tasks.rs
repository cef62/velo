//! Task-line parsing and toggling. The line rule mirrors `TASK_ITEM` in src/preview.ts.
use crate::frontmatter;

#[derive(Debug, Clone, PartialEq)]
pub struct TaskLine {
    pub line: usize,
    /// Raw line as in the text, minus a trailing `\r`.
    pub line_text: String,
    pub text: String,
    pub done: bool,
    pub due: Option<String>,
    pub done_on: Option<String>,
}

/// Byte index of the box char and whether it is checked, if `line` is a task line.
fn scan(line: &str) -> Option<(usize, bool)> {
    let mut s = line.trim_start();
    while let Some(r) = s.strip_prefix('>') { s = r.trim_start(); }
    let s = match s.strip_prefix(['-', '*', '+']) {
        Some(r) => r,
        None => {
            let r = s.trim_start_matches(|c: char| c.is_ascii_digit());
            if r.len() == s.len() { return None; }
            r.strip_prefix(['.', ')'])?
        }
    };
    let r = s.trim_start();
    if r.len() == s.len() { return None; } // `\s+` needs at least one space
    let mut cs = r.strip_prefix('[')?.chars();
    let c = cs.next().filter(|c| matches!(c, ' ' | 'x' | 'X'))?;
    if cs.next() != Some(']') { return None; }
    Some((line.len() - r.len() + 1, c != ' '))
}

fn iso(s: &str) -> Option<&str> {
    let d = s.get(..10)?;
    chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()?;
    Some(d)
}

/// Removes every `<marker><date>` (with the space before it); returns the rest and the first date.
fn strip(s: &str, marker: &str) -> (String, Option<String>) {
    let (mut out, mut first, mut rest) = (String::new(), None, s);
    while let Some(i) = rest.find(marker) {
        let after = &rest[i + marker.len()..];
        match iso(after) {
            Some(d) => {
                out.push_str(rest[..i].trim_end());
                first.get_or_insert(d.to_string());
                rest = &after[10..];
            }
            None => { out.push_str(&rest[..i + marker.len()]); rest = after; }
        }
    }
    out.push_str(rest);
    (out, first)
}

pub fn parse_tasks(full_text: &str) -> Vec<TaskLine> {
    let start = frontmatter::parse(full_text).map_or(0, |f| f.end);
    let mut line = full_text[..start].matches('\n').count();
    let mut fenced = false;
    let mut out = vec![];
    for raw in full_text[start..].split('\n') {
        let l = raw.strip_suffix('\r').unwrap_or(raw);
        let t = l.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fenced = !fenced;
        } else if !fenced {
            if let Some((b, done)) = scan(l) {
                let (rest, due) = strip(&l[b + 2..], "📅 ");
                let (rest, done_on) = strip(&rest, "✅ ");
                out.push(TaskLine { line, line_text: l.to_string(), text: rest.trim().to_string(), done, due, done_on });
            }
        }
        line += 1;
    }
    out
}

pub fn toggle_line(line: &str, today: &str) -> Option<String> {
    let (body, cr) = match line.strip_suffix('\r') { Some(b) => (b, "\r"), None => (line, "") };
    let (b, done) = scan(body)?;
    let (rest, _) = strip(&body[b + 2..], "✅ ");
    let mark = if done { ' ' } else { 'x' };
    let stamp = if done { String::new() } else { format!(" ✅ {today}") };
    Some(format!("{}{mark}]{rest}{stamp}{cr}", &body[..b]))
}

pub fn local_today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toggle_matches_fixture() {
        let cases: Vec<serde_json::Value> = serde_json::from_str(include_str!("../../tests/fixtures/task-toggle.json")).unwrap();
        for c in cases {
            let (i, t) = (c["in"].as_str().unwrap(), c["today"].as_str().unwrap());
            assert_eq!(toggle_line(i, t).as_deref(), c["out"].as_str(), "in: {i:?}");
        }
    }

    #[test]
    fn parse_skips_front_matter_and_code() {
        let t = parse_tasks("---\ncreated: x\n---\n- [ ] a 📅 2026-11-01\n```\n- [ ] code\n```\n* [x] b ✅ 2026-10-20\r\n");
        assert_eq!(t.len(), 2);
        assert_eq!((t[0].line, t[0].text.as_str(), t[0].done, t[0].due.as_deref()), (3, "a", false, Some("2026-11-01")));
        assert_eq!(t[0].line_text, "- [ ] a 📅 2026-11-01");
        assert_eq!((t[1].line, t[1].text.as_str(), t[1].done, t[1].done_on.as_deref()), (7, "b", true, Some("2026-10-20")));
        assert_eq!(t[1].line_text, "* [x] b ✅ 2026-10-20");
    }

    #[test]
    fn toggle_twice_is_one_done_date() {
        let mut l = "- [ ] a 📅 2026-10-30".to_string();
        for _ in 0..3 { l = toggle_line(&l, "2026-10-27").unwrap(); }
        assert_eq!(l.matches('✅').count(), 1);
        assert!(l.contains("✅ 2026-10-27") && l.contains("📅 2026-10-30"));
    }
}
