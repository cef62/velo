//! Markdown export of the timeline's notes: a task summary, then one section per note.
use crate::frontmatter;
use crate::tasks::parse_tasks;
use crate::vault::{TimelineBy, TimelineRow, Vault};
use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::Path;

pub const LIMIT: usize = 1000;
const DAY_MS: i64 = 86_400_000;

#[derive(Deserialize)]
pub struct ExportRequest {
    pub query: String,
    pub tags: Vec<String>,
    pub no_links: bool,
    pub by: TimelineBy,
    pub since_ms: Option<i64>,
    pub tasks_only: bool,
    pub title: String,
}

#[derive(Serialize, Default, Debug, PartialEq)]
pub struct ExportCounts {
    pub notes: usize,
    pub open: usize,
    pub done: usize,
    pub locked: usize,
    pub over_limit: usize,
    pub no_tasks: usize,
    pub unreadable: usize,
}

fn day(ms: i64) -> String {
    Local.timestamp_millis_opt(ms).single().map_or_else(String::new, |d| d.format("%F").to_string())
}

/// The UI sends 7 or 30 days back from now; anything else is shown as its start date.
fn range_line(since_ms: Option<i64>, now_ms: i64) -> String {
    let Some(s) = since_ms else { return "All dates".into() };
    match ((now_ms - s) as f64 / DAY_MS as f64).round() as i64 {
        n @ (7 | 30) => format!("Last {n} days"),
        _ => format!("Since {}", day(s)),
    }
}

pub fn build(v: &Vault, r: &ExportRequest, today: &str) -> anyhow::Result<(String, ExportCounts)> {
    let rows = v.timeline(&r.query, &r.tags, r.no_links, r.by, r.since_ms)?;
    Ok(build_from(rows, &v.index.dates()?, r, today, chrono::Utc::now().timestamp_millis()))
}

/// Locked rows are counted, never read: an unlocked one's plaintext lives only in the vault's memory.
fn build_from(rows: Vec<TimelineRow>, dates: &HashMap<String, (i64, i64)>, r: &ExportRequest, today: &str, now_ms: i64) -> (String, ExportCounts) {
    let since_day = r.since_ms.map(day);
    let mut c = ExportCounts::default();
    let (mut open, mut done, mut sections) = (String::new(), String::new(), String::new());
    let mut plain = 0;
    for row in rows {
        if row.locked { c.locked += 1; continue; }
        plain += 1;
        if plain > LIMIT { c.over_limit += 1; continue; }
        let Ok(text) = std::fs::read(&row.path).map(|b| String::from_utf8_lossy(&b).into_owned()) else { c.unreadable += 1; continue };
        let tasks = parse_tasks(&text);
        if r.tasks_only && tasks.is_empty() { c.no_tasks += 1; continue; }
        for t in &tasks {
            if !t.done {
                c.open += 1;
                let _ = writeln!(open, "- [ ] {} — {}", t.text, row.title);
            } else if since_day.as_ref().is_none_or(|s| t.done_on.as_ref().is_some_and(|d| d >= s)) {
                c.done += 1;
                let date = t.done_on.as_ref().map_or_else(String::new, |d| format!(" @done({d})"));
                let _ = writeln!(done, "- [x] {} — {}{date}", t.text, row.title);
            }
        }
        c.notes += 1;
        let (created, updated) = dates.get(&row.path).copied().unwrap_or((row.date, row.date));
        let _ = write!(sections, "## {}\nCreated {} · Updated {}\n\n", row.title, day(created), day(updated));
        if r.tasks_only {
            for t in &tasks { let _ = writeln!(sections, "{}", t.line_text); }
            sections.push('\n');
        } else {
            let body = frontmatter::body(&text).trim_start_matches(['\r', '\n']).trim_end();
            let _ = write!(sections, "{body}\n\n");
        }
    }
    let mut out = format!("# {}\n{} · exported {today}\n\n## Status\n{} open · {} done\n\n", r.title, range_line(r.since_ms, now_ms), c.open, c.done);
    let _ = write!(out, "### Open\n{open}### Done\n{done}\n{sections}");
    let parts: Vec<String> = [(c.locked, "locked notes left out"), (c.over_limit, "over the 1,000 limit"), (c.no_tasks, "without tasks"), (c.unreadable, "unreadable")]
        .iter().filter(|(n, _)| *n > 0).map(|(n, s)| format!("{n} {s}")).collect();
    if !parts.is_empty() { let _ = writeln!(out, "---\n{}", parts.join(" · ")); }
    (out, c)
}

/// Temp file beside `path`, then rename: an interrupted export never leaves a half-written file at `path`.
pub fn write(path: &Path, text: &str) -> std::io::Result<()> {
    let name = path.file_name().and_then(|n| n.to_str()).ok_or_else(|| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let tmp = path.with_file_name(format!(".{name}.tmp"));
    let res = std::fs::File::create(&tmp)
        .and_then(|mut f| std::io::Write::write_all(&mut f, text.as_bytes()).and_then(|_| f.sync_all()))
        .and_then(|_| std::fs::rename(&tmp, path));
    if res.is_err() { let _ = std::fs::remove_file(&tmp); }
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto;
    use std::path::PathBuf;

    fn req(tasks_only: bool) -> ExportRequest {
        ExportRequest { query: String::new(), tags: vec![], no_links: false, by: TimelineBy::Updated, since_ms: None, tasks_only, title: "Export".into() }
    }
    fn vault(notes: &[(&str, &str, &str)]) -> (Vault, PathBuf) {
        let dir = tempfile::tempdir().unwrap().keep();
        for (n, m, body) in notes {
            std::fs::write(dir.join(format!("{n}.md")), format!("---\ncreated: 2020-01-01T00:00:00+00:00\nmodified: {m}\n---\n{body}\n")).unwrap();
        }
        let db = tempfile::tempdir().unwrap().keep().join("i.sqlite");
        (Vault::open_with_progress(dir.clone(), &db, None, &mut |_, _| {}).unwrap(), dir)
    }

    #[test] fn export_full_has_summary_and_sections() {
        let (v, _) = vault(&[("older", "2026-10-01T12:00:00+00:00", "plain text"), ("newer", "2026-10-29T12:00:00+00:00", "intro\n- [ ] a\n- [x] b @done(2026-10-29)")]);
        let (t, c) = build(&v, &req(false), "2026-10-30").unwrap();
        assert_eq!((c.notes, c.open, c.done), (2, 1, 1));
        assert!(t.starts_with("# Export\nAll dates · exported 2026-10-30\n\n## Status\n1 open · 1 done\n\n### Open\n- [ ] a — newer\n### Done\n- [x] b — newer @done(2026-10-29)\n\n## newer\nCreated "), "{t}");
        assert!(t.find("## newer").unwrap() < t.find("## older").unwrap());
        assert!(t.contains("\n\nintro\n- [ ] a\n") && t.contains("plain text"));
        assert!(!t.contains("modified:") && !t.contains("\n---\n"));
    }

    #[test] fn export_done_respects_the_range() {
        let (v, _) = vault(&[("n", "2026-10-29T12:00:00+00:00", "- [x] old @done(2020-01-01)\n- [x] new @done(2026-10-29)\n- [x] undated")]);
        let mut r = req(false);
        let now = chrono::Utc::now().timestamp_millis();
        r.since_ms = Some(chrono::DateTime::parse_from_rfc3339("2026-10-01T00:00:00+00:00").unwrap().timestamp_millis());
        let rows = v.timeline("", &[], false, r.by, None).unwrap();
        let (t, c) = build_from(rows, &v.index.dates().unwrap(), &r, "2026-10-30", r.since_ms.unwrap() + 7 * DAY_MS);
        assert_eq!(c.done, 1);
        assert!(t.contains("Last 7 days") && t.contains("- [x] new — n @done(2026-10-29)") && !t.contains("old —") && !t.contains("undated —"));
        assert_eq!(range_line(Some(now - 30 * DAY_MS), now), "Last 30 days");
        assert!(range_line(Some(now - 3 * DAY_MS), now).starts_with("Since "));
    }

    #[test] fn export_tasks_only_keeps_headings_and_tasks() {
        let (v, _) = vault(&[("t", "2026-10-29T12:00:00+00:00", "intro\n- [ ] a"), ("none", "2026-10-28T12:00:00+00:00", "no tasks here")]);
        let (t, c) = build(&v, &req(true), "2026-10-30").unwrap();
        assert_eq!((c.notes, c.no_tasks), (1, 1));
        assert!(t.contains("## t\nCreated ") && t.contains("\n\n- [ ] a\n") && !t.contains("intro"));
        assert!(!t.contains("## none") && !t.contains("no tasks here"));
        assert!(t.ends_with("---\n1 without tasks\n"), "{t}");
    }

    #[test] fn export_never_includes_locked_notes() {
        let (mut v, _) = vault(&[]);
        let id = crypto::new_identity();
        let d = v.open_or_create("SECRET-XYZ", None, false).unwrap();
        let p = v.lock_note(&d.path, &id).unwrap();
        let hash = crate::store::hash(&std::fs::read(&p).unwrap());
        v.save_note(&p, "SECRET-XYZ body\n- [ ] SECRET-XYZ task", &hash, Some(&id), false).unwrap();
        let mut r = req(false);
        r.query = "SECRET-XYZ".into();
        let (t, c) = build(&v, &r, "2026-10-30").unwrap();
        assert!(!t.contains("SECRET-XYZ"), "{t}");
        assert_eq!((c.locked, c.notes, c.open), (1, 0, 0));
        assert!(t.ends_with("---\n1 locked notes left out\n"));
    }

    #[test] fn export_limit_counts_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let rows: Vec<TimelineRow> = (0..=LIMIT).map(|i| {
            let p = dir.path().join(format!("n{i}.md"));
            std::fs::write(&p, "x").unwrap();
            TimelineRow { path: p.to_string_lossy().into_owned(), title: format!("n{i}"), date: 0, snippet: String::new(), locked: false }
        }).collect();
        let (t, c) = build_from(rows, &HashMap::new(), &req(false), "2026-10-30", 0);
        assert_eq!((c.notes, c.over_limit), (LIMIT, 1));
        assert_eq!(t.matches("\n## n").count(), LIMIT);
        assert!(!t.contains(&format!("## n{LIMIT}\n")));
    }

    #[test] fn export_counts_unreadable_notes() {
        let row = TimelineRow { path: "/nonexistent/velo/x.md".into(), title: "x".into(), date: 0, snippet: String::new(), locked: false };
        let (t, c) = build_from(vec![row], &HashMap::new(), &req(false), "2026-10-30", 0);
        assert_eq!((c.notes, c.unreadable), (0, 1));
        assert!(t.ends_with("---\n1 unreadable\n"));
    }

    #[test] fn export_markdown_writes_only_the_given_path() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("out.md");
        write(&p, "hello").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "hello");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
