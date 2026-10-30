//! Task-line parsing and toggling. The line rule mirrors `TASK_ITEM` in src/preview.ts.
use crate::frontmatter;
use crate::index::TaskRow;
use crate::text::fold;
use serde::Serialize;

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

/// A `YYYY-MM-DD` date at the start of `s`, not followed by another letter or digit (`2026-10-271` is no date).
fn iso(s: &str) -> Option<&str> {
    let d = s.get(..10)?;
    let shape = d.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() });
    if !shape || s[10..].starts_with(char::is_alphanumeric) { return None; }
    chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()?;
    Some(d)
}

/// A code-fence line: its char, its length, and the text after it.
fn fence(line: &str) -> Option<(char, usize, &str)> {
    let t = line.trim_start();
    let c = t.chars().next().filter(|c| matches!(c, '`' | '~'))?;
    let rest = t.trim_start_matches(c);
    let n = t.len() - rest.len();
    (n >= 3).then_some((c, n, rest))
}

/// Removes every `<marker><date><close>` (with the space before it); returns the rest and the first date.
fn strip(s: &str, marker: &str, close: &str) -> (String, Option<String>) {
    let (mut out, mut first, mut rest) = (String::new(), None, s);
    while let Some(i) = rest.find(marker) {
        let after = &rest[i + marker.len()..];
        match iso(after).filter(|_| after[10..].starts_with(close)) {
            Some(d) => {
                out.push_str(rest[..i].trim_end());
                first.get_or_insert(d.to_string());
                rest = &after[10 + close.len()..];
            }
            None => { out.push_str(&rest[..i + marker.len()]); rest = after; }
        }
    }
    out.push_str(rest);
    (out, first)
}

/// The done date: velo writes `@done(YYYY-MM-DD)`; Obsidian's `✅ YYYY-MM-DD` is still read, and replaced on a toggle.
fn strip_done(s: &str) -> (String, Option<String>) {
    let (rest, done) = strip(s, "@done(", ")");
    let (rest, legacy) = strip(&rest, "✅ ", "");
    (rest, done.or(legacy))
}

pub fn parse_tasks(full_text: &str) -> Vec<TaskLine> {
    let start = frontmatter::parse(full_text).map_or(0, |f| f.end);
    let mut line = full_text[..start].matches('\n').count();
    let mut open: Option<(char, usize)> = None; // the fence we are inside
    let mut out = vec![];
    for raw in full_text[start..].split('\n') {
        let l = raw.strip_suffix('\r').unwrap_or(raw);
        match (open, fence(l)) {
            // CommonMark: only the same char, at least as long, with nothing after it, closes a fence
            (Some((c, n)), Some((c2, n2, rest))) if c == c2 && n2 >= n && rest.trim().is_empty() => open = None,
            (Some(_), _) => {}
            (None, Some((c, n, _))) => open = Some((c, n)),
            (None, None) => if let Some((b, done)) = scan(l) {
                let (rest, due) = strip(&l[b + 2..], "📅 ", "");
                let (rest, done_on) = strip_done(&rest);
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
    let (rest, _) = strip_done(&body[b + 2..]);
    let mark = if done { ' ' } else { 'x' };
    let stamp = if done { String::new() } else { format!(" @done({today})") };
    Some(format!("{}{mark}]{rest}{stamp}{cr}", &body[..b]))
}

#[derive(Serialize, Debug, Clone)]
pub struct TaskItem {
    pub path: String,
    pub title: String,
    pub line: usize,
    pub text: String,
    pub due: Option<String>,
    pub done: bool,
    pub done_on: Option<String>,
    /// Raw line: the `expected` for a tick.
    pub line_text: String,
}

#[derive(Serialize, Debug, Default)]
pub struct TaskView {
    pub overdue: Vec<TaskItem>,
    pub today: Vec<TaskItem>,
    pub upcoming: Vec<TaskItem>,
    pub no_date: Vec<TaskItem>,
    pub done: Vec<TaskItem>,
    pub due_count: usize,
}

/// Buckets open tasks by due date vs `today` (YYYY-MM-DD); `done` holds ticks from the last 7 days when `show_done`.
pub fn group_tasks(rows: Vec<TaskRow>, query: &str, show_done: bool, today: &str) -> TaskView {
    let q = fold(query);
    let q = q.trim();
    let cutoff = chrono::NaiveDate::parse_from_str(today, "%Y-%m-%d").ok().map(|d| (d - chrono::Days::new(7)).to_string());
    let mut rows: Vec<TaskRow> = rows.into_iter().filter(|r| q.is_empty() || fold(&r.text).contains(q) || fold(&r.title).contains(q)).collect();
    // Undated after dated; ties: newest note, then position.
    rows.sort_by(|a, b| (a.due.is_none(), &a.due, std::cmp::Reverse(a.modified), &a.path, a.line).cmp(&(b.due.is_none(), &b.due, std::cmp::Reverse(b.modified), &b.path, b.line)));
    let mut v = TaskView::default();
    for r in rows {
        let item = |r: TaskRow| TaskItem { path: r.path, title: r.title, line: r.line, text: r.text, due: r.due, done: r.done, done_on: r.done_on, line_text: r.line_text };
        let bucket = if r.done {
            match (&r.done_on, &cutoff) {
                (Some(d), Some(c)) if show_done && d > c => &mut v.done,
                _ => continue,
            }
        } else {
            match r.due.as_deref() {
                Some(d) if d < today => &mut v.overdue,
                Some(d) if d == today => &mut v.today,
                Some(_) => &mut v.upcoming,
                None => &mut v.no_date,
            }
        };
        bucket.push(item(r));
    }
    v.due_count = v.overdue.len() + v.today.len();
    v
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

    fn row(title: &str, text: &str, due: Option<&str>, modified: i64) -> TaskRow {
        TaskRow { path: format!("{title}.md"), title: title.into(), modified, line: 0, text: text.into(), done: false, due: due.map(Into::into), done_on: None, line_text: String::new() }
    }
    fn texts(v: &[TaskItem]) -> Vec<&str> { v.iter().map(|t| t.text.as_str()).collect() }

    #[test]
    fn group_tasks_buckets_and_orders() {
        let rows = vec![
            row("n", "none", None, 1), row("n", "up", Some("2026-11-02"), 1), row("n", "now", Some("2026-10-27"), 1), row("n", "late", Some("2026-10-20"), 1),
            row("n", "later", Some("2026-10-25"), 5), row("n", "none2", None, 9),
        ];
        let v = group_tasks(rows, "", false, "2026-10-27");
        assert_eq!(texts(&v.overdue), ["late", "later"]);
        assert_eq!(texts(&v.today), ["now"]);
        assert_eq!(texts(&v.upcoming), ["up"]);
        assert_eq!(texts(&v.no_date), ["none2", "none"], "newest note first");
        assert_eq!(v.due_count, 3);
    }

    #[test]
    fn show_done_only_last_7_days() {
        let done = |t: &str, d: &str| TaskRow { done: true, done_on: Some(d.into()), ..row("n", t, None, 1) };
        let rows = || vec![done("recent", "2026-10-21"), done("old", "2026-10-19"), done("edge", "2026-10-20"), TaskRow { done: true, ..row("n", "undated", None, 1) }];
        assert_eq!(texts(&group_tasks(rows(), "", true, "2026-10-27").done), ["recent"]);
        assert!(group_tasks(rows(), "", false, "2026-10-27").done.is_empty());
    }

    #[test]
    fn query_matches_task_text_or_title() {
        let rows = vec![row("Garden", "water", None, 1), row("Home", "buy Café beans", None, 1), row("Home", "other", None, 1)];
        assert_eq!(texts(&group_tasks(rows.clone(), "garden", false, "2026-10-27").no_date), ["water"]);
        assert_eq!(texts(&group_tasks(rows, "cafe", false, "2026-10-27").no_date), ["buy Café beans"]);
    }

    #[test]
    fn fence_closes_only_on_same_char_and_at_least_its_length() {
        let t = parse_tasks("````\n```\n- [ ] in code\n````\n- [ ] a\n~~~\n```\n- [ ] in code\n~~~\n- [ ] b\n```\n``` not a close\n- [ ] in code\n```\n- [ ] c\n");
        assert_eq!(t.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(), ["a", "b", "c"]);
    }

    #[test]
    fn a_date_needs_a_boundary() {
        let t = parse_tasks("- [ ] a 📅 2026-10-271\n- [ ] b 📅 2026-10-27, later\n");
        assert_eq!((t[0].due.as_deref(), t[0].text.as_str()), (None, "a 📅 2026-10-271"));
        assert_eq!(t[1].due.as_deref(), Some("2026-10-27"));
    }

    #[test]
    fn toggle_twice_is_one_done_date() {
        let mut l = "- [ ] a 📅 2026-10-30".to_string();
        for _ in 0..3 { l = toggle_line(&l, "2026-10-27").unwrap(); }
        assert_eq!(l.matches("@done(").count(), 1);
        assert!(l.contains("@done(2026-10-27)") && l.contains("📅 2026-10-30"));
    }

    #[test]
    fn done_date_reads_both_marks() {
        let t = parse_tasks("- [x] a @done(2026-10-20)
- [x] b ✅ 2026-10-21
");
        assert_eq!((t[0].done_on.as_deref(), t[0].text.as_str()), (Some("2026-10-20"), "a"));
        assert_eq!((t[1].done_on.as_deref(), t[1].text.as_str()), (Some("2026-10-21"), "b"));
    }
}
