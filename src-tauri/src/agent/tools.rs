//! The MCP tools velo exposes: specs for `tools/list` and the handlers, all over `NoteOps`.
use super::ops::{NoteOps, PAGE};
use serde_json::{Value, json};

pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    /// JSON Schema (an object) as text
    pub input_schema: &'static str,
}

/// velo's note conventions, appended to the write tools' descriptions.
macro_rules! conventions {
    () => {
        " velo conventions: notes are Markdown, one note per title (titles are case-insensitive and may have aliases). \
Tasks are `- [ ] text` lines (done: `- [x]`); a due date is ` 📅 YYYY-MM-DD` at the end of the task line. \
Link notes with [[Note title]]. Tag with inline #tag words or the front-matter `tags:` list. \
Always read_note before editing a note. `summary` is a one-line description of the change, shown in the note's revisions."
    };
}

pub const TOOL_SPECS: &[ToolSpec] = &[
    ToolSpec {
        name: "search_notes",
        description: "Search velo notes like the velo search field (titles, aliases, then text). Empty query lists all notes. `tags` keeps notes having every tag. At most 50 results per call; page with `offset`. Returns title, snippet, modified, tags.",
        input_schema: r#"{"type":"object","properties":{"query":{"type":"string"},"tags":{"type":"array","items":{"type":"string"}},"limit":{"type":"integer","minimum":1,"maximum":50},"offset":{"type":"integer","minimum":0}}}"#,
    },
    ToolSpec {
        name: "list_tags",
        description: "All tags in velo notes (front-matter `tags:` and inline #tag words) with the number of notes carrying each.",
        input_schema: r#"{"type":"object","properties":{}}"#,
    },
    ToolSpec {
        name: "read_note",
        description: "Read a note by title (or alias). Returns the full text (front matter included), `hash` (pass it to replace_note), created, modified, tags, aliases, outgoing [[links]] and backlinks (titles of notes linking here).",
        input_schema: r#"{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}"#,
    },
    ToolSpec {
        name: "create_note",
        description: concat!("Create a new note. Fails if a note with that title or alias exists. Front matter is stamped as for any new note. Returns the title and new hash.", conventions!()),
        input_schema: r#"{"type":"object","properties":{"title":{"type":"string"},"text":{"type":"string"},"summary":{"type":"string"}},"required":["title","text","summary"]}"#,
    },
    ToolSpec {
        name: "append_to_note",
        description: concat!("Append text at the end of a note, on a new line. Creates the note if it does not exist. Returns the title and new hash.", conventions!()),
        input_schema: r#"{"type":"object","properties":{"title":{"type":"string"},"text":{"type":"string"},"summary":{"type":"string"}},"required":["title","text","summary"]}"#,
    },
    ToolSpec {
        name: "edit_note",
        description: concat!("Replace `old_text` with `new_text` in a note. `old_text` must occur exactly once in the current text (include surrounding text to make it unique); otherwise nothing changes and the error gives the match count. Returns the new hash.", conventions!()),
        input_schema: r#"{"type":"object","properties":{"title":{"type":"string"},"old_text":{"type":"string"},"new_text":{"type":"string"},"summary":{"type":"string"}},"required":["title","old_text","new_text","summary"]}"#,
    },
    ToolSpec {
        name: "replace_note",
        description: concat!("Replace a note's whole text (front matter included). `expected_hash` must be the hash from your latest read_note or write; if the note changed since, nothing changes. Prefer edit_note for small changes. Returns the new hash.", conventions!()),
        input_schema: r#"{"type":"object","properties":{"title":{"type":"string"},"text":{"type":"string"},"expected_hash":{"type":"string"},"summary":{"type":"string"}},"required":["title","text","expected_hash","summary"]}"#,
    },
    ToolSpec {
        name: "add_tags",
        description: concat!("Add tags to up to 200 notes (`titles`). Each note is its own write; the result lists `changed` (with the new hash), `unchanged` (already has the tag, in front matter or inline) or `failed` with a reason per title. Tags go in the front-matter `tags:` list (or as a #tag line at the end of the note when velo's front-matter setting is off).", conventions!()),
        input_schema: r#"{"type":"object","properties":{"titles":{"type":"array","items":{"type":"string"},"maxItems":200},"tags":{"type":"array","items":{"type":"string"}},"summary":{"type":"string"}},"required":["titles","tags","summary"]}"#,
    },
    ToolSpec {
        name: "remove_tags",
        description: concat!("Remove tags from up to 200 notes (`titles`): from the front-matter `tags:` list and exact inline #tag words (never inside code or links). Each note is its own write; the result lists `changed` (with the new hash), `unchanged` or `failed` with a reason per title.", conventions!()),
        input_schema: r#"{"type":"object","properties":{"titles":{"type":"array","items":{"type":"string"},"maxItems":200},"tags":{"type":"array","items":{"type":"string"}},"summary":{"type":"string"}},"required":["titles","tags","summary"]}"#,
    },
    ToolSpec {
        name: "list_tasks",
        description: "The Tasks view: open tasks from all notes grouped as overdue, today, upcoming, no_date (and done = ticked in the last 7 days when `show_done`), plus due_count (overdue + today). `query` filters task or note text, `tags` keeps notes having every tag. Each task has title (note), text, due, line, line_text (pass line and line_text to set_task_done).",
        input_schema: r#"{"type":"object","properties":{"query":{"type":"string"},"tags":{"type":"array","items":{"type":"string"}},"show_done":{"type":"boolean"}}}"#,
    },
    ToolSpec {
        name: "add_task",
        description: concat!("Add a `- [ ] text` task line. Without `title` it goes to velo's capture target (the Inbox or today's daily note, per the user's setting); the note is created if missing. `due` (YYYY-MM-DD) adds ` 📅 due`. Returns the note title and new hash.", conventions!()),
        input_schema: r#"{"type":"object","properties":{"text":{"type":"string"},"title":{"type":"string"},"due":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}$"},"summary":{"type":"string"}},"required":["text","summary"]}"#,
    },
    ToolSpec {
        name: "set_task_done",
        description: concat!("Tick (`done` true) or untick a task in a note, with velo's ✅ date handling. Pass `line` and `line_text` from list_tasks or read_note; if the line changed since, it fails with task-moved. Returns status `changed` (with the new hash and line) or `unchanged` when the task is already in that state.", conventions!()),
        input_schema: r#"{"type":"object","properties":{"title":{"type":"string"},"line":{"type":"integer","minimum":0},"line_text":{"type":"string"},"done":{"type":"boolean"},"summary":{"type":"string"}},"required":["title","line","line_text","done","summary"]}"#,
    },
    ToolSpec {
        name: "rename_note",
        description: concat!("Rename a note. With `rewrite_links` true, [[links]] to it in other notes are updated. Returns the new title and hash.", conventions!()),
        input_schema: r#"{"type":"object","properties":{"title":{"type":"string"},"new_title":{"type":"string"},"rewrite_links":{"type":"boolean"},"summary":{"type":"string"}},"required":["title","new_title","rewrite_links","summary"]}"#,
    },
    ToolSpec {
        name: "move_to_trash",
        description: concat!("Move a note to the OS Trash (recoverable there; nothing is deleted permanently). Its revisions are kept.", conventions!()),
        input_schema: r#"{"type":"object","properties":{"title":{"type":"string"},"summary":{"type":"string"}},"required":["title","summary"]}"#,
    },
    ToolSpec {
        name: "daily_note",
        description: "The daily note for a date (`date` YYYY-MM-DD, default today, local time): title, text and whether this call created it (no template; optional `summary` describes the creation in the note's revisions).",
        input_schema: r#"{"type":"object","properties":{"date":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}$"},"summary":{"type":"string"}}}"#,
    },
];

fn arg<'a>(a: &'a Value, k: &str) -> Result<&'a str, String> {
    a.get(k).and_then(Value::as_str).ok_or_else(|| format!("missing {k}"))
}

fn strings(a: &Value, k: &str) -> Vec<String> {
    a.get(k).and_then(Value::as_array).map(|v| v.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default()
}

fn uint(a: &Value, k: &str, default: usize) -> usize {
    a.get(k).and_then(Value::as_u64).map_or(default, |n| n as usize)
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map(|d| d.with_timezone(&chrono::Local).to_rfc3339()).unwrap_or_default()
}

fn err(e: anyhow::Error) -> String {
    e.to_string()
}

/// `a[k]` as a title that maps to a file name (one of only dots and spaces would become "Untitled").
fn title_arg<'a>(a: &'a Value, k: &str) -> Result<&'a str, String> {
    let t = arg(a, k)?;
    match t.trim() {
        "" => Err("title is empty".into()),
        s if s.chars().all(|c| c == '.' || c == ' ') => Err(format!("invalid title: {t}")),
        _ => Ok(t),
    }
}

/// Path of the plain note `title`; a locked or missing one is "not found".
fn path_of(ops: &dyn NoteOps, a: &Value) -> Result<String, String> {
    ops.find(arg(a, "title")?).map_err(err)?.ok_or_else(|| "not found".to_string())
}

/// `d` if it is a real `YYYY-MM-DD` date.
fn valid_date(d: &str) -> Result<&str, String> {
    match chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d") {
        Ok(n) if n.format("%Y-%m-%d").to_string() == d => Ok(d),
        _ => Err(format!("invalid date: {d} (expected YYYY-MM-DD)")),
    }
}

/// Occurrences of `pat` in `text`, overlapping ones included ("aa" occurs twice in "aaa"); 0 for an empty `pat`.
fn occurrences(text: &str, pat: &str) -> usize {
    let Some(step) = pat.chars().next().map(char::len_utf8) else { return 0 };
    let (mut n, mut at) = (0, 0);
    while let Some(i) = text[at..].find(pat) {
        n += 1;
        at += i + step;
    }
    n
}

pub fn call(ops: &mut dyn NoteOps, name: &str, a: Value) -> Result<Value, String> {
    let is_write = matches!(name, "create_note" | "append_to_note" | "edit_note" | "replace_note" | "add_tags" | "remove_tags" | "add_task" | "set_task_done" | "rename_note" | "move_to_trash");
    let summary = if is_write {
        let s = a.get("summary").and_then(Value::as_str).unwrap_or("");
        if s.trim().is_empty() {
            return Err("summary is required: one line describing the change".into());
        }
        s
    } else {
        ""
    };
    match name {
        "search_notes" => {
            let limit = uint(&a, "limit", PAGE).clamp(1, PAGE);
            let p = ops.search(a.get("query").and_then(Value::as_str).unwrap_or(""), &strings(&a, "tags"), uint(&a, "offset", 0)).map_err(err)?;
            let has_more = p.has_more || p.hits.len() > limit;
            let notes = p.hits.iter().take(limit).map(|h| Ok(json!({"title": h.title, "snippet": h.snippet, "modified": iso(h.mtime), "tags": ops.note_tags(&h.path)?}))).collect::<anyhow::Result<Vec<_>>>().map_err(err)?;
            Ok(json!({"notes": notes, "has_more": has_more}))
        }
        "list_tags" => Ok(json!({"tags": ops.tags().map_err(err)?})),
        "read_note" => {
            let doc = ops.read(&path_of(ops, &a)?).map_err(err)?;
            let links = crate::text::extract_links(crate::frontmatter::body(&doc.text));
            let backlinks = ops.backlinks(&doc.title).map_err(err)?;
            let m = &doc.meta;
            Ok(json!({"title": doc.title, "text": doc.text, "hash": doc.hash, "created": iso(m.created), "modified": iso(m.modified), "tags": m.tags, "aliases": m.aliases, "links": links, "backlinks": backlinks}))
        }
        "create_note" => {
            let doc = ops.create(title_arg(&a, "title")?, arg(&a, "text")?, summary).map_err(err)?;
            Ok(json!({"title": doc.title, "hash": doc.hash}))
        }
        "append_to_note" => {
            let (title, text) = (title_arg(&a, "title")?, arg(&a, "text")?);
            let Some(path) = ops.find(title).map_err(err)? else {
                let doc = ops.create(title, &format!("{text}\n"), summary).map_err(err)?;
                return Ok(json!({"title": doc.title, "hash": doc.hash}));
            };
            let doc = ops.read(&path).map_err(err)?;
            let sep = if doc.text.is_empty() || doc.text.ends_with('\n') { "" } else { "\n" };
            let end = if text.ends_with('\n') { "" } else { "\n" };
            let hash = ops.write(&path, &format!("{}{sep}{text}{end}", doc.text), &doc.hash, summary).map_err(err)?;
            Ok(json!({"title": doc.title, "hash": hash}))
        }
        "edit_note" => {
            let (old, new) = (arg(&a, "old_text")?, arg(&a, "new_text")?);
            let path = path_of(ops, &a)?;
            let doc = ops.read(&path).map_err(err)?;
            let n = occurrences(&doc.text, old);
            if n != 1 {
                return Err(format!("old_text must occur exactly once in the note; it occurs {n} times. Nothing was changed."));
            }
            let hash = ops.write(&path, &doc.text.replacen(old, new, 1), &doc.hash, summary).map_err(err)?;
            Ok(json!({"title": doc.title, "hash": hash}))
        }
        "replace_note" => {
            let (text, expected) = (arg(&a, "text")?, arg(&a, "expected_hash")?);
            let path = path_of(ops, &a)?;
            let doc = ops.read(&path).map_err(err)?;
            if doc.hash != expected {
                return Err("note changed since you read it".into());
            }
            let hash = ops.write(&path, text, &doc.hash, summary).map_err(err)?;
            Ok(json!({"title": doc.title, "hash": hash}))
        }
        "list_tasks" => {
            let v = ops.tasks(a.get("query").and_then(Value::as_str).unwrap_or(""), &strings(&a, "tags"), a.get("show_done").and_then(Value::as_bool).unwrap_or(false)).map_err(err)?;
            let mut v = serde_json::to_value(v).map_err(|e| e.to_string())?;
            // tools speak titles: drop each task's file path
            for g in ["overdue", "today", "upcoming", "no_date", "done"] {
                for t in v[g].as_array_mut().into_iter().flatten().filter_map(Value::as_object_mut) {
                    t.remove("path");
                }
            }
            Ok(v)
        }
        "add_task" => {
            let mut text = arg(&a, "text")?.trim().to_string();
            if text.is_empty() {
                return Err("text is empty".into());
            }
            if a.get("title").is_some() {
                title_arg(&a, "title")?;
            }
            if let Some(d) = a.get("due").and_then(Value::as_str) {
                text = format!("{text} 📅 {}", valid_date(d)?);
            }
            let title = match a.get("title").and_then(Value::as_str) {
                Some(t) => t.to_string(),
                None => crate::settings::capture_title(&ops.settings(), &crate::tasks::local_today()),
            };
            let path = ops.capture_task(&title, &text, summary).map_err(err)?;
            let doc = ops.read(&path).map_err(err)?;
            Ok(json!({"title": doc.title, "hash": doc.hash}))
        }
        "set_task_done" => {
            let line = a.get("line").and_then(Value::as_u64).ok_or("line is required")? as usize;
            let (expected, done) = (arg(&a, "line_text")?, a.get("done").and_then(Value::as_bool).ok_or("missing done")?);
            let path = path_of(ops, &a)?;
            let doc = ops.read(&path).map_err(err)?;
            let Some(t) = crate::tasks::parse_tasks(&doc.text).into_iter().find(|t| t.line == line && t.line_text == expected) else { return Err("task-moved".into()) };
            if t.done == done {
                return Ok(json!({"title": doc.title, "status": "unchanged", "hash": doc.hash, "line": line, "line_text": t.line_text}));
            }
            let r = ops.toggle_task(&path, line, expected, summary).map_err(err)?;
            let hash = ops.read(&path).map_err(err)?.hash;
            Ok(json!({"title": doc.title, "status": "changed", "hash": hash, "line": r.line, "line_text": r.line_text}))
        }
        "rename_note" => {
            let rewrite = a.get("rewrite_links").and_then(Value::as_bool).ok_or("missing rewrite_links")?;
            let new = ops.rename(&path_of(ops, &a)?, title_arg(&a, "new_title")?, rewrite, summary).map_err(err)?;
            let doc = ops.read(&new).map_err(err)?;
            Ok(json!({"title": doc.title, "hash": doc.hash}))
        }
        "move_to_trash" => {
            let path = path_of(ops, &a)?;
            let title = ops.read(&path).map_err(err)?.title;
            ops.trash(&path, summary).map_err(err)?;
            Ok(json!({"title": title, "trashed": true}))
        }
        "daily_note" => {
            let date = match a.get("date").and_then(Value::as_str) {
                Some(d) => valid_date(d)?.to_string(),
                None => crate::tasks::local_today(),
            };
            let created = ops.find(&date).map_err(err)?.is_none();
            let doc = ops.open_or_create(&date).map_err(err)?;
            if created {
                let default = format!("Agent: created daily note {date}");
                let sum = a.get("summary").and_then(Value::as_str).filter(|s| !s.trim().is_empty()).unwrap_or(&default);
                ops.snapshot(&doc.path, sum).map_err(err)?;
            }
            Ok(json!({"title": doc.title, "text": doc.text, "created": created}))
        }
        "add_tags" | "remove_tags" => bulk_tags(ops, name == "add_tags", &a, summary),
        _ => Err("unknown tool".into()),
    }
}

/// Max notes per bulk call.
const BULK_MAX: usize = 200;

fn bulk_tags(ops: &mut dyn NoteOps, add: bool, a: &Value, summary: &str) -> Result<Value, String> {
    use crate::{frontmatter, index, text};
    let Some(titles) = a.get("titles").and_then(Value::as_array) else { return Err("titles is required".into()) };
    if titles.len() > BULK_MAX {
        return Err(format!("too many notes: {} (at most {BULK_MAX} per call). Nothing was changed.", titles.len()));
    }
    let tags: Vec<String> = strings(a, "tags").iter().map(|t| t.trim().trim_start_matches('#').to_string()).filter(|t| !t.is_empty()).collect();
    if tags.is_empty() {
        return Err("tags is required".into());
    }
    if let Some(t) = tags.iter().find(|t| !t.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '/')) || !t.chars().any(char::is_alphabetic)) {
        return Err(format!("invalid tag: {t}"));
    }
    let wfm = ops.settings().write_front_matter;
    // the new hash when the note changed
    let one = |ops: &mut dyn NoteOps, title: &str| -> Result<Option<String>, String> {
        let path = ops.find(title).map_err(err)?.ok_or("not found")?;
        let doc = ops.read(&path).map_err(err)?;
        let fm = frontmatter::parse(&doc.text);
        let new = if add {
            let have: Vec<String> = index::all_tags(frontmatter::body(&doc.text), fm.as_ref()).into_iter().map(|(f, _)| f).collect();
            let mut missing: Vec<String> = vec![];
            for t in tags.iter().filter(|t| !have.contains(&text::fold(t))) {
                if !missing.iter().any(|m| text::fold(m) == text::fold(t)) { missing.push(t.clone()); }
            }
            if missing.is_empty() {
                None
            } else if wfm {
                frontmatter::set_tags(&doc.text, &missing, &[], true)?
            } else {
                let sep = if doc.text.is_empty() || doc.text.ends_with('\n') { "" } else { "\n" };
                Some(format!("{}{sep}{}\n", doc.text, missing.iter().map(|t| format!("#{t}")).collect::<Vec<_>>().join(" ")))
            }
        } else {
            let mut cur = frontmatter::set_tags(&doc.text, &[], &tags, false)?.unwrap_or_else(|| doc.text.clone());
            let start = frontmatter::parse(&cur).map_or(0, |f| f.end);
            let mut body = cur.split_off(start);
            for t in &tags { body = text::remove_inline_tag(&body, &text::fold(t)).0; }
            cur.push_str(&body);
            Some(cur).filter(|c| *c != doc.text)
        };
        let mut changed = None;
        if let Some(new) = &new {
            changed = Some(ops.write(&path, new, &doc.hash, summary).map_err(err)?);
        }
        if !add {
            // A tag the index still sees (e.g. only in a link target) could not be removed: write what went, then fail.
            let now = new.as_deref().unwrap_or(&doc.text);
            let left = index::all_tags(frontmatter::body(now), frontmatter::parse(now).as_ref());
            if tags.iter().any(|t| left.iter().any(|(f, _)| *f == text::fold(t))) {
                return Err("tag only appears in code or a link".into());
            }
        }
        Ok(changed)
    };
    let busy = crate::agent::client::BUSY;
    let mut stop = false; // once velo said busy, the rest would only queue up behind it
    let results: Vec<Value> = titles.iter().map(|v| {
        let Some(t) = v.as_str() else { return json!({"title": v, "status": "failed", "reason": "not a title"}) };
        match if stop { Err(busy.to_string()) } else { one(ops, t) } {
            Ok(Some(hash)) => json!({"title": t, "status": "changed", "hash": hash}),
            Ok(None) => json!({"title": t, "status": "unchanged"}),
            Err(e) => {
                stop |= e == busy;
                json!({"title": t, "status": "failed", "reason": e})
            }
        }
    }).collect();
    Ok(json!({"results": results}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::ops::DirectOps;
    use std::path::{Path, PathBuf};

    fn vault(files: &[(&str, &str)]) -> (DirectOps, PathBuf) {
        let dir = tempfile::tempdir().unwrap().keep();
        for (name, text) in files {
            std::fs::write(dir.join(name), text).unwrap();
        }
        let data = tempfile::tempdir().unwrap().keep();
        (DirectOps::open(dir.clone(), &data.join("i.sqlite"), data.join("settings.json")).unwrap(), dir)
    }

    fn titles(v: &Value) -> Vec<String> {
        v["notes"].as_array().unwrap().iter().map(|n| n["title"].as_str().unwrap().to_string()).collect()
    }

    #[test] fn search_and_read_skip_locked() {
        let (mut ops, _) = vault(&[("a.md", "zebra #shared"), ("zebra secret.md.age", "zebra #secret")]);
        let got = call(&mut ops, "search_notes", json!({"query": "zebra"})).unwrap();
        assert_eq!(titles(&got), vec!["a"]);
        assert_eq!(got["notes"][0]["tags"], json!(["shared"]));
        assert_eq!(call(&mut ops, "read_note", json!({"title": "zebra secret"})), Err("not found".to_string()));
        let tags = call(&mut ops, "list_tags", json!({})).unwrap();
        assert_eq!(tags["tags"], json!([{"tag": "shared", "count": 1}]));
    }

    #[test] fn read_note_returns_fields() {
        let (mut ops, dir) = vault(&[("a.md", "---\naliases: [Alpha]\ntags: [t1]\n---\nsee [[b]] #t2"), ("b.md", "back to [[a]]"), ("c.md.age", "x")]);
        let r = call(&mut ops, "read_note", json!({"title": "alpha"})).unwrap();
        let bytes = std::fs::read(dir.join("a.md")).unwrap();
        assert_eq!(r["title"], "a");
        assert_eq!(r["text"], String::from_utf8_lossy(&bytes).as_ref());
        assert_eq!(r["hash"], crate::store::hash(&bytes));
        assert_eq!(r["aliases"], json!(["Alpha"]));
        assert_eq!(r["tags"], json!(["t2", "t1"])); // all_tags order: inline, then front matter
        assert_eq!(r["links"], json!(["b"]));
        assert_eq!(r["backlinks"], json!(["b"]));
        assert!(r["created"].is_string() && r["modified"].is_string());
    }

    #[test] fn create_refuses_existing_title_or_alias() {
        let (mut ops, dir) = vault(&[("a.md", "x"), ("b.md", "---\naliases: [Bee]\n---\n"), ("s.md.age", "x")]);
        for t in ["A", "bee", "s"] {
            assert_eq!(call(&mut ops, "create_note", json!({"title": t, "text": "new", "summary": "test"})), Err("a note with that title already exists".to_string()), "{t}");
        }
        assert_eq!(std::fs::read_to_string(dir.join("a.md")).unwrap(), "x");
        let r = call(&mut ops, "create_note", json!({"title": "C", "text": "hello [[a]]", "summary": "test"})).unwrap();
        let bytes = std::fs::read(dir.join("C.md")).unwrap();
        assert!(String::from_utf8_lossy(&bytes).ends_with("hello [[a]]"));
        assert_eq!(r["title"], "C");
        assert_eq!(r["hash"], crate::store::hash(&bytes));
    }

    #[test] fn edit_note_requires_one_exact_match() {
        let (mut ops, dir) = vault(&[("a.md", "one two two")]);
        let edit = |ops: &mut DirectOps, old: &str| call(ops, "edit_note", json!({"title": "a", "old_text": old, "new_text": "three", "summary": "test"}));
        let e0 = edit(&mut ops, "four").unwrap_err();
        assert!(e0.contains("occurs 0 times"), "{e0}");
        let e2 = edit(&mut ops, "two").unwrap_err();
        assert!(e2.contains("occurs 2 times"), "{e2}");
        assert_eq!(std::fs::read_to_string(dir.join("a.md")).unwrap(), "one two two");
        let r = edit(&mut ops, "one").unwrap();
        let bytes = std::fs::read(dir.join("a.md")).unwrap();
        assert!(String::from_utf8_lossy(&bytes).ends_with("three two two"));
        assert_eq!(r["hash"], crate::store::hash(&bytes));
    }

    #[test] fn edit_note_counts_overlapping_matches() {
        let (mut ops, dir) = vault(&[("a.md", "aaa")]);
        let e = call(&mut ops, "edit_note", json!({"title": "a", "old_text": "aa", "new_text": "b", "summary": "test"})).unwrap_err();
        assert!(e.contains("occurs 2 times"), "{e}");
        assert_eq!(std::fs::read_to_string(dir.join("a.md")).unwrap(), "aaa");
    }

    #[test] fn replace_note_needs_current_hash() {
        let (mut ops, dir) = vault(&[("a.md", "old")]);
        let h = crate::store::hash(b"old");
        assert_eq!(call(&mut ops, "replace_note", json!({"title": "a", "text": "new", "expected_hash": "stale", "summary": "test"})), Err("note changed since you read it".to_string()));
        assert_eq!(std::fs::read_to_string(dir.join("a.md")).unwrap(), "old");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "no conflict copy");
        let r = call(&mut ops, "replace_note", json!({"title": "a", "text": "new", "expected_hash": h, "summary": "test"})).unwrap();
        let bytes = std::fs::read(dir.join("a.md")).unwrap();
        assert!(String::from_utf8_lossy(&bytes).ends_with("new"));
        assert_eq!(r["hash"], crate::store::hash(&bytes));
    }

    #[test] fn append_creates_missing_note() {
        let (mut ops, dir) = vault(&[]);
        call(&mut ops, "append_to_note", json!({"title": "New", "text": "- [ ] first", "summary": "test"})).unwrap();
        let r = call(&mut ops, "append_to_note", json!({"title": "new", "text": "- [ ] second", "summary": "test"})).unwrap();
        let bytes = std::fs::read(dir.join("New.md")).unwrap();
        assert!(String::from_utf8_lossy(&bytes).ends_with("- [ ] first\n- [ ] second\n"), "{}", String::from_utf8_lossy(&bytes));
        assert_eq!(r["hash"], crate::store::hash(&bytes));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test] fn writes_require_summary() {
        let (mut ops, dir) = vault(&[("a.md", "old")]);
        let h = crate::store::hash(b"old");
        for summary in [None, Some(""), Some("  ")] {
            let with = |mut v: Value| { if let Some(s) = summary { v["summary"] = json!(s) } v };
            for (name, args) in [
                ("create_note", json!({"title": "b", "text": "x"})),
                ("append_to_note", json!({"title": "a", "text": "x"})),
                ("edit_note", json!({"title": "a", "old_text": "old", "new_text": "x"})),
                ("replace_note", json!({"title": "a", "text": "x", "expected_hash": h})),
            ] {
                assert!(call(&mut ops, name, with(args)).unwrap_err().contains("summary"), "{name} {summary:?}");
            }
        }
        assert_eq!(std::fs::read_to_string(dir.join("a.md")).unwrap(), "old");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test] fn search_page_limit_50() {
        let mut files: Vec<(String, String)> = (0..60).map(|i| (format!("n{i:02}.md"), "x".to_string())).collect();
        files.extend((0..5).map(|i| (format!("n{i:02} locked.md.age"), "x".to_string())));
        let refs: Vec<(&str, &str)> = files.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        let (mut ops, _) = vault(&refs);
        let p1 = call(&mut ops, "search_notes", json!({"limit": 500})).unwrap();
        assert_eq!(titles(&p1).len(), 50);
        assert_eq!(p1["has_more"], true);
        let p2 = call(&mut ops, "search_notes", json!({"offset": 50})).unwrap();
        assert_eq!(titles(&p2).len(), 10);
        assert_eq!(p2["has_more"], false);
        assert!(titles(&p1).iter().chain(titles(&p2).iter()).all(|t| !t.contains("locked")));
        let p3 = call(&mut ops, "search_notes", json!({"limit": 5})).unwrap();
        assert_eq!(titles(&p3).len(), 5);
        assert_eq!(p3["has_more"], true);
    }

    #[test] fn unknown_tool_errors() {
        let (mut ops, _) = vault(&[]);
        assert_eq!(call(&mut ops, "nope", json!({})), Err("unknown tool".to_string()));
    }

    fn vault_wfm(files: &[(&str, &str)], wfm: bool) -> (DirectOps, PathBuf) {
        let dir = tempfile::tempdir().unwrap().keep();
        for (name, text) in files {
            std::fs::write(dir.join(name), text).unwrap();
        }
        let data = tempfile::tempdir().unwrap().keep();
        std::fs::write(data.join("settings.json"), format!("{{\"write_front_matter\": {wfm}}}")).unwrap();
        (DirectOps::open(dir.clone(), &data.join("i.sqlite"), data.join("settings.json")).unwrap(), dir)
    }

    fn read(dir: &Path, f: &str) -> String { std::fs::read_to_string(dir.join(f)).unwrap() }

    #[test] fn add_tags_skips_inline_present() {
        let (mut ops, dir) = vault(&[("a.md", "hello #Work"), ("b.md", "---\ntags: [work]\n---\nx"), ("c.md", "plain")]);
        let r = call(&mut ops, "add_tags", json!({"titles": ["a", "b", "c"], "tags": ["#WORK"], "summary": "t"})).unwrap();
        let st: Vec<&str> = r["results"].as_array().unwrap().iter().map(|x| x["status"].as_str().unwrap()).collect();
        assert_eq!(st, ["unchanged", "unchanged", "changed"]);
        assert_eq!(read(&dir, "a.md"), "hello #Work");
        assert!(read(&dir, "c.md").contains("tags: [WORK]"), "{}", read(&dir, "c.md"));
    }

    #[test] fn add_tags_without_front_matter_setting_appends_hash_line() {
        let (mut ops, dir) = vault_wfm(&[("a.md", "text")], false);
        call(&mut ops, "add_tags", json!({"titles": ["a"], "tags": ["x", "#y"], "summary": "t"})).unwrap();
        assert_eq!(read(&dir, "a.md"), "text\n#x #y\n");
    }

    #[test] fn remove_tags_front_matter_and_inline() {
        let (mut ops, dir) = vault_wfm(&[("a.md", "---\ntags: [x, keep]\n---\nsee #x and #xylo")], false);
        let r = call(&mut ops, "remove_tags", json!({"titles": ["a"], "tags": ["X"], "summary": "t"})).unwrap();
        assert_eq!(r["results"][0]["status"], "changed");
        assert_eq!(read(&dir, "a.md"), "---\ntags: [keep]\n---\nsee and #xylo");
    }

    #[test] fn bulk_partial_failure() {
        let (mut ops, dir) = vault(&[("a.md", "one"), ("s.md.age", "x")]);
        let r = call(&mut ops, "add_tags", json!({"titles": ["a", "missing", "s"], "tags": ["t"], "summary": "t"})).unwrap();
        let rs = r["results"].as_array().unwrap();
        assert_eq!(rs[0]["status"], "changed");
        assert_eq!((rs[1]["status"].as_str(), rs[1]["reason"].as_str()), (Some("failed"), Some("not found")));
        assert_eq!((rs[2]["status"].as_str(), rs[2]["reason"].as_str()), (Some("failed"), Some("not found")));
        assert!(read(&dir, "a.md").contains("tags: [t]"));
    }

    #[test] fn remove_tags_reports_surviving_tag_and_bad_layout() {
        let (mut ops, dir) = vault(&[("a.md", "[x](#t) #t"), ("b.md", "---\ntags: [t] # c\n---\nx"), ("c.md", "[x](#t)")]);
        let r = call(&mut ops, "remove_tags", json!({"titles": ["a", "b", "c"], "tags": ["t"], "summary": "s"})).unwrap();
        let rs = r["results"].as_array().unwrap();
        assert_eq!(rs[0]["reason"], "tag only appears in code or a link");
        assert_eq!(rs[1]["reason"], "unsupported tags: layout");
        assert_eq!(rs[2]["status"], "failed");
        assert!(read(&dir, "a.md").ends_with("\n[x](#t)"), "partial removal written");
        assert_eq!(read(&dir, "b.md"), "---\ntags: [t] # c\n---\nx");
        assert_eq!(call(&mut ops, "add_tags", json!({"tags": ["t"], "summary": "s"})), Err("titles is required".to_string()));
    }

    #[test] fn bulk_over_200_rejected() {
        let (mut ops, dir) = vault(&[("a.md", "one")]);
        let titles: Vec<String> = (0..201).map(|_| "a".to_string()).collect();
        let e = call(&mut ops, "add_tags", json!({"titles": titles, "tags": ["t"], "summary": "t"})).unwrap_err();
        assert!(e.contains("200"), "{e}");
        assert_eq!(read(&dir, "a.md"), "one");
    }

    fn task_ops(files: &[(&str, &str)]) -> (DirectOps, PathBuf) {
        let (mut o, d) = vault(files);
        o.remove = |p| std::fs::remove_file(p);
        (o, d)
    }

    /// Summaries of the agent revisions of `title`, newest first.
    fn agent_revs(ops: &DirectOps, path: &str) -> Vec<String> {
        ops.vault.list_revisions(path).unwrap().into_iter().filter(|r| r.agent).map(|r| r.summary.unwrap_or_default()).collect()
    }

    fn hash_of(dir: &Path, f: &str) -> String { crate::store::hash(&std::fs::read(dir.join(f)).unwrap()) }

    #[test] fn list_tasks_excludes_locked() {
        let (mut ops, _) = task_ops(&[("a.md", "- [ ] open one"), ("b.md", "- [ ] hidden")]);
        // an unlocked locked note lists its tasks from memory in Vault::tasks: only the tool-level filter hides them
        let p = ops.find("b").unwrap().unwrap();
        let locked_path = ops.vault.lock_note(&p, &crate::crypto::new_identity()).unwrap();
        let raw = ops.vault.tasks("", &[], false).unwrap();
        assert!(raw.no_date.iter().any(|t| t.path.ends_with(".md.age")), "precondition: vault lists {locked_path:?}");
        let r = call(&mut ops, "list_tasks", json!({})).unwrap();
        assert_eq!(r["no_date"].as_array().unwrap().len(), 1);
        assert_eq!(r["no_date"][0]["title"], "a");
        assert_eq!(r["no_date"][0]["line_text"], "- [ ] open one");
        assert_eq!(r["no_date"][0]["line"], 0);
        assert!(r["no_date"][0].get("path").is_none(), "tools return titles, not paths");
        assert_eq!(r["due_count"], 0);
    }

    #[test] fn add_task_to_capture_target_and_due() {
        let (mut ops, dir) = task_ops(&[]);
        let r = call(&mut ops, "add_task", json!({"text": "buy milk", "due": "2030-01-02", "summary": "added milk"})).unwrap();
        assert_eq!(r["title"], "Inbox");
        assert_eq!(r["hash"], hash_of(&dir, "Inbox.md"));
        assert!(read(&dir, "Inbox.md").ends_with("- [ ] buy milk 📅 2030-01-02\n"), "{}", read(&dir, "Inbox.md"));
        let p = ops.find("Inbox").unwrap().unwrap();
        // created note: exactly one agent revision, holding the created text
        assert_eq!(agent_revs(&ops, &p), ["added milk"]);
        let first = ops.vault.list_revisions(&p).unwrap().into_iter().find(|r| r.agent).unwrap();
        assert!(ops.vault.read_revision(&p, &first.id, None).unwrap().contains("buy milk"));
        // existing note: one more agent revision holding the text before the write
        let r = call(&mut ops, "add_task", json!({"text": "two", "summary": "added two"})).unwrap();
        assert_eq!(agent_revs(&ops, &p), ["added two", "added milk"]);
        assert_eq!(r["hash"], hash_of(&dir, "Inbox.md"));
        call(&mut ops, "add_task", json!({"text": "three", "title": "Other", "summary": "s"})).unwrap();
        assert!(read(&dir, "Other.md").contains("- [ ] three"));
        let (mut ops, dir) = task_ops(&[("Daily.md.age", "x")]);
        assert_eq!(call(&mut ops, "add_task", json!({"text": "t", "title": "Daily", "summary": "s"})), Err("not found".to_string()));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test] fn add_task_rejects_empty_text_and_title() {
        let (mut ops, dir) = task_ops(&[]);
        assert_eq!(call(&mut ops, "add_task", json!({"text": "  ", "due": "2030-01-02", "summary": "s"})), Err("text is empty".to_string()));
        assert_eq!(call(&mut ops, "add_task", json!({"text": "t", "title": " ", "summary": "s"})), Err("title is empty".to_string()));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
    }

    #[test] fn add_task_rejects_bad_due() {
        let (mut ops, dir) = task_ops(&[]);
        for d in ["2030-02-30", "tomorrow", "2030-1-2", "2030-01-02x"] {
            let e = call(&mut ops, "add_task", json!({"text": "t", "due": d, "summary": "s"})).unwrap_err();
            assert!(e.contains("invalid date"), "{d}: {e}");
        }
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
    }

    #[test] fn set_task_done_idempotent() {
        let (mut ops, dir) = task_ops(&[("a.md", "intro\n- [ ] do it")]);
        let p = ops.find("a").unwrap().unwrap();
        let line = std::cell::Cell::new(1); // a tick may stamp front matter and shift the line
        let args = |done: bool, lt: &str, s: &str| json!({"title": "a", "line": line.get(), "line_text": lt, "done": done, "summary": s});
        let r = call(&mut ops, "set_task_done", args(false, "- [ ] do it", "noop")).unwrap();
        assert_eq!(r["status"], "unchanged");
        assert_eq!(r["hash"], hash_of(&dir, "a.md"));
        assert_eq!(read(&dir, "a.md"), "intro\n- [ ] do it");
        assert!(agent_revs(&ops, &p).is_empty(), "unchanged takes no snapshot");
        let r = call(&mut ops, "set_task_done", args(true, "- [ ] do it", "ticked")).unwrap();
        assert_eq!(r["status"], "changed");
        assert_eq!(r["hash"], hash_of(&dir, "a.md"));
        assert!(read(&dir, "a.md").contains("- [x] do it ✅"), "{}", read(&dir, "a.md"));
        assert_eq!(agent_revs(&ops, &p), ["ticked"]);
        let lt = r["line_text"].as_str().unwrap().to_string();
        line.set(r["line"].as_u64().unwrap());
        assert_eq!(call(&mut ops, "set_task_done", args(true, &lt, "noop")).unwrap()["status"], "unchanged");
        assert_eq!(agent_revs(&ops, &p), ["ticked"]);
        let r = call(&mut ops, "set_task_done", args(false, &lt, "unticked")).unwrap();
        assert_eq!(r["status"], "changed");
        assert_eq!(r["hash"], hash_of(&dir, "a.md"));
        assert_eq!(agent_revs(&ops, &p), ["unticked", "ticked"]);
        assert!(read(&dir, "a.md").contains("- [ ] do it"));
    }

    #[test] fn set_task_done_needs_line() {
        let (mut ops, _) = task_ops(&[("a.md", "- [ ] x")]);
        for line in [json!(null), json!("1"), json!(1.5)] {
            assert_eq!(call(&mut ops, "set_task_done", json!({"title": "a", "line": line, "line_text": "- [ ] x", "done": true, "summary": "s"})), Err("line is required".to_string()));
        }
    }

    #[test] fn set_task_done_line_moved_fails() {
        let (mut ops, dir) = task_ops(&[("a.md", "x\n- [ ] do it")]);
        for (line, lt) in [(0, "- [ ] do it"), (1, "- [ ] other"), (9, "- [ ] do it")] {
            assert_eq!(call(&mut ops, "set_task_done", json!({"title": "a", "line": line, "line_text": lt, "done": true, "summary": "s"})), Err("task-moved".to_string()));
        }
        assert_eq!(read(&dir, "a.md"), "x\n- [ ] do it");
    }

    #[test] fn rename_rewrites_links() {
        let (mut ops, dir) = task_ops(&[("a.md", "x"), ("b.md", "see [[a]]")]);
        let r = call(&mut ops, "rename_note", json!({"title": "a", "new_title": "z", "rewrite_links": true, "summary": "renamed"})).unwrap();
        assert_eq!(r["title"], "z");
        assert_eq!(r["hash"], hash_of(&dir, "z.md"));
        assert!(dir.join("z.md").exists() && !dir.join("a.md").exists());
        assert_eq!(read(&dir, "b.md"), "see [[z]]");
        let p = ops.find("z").unwrap().unwrap();
        assert_eq!(agent_revs(&ops, &p), ["renamed"]);
        // the link source changed too: its previous text is an agent revision with the summary
        let b = ops.find("b").unwrap().unwrap();
        assert_eq!(agent_revs(&ops, &b), ["renamed"]);
        let rev = ops.vault.list_revisions(&b).unwrap().into_iter().find(|r| r.agent).unwrap();
        assert_eq!(ops.vault.read_revision(&b, &rev.id, None).unwrap(), "see [[a]]");
        assert_eq!(call(&mut ops, "rename_note", json!({"title": "a", "new_title": "q", "rewrite_links": true, "summary": "s"})), Err("not found".to_string()));
    }

    #[test] fn trash_moves_out_and_keeps_revisions() {
        let (mut ops, dir) = task_ops(&[("a.md", "bye"), ("s.md.age", "x")]);
        let p = ops.find("a").unwrap().unwrap();
        let r = call(&mut ops, "move_to_trash", json!({"title": "A", "summary": "cleanup"})).unwrap();
        assert_eq!(r["title"], "a", "the resolved title");
        assert!(!dir.join("a.md").exists());
        assert_eq!(ops.vault.list_revisions(&p).unwrap()[0].summary.as_deref(), Some("cleanup"));
        assert_eq!(call(&mut ops, "move_to_trash", json!({"title": "s", "summary": "c"})), Err("not found".to_string()));
        assert!(dir.join("s.md.age").exists());
    }

    #[test] fn daily_note_creates_today() {
        let (mut ops, dir) = task_ops(&[]);
        let today = crate::tasks::local_today();
        let r = call(&mut ops, "daily_note", json!({})).unwrap();
        assert_eq!((r["title"].as_str(), r["created"].as_bool()), (Some(today.as_str()), Some(true)));
        assert!(dir.join(format!("{today}.md")).exists());
        let p = ops.find(&today).unwrap().unwrap();
        assert_eq!(agent_revs(&ops, &p), [format!("Agent: created daily note {today}")]);
        assert_eq!(call(&mut ops, "daily_note", json!({"summary": "again"})).unwrap()["created"], false);
        assert_eq!(agent_revs(&ops, &p).len(), 1);
        call(&mut ops, "daily_note", json!({"date": "2031-07-08", "summary": "mine"})).unwrap();
        let p2 = ops.find("2031-07-08").unwrap().unwrap();
        assert_eq!(agent_revs(&ops, &p2), ["mine"]);
        assert_eq!(call(&mut ops, "daily_note", json!({"date": "2031-05-06"})).unwrap()["title"], "2031-05-06");
        assert!(call(&mut ops, "daily_note", json!({"date": "2031-13-06"})).unwrap_err().contains("invalid date"));
    }
}

#[cfg(test)]
mod fix_tests {
    use super::*;
    use crate::agent::ops::DirectOps;

    fn vault(files: &[(&str, &str)]) -> (DirectOps, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap().keep();
        for (name, text) in files {
            std::fs::write(dir.join(name), text).unwrap();
        }
        let data = tempfile::tempdir().unwrap().keep();
        (DirectOps::open(dir.clone(), &data.join("i.sqlite"), data.join("settings.json")).unwrap(), dir)
    }

    fn read(dir: &std::path::Path, f: &str) -> String { std::fs::read_to_string(dir.join(f)).unwrap() }

    fn titles(v: &Value) -> Vec<String> {
        v["notes"].as_array().unwrap().iter().map(|n| n["title"].as_str().unwrap().to_string()).collect()
    }

    #[test] fn rename_onto_existing_title_says_so() {
        let (mut ops, dir) = vault(&[("a.md", "x"), ("b.md", "y")]);
        let r = call(&mut ops, "rename_note", json!({"title": "a", "new_title": "B", "rewrite_links": false, "summary": "s"}));
        assert_eq!(r, Err("a note with that title already exists".to_string()));
        assert!(dir.join("a.md").exists());
    }

    #[test] fn titles_without_a_usable_name_are_rejected_before_any_write() {
        let (mut ops, dir) = vault(&[("a.md", "x")]);
        for t in ["...", " . . "] {
            for (name, args) in [
                ("create_note", json!({"title": t, "text": "x", "summary": "s"})),
                ("append_to_note", json!({"title": t, "text": "x", "summary": "s"})),
                ("add_task", json!({"title": t, "text": "x", "summary": "s"})),
                ("rename_note", json!({"title": "a", "new_title": t, "rewrite_links": false, "summary": "s"})),
            ] {
                assert_eq!(call(&mut ops, name, args), Err(format!("invalid title: {t}")), "{name} {t:?}");
            }
        }
        let names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["a.md"]);
        // a leading dot is fine: the file is not hidden
        call(&mut ops, "create_note", json!({"title": ".net", "text": "x", "summary": "s"})).unwrap();
        assert!(dir.join("-net.md").exists());
    }

    #[test] fn bulk_reports_non_string_titles() {
        let (mut ops, _) = vault(&[("a.md", "x")]);
        let r = call(&mut ops, "add_tags", json!({"titles": ["a", 7, null], "tags": ["t"], "summary": "s"})).unwrap();
        let rs = r["results"].as_array().unwrap();
        assert_eq!(rs.len(), 3);
        assert_eq!(rs[0]["status"], "changed");
        assert_eq!((rs[1]["status"].as_str(), rs[1]["reason"].as_str(), &rs[1]["title"]), (Some("failed"), Some("not a title"), &json!(7)));
        assert_eq!(rs[2]["reason"], "not a title");
    }

    /// `X.md` beside `X.md.age` (lock synced in before the delete, or a lock that failed to remove the plaintext).
    #[test] fn plain_twin_of_locked_note_is_hidden() {
        let (mut ops, dir) = vault(&[("X.md", "the secret plan #hush #shared\n- [ ] secret task\nsee [[A]]\n"), ("A.md", "a #shared\n")]);
        call(&mut ops, "list_tags", json!({})).unwrap();
        std::fs::write(dir.join("X.md.age"), "ciphertext").unwrap();
        ops.rescan();
        for name in ["read_note", "move_to_trash", "set_task_done", "edit_note", "replace_note"] {
            let args = json!({"title": "X", "summary": "s", "line": 1, "line_text": "- [ ] secret task", "done": true, "old_text": "plan", "new_text": "p", "text": "t", "expected_hash": "h"});
            assert_eq!(call(&mut ops, name, args), Err("not found".to_string()), "{name}");
        }
        assert_eq!(call(&mut ops, "rename_note", json!({"title": "X", "new_title": "Y", "rewrite_links": false, "summary": "s"})), Err("not found".to_string()));
        assert_eq!(call(&mut ops, "add_task", json!({"title": "X", "text": "t", "summary": "s"})), Err("not found".to_string()));
        let r = call(&mut ops, "add_tags", json!({"titles": ["X"], "tags": ["t"], "summary": "s"})).unwrap();
        assert_eq!(r["results"][0]["reason"], "not found");
        assert!(titles(&call(&mut ops, "search_notes", json!({"query": "secret"})).unwrap()).is_empty());
        assert_eq!(call(&mut ops, "list_tags", json!({})).unwrap()["tags"], json!([{"tag": "shared", "count": 1}]));
        assert_eq!(call(&mut ops, "list_tasks", json!({})).unwrap()["no_date"], json!([]));
        assert_eq!(call(&mut ops, "read_note", json!({"title": "A"})).unwrap()["backlinks"], json!([]));
        assert_eq!(read(&dir, "X.md"), "the secret plan #hush #shared\n- [ ] secret task\nsee [[A]]\n");
    }

    #[test] fn remove_tags_keeps_links_code_and_paragraphs() {
        let (mut ops, dir) = vault(&[("A.md", "read [the #work notes](http://x) and [[Plan #work]]\n\n    code #work here\n"), ("B.md", "Some paragraph\n- #work\n- [ ] #work\n")]);
        let r = call(&mut ops, "remove_tags", json!({"titles": ["A", "B"], "tags": ["work"], "summary": "s"})).unwrap();
        assert_eq!(r["results"][0]["reason"], "tag only appears in code or a link");
        assert_eq!(read(&dir, "A.md"), "read [the #work notes](http://x) and [[Plan #work]]\n\n    code #work here\n");
        assert_eq!(r["results"][1]["status"], "changed");
        assert!(read(&dir, "B.md").ends_with("---\nSome paragraph\n"));
    }

    #[test] fn bulk_tag_results_carry_the_new_hash() {
        let (mut ops, dir) = vault(&[("a.md", "one\n"), ("b.md", "two #t\n")]);
        let r = call(&mut ops, "add_tags", json!({"titles": ["a", "b"], "tags": ["t"], "summary": "s"})).unwrap();
        assert_eq!(r["results"][0]["hash"], crate::store::hash(&std::fs::read(dir.join("a.md")).unwrap()));
        assert_eq!(r["results"][1], json!({"title": "b", "status": "unchanged"}));
        let r = call(&mut ops, "remove_tags", json!({"titles": ["b"], "tags": ["t"], "summary": "s"})).unwrap();
        assert_eq!(r["results"][0]["hash"], crate::store::hash(&std::fs::read(dir.join("b.md")).unwrap()));
    }

    /// The file write lands, then indexing fails (SQLite busy or broken): a plain error would invite a retry that
    /// appends twice.
    #[test] fn failure_after_the_write_landed_is_not_retryable() {
        let dir = tempfile::tempdir().unwrap().keep();
        std::fs::write(dir.join("A.md"), "a\n").unwrap();
        std::fs::write(dir.join("B.md"), "- [ ] t\n").unwrap();
        let data = tempfile::tempdir().unwrap().keep();
        let db = data.join("i.sqlite");
        let mut ops = DirectOps::open(dir.clone(), &db, data.join("settings.json")).unwrap();
        rusqlite::Connection::open(&db).unwrap().execute_batch("CREATE TRIGGER boom BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT, 'boom'); END;").unwrap();
        let na = crate::agent::client::NO_ANSWER.to_string();
        assert_eq!(call(&mut ops, "append_to_note", json!({"title": "A", "text": "once", "summary": "s"})), Err(na.clone()));
        assert!(read(&dir, "A.md").ends_with("\na\nonce\n"), "it did land");
        assert_eq!(call(&mut ops, "add_task", json!({"title": "A", "text": "x", "summary": "s"})), Err(na.clone()));
        assert_eq!(call(&mut ops, "add_task", json!({"title": "New", "text": "x", "summary": "s"})), Err(na.clone()));
        assert_eq!(call(&mut ops, "set_task_done", json!({"title": "B", "line": 0, "line_text": "- [ ] t", "done": true, "summary": "s"})), Err(na.clone()));
        assert_eq!(call(&mut ops, "create_note", json!({"title": "C", "text": "c", "summary": "s"})), Err(na));
        // nothing written: the plain error stays
        assert_eq!(call(&mut ops, "edit_note", json!({"title": "A", "old_text": "zzz", "new_text": "y", "summary": "s"})).unwrap_err().contains("0 times"), true);
    }
}
