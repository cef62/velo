# Archived notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Archive and unarchive notes; archived notes leave every listing (app and MCP) until "show archived" is on, and then show dimmed with an "archived" badge.

**Architecture:** The archived state is a title list in `<notes folder>/.velo/archived`, owned by a new module `src-tauri/src/archive.rs`. Each `Index` connection mirrors the list into a per-connection `TEMP` table `archived(title_folded)`, and every listing query gains one SQL condition against it, so paging, `has_more` and totals stay in SQL. The table is keyed by folded title, not by path, so rescans, watcher batches, lock and unlock need no refresh: a re-indexed file matches by its title. `Vault` reads the (tiny) list file at the start of every query method and reloads the table only when the entries differ from the ones loaded; it rewrites the file itself on archive, rename, delete, merge and note creation. Every listing takes `include_archived: bool`: the front end passes the `show_archived` setting, MCP passes its per-call flag.

**Tech Stack:** Tauri 2 (Rust, rusqlite), React 19, Park UI v1 / Panda CSS 1.12.1, Vitest. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-12-velo-archived-notes-design.md`

## Global Constraints

- List file: `<notes folder>/.velo/archived`, UTF-8 (read lossily), one title per line, `\n` line ends, no header. Parsing: strip a leading BOM, split on `\n`, strip one trailing `\r`, skip empty lines, never `trim` (titles keep their spaces). A missing file means nothing is archived. velo creates the file on the first archive.
- Entries match titles case-folded with `crate::text::fold` (what fills the `title_folded` column).
- Entries are removed only by velo's own events: unarchive, delete, merge source, a title coming into being (creation, or a rename of a non-archived note onto it); a rename of an archived note moves the entry. An entry that matches no note is kept and ignored (no pruning). Writes are atomic (temporary file, then rename) and re-read the file first.
- Archiving never changes a note file, its content or its dates. It never needs the passphrase and writes no plaintext.
- Not filtered in any state: link resolution (`list_titles`, `find_titles`), the "does this title exist" checks (search Create hint, `[[` Create row), opening by path, title uniqueness, the "No links" condition, the centre of a connections query (its own Related panel, counts included).
- Filtered always, with no flag: MCP `read_note.backlinks` leaves out archived titles (agents use `get_connections` with `include_archived` to see them).
- A task added to an archived note (quick capture, MCP `add_task`) stays hidden with the note. Intended.
- A failed list write never fails a rename, delete, merge or create: the note operation succeeds, the failure is logged and shown through the `archive-error` event (Tasks 4, 6, 7). Archive and unarchive return the error.
- An unreadable list (exists, cannot be read): velo keeps the last loaded set; at cold start nothing is loaded, so archived notes show until it can be read (accepted limit). Log only: one line per vault (`crate::log::line` and `eprintln!`), not per query, and no UI event. The `archive-error` event is for write failures only.
- A title containing `\n` or ending in `\r` cannot be archived (it would read back as other titles): `archive::update` refuses it and writes nothing.
- The temporary file is `.velo/archived.<pid>.tmp`, unique per process, so the app and `velo --mcp` never share one.
- Archive acts on the open note only (palette, shortcut and `⋯` menu alike) and is disabled when none is open. A locked note is opened (passphrase) first; archiving itself never decrypts or rewrites the file (`set_archived` takes a path and needs no key).
- Setting key `show_archived: bool`, default `false`. The Rust side never reads it. MCP ignores it and takes its own `include_archived` (default `false`) on `search_notes`, `list_tasks`, `list_tags`, `get_connections` only.
- New actions `toggle_archived` and `archive_note`, both default `NONE`.
- Copy (exact): palette and `⋯` menu "Archive note" / "Unarchive note"; shortcut label "Archive / unarchive note"; toggle label "Show / hide archived notes"; badge text "archived"; hidden line "`N` archived note hidden" / "`N` archived notes hidden".
- `styled-system/` is generated: never edit it. Panda stays at 1.12.1.
- Never run the app (`pnpm tauri dev`, the built binary): it uses the owner's notes. UI checks run in the browser demo only.
- Per task: `cd src-tauri && cargo test -q`, `pnpm test`. Per PR: the full quality gate in `CONTRIBUTING.md`.
- Commit trailer, exactly:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012ZCdCHUHMtHSdiKruTKX7n
  ```

## PR split

| PR | Branch | Tasks | Ships to users |
|---|---|---|---|
| 1 | `feat/archived-notes-backend` | 1-9 | Nothing visible in the app: no UI can archive, no changeset (nothing can be archived before PR 2). The README's MCP section names `include_archived` and the tool reference is regenerated, so gate row 3 holds. A hand-made `.velo/archived` already works end to end, and MCP gains the flag. A release cut between the PRs is safe. |
| 2 | `feat/archived-notes-ui` (from `main` after PR 1) | 10-13 | The whole feature, one `minor` changeset, README. |

## Review Focus

1. **Two files with one title** (`Foo.md` beside `Foo.md.age`, or `Foo.md` plus `Foo.txt`): one entry hides both. Renaming one of them must keep the other archived. MCP `list_tags`, which subtracts a locked note's plain-twin tags, must not subtract them a second time when the twin is already hidden. Tests: Task 4 `rename_of_one_twin_keeps_the_other_archived`, Task 8 `list_tags_does_not_double_subtract_an_archived_twin`.
2. **List file edited by hand or deleted while velo runs:** the next query reflects it, with no restart. Test: Task 3 `hand_edit_and_delete_of_list_seen_at_next_query`.
3. **A note archived in the app, then renamed by an agent while the app is open** (app mode, `AppOps`): it stays archived under the new title. Test: Task 8 `agent_rename_in_app_mode_keeps_archived`.
4. **Title case, whitespace and encoding:** the entry `meeting notes` (CRLF line end, BOM) archives `Meeting Notes.md`; `Foo ` (trailing space) archives `Foo .md` and not `Foo.md`; a bad byte does not fail queries; a case-only rename keeps it archived. Tests: Task 1 `read_parses_bom_crlf_and_keeps_spaces`, Task 4 `case_only_rename_keeps_archived`.
5. **Stale entry re-archives a new note:** a note archived, then deleted or renamed in Finder, leaves its title in the list; a new note created later with that title, or a note renamed to it, must not appear archived. Tests: Task 4 `stale_entry_is_kept_and_ignored_and_creation_clears_it`, `rename_onto_a_stale_entry_is_not_archived`.

---

## PR 1: backend (`feat/archived-notes-backend`)

### Task 1: The list file module

**Files:**
- Create: `src-tauri/src/archive.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod archive;` with the other `pub mod` lines)
- Test: inline `#[cfg(test)] mod tests` in `src-tauri/src/archive.rs`

**Interfaces:**
- Produces:
  - `pub const FILE: &str = ".velo/archived";`
  - `pub fn parse(text: &str) -> Vec<String>`: strip a leading `\u{feff}`, split on `\n`, strip one trailing `\r` per line, skip empty lines, no `trim`.
  - `pub fn read(dir: &Path) -> std::io::Result<Vec<String>>`: missing file is `Ok(vec![])`; bytes decoded with `String::from_utf8_lossy`, then `parse`, then de-duplicated by `fold` (first spelling wins), so a hand or sync-tool duplicate never reaches the index twice. Only an I/O error (permissions) is `Err`.
  - `pub fn update(dir: &Path, change: impl FnOnce(&mut Vec<String>)) -> std::io::Result<Vec<String>>`: re-reads the file, applies `change`, keeps the first of entries that fold the same (no pruning: an entry naming no note stays), refuses (`ErrorKind::InvalidInput`, nothing written) when an entry contains `\n` or ends in `\r`, writes each entry followed by `\n` (an empty list writes an empty file) through `.velo/archived.<std::process::id()>.tmp` plus rename (creating `.velo/` if needed, like `settings::save`). Returns the entries now in effect. No write when the result equals what was read, so a missing file stays missing while nothing is archived.
- Do not use `Store::write_atomic`: it records a self-write the non-recursive watcher never consumes.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn read_missing_is_empty() { let d = tempfile::tempdir().unwrap(); assert_eq!(read(d.path()).unwrap(), Vec::<String>::new()); }
#[test] fn read_parses_bom_crlf_and_keeps_spaces() {
    assert_eq!(parse("\u{feff}meeting notes\r\n\nFoo \n \nBar"), ["meeting notes", "Foo ", " ", "Bar"]);
    let d = tempfile::tempdir().unwrap(); std::fs::create_dir(d.path().join(".velo")).unwrap();
    std::fs::write(d.path().join(FILE), b"A\n\xff\xfe\nB\n").unwrap(); // a bad byte: lossy, never an error
    assert_eq!(read(d.path()).unwrap(), ["A", "\u{fffd}\u{fffd}", "B"]);
}
#[test] fn update_creates_file_and_dir() {
    let d = tempfile::tempdir().unwrap();
    assert_eq!(update(d.path(), |e| e.push("A".into())).unwrap(), ["A"]);
    assert_eq!(std::fs::read_to_string(d.path().join(FILE)).unwrap(), "A\n");
    assert_eq!(std::fs::read_dir(d.path().join(".velo")).unwrap().count(), 1); // no temp file left
}
#[test] fn read_dedupes_by_fold() {
    let d = tempfile::tempdir().unwrap(); std::fs::create_dir(d.path().join(".velo")).unwrap();
    std::fs::write(d.path().join(FILE), "Foo\nfoo\nFOO\nBar\n").unwrap();
    assert_eq!(read(d.path()).unwrap(), ["Foo", "Bar"]);
}
#[test] fn update_refuses_titles_with_line_breaks() {
    let d = tempfile::tempdir().unwrap();
    for bad in ["A\nB", "A\r"] {
        let e = update(d.path(), |e| e.push(bad.into())).unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::InvalidInput);
    }
    assert!(!d.path().join(".velo").exists());
}
#[test] fn update_keeps_unknown_and_drops_duplicate_entries() {
    let d = tempfile::tempdir().unwrap(); std::fs::create_dir(d.path().join(".velo")).unwrap();
    std::fs::write(d.path().join(FILE), "Gone\nA\na\n").unwrap();
    assert_eq!(update(d.path(), |e| e.push("B".into())).unwrap(), ["Gone", "A", "B"]);
}
#[test] fn update_without_change_writes_nothing() {
    let d = tempfile::tempdir().unwrap();
    assert!(update(d.path(), |_| {}).unwrap().is_empty());
    assert!(!d.path().join(".velo").exists());
}
#[test] fn update_rereads_the_file() { // another process's entry, written after our last read, survives our write
    let d = tempfile::tempdir().unwrap();
    update(d.path(), |e| e.push("A".into())).unwrap();
    std::fs::write(d.path().join(FILE), "A\nB\n").unwrap();
    assert_eq!(update(d.path(), |e| e.retain(|t| t != "A")).unwrap(), ["B"]);
}
```

- [ ] **Step 2: Run, see them fail.** `cd src-tauri && cargo test -q archive::` → FAIL (module missing).
- [ ] **Step 3: Implement** the four items above.
- [ ] **Step 4: Run, see them pass.** Same command → PASS.
- [ ] **Step 5: Commit** `feat(archive): .velo/archived list file`.

### Task 2: Index hides archived titles

**Files:**
- Modify: `src-tauri/src/index.rs` (`Hit`, `Page`, `TaskRow`, `LinkTarget` untouched, `NodeRow`, `Index::open`, `search_page`, `search_page_where`, `tags`, `task_rows`, `link_targets`, `tag_notes`, `node`, new methods)
- Modify: `src-tauri/src/tasks.rs` (`TaskItem.archived`, filled in `group_tasks` from `TaskRow.archived`)
- Modify: every `TaskRow {`, `Hit {`, `Page {` literal the compiler flags (7, 3 and 5 sites today, in `index.rs`, `vault.rs`, `tasks.rs`, `agent/ops.rs` and tests)
- Test: `src-tauri/src/index.rs` tests

**Interfaces:**
- Consumes: nothing from Task 1 (the index only sees titles).
- Produces:
  - In `Index::open`, after `execute_batch(SCHEMA)`: `CREATE TEMP TABLE IF NOT EXISTS archived(title_folded TEXT PRIMARY KEY)`. TEMP: per connection, never written to the shared index file, never takes its write lock, no `SCHEMA_VERSION` bump and no reindex.
  - `pub fn set_archived(&self, titles: &[String]) -> anyhow::Result<()>`: in one `self.db.unchecked_transaction()`, `DELETE FROM temp.archived` then `INSERT OR IGNORE` the `fold` of each title, then commit. A duplicate never errors; any failure rolls back and leaves the previous rows. Never called inside a `begin()` batch (`debug_assert!(!self.in_batch())`): a nested transaction fails and a batch rollback would undo it.
  - `pub fn archived_titles(&self) -> anyhow::Result<HashSet<String>>` (folded).
  - `pub fn archived_paths(&self) -> anyhow::Result<HashSet<String>>`: indexed paths whose `title_folded` is in the table.
  - `Hit.archived: bool`, `TaskRow.archived: bool`, `TaskItem.archived: bool`, `NodeRow.archived: bool` (from `title_folded IN (SELECT title_folded FROM temp.archived)`).
  - `Page.hidden: usize` (filled by `Vault::search_where`, Task 3; `0` from the index).
  - `#[allow(clippy::too_many_arguments)] pub fn search_page_where(&self, query, sort, offset, limit, tags, unlocked, no_links: bool, include_archived: bool) -> anyhow::Result<Page>`: when `!include_archived`, `tag_cond` appends ` AND {p}title_folded NOT IN (SELECT title_folded FROM temp.archived)` (one hook, so groups 0, 1 and `sql_count` all follow), and `unlocked_hits` skips a note whose folded title is archived. Each returned hit has `archived` set from `archived_titles()`. The `no_links` subqueries stay unfiltered. `search_page` passes `false`.
  - `pub fn tags(&self, include_archived: bool)`, `pub fn task_rows(&self, tags: &[String], include_archived: bool)`, `pub fn link_targets(&self, include_archived: bool)`, `pub fn tag_notes(&self, tag_folded: &str, limit: usize, include_archived: bool)`: when `false`, leave out rows whose note path is in `SELECT n.path FROM notes n JOIN temp.archived a ON a.title_folded = n.title_folded`.
  - Unchanged on purpose: `titles`, `find_titles`, `find_title`, `names`, `linked_from`, `backlinks`.

- [ ] **Step 1: Write the failing tests** (use the existing `idx` / `idx_owned` helpers)

```rust
#[test] fn archived_paging_and_totals() {
    let notes: Vec<(String, String, i64)> = (0..450).map(|n| (format!("n{n:03}.md"), String::new(), n)).collect();
    let i = idx_owned(&notes);
    i.set_archived(&(0..300).map(|n| format!("N{n:03}")).collect::<Vec<_>>()).unwrap(); // case differs from the files
    for (inc, want) in [(false, 150), (true, 450)] {
        for sort in [Sort::Modified, Sort::Title] {
            let first = i.search_page_where("", sort, 0, 200, &[], &HashMap::new(), false, inc).unwrap();
            assert_eq!(first.total, want);
            let (mut all, mut off) = (vec![], 0);
            loop { let pg = i.search_page_where("", sort, off, 200, &[], &HashMap::new(), false, inc).unwrap(); off += pg.hits.len(); all.extend(pg.hits); if !pg.has_more { break } }
            assert_eq!(all.len(), want);
            assert_eq!(all.iter().filter(|h| h.archived).count(), if inc { 300 } else { 0 });
        }
    }
}
#[test] fn failed_reload_keeps_the_previous_table() {
    let i = idx(&[("A.md", "", 1), ("B.md", "", 2)]);
    i.set_archived(&["A".into()]).unwrap();
    i.raw().execute_batch("CREATE TEMP TRIGGER boom BEFORE INSERT ON archived WHEN NEW.title_folded = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END;").unwrap();
    assert!(i.set_archived(&["B".into(), "boom".into()]).is_err()); // rolls back
    assert_eq!(i.archived_titles().unwrap(), HashSet::from(["a".to_string()]));
}
#[test] fn duplicate_titles_hide_and_do_not_error() {
    let i = idx(&[("Foo.md", "", 1), ("Bar.md", "", 2)]);
    i.set_archived(&["Foo".into(), "foo".into()]).unwrap();
    assert_eq!(i.search_page_where("", Sort::Title, 0, 10, &[], &HashMap::new(), false, false).unwrap().total, 1);
}
#[test] fn archived_hidden_from_query_groups_and_tags() {
    let i = idx(&[("Plan.md", "garden #t", 1), ("x.md", "garden plan #t", 2), ("y.md", "#t", 3)]);
    i.set_archived(&["plan".into(), "X".into()]).unwrap();
    assert!(i.search_page_where("plan", Sort::Title, 0, 10, &[], &HashMap::new(), false, false).unwrap().hits.is_empty());
    assert_eq!(i.tags(false).unwrap(), vec![TagCount { tag: "t".into(), count: 1 }]);
    assert_eq!(i.tags(true).unwrap(), vec![TagCount { tag: "t".into(), count: 3 }]);
    assert_eq!(i.tag_notes("t", 10, false).unwrap(), (1, vec!["y.md".to_string()]));
}
#[test] fn archived_unlocked_note_follows_the_flag() {
    let mut i = idx(&[]);
    i.upsert("s.md.age", &NoteFile { title: "s".into(), encrypted: true }, &Meta { mtime: 1, size: 1, birth: 0 }, None).unwrap();
    let u: HashMap<String, String> = [("s.md.age".to_string(), "secretword".to_string())].into();
    i.set_archived(&["S".into()]).unwrap();
    assert!(i.search_page_where("secretword", Sort::Title, 0, 10, &[], &u, false, false).unwrap().hits.is_empty());
    let h = i.search_page_where("secretword", Sort::Title, 0, 10, &[], &u, false, true).unwrap();
    assert!(h.hits[0].archived && h.total == 1);
}
#[test] fn no_links_ignores_archive_state() { // A links only to archived B: still not an orphan
    let i = idx(&[("A.md", "[[B]]", 1), ("B.md", "", 2), ("C.md", "", 3)]);
    i.set_archived(&["B".into()]).unwrap();
    let p = i.search_page_where("", Sort::Title, 0, 10, &[], &HashMap::new(), true, false).unwrap();
    assert_eq!(p.hits.iter().map(|h| h.path.as_str()).collect::<Vec<_>>(), ["C.md"]);
}
#[test] fn link_targets_and_tasks_follow_flag_titles_do_not() {
    let i = idx(&[("A.md", "- [ ] t", 1), ("B.md", "- [ ] u", 2)]);
    i.set_archived(&["a".into()]).unwrap();
    assert_eq!(i.link_targets(false).unwrap().len(), 1);
    assert_eq!(i.link_targets(true).unwrap().len(), 2);
    assert_eq!(i.task_rows(&[], false).unwrap().len(), 1);
    assert!(i.task_rows(&[], true).unwrap().iter().any(|r| r.archived && r.path == "A.md"));
    assert_eq!(i.titles().unwrap().len(), 2); // link resolution and uniqueness keep archived titles
}
```

- [ ] **Step 2: Run, see them fail.** `cd src-tauri && cargo test -q index::` → FAIL (missing methods and parameters).
- [ ] **Step 3: Implement** the Interfaces. Fix every caller the compiler flags by passing `false` for now (Task 3 threads the real value).
- [ ] **Step 4: Run, see them pass.** `cargo test -q` → all PASS, the existing paging, total and `no_links` tests included.
- [ ] **Step 5: Commit** `feat(index): hide archived titles in listings`.

### Task 3: Vault filters, sync and the archive call

**Files:**
- Modify: `src-tauri/src/vault.rs` (`Vault` struct and `open_with_progress`, `TimelineRow`, `NoteDoc`, `search`, `search_where`, `timeline`, `tasks`, `tags`, `link_targets`, `open_note`, new methods)
- Modify (pass `false` until Tasks 6 and 8): `commands.rs:576` (`timeline`), `:611` (`search_where`), `:616` (`tags`), `:626` (`link_targets`), `:675` (`tasks`); `export.rs:50` and its test `:141` (`timeline`); `agent/ops.rs:183`, `:200`, `:218`; `agent/tools.rs` test `:732` (`vault.tasks`); `vault.rs` tests `:896`, `:902`, `:903` (`timeline`).
- Test: `src-tauri/src/vault.rs` tests (`setup`, `open` helpers)

**Interfaces:**
- Consumes: Task 1 `archive::{read, update}`; Task 2 `Index::{set_archived, archived_titles}` and the `include_archived` parameters.
- Produces:
  - `Vault.archive_loaded: std::cell::RefCell<Vec<String>>`, initially empty (matches the empty TEMP table). `RefCell` keeps `Vault: Send` (it sits in `Mutex<Option<Vault>>`); the methods below stay `&self`.
  - `pub fn sync_archive(&self)`: `archive::read` the list (a few hundred bytes); when the entries differ from `archive_loaded`, `index.set_archived` and replace `archive_loaded`. No mtime stamp, so an equal-size change in one timestamp tick (another process, coarse-mtime volumes) is never missed. A read error (permissions) keeps the loaded set (empty at cold start: archived notes show, the accepted limit) and is retried at the next query; the first failure for this vault is logged (`crate::log::line` and `eprintln!`), later ones are silent (`archive_read_logged: Cell<bool>`); a read failure never touches `archive_error`. A reload that fails in `set_archived` also keeps `archive_loaded` unchanged, so the next query retries.
  - `pub archive_error: std::cell::Cell<Option<String>>` on `Vault`: the latest list-write failure (Task 4), latest wins by intent (one message is enough to tell the owner the list is stuck); `take()` reads and clears it; Task 6 emits it. Only write commands emit, so no query command needs to.
  - `sync_archive` is called first in `search_where`, `timeline`, `tasks`, `tags`, `link_targets`, `connections` (Task 5) and `open_note`. Rescan and `apply_fs_changes` need no call: the table is title-keyed.
  - `fn archive_edit(&mut self, change: impl FnOnce(&mut Vec<String>)) -> anyhow::Result<()>`: `archive::update`, then `index.set_archived(&entries)` and `archive_loaded` set to them.
  - `pub fn set_archived(&mut self, path: &str, on: bool) -> anyhow::Result<()>`: `self.note(path)?` validates the path (webview input); adds the title, or removes every entry folding to it. Never reads or decrypts the note.
  - `NoteDoc.archived: bool` (set in `open_note`), `TimelineRow.archived: bool` (from `Hit.archived`).
  - `pub fn search_where(&self, query, sort, offset, tags, no_links: bool, include_archived: bool) -> anyhow::Result<Page>`: when `!include_archived && offset == 0`, `page.hidden = <same call with include_archived = true and limit 0>.total - page.total` (limit 0 still returns `total`).
  - `pub fn timeline(&self, query, tags, no_links: bool, include_archived: bool, by, since_ms)`, `pub fn tasks(&self, query, tags, show_done: bool, include_archived: bool)` (the unlocked loop skips an archived title unless included and sets `TaskRow.archived`), `pub fn tags(&self, include_archived: bool)`, `pub fn link_targets(&self, include_archived: bool)`. `search` passes `false, false`.

- [ ] **Step 1: Write the failing tests**

```rust
fn shown(v: &Vault) -> Vec<String> { v.search_where("", Sort::Title, 0, &[], false, false).unwrap().hits.into_iter().map(|h| h.title).collect() }
#[test] fn archive_hides_in_search_timeline_tasks_tags_and_counts_hidden() {
    let (dir, db) = setup();
    for (n, b) in [("Meeting", "agenda #w\n- [ ] ask"), ("Other", "agenda #w")] { std::fs::write(dir.join(format!("{n}.md")), b).unwrap(); }
    let mut v = open(dir.clone(), &db, None).unwrap();
    v.set_archived(&s(&dir.join("Meeting.md")), true).unwrap();
    let p = v.search_where("agenda", Sort::Title, 0, &[], false, false).unwrap();
    assert_eq!((p.hits.len(), p.total, p.hidden), (1, 1, 1));
    let p = v.search_where("agenda", Sort::Title, 0, &[], false, true).unwrap();
    assert_eq!((p.total, p.hidden, p.hits.iter().filter(|h| h.archived).count()), (2, 0, 1));
    assert_eq!(v.timeline("", &[], false, false, TimelineBy::Updated, None).unwrap().len(), 1);
    assert!(v.timeline("", &[], false, true, TimelineBy::Updated, None).unwrap().iter().any(|r| r.archived));
    assert!(v.tasks("", &[], false, false).unwrap().no_date.is_empty());
    assert!(v.tasks("", &[], false, true).unwrap().no_date[0].archived);
    assert_eq!(v.tags(false).unwrap()[0].count, 1);
    assert!(v.open_note(&s(&dir.join("Meeting.md")), None).unwrap().archived);
}
#[test] fn archiving_leaves_the_file_untouched() {
    let (dir, db) = setup(); let f = dir.join("A.md"); std::fs::write(&f, "a").unwrap();
    let mut v = open(dir.clone(), &db, None).unwrap();
    let before = (std::fs::read(&f).unwrap(), std::fs::metadata(&f).unwrap().modified().unwrap());
    v.set_archived(&s(&f), true).unwrap(); v.set_archived(&s(&f), false).unwrap(); v.set_archived(&s(&f), true).unwrap();
    assert_eq!((std::fs::read(&f).unwrap(), std::fs::metadata(&f).unwrap().modified().unwrap()), before);
    assert_eq!(std::fs::read_to_string(dir.join(".velo/archived")).unwrap(), "A\n");
}
#[test] fn hand_edit_and_delete_of_list_seen_at_next_query() {
    let (dir, db) = setup(); std::fs::write(dir.join("A.md"), "").unwrap(); std::fs::write(dir.join("B.md"), "").unwrap();
    let v = open(dir.clone(), &db, None).unwrap();
    std::fs::create_dir(dir.join(".velo")).unwrap(); std::fs::write(dir.join(".velo/archived"), "a\nb\n").unwrap();
    assert_eq!(v.search_where("", Sort::Title, 0, &[], false, false).unwrap().total, 0);
    std::fs::remove_file(dir.join(".velo/archived")).unwrap();
    assert_eq!(v.search_where("", Sort::Title, 0, &[], false, false).unwrap().total, 2);
}
#[test] fn equal_length_rewrite_is_seen_at_the_next_query() { // fails under an (mtime, size) stamp
    let (dir, db) = setup(); for n in ["Foo", "Bar"] { std::fs::write(dir.join(format!("{n}.md")), "").unwrap(); }
    let v = open(dir.clone(), &db, None).unwrap();
    std::fs::create_dir(dir.join(".velo")).unwrap();
    std::fs::write(dir.join(".velo/archived"), "Foo\n").unwrap();
    assert_eq!(shown(&v), ["Bar"]);
    std::fs::write(dir.join(".velo/archived"), "Bar\n").unwrap(); // same size, same tick
    assert_eq!(shown(&v), ["Foo"]);
}
#[cfg(unix)] #[test] fn unreadable_list_keeps_the_loaded_set_and_only_logs() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, db) = setup(); for n in ["A", "B"] { std::fs::write(dir.join(format!("{n}.md")), "").unwrap(); }
    std::fs::create_dir(dir.join(".velo")).unwrap(); std::fs::write(dir.join(".velo/archived"), "A\n").unwrap();
    let f = dir.join(".velo/archived");
    let chmod = |m| std::fs::set_permissions(&f, std::fs::Permissions::from_mode(m)).unwrap();
    chmod(0o000); // cold start, unreadable: nothing loaded, everything shows
    let v = open(dir.clone(), &db, None).unwrap();
    assert_eq!(shown(&v), ["A", "B"]);
    assert!(v.archive_error.take().is_none()); // log only, no UI event
    chmod(0o644); assert_eq!(shown(&v), ["B"]); // readable again: loaded
    chmod(0o000); assert_eq!(shown(&v), ["B"]); // unreadable later: the loaded set stays
    chmod(0o644);
}
#[test] fn unlocked_archived_note_follows_the_flag() {
    let (dir, db) = setup(); let id = crypto::new_identity();
    std::fs::write(dir.join("S.md"), "secretword\n- [ ] hush").unwrap();
    let mut v = open(dir.clone(), &db, Some(&id)).unwrap();
    let p = v.lock_note(&s(&dir.join("S.md")), &id).unwrap(); // stays unlocked in memory
    v.set_archived(&p, true).unwrap();
    assert!(v.search_where("secretword", Sort::Title, 0, &[], false, false).unwrap().hits.is_empty());
    assert!(v.search_where("secretword", Sort::Title, 0, &[], false, true).unwrap().hits[0].archived);
    assert!(v.tasks("", &[], false, false).unwrap().no_date.is_empty());
    assert!(v.tasks("", &[], false, true).unwrap().no_date[0].archived);
}
#[test] fn each_folder_has_its_own_list() { // Settings › notes folder changed: the new vault reads the new folder's list
    let (a, db) = setup(); let (b, db2) = setup();
    for d in [&a, &b] { std::fs::write(d.join("N.md"), "").unwrap(); }
    open(a.clone(), &db, None).unwrap().set_archived(&s(&a.join("N.md")), true).unwrap();
    assert_eq!(open(b, &db2, None).unwrap().search_where("", Sort::Title, 0, &[], false, false).unwrap().total, 1);
}
```

- [ ] **Step 2: Run, see them fail.** `cargo test -q vault::` → FAIL.
- [ ] **Step 3: Implement** the Interfaces.
- [ ] **Step 4: Run, see them pass.** `cargo test -q` → PASS.
- [ ] **Step 5: Commit** `feat(vault): archive notes and filter them from listings`.

### Task 4: Keep the list in step (rename, delete, merge, create, lock)

**Files:**
- Modify: `src-tauri/src/vault.rs` (`archive_follow`, `title_on_disk`, `rename_note`, `delete_note_with`, `create_from_selection`, `open_or_create_new`, `save_note`)
- Test: `src-tauri/src/vault.rs` tests (`rm` helper exists for merge and delete)

**Interfaces:**
- Consumes: Task 3 `archive_edit`, `set_archived`.
- Produces:
  - `fn archive_follow(&mut self, change: impl FnOnce(&mut Vec<String>))`: runs `archive_edit`; on failure writes the message to `crate::log::line` and `eprintln!` (as `Index::finish_bulk` does: `velo --mcp` direct mode has no velo.log) and stores it in `archive_error` (Task 3). The note operation still returns `Ok`. Tasks 6 and 7 show it to the owner. `set_archived` keeps returning its error directly.
  - Placement: `archive_follow` always runs after the note operation's index work has committed and never inside `Index::begin()`; `archive_edit` starts with `debug_assert!(!self.index.in_batch())`. Exact spots: `rename_note` after `rewrite_backlinks` returns (it commits its batch before returning); `delete_note_with` after `remove_note` and `self.unlocked.remove`; `merge_notes_with` through `delete_note_with`, which it calls after `rewrite_backlinks`; `create_from_selection`, `open_or_create_new` and `save_note` after their `reindex` (a single upsert, its own savepoint, no batch). The TEMP reload in `sync_archive` runs from query methods, which never run inside a batch.
  - `fn title_on_disk(&self, title: &str) -> bool`: some file in `self.store.list()` still has a title folding to `title` (a twin: `Foo.md` beside `Foo.md.age` or `Foo.txt`).
  - `rename_note`: after the file moved, `let twin = fold(&old.title) != fold(&nf.title) && self.title_on_disk(&old.title);` (a case-only rename finds itself on disk, so it never counts as a twin) then `self.archive_follow(|e| { let was = e.iter().any(|t| fold(t) == fold(&old.title)); if was && !twin { e.retain(|t| fold(t) != fold(&old.title)) } e.retain(|t| fold(t) != fold(&nf.title)); if was { e.push(nf.title.clone()) } })`. A title comes into being by rename too: a stale entry for the new title is always cleared, and only an archived note carries its entry over. Nothing may fail a rename once the file moved, hence `archive_follow`. Owner (`commands::rename_note`) and agent (`VaultOps::rename`, direct and app mode) both call this.
  - `delete_note_with`: take `title` from its `self.note(p)?`; after `remove_note`, unless `self.title_on_disk(&title)`, `self.archive_follow(|e| e.retain(|t| fold(t) != fold(&title)))` (a remaining twin keeps the entry). `merge_notes_with` gets the source's removal through it; the target's entry is untouched.
  - `create_from_selection`, and `open_or_create_new` when it wrote the file: `self.archive_follow(|e| e.retain(|t| fold(t) != fold(title)))`. Covers new note, extract, `[[` create, MCP `create_note`, `daily_note` and capture into a missing note. `save_note` on `SaveResult::Conflict { conflict_path, .. }`: `let conflict_title = parse_note_file(Path::new(&conflict_path)).map(|n| n.title)` (the copy's own title, `"{stem} (conflict {stamp})[ n]"` as `Store::save` builds it at `store.rs:108-113`; never the source note's title, which would unarchive the real note), then `self.archive_follow(|e| e.retain(|t| fold(t) != fold(&conflict_title)))`, since a conflict name (minute resolution) can repeat after a Finder delete of an archived copy.
  - Lock, unlock, save, agent write: no step (title-keyed).

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn rename_moves_the_entry() {
    let (dir, db) = setup(); std::fs::write(dir.join("Old.md"), "").unwrap();
    let mut v = open(dir.clone(), &db, None).unwrap(); let p = s(&dir.join("Old.md"));
    v.set_archived(&p, true).unwrap(); v.rename_note(&p, "New", false).unwrap();
    assert_eq!(std::fs::read_to_string(dir.join(".velo/archived")).unwrap(), "New\n");
    assert!(shown(&v).is_empty());
}
#[test] fn case_only_rename_keeps_archived() {
    let (dir, db) = setup(); std::fs::write(dir.join("meeting notes.md"), "").unwrap();
    let mut v = open(dir.clone(), &db, None).unwrap(); let p = s(&dir.join("meeting notes.md"));
    v.set_archived(&p, true).unwrap(); v.rename_note(&p, "Meeting Notes", false).unwrap();
    assert!(shown(&v).is_empty());
}
#[test] fn rename_onto_a_stale_entry_is_not_archived() {
    let (dir, db) = setup(); std::fs::create_dir(dir.join(".velo")).unwrap(); std::fs::write(dir.join("Foo.md"), "").unwrap();
    std::fs::write(dir.join(".velo/archived"), "Bar\n").unwrap(); // Bar archived, then deleted in Finder
    let mut v = open(dir.clone(), &db, None).unwrap();
    v.rename_note(&s(&dir.join("Foo.md")), "Bar", false).unwrap();
    assert_eq!(shown(&v), ["Bar"]);
    assert_eq!(std::fs::read_to_string(dir.join(".velo/archived")).unwrap(), "");
}
#[test] fn conflict_copy_of_an_archived_note_is_not_archived() {
    let (dir, db) = setup(); let f = dir.join("A.md"); std::fs::write(&f, "a").unwrap();
    let mut v = open(dir.clone(), &db, None).unwrap(); v.set_archived(&s(&f), true).unwrap();
    let now = chrono::Local::now(); // stale entries for the copy's possible names (this minute and the next)
    let names: Vec<String> = [now, now + chrono::Duration::minutes(1)].iter().map(|t| format!("A (conflict {})", t.format("%Y-%m-%d %H%M"))).collect();
    std::fs::write(dir.join(".velo/archived"), format!("A\n{}\n", names.join("\n"))).unwrap();
    assert!(matches!(v.save_note(&s(&f), "b", "stale-hash", None, false).unwrap(), SaveResult::Conflict { .. }));
    let t = shown(&v); assert!(t.len() == 1 && t[0].starts_with("A (conflict "), "{t:?}");
}
#[cfg(unix)] #[test] fn rename_succeeds_and_reports_when_the_list_is_unwritable() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, db) = setup(); std::fs::write(dir.join("Old.md"), "").unwrap();
    let mut v = open(dir.clone(), &db, None).unwrap(); let p = s(&dir.join("Old.md"));
    v.set_archived(&p, true).unwrap();
    std::fs::set_permissions(dir.join(".velo"), std::fs::Permissions::from_mode(0o555)).unwrap();
    let r = v.rename_note(&p, "New", false);
    std::fs::set_permissions(dir.join(".velo"), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(r.is_ok() && dir.join("New.md").exists());
    assert!(v.archive_error.take().is_some());
}
#[cfg(unix)] #[test] fn delete_merge_and_create_succeed_and_report_when_the_list_is_unwritable() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, db) = setup(); for n in ["A", "B", "T"] { std::fs::write(dir.join(format!("{n}.md")), n).unwrap(); }
    let mut v = open(dir.clone(), &db, None).unwrap();
    for n in ["A", "B"] { v.set_archived(&s(&dir.join(format!("{n}.md"))), true).unwrap(); }
    std::fs::write(dir.join(".velo/archived"), "A\nB\nNew\n").unwrap(); // New: stale, so create must write
    let lock = |m| std::fs::set_permissions(dir.join(".velo"), std::fs::Permissions::from_mode(m)).unwrap();
    lock(0o555);
    v.delete_note_with(&s(&dir.join("A.md")), rm).unwrap();
    assert!(v.archive_error.take().is_some());
    v.merge_notes_with(&s(&dir.join("B.md")), &s(&dir.join("T.md")), false, rm).unwrap();
    assert!(v.archive_error.take().is_some());
    v.create_from_selection("New", "x", false).unwrap();
    assert!(v.archive_error.take().is_some());
    lock(0o755);
}
#[test] fn titles_with_line_breaks_cannot_be_archived() {
    let (dir, db) = setup(); std::fs::write(dir.join("A\nB.md"), "").unwrap(); // a valid file name on disk
    let mut v = open(dir.clone(), &db, None).unwrap();
    assert!(v.set_archived(&s(&dir.join("A\nB.md")), true).is_err());
    assert!(!dir.join(".velo/archived").exists());
}
#[test] fn rename_of_one_twin_keeps_the_other_archived() {
    let (dir, db) = setup(); std::fs::write(dir.join("Foo.md"), "").unwrap(); std::fs::write(dir.join("Foo.txt"), "").unwrap();
    let mut v = open(dir.clone(), &db, None).unwrap();
    v.set_archived(&s(&dir.join("Foo.md")), true).unwrap();
    assert!(shown(&v).is_empty()); // one entry, both files
    v.rename_note(&s(&dir.join("Foo.txt")), "Bar", false).unwrap();
    assert!(shown(&v).is_empty()); // Foo.md still archived, Bar archived too
}
#[test] fn delete_and_merge_drop_the_entry() {
    let (dir, db) = setup(); for n in ["A", "B", "T"] { std::fs::write(dir.join(format!("{n}.md")), n).unwrap(); }
    let mut v = open(dir.clone(), &db, None).unwrap();
    for n in ["A", "B", "T"] { v.set_archived(&s(&dir.join(format!("{n}.md"))), true).unwrap(); }
    v.delete_note_with(&s(&dir.join("A.md")), rm).unwrap();
    v.merge_notes_with(&s(&dir.join("B.md")), &s(&dir.join("T.md")), false, rm).unwrap();
    assert_eq!(std::fs::read_to_string(dir.join(".velo/archived")).unwrap(), "T\n");
    std::fs::write(dir.join("A.md"), "back from the Trash").unwrap(); v.rescan(None);
    assert_eq!(shown(&v), ["A"]);
}
#[test] fn stale_entry_is_kept_and_ignored_and_creation_clears_it() {
    let (dir, db) = setup(); std::fs::create_dir(dir.join(".velo")).unwrap(); std::fs::write(dir.join("O.md"), "").unwrap();
    std::fs::write(dir.join(".velo/archived"), "Standup\nDaily\n").unwrap(); // left by a Finder delete
    let mut v = open(dir.clone(), &db, None).unwrap();
    assert_eq!(shown(&v), ["O"]); // matches nothing, hides nothing
    v.set_archived(&s(&dir.join("O.md")), true).unwrap(); v.set_archived(&s(&dir.join("O.md")), false).unwrap();
    assert_eq!(std::fs::read_to_string(dir.join(".velo/archived")).unwrap(), "Standup\nDaily\n"); // kept: no pruning
    v.create_from_selection("standup", "x", false).unwrap();
    v.open_or_create("Daily", None, false).unwrap();
    assert_eq!(shown(&v), ["Daily", "O", "standup"]);
    assert_eq!(std::fs::read_to_string(dir.join(".velo/archived")).unwrap(), "");
}
#[test] fn archived_survives_lock_unlock_and_relaunch_without_key() {
    let (dir, db) = setup(); let id = crypto::new_identity(); std::fs::write(dir.join("L.md"), "x").unwrap();
    let mut v = open(dir.clone(), &db, Some(&id)).unwrap();
    v.set_archived(&s(&dir.join("L.md")), true).unwrap();
    let locked = v.lock_note(&s(&dir.join("L.md")), &id).unwrap(); drop(v);
    let mut v = open(dir.clone(), &db, None).unwrap(); // relaunch, no key: nothing can be decrypted
    assert!(shown(&v).is_empty());
    v.set_archived(&locked, false).unwrap(); v.set_archived(&locked, true).unwrap(); // works without the key
    drop(v); let mut v = open(dir.clone(), &db, Some(&id)).unwrap();
    v.unlock_note(&locked, &id).unwrap();
    assert!(shown(&v).is_empty());
}
#[test] fn save_keeps_archived() {
    let (dir, db) = setup(); let f = dir.join("A.md"); std::fs::write(&f, "a").unwrap();
    let mut v = open(dir.clone(), &db, None).unwrap(); v.set_archived(&s(&f), true).unwrap();
    let d = v.open_note(&s(&f), None).unwrap(); v.save_note(&d.path, "b", &d.hash, None, true).unwrap();
    assert!(shown(&v).is_empty());
}
```

- [ ] **Step 2: Run, see them fail.** `cargo test -q vault::` → FAIL on the rename, delete and create tests.
- [ ] **Step 3: Implement** `archive_follow` and the four call sites.
- [ ] **Step 4: Run, see them pass.** `cargo test -q` → PASS.
- [ ] **Step 5: Commit** `feat(vault): keep .velo/archived in step on rename, delete, merge and create`.

### Task 5: Related panel (connections)

**Files:**
- Modify: `src-tauri/src/connections.rs` (`Node`, `node`, `build`), `src-tauri/src/vault.rs` (`connections`)
- Modify (add `, false`): every `v.connections(&.., &|_| false)` in `connections.rs` tests (14 calls), `commands.rs:732`, `agent/ops.rs:328`, `agent/app_ops.rs` tests `:710`, `:733`, `:749`
- Test: `src-tauri/src/connections.rs` tests (`vault(files, id, unlock)`, `p`, `paths` helpers)

**Interfaces:**
- Consumes: Task 2 `Index::{archived_paths, tag_notes(.., include_archived)}`, `NodeRow.archived`.
- Produces:
  - `Node.archived: bool`.
  - `pub fn build(index, unlocked, path, text, hide: &dyn Fn(&str) -> bool, include_archived: bool) -> anyhow::Result<Connections>`: when `false`, take `archived_paths()` minus the centre and leave those paths out of `out`, `sources`, the unlocked `others`, the tag groups and mention matching (add them to `hide`). The centre is never subject to the filter, counts included: today `count = tag_notes(..).0 - indexed.contains(&tag) as usize` assumes the index counted the centre, but `tag_notes(.., false)` leaves an archived centre out, so subtract only when `include_archived || !centre_archived`.
  - `pub fn connections(&self, path: &str, hide: &dyn Fn(&str) -> bool, include_archived: bool)` on `Vault`, calling `sync_archive` first.

- [ ] **Step 1: Write the failing test**

```rust
#[test] fn archived_neighbours_follow_the_flag_centre_does_not() {
    let (mut v, d) = vault(&[("C.md", "[[A]] #t mentions Bee"), ("A.md", "[[C]] #t"), ("Bee.md", "#t")], &crypto::new_identity(), false);
    for n in ["A.md", "Bee.md"] { v.set_archived(&p(&d, n), true).unwrap(); }
    let c = v.connections(&p(&d, "C.md"), &|_| false, false).unwrap();
    assert!(c.links_out.is_empty() && c.links_in.is_empty() && c.mentions.is_empty() && c.tags[0].count == 0);
    let c = v.connections(&p(&d, "C.md"), &|_| false, true).unwrap();
    assert!(c.links_out[0].archived && c.tags[0].count == 2 && c.mentions.len() == 1);
    v.set_archived(&p(&d, "C.md"), true).unwrap(); // an archived centre still shows its plain neighbours
    v.set_archived(&p(&d, "A.md"), false).unwrap();
    let c = v.connections(&p(&d, "C.md"), &|_| false, false).unwrap();
    assert_eq!(paths(&c.links_out), [p(&d, "A.md")]);
    assert_eq!((c.tags[0].count, paths(&c.tags[0].notes)), (1, vec![p(&d, "A.md")])); // C archived, A not: count 1, not 0
}
```

- [ ] **Step 2: Run, see it fail.** `cargo test -q connections::` → FAIL.
- [ ] **Step 3: Implement.** Existing callers pass `false` (Tasks 6 and 8 thread the real flag). Check the existing helper names `vault`, `p`, `paths` before use; adjust the fixture call if its signature differs.
- [ ] **Step 4: Run, see it pass.**
- [ ] **Step 5: Commit** `feat(connections): hide archived neighbours unless asked`.

### Task 6: Setting, commands and export (Rust)

**Files:**
- Modify: `src-tauri/src/settings.rs` (`Settings.show_archived`, `Default`), `src-tauri/src/commands.rs` (`search`, `timeline`, `list_tags`, `list_link_targets`, `tasks`, `connections`, new `set_archived`, new `emit_archive_error`; `rename_note`, `delete_note`, `merge_notes`, `create_from_selection`, `open_or_create`, `save_note` emit the list error), `src-tauri/src/agent/listener.rs` (after `tools::call`, line ~83), `src-tauri/src/lib.rs` (register `commands::set_archived`), `src-tauri/src/export.rs` (`ExportRequest.include_archived`, `build`, test `req` at `:115`)
- Test: `src-tauri/src/settings.rs`, `src-tauri/src/export.rs`, `src-tauri/src/commands.rs` tests

**Interfaces:**
- Consumes: Tasks 3, 4 and 5 Vault signatures, `Vault.archive_error`.
- Produces:
  - `Settings.show_archived: bool`, `false` in `Default` (comment: "show archived notes in every listing; only the UI reads it").
  - Commands gain `include_archived: bool` (camelCase `includeArchived` from TS): `search(.., no_links: Option<bool>, include_archived: bool)`, `timeline(.., no_links, include_archived, by, since_ms)`, `list_tags(include_archived)`, `list_link_targets(include_archived)`, `tasks(.., show_done, include_archived)`, `connections(path, include_archived)`. Task 7 updates the TS callers in the same PR; between the two commits only a running app would notice.
  - `#[tauri::command(async)] pub fn set_archived(st: State<'_, AppState>, path: String, archived: bool) -> Res<()>` via `with_vault`. It takes a path, not "the open note": a locked note is archived by path without a key (Task 4 test). App commands need no capability entry (`build.rs` is plain `tauri_build::build()`).
  - `ExportRequest.include_archived: bool` with `#[serde(default)]`; `build` passes it to `Vault::timeline`.
  - `pub fn emit_archive_error(v: &Vault, emit: impl FnOnce(&str, serde_json::Value))`: takes `v.archive_error` and, when set, calls `emit("archive-error", json!({ "message": m }))`. The six note commands above take `app: AppHandle` and call it inside their `with_vault` closure with `|e, p| { app.emit(e, p).ok(); }`. In `src-tauri/src/agent/listener.rs`, after `tools::call` returns (line ~83), take the vault lock again (`st.vault.lock()`) and call it with `app.emit`, so agent writes in app mode report too. Query commands emit nothing (read failures are log-only). In the front end, Task 7 adds the `listen("archive-error", ..)` call in `src/ui/main.tsx` and `Controller.onArchiveError` in `src/app/controller.ts`, the same path as `index-error` (`main.tsx:67`). Direct `velo --mcp` only logs (Task 4).

- [ ] **Step 1: Write the failing tests**

```rust
// settings.rs
#[test] fn show_archived_defaults_off_and_round_trips() {
    let tmp = tempfile::tempdir().unwrap(); let p = tmp.path().join("s.json");
    assert!(!load(&p).show_archived);
    save(&p, &Settings { show_archived: true, ..Settings::default() }).unwrap();
    assert!(load(&p).show_archived);
}
// export.rs (uses the module's `vault` helper)
#[test] fn export_leaves_out_archived_unless_included() {
    let (mut v, d) = vault(&[("A", "2026-01-01T00:00:00+00:00", "x"), ("B", "2026-01-02T00:00:00+00:00", "y")]);
    v.set_archived(&d.join("A.md").to_string_lossy(), true).unwrap();
    assert_eq!(build(&v, &req(false), "2026-01-03").unwrap().1.notes, 1);
    assert_eq!(build(&v, &ExportRequest { include_archived: true, ..req(false) }, "2026-01-03").unwrap().1.notes, 2);
}
// commands.rs
#[test] fn emit_archive_error_sends_once_then_nothing() {
    let dir = tempfile::tempdir().unwrap().keep(); let db = tempfile::tempdir().unwrap().keep().join("i.sqlite");
    let v = Vault::open_with_progress(dir, &db, None, &mut |_, _| {}).unwrap();
    v.archive_error.set(Some("denied".into()));
    let mut got = vec![];
    emit_archive_error(&v, |e, p| got.push((e.to_string(), p)));
    emit_archive_error(&v, |e, p| got.push((e.to_string(), p)));
    assert_eq!(got, [("archive-error".to_string(), serde_json::json!({"message": "denied"}))]);
}
```

- [ ] **Step 2: Run, see them fail.** `cd src-tauri && cargo test -q settings:: export:: commands::` → FAIL.
- [ ] **Step 3: Implement** the Interfaces.
- [ ] **Step 4: Run, see them pass.** `cargo test -q` → PASS.
- [ ] **Step 5: Commit** `feat(archive): include_archived on commands and export, archive-error event`.

### Task 7: Front-end API, fakes, demo, controller call sites (TS)

**Files:**
- Modify: `src/api.ts`, `src/app/fakes.ts`, `src/app/store.ts`, `src/complete.ts` (`CompleteSource.exists`), `src/ui/main.tsx` (one `listen`), `src/demo/api.ts`, and the controller call sites that break: `controller.ts:93` (`search`), `:164` (`exactTitleMatch`), `:113` (`complete`), `:231` (`listLinkTargets`), `:1229` (`timeline`), `:1282` (`exportRequest`), `:1363` (`connections`), `:1444` and `:1449` (`tasks`), `:1543` (`listTags`)
- Test: `src/app/controller.test.ts`, `src/complete.test.ts`, `src/demo/api.test.ts`

**Interfaces:**
- Consumes: Task 6 command names and arguments, the `"archive-error"` event.
- Produces (TS, `src/api.ts`):
  - Fields: `Hit.archived: boolean`, `Page.hidden: number`, `TimelineRow.archived`, `TaskItem.archived`, `GraphNode.archived`, `NoteDoc.archived`, `ExportRequest.include_archived`, `Settings.show_archived`.
  - `search(query, sort, offset, tags, noLinks, includeArchived: boolean)`, `timeline(query, tags, noLinks, by, sinceMs, includeArchived: boolean)`, `listTags(includeArchived: boolean)`, `listLinkTargets(includeArchived: boolean)`, `tasks(query, tags, showDone, includeArchived: boolean)`, `connections(path, includeArchived: boolean)`, `setArchived(path: string, archived: boolean): Promise<void>` (`"set_archived"`).
  - `listTitles()` unchanged: link existence (resolution) and the create checks keep archived titles.
  - `src/complete.ts`: `CompleteSource.exists?: (title: string) => boolean`; the `[[` "Create" row shows only when `!(src.exists?.(title) ?? src.links().some((r) => r.f === fold(title)))`.
- Produces (store/controller): `AppState.showArchived: boolean` (initial `false`), loaded in `start()` as `s.show_archived === true` and in the settings-saved `store.set` (today's line with `tasksByNote: next.tasks_by_note !== false`). Every call site passes `this.store.get().showArchived`: `Results` fetch, `loadLinkTargets`, `doLoadTimeline`, `exportRequest`, `loadRelated`, `doLoadTasks` (both `tasks` calls, so the Dock badge follows the switch too), `refreshTags`. `mergeCandidates` and `[[` options read `linkIndex`, so they follow `listLinkTargets`. Existence never follows the switch: `editorOpts().complete.exists = (t) => this.titles.has(fold(t))` (unfiltered `listTitles`), and `listChanged` sets `exactTitleMatch: q !== "" && (r.loaded.some(..) || this.titles.has(q))`, so a hidden archived title never offers ⇧↩ Create.
  - `onArchiveError(message: string)`: ``setErr(`The archived-notes list could not be updated: ${message}`)``; `main.tsx` adds `void listen<{ message: string }>("archive-error", (ev) => controller.onArchiveError(ev.payload.message));`.
- Produces (fakes): `fakeApi` keeps `archived = new Set<string>()` (titles): `setArchived` adds or deletes; `search` and `listLinkTargets` drop archived unless `includeArchived`, and `search` returns `hidden: includeArchived ? 0 : <archived count>`; `docOf` sets `archived`; `hit()` sets `archived: false`; settings literal gets `show_archived: false`.
- Produces (demo): `src/demo/api.ts` same signatures; an in-memory `archived: Set<string>` of folded titles cleared by `resetDemo`; `filtered(query, tags, noLinks, includeArchived)` drops archived notes; `search` returns `hidden` like Rust; `timeline`, `tasks`, `listTags`, `listLinkTargets`, `connections`, `exportPreview` follow the flag; `setArchived`; `renameNote` moves the title, `deleteNote` and `mergeNotes` (source) delete it, `createFromSelection` and `openOrCreate` clear it; `show_archived: false` in the demo settings. No archived note is seeded (screenshots archive one in-session).

- [ ] **Step 1: Write the failing tests**

```ts
// controller.test.ts
test("listings pass show_archived from the settings", async () => {
  const { c, api } = setup();
  api.getSettings.mockResolvedValue({ ...(await api.getSettings()), show_archived: true });
  await c.start(); await settle();
  expect(api.search.mock.calls.at(-1)?.[5]).toBe(true);
  expect(api.tasks.mock.calls.length).toBeGreaterThan(0);
  expect(api.tasks.mock.calls.every((a) => a[3] === true)).toBe(true);
  expect(api.listTags).toHaveBeenLastCalledWith(true);
  expect(api.listLinkTargets).toHaveBeenLastCalledWith(true);
});
test("merge picker follows the switch; an archived title still exists for Create", async () => {
  const { c, api, store } = setup({ A: "a", B: "b" });
  await c.start(); await settle();
  await api.setArchived("/n/B.md", true); await c.refreshTitles(); await settle();
  expect(c.mergeCandidates("").map((t) => t.title)).not.toContain("B");
  expect(c.editorOpts().complete.exists!("b")).toBe(true);
  c.setQuery("B"); await settle();
  expect(store.get().exactTitleMatch).toBe(true); // no ⇧↩ Create for a hidden archived title
  store.set({ showArchived: true }); await c.loadLinkTargets();
  expect(c.mergeCandidates("").map((t) => t.title)).toContain("B");
});
test("a list-write failure is shown", () => {
  const { c, store } = setup();
  c.onArchiveError("permission denied");
  expect(store.get().err).toBe("The archived-notes list could not be updated: permission denied");
});
// complete.test.ts (uses the file's `source` and `options` helpers)
test("no Create row when exists says the title is taken, even if it is not suggested", () => {
  const src = { ...source([]), exists: (t: string) => t === "Hidden" };
  expect(options(src, "[[Hidden").map((o) => o.label)).not.toContain('Create "Hidden"');
});
// demo/api.test.ts
test("demo archive: hidden by default, listed with the flag, follows a rename", async () => {
  resetDemo();
  const [h] = (await search("", "title", 0, [], false, false)).hits;
  await setArchived(h.path, true);
  expect((await search("", "title", 0, [], false, false)).hits.map((x) => x.path)).not.toContain(h.path);
  expect((await search("", "title", 0, [], false, true)).hits.find((x) => x.path === h.path)?.archived).toBe(true);
  const r = await renameNote(h.path, "Renamed archived", false);
  expect((await openNote(r.path)).archived).toBe(true);
});
```

- [ ] **Step 2: Run, see them fail.** `pnpm vitest run src/app/controller.test.ts src/complete.test.ts src/demo/api.test.ts` → FAIL.
- [ ] **Step 3: Implement** the Interfaces. `pnpm build` must typecheck: every TS `Hit`, `TimelineRow`, `TaskItem`, `GraphNode`, `NoteDoc` literal in tests and the demo gets `archived`.
- [ ] **Step 4: Run, see them pass.** `pnpm test`, `pnpm build`, `pnpm exec tsc -p e2e --noEmit` → PASS.
- [ ] **Step 5: Commit** `feat(archive): front-end API, demo and controller pass include_archived`.

### Task 8: MCP

**Files:**
- Modify: `src-tauri/src/agent/ops.rs` (`NoteOps::{search, tags, tasks, connections}`, `VaultOps` impls including `backlinks`), `src-tauri/src/agent/app_ops.rs` (forwarding impls `:218`, `:222`, `:226`, `:365`), `src-tauri/src/agent/tools.rs` (`TOOL_SPECS` for the four tools, `call` at `:178`, `:183`, `:192`, `:240`, `read_note` description)
- Modify (callers that break): `agent/ops.rs` test `:462` (`o.tags()`), `agent/app_ops.rs` tests `:422`, `:425`, `:696`, `:697` (`tasks`, `tags`)
- Modify: `README.md` `## Agents (MCP)`: `search_notes`, `list_tasks`, `list_tags`, `get_connections` hide archived notes unless `include_archived` is true; `read_note` backlinks never list them (PR 1 gate row 3)
- Regenerate: `site/src/content/reference/mcp-tools.json` (`cd src-tauri && VELO_UPDATE_DOCS=1 cargo test dump_tool_specs`)
- Test: `src-tauri/src/agent/tools.rs`, `src-tauri/src/agent/app_ops.rs` tests

**Interfaces:**
- Consumes: Task 3 and 5 Vault signatures.
- Produces:
  - `fn search(&self, query: &str, tags: &[String], offset: usize, no_links: bool, include_archived: bool) -> anyhow::Result<Page>`, `fn tags(&self, include_archived: bool)`, `fn tasks(&self, query, tags, show_done: bool, include_archived: bool)`, `fn connections(&self, path: &str, include_archived: bool)` on `NoteOps`, `VaultOps` and `AppOps`. `VaultOps::connections` passes the flag to `tag_notes` in its locked-group recount.
  - `VaultOps::tags`: skip the plain-twin subtraction for a locked note whose title is archived when `!include_archived` (its twin's tags were never counted).
  - `tools::call`: reads `include_archived` (`as_bool`, default `false`) on the four tools. With it set: each note object in `search_notes` and in `get_connections` (`links_out`, `links_in`, `mentions`) carries `"archived": bool`; each `get_connections` tag group keeps `titles` as strings and adds `"archived_titles": [..]`; `list_tasks` keeps `archived` on each task. Without it, none of these keys appear (`list_tasks` removes `archived` next to `path`). `read_note` (`find` is unfiltered) and every write tool work on archived notes.
  - `VaultOps::backlinks`: always leaves out archived sources (`self.vault.sync_archive()`, then filter `linked_from` by `index.archived_paths()`); no flag on `read_note`. Its description gains "Backlinks leave out archived notes; get_connections with include_archived lists them."
  - `get_connections` of an archived note: the centre is never filtered (Task 5), so its tag counts match its listed titles.
  - Schema: add `"include_archived":{"type":"boolean"}` to the four `input_schema`s. Description sentence (append to each of the four): "Archived notes are left out unless `include_archived` is true; then each note says `archived`."

- [ ] **Step 1: Write the failing tests** (`vault` helper in `tools.rs` tests returns a `DirectOps`)

```rust
#[test] fn mcp_hides_archived_by_default_and_marks_with_flag() {
    let (mut ops, dir) = vault(&[("a.md", "#t [[b]]\n- [ ] x"), ("b.md", "#t")]);
    ops.vault.set_archived(&dir.join("a.md").to_string_lossy(), true).unwrap();
    assert_eq!(titles(&call(&mut ops, "search_notes", json!({})).unwrap()), ["b"]);
    let all = call(&mut ops, "search_notes", json!({"include_archived": true})).unwrap();
    assert!(all["notes"].as_array().unwrap().iter().any(|n| n["title"] == "a" && n["archived"] == true));
    assert_eq!(call(&mut ops, "list_tags", json!({})).unwrap()["tags"], json!([{"tag": "t", "count": 1}]));
    assert!(call(&mut ops, "list_tasks", json!({})).unwrap()["no_date"].as_array().unwrap().is_empty());
    assert_eq!(call(&mut ops, "list_tasks", json!({"include_archived": true})).unwrap()["no_date"][0]["archived"], true);
    assert!(call(&mut ops, "get_connections", json!({"title": "b"})).unwrap()["links_in"].as_array().unwrap().is_empty());
    assert_eq!(call(&mut ops, "read_note", json!({"title": "a"})).unwrap()["title"], "a"); // by title: always
    assert_eq!(call(&mut ops, "read_note", json!({"title": "b"})).unwrap()["backlinks"], json!([])); // a is archived
}
#[test] fn get_connections_of_an_archived_centre_counts_right() {
    let (mut ops, dir) = vault(&[("c.md", "#t"), ("a.md", "#t")]);
    ops.vault.set_archived(&dir.join("c.md").to_string_lossy(), true).unwrap();
    let r = call(&mut ops, "get_connections", json!({"title": "c"})).unwrap();
    assert_eq!(r["tags"], json!([{"tag": "t", "count": 1, "titles": ["a"]}]));
}
#[test] fn app_archive_is_seen_by_next_mcp_query_and_mcp_rename_by_the_app() {
    let (mut ops, dir) = vault(&[("a.md", ""), ("b.md", "")]);
    let data = tempfile::tempdir().unwrap().keep();
    let mut app = crate::vault::Vault::open_with_progress(dir.clone(), &data.join("app.sqlite"), None, &mut |_, _| {}).unwrap();
    app.set_archived(&dir.join("a.md").to_string_lossy(), true).unwrap();
    assert_eq!(titles(&call(&mut ops, "search_notes", json!({})).unwrap()), ["b"]);
    call(&mut ops, "rename_note", json!({"title": "a", "new_title": "c", "rewrite_links": false, "summary": "s"})).unwrap();
    app.rescan(None); // the app's watcher
    let p = app.search_where("", crate::index::Sort::Title, 0, &[], false, true).unwrap();
    assert!(p.hits.iter().any(|h| h.title == "c" && h.archived));
}
#[test] fn list_tags_does_not_double_subtract_an_archived_twin() {
    let (mut ops, dir) = vault(&[("x.md", "#t"), ("x.md.age", "cipher"), ("y.md", "#t")]);
    ops.vault.set_archived(&dir.join("x.md").to_string_lossy(), true).unwrap();
    assert_eq!(call(&mut ops, "list_tags", json!({})).unwrap()["tags"], json!([{"tag": "t", "count": 1}]));
}
```

In `app_ops.rs` tests (harness `state()` / `app_state`, rescan as the existing tests do):

```rust
#[test] fn agent_rename_in_app_mode_keeps_archived() {
    let (st, dir) = state();
    let p = dir.join("P.md").to_string_lossy().into_owned();
    st.vault.lock().unwrap().as_mut().unwrap().set_archived(&p, true).unwrap();
    let route = |_: Value| -> anyhow::Result<Value> { Ok(json!("not-open")) }; // the note is not open in the editor
    let to = AppOps::new(&st, &route).rename(&p, "Q", false, "s").unwrap();
    let g = st.vault.lock().unwrap(); let v = g.as_ref().unwrap();
    assert!(v.search_where("", Sort::Title, 0, &[], false, false).unwrap().hits.iter().all(|h| h.path != to));
    assert!(v.search_where("", Sort::Title, 0, &[], false, true).unwrap().hits.iter().any(|h| h.path == to && h.archived));
    assert_eq!(std::fs::read_to_string(dir.join(".velo/archived")).unwrap(), "Q\n");
}
```

- [ ] **Step 2: Run, see them fail.** `cargo test -q agent::` → FAIL; `dump_tool_specs` FAIL (stale json) once schemas change.
- [ ] **Step 3: Implement**, then `VELO_UPDATE_DOCS=1 cargo test dump_tool_specs` to rewrite `mcp-tools.json`.
- [ ] **Step 4: Run, see them pass.** `cargo test -q` → PASS.
- [ ] **Step 5: Commit** `feat(mcp): include_archived on search_notes, list_tasks, list_tags and get_connections`.

### Task 9: PR 1 gate and review

- [ ] **Step 1: Quality gate** (`CONTRIBUTING.md`), reported as a table: `pnpm build`, `pnpm exec tsc -p e2e --noEmit`, `pnpm test`, `cd src-tauri && cargo test`, `pnpm docs:check`, `cd src-tauri && cargo build --release`; capabilities unchanged.
- [ ] **Step 2: No changeset.** State in the PR body why: nothing can be archived before PR 2 (no UI), so no user-visible change; the README's MCP section (Task 8) and the regenerated tool reference already describe `include_archived`, so gate row 3 holds. PR 2 adds the changeset and the rest of the docs.
- [ ] **Step 3: Open the PR** `feat: archived notes backend (list file, filters, MCP flag)`, body `## Summary` / `## Test plan`, ending with the attribution line from the session.
- [ ] **Step 4: Adversarial review** by a fresh Opus agent (data integrity, two processes). Attack list: every listing path that can leak an archived note (each row of the spec's "hidden" table, `unlocked_hits`, `Vault::tasks` unlocked loop, `tag_notes` counts, MCP `tags` twin subtraction); paging and totals with archived rows on both sides of a page edge; `.velo/archived` missing, empty, BOM, CRLF, invalid UTF-8, trailing spaces, duplicated, hand-edited, deleted, unreadable, unwritable during rename/delete/create (reported, never fatal); rename onto a stale entry; duplicate and case-variant lines; titles with `\n`; app and `velo --mcp` writing at once (per-process temp file); `archive_follow` or a TEMP reload inside an index batch; rename, case-only rename, twin rename, delete, merge, create with stale entries, lock/unlock, relaunch without key; app and direct MCP on one folder; `hidden` count under tags, `no_links` and unlocked notes. Post the report on the PR; fix Critical/Major with regression tests; strike rule.

---

## PR 2: UI (`feat/archived-notes-ui`, from `main` after PR 1)

### Task 10: Actions, palette, generated docs

**Files:**
- Modify: `src/shortcuts.ts` (`Action`, `DEFAULTS`, `LABELS`), `src-tauri/src/settings.rs` (`ACTIONS: [&str; 31]`), `scripts/gen-docs.ts` (`GROUPS`), `src/palette.ts` (`NOTE_ACTIONS`, `PaletteState.archived`, `paletteItem`)
- Regenerate: `site/src/content/reference/shortcuts.json` (`pnpm docs:gen`)
- Test: `src/shortcuts.test.ts`, `src/palette.test.ts`, the Rust ACTIONS parity test

**Interfaces:**
- Produces: actions `"toggle_archived"` (label "Show / hide archived notes", group "View") and `"archive_note"` (label "Archive / unarchive note", group "Notes"), both `NONE`. `NOTE_ACTIONS = ["rename", "extract_note", "merge_note", "toggle_front_matter", "toggle_lock", "archive_note", "delete_note"]`. `PaletteState.archived: boolean`: the open note's flag, `AppState.archived` (Task 11), which comes from `NoteDoc.archived` in the `open_note` response (Rust field added in Task 3, TS type in Task 7). `paletteItem` labels `archive_note` "Unarchive note" when `s.archived`, else "Archive note"; the existing `NOTE_ACTIONS` rule disables it ("open a note first") with no note open.

- [ ] **Step 1: Failing tests.** `palette.test.ts`: update the note-group expectation to `["extract_note", "merge_note", "toggle_front_matter", "toggle_lock", "archive_note", "delete_note"]` (base gets `archived: false`); new test:

```ts
test("archive entry reads Archive or Unarchive for the open note and needs one", () => {
  expect(paletteSearch("archive note", base)[0]).toMatchObject({ action: "archive_note", label: "Archive note", context: "Velo roadmap" });
  expect(paletteSearch("archive", { ...base, archived: true }).find((i) => i.action === "archive_note")?.label).toBe("Unarchive note");
  expect(paletteSearch("archive", { ...base, noteOpen: false }).find((i) => i.action === "archive_note")?.disabled).toBe("open a note first");
  expect(paletteSearch("show / hide archived", base)[0]).toMatchObject({ action: "toggle_archived", binding: "" });
});
```

`shortcuts.test.ts`: `DEFAULTS.toggle_archived === NONE`, `DEFAULTS.archive_note === NONE`; Rust `ACTIONS` parity test passes with 31.
- [ ] **Step 2: Run, see them fail.** `pnpm vitest run src/palette.test.ts src/shortcuts.test.ts`; `cargo test -q settings`.
- [ ] **Step 3: Implement**; `pnpm docs:gen`. Search keeps matching `LABELS`: "archive note" is a substring of "Archive / unarchive note".
- [ ] **Step 4: Run, see them pass**, plus `pnpm docs:check`.
- [ ] **Step 5: Commit** `feat(archive): archive and show-archived actions`.

### Task 11: Controller

**Files:**
- Modify: `src/app/store.ts` (`archived`, `hiddenArchived`), `src/app/controller.ts`, `src/list.ts` (`Results.hidden`)
- Test: `src/app/controller.test.ts`, `src/list.test.ts`

**Interfaces:**
- Consumes: Task 7 `api.setArchived`, `Page.hidden`, `NoteDoc.archived`, `AppState.showArchived`; Task 10 action ids.
- Produces:
  - `AppState.archived: boolean` (the open note; `loadedDoc` sets `doc.archived`, `closedDoc` sets `false`), `AppState.hiddenArchived: number` (from `Results.hidden` in `listChanged`).
  - `Results.hidden: number`: `page.hidden` of the latest first page (`reset` and `refresh`, like `total`).
  - `async setShowArchived(on: boolean): Promise<void>`: persists `show_archived` through `updateSettings` (as `toggleFrontMatter`), sets `showArchived`, then refreshes every listing without moving the editor: in Notes mode `runSearch(false)` (refresh in place, `reselect`; never `filterChanged`, whose fresh first page would `select(0, "auto")` and replace an open archived note), in Tasks and Timeline mode set `listStale = true`; then `loadTasks()`, `refreshTimeline()`, `refreshTags()`, `loadLinkTargets()`, `loadRelated()`. Errors go to `setErr(errText(e))`.
  - `async toggleArchive(): Promise<void>`: acts on the open note only; none → `setErr("Open a note to archive")`; `busy` or indexing → `BUSY_MSG`. Capture `path` and `archived` before the await, call `api.setArchived(path, !archived)`, then set `archived` only if `editor.currentPath() === path` still (another note may be open by then); always `runSearch(false)` (the open note stays in the editor; `reselect` leaves `sel` at `-1` when its row left), `loadTasks()`, `refreshTimeline()`, `refreshTags()`, `loadLinkTargets()`. Never opens, unlocks or rewrites the note.
  - `actions.toggle_archived: () => void this.setShowArchived(!this.store.get().showArchived)`, `actions.archive_note: () => void this.toggleArchive()`.
  - `src/list.ts`: `hiddenText(hidden: number, showArchived: boolean, filtering: boolean): string | null` → `null` unless `!showArchived && filtering && hidden > 0`; else "1 archived note hidden" / "N archived notes hidden".
  - `src/list.ts`: `archivedLabel(name: string, archived: boolean): string` → ``archived ? `${name}, archived` : name`` (Task 12's aria labels).

- [ ] **Step 1: Failing tests**

```ts
// controller.test.ts
test("archiving the open note with the switch off keeps it open and clears the selection", async () => {
  const { c, api, store, editor } = setup();
  await c.start(); await settle();
  const path = store.get().openPath!;
  await c.toggleArchive();
  expect(api.setArchived).toHaveBeenCalledWith(path, true);
  expect(store.get()).toMatchObject({ openPath: path, archived: true, sel: -1 });
  expect(editor.currentPath()).toBe(path);
  expect(c.row(0)?.path).not.toBe(path);
  await c.toggleArchive(); // unarchive: one step away
  expect(api.setArchived).toHaveBeenLastCalledWith(path, false);
  expect(store.get().archived).toBe(false);
});
test("no open note: archive says why", async () => {
  const { c, store, api } = setup({});
  await c.start(); await settle();
  await c.toggleArchive();
  expect(store.get().err).toBe("Open a note to archive");
  expect(api.setArchived).not.toHaveBeenCalled();
});
test("the archive result applies to the note it was for, not the one open afterwards", async () => {
  const { c, api, store } = setup();
  await c.start(); await settle();
  const a = store.get().openPath!;
  const d = deferred<void>(); api.setArchived.mockImplementationOnce(() => d.promise);
  const done = c.toggleArchive();
  await c.select(1); await settle();
  const b = store.get().openPath!;
  d.resolve(); await done; await settle();
  expect(api.setArchived).toHaveBeenCalledWith(a, true);
  expect(store.get()).toMatchObject({ openPath: b, archived: false });
});
test("the hidden-matches line turns the switch on and persists it", async () => {
  const { c, api, store } = setup();
  await c.start(); await settle();
  await c.toggleArchive(); c.setQuery("a"); await settle();
  expect(store.get().hiddenArchived).toBe(1);
  await c.setShowArchived(true); await settle();
  expect(api.setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ show_archived: true }));
  expect(store.get().showArchived).toBe(true);
  expect(api.search.mock.calls.at(-1)?.[5]).toBe(true);
});
test("switching show archived off keeps an open archived note open", async () => {
  const { c, api, store, editor } = setup();
  api.getSettings.mockResolvedValue({ ...(await api.getSettings()), show_archived: true });
  await c.start(); await settle();
  const path = store.get().openPath!;
  await c.toggleArchive(); await settle(); // archived, still listed (switch on)
  const opens = api.openNote.mock.calls.length;
  await c.setShowArchived(false); await settle();
  expect(editor.currentPath()).toBe(path);
  expect(store.get()).toMatchObject({ openPath: path, archived: true, sel: -1 });
  expect(api.openNote.mock.calls.length).toBe(opens); // row 0 was not opened in its place
});
// list.test.ts
test("hiddenText only with a filter, the switch off and something hidden", () => {
  expect(hiddenText(3, false, true)).toBe("3 archived notes hidden");
  expect(hiddenText(1, false, true)).toBe("1 archived note hidden");
  expect(hiddenText(3, false, false)).toBeNull();
  expect(hiddenText(3, true, true)).toBeNull();
  expect(hiddenText(0, false, true)).toBeNull();
});
test("archivedLabel adds the word, not a colour", () => {
  expect(archivedLabel("Standup, 2 tasks", true)).toBe("Standup, 2 tasks, archived");
  expect(archivedLabel("Standup", false)).toBe("Standup");
});
```

- [ ] **Step 2: Run, see them fail.** `pnpm vitest run src/app/controller.test.ts src/list.test.ts`.
- [ ] **Step 3: Implement** the Interfaces.
- [ ] **Step 4: Run, see them pass.** `pnpm test`.
- [ ] **Step 5: Commit** `feat(archive): archive the open note and the show-archived switch`.

### Task 12: UI

**Files:**
- Modify: `src/tasks.ts` (`sameTask`), `src/ui/CommandPalette.tsx` (`archived` in its state), `src/ui/PaneBar.tsx` (toggle), `src/ui/NoteList.tsx` (row badge and dim, hidden line), `src/ui/TimelineView.tsx` (row badge and dim), `src/ui/TaskList.tsx` (heading or row badge and dim, aria labels), `src/ui/TitleBar.tsx` (badge, `⋯` item), `src/theme/recipes/velo/list-row.ts` (root `'&[data-archived]': { opacity: '0.6' }`)
- Test: no component test file exists for `NoteList`, `TimelineView`, `TaskList` or `TitleBar` (vitest runs in node, tests are logic-only), so the accessible name is pinned by Task 11's `archivedLabel` test plus the demo pass (Step 3)

**Interfaces:**
- Consumes: Task 11 `setShowArchived`, `toggleArchive`, `hiddenText`, store `archived`, `showArchived`, `hiddenArchived`; `Hit.archived`, `TimelineRow.archived`, `TaskItem.archived`.
- Produces (no exports):
  - PaneBar: one toggle after each mode's controls, in all three modes: `<button type="button" className={menuButton({ iconOnly: true })} aria-pressed={showArchived} aria-label="Show archived notes">` with lucide `Archive`, inside `Tooltip` `tip("toggle_archived", "Show archived notes")`. Always icon-only, so `paneBarMode` widths stay as they are. `aria-pressed` reuses the "Show done" lit style in `menu-button.ts`.
  - Rows: `data-archived` on `listRow` roots (NoteList, TimelineView) and on TaskList's `row` and note heading (add the same selector to the `row` css object there); a `<Badge size="sm" variant="subtle">archived</Badge>` (`@/components/ui`) after the title. `TaskList.sameRow` (`src/ui/TaskList.tsx:74-77`) compares a fixed key list and memoises rows, so an archive-only change would keep stale rows: add `export function sameTask(a: TaskItem, b: TaskItem): boolean` to `src/tasks.ts`, comparing `["path", "line", "line_text", "text", "title", "due", "done", "archived"]`, and make `sameRow` call `sameTask(a.t, b.t)` instead of its inline list. `sameRow` itself stays in `TaskList.tsx` (it also compares props and highlight marks); `TaskList.tsx` has no test file, so `src/tasks.test.ts` tests `sameTask`. Text badge inside the row gives the accessible name; TaskList heading `aria-label` and a flat task row's checkbox `aria-label` go through `archivedLabel(.., t.archived)`.
  - NoteList: below the list (and below the "No notes match" empty state), when `hiddenText(hiddenArchived, showArchived, query.trim() !== "" || selectedTags.length > 0 || noLinks)` is not null, `<Button variant="plain" size="sm" onClick={() => void controller.setShowArchived(true)}>{text}</Button>`. Not in timeline or Tasks.
  - TitleBar: `<Badge size="sm" variant="subtle">archived</Badge>` next to the title when `s.archived`; `⋯` menu item `value="archive"` (`disabled={noNote}`, `onSelect={() => void controller.toggleArchive()}`), icon `Archive` / `ArchiveRestore`, text "Archive note" / "Unarchive note", `kbd("archive_note")`, before "Move to Trash".
  - CommandPalette: `archived` (from the store) in `state` and in the `useMemo` deps.

- [ ] **Step 1: Failing test** in `src/tasks.test.ts` → FAIL (`pnpm vitest run src/tasks.test.ts`):

```ts
test("a task row re-renders when only archived changes", () => {
  const t: TaskItem = { path: "/n/A.md", title: "A", line: 1, text: "x", due: null, done: false, done_on: null, line_text: "- [ ] x", archived: false };
  expect(sameTask(t, { ...t })).toBe(true);
  expect(sameTask(t, { ...t, archived: true })).toBe(false);
});
```
- [ ] **Step 1b: Implement** the Interfaces.
- [ ] **Step 2: Typecheck and tests.** `pnpm build`, `pnpm test` → PASS.
- [ ] **Step 3: Demo check.** `pnpm demo:build` and open the demo in a browser (never the app): archive the open note from `⋯` (it stays open, its row leaves, title badge shows); with VoiceOver or the browser's accessibility tree, check an archived row's name contains "archived"; search a word it contains → hidden line, click → switch lit, row dimmed with badge; check timeline and Tasks (with the switch on, archive a note whose tasks show: its rows dim at once); toggle from the palette. Record what was seen in the PR's Test plan; real-window rendering stays unverified.
- [ ] **Step 4: Commit** `feat(archive): archive toggle, badges and hidden-matches line`.

### Task 13: PR 2 gate, docs, changeset, review

**Files:**
- Create: `.changeset/archived-notes.md`
- Modify: `README.md`

- [ ] **Step 1: Changeset** (`minor`):

```md
---
"velo": minor
---

Added archived notes: archive a note from its ⋯ menu or the command palette to hide it from the list, search, timeline, Tasks, tags and agents until you turn on Show archived.
```

- [ ] **Step 2: README.** New section `## Archived notes` after `## Saved searches`: what archiving does, the `⋯` and palette entries, the pane-bar toggle and its persistence, the hidden-matches line, links still open archived notes, rename/lock keep the state, a Finder rename un-archives, and that it is stored in `.velo/archived`. `## Storage`: add a `.velo/archived` bullet. Shortcut table: two `— | — |` rows ("Show / hide archived notes (set in Settings)", "Archive / unarchive the current note (set in Settings)"). `## Agents (MCP)` (flag already documented in PR 1): add that `read_note` and writes work on archived notes, a task added to one stays hidden with it, and agents cannot archive. No site page change: the feature cards in `site/src/pages/index.astro` need a capture, out of scope.
- [ ] **Step 3: Quality gate** as in Task 9 Step 1, plus `pnpm docs:check`; report the table.
- [ ] **Step 4: PR** `feat: archived notes`, body `## Summary` / `## Test plan` (demo checks ticked, real-window checks unticked).
- [ ] **Step 5: Adversarial review** by a fresh Opus agent. Attack list: the invariant "an archived note never shows in a default view": every code path that fills the list, timeline, Tasks (grouped and flat), tags panel and counts, `[[` completion, merge picker, Related, export, Dock badge, including refreshes after watcher events, agent writes, lock/unlock hand-offs and switching notes folders; the open note archived then renamed, locked, deleted or merged; the switch toggled while a search, task or timeline load is in flight (`latest()` guards); hidden line with tags only, `no_links` only, and an empty result; keyboard and screen-reader use of the toggle, badge and line. Post each round on the PR; fix Critical/Major with regression tests; strike rule.

---

## Self-review notes

- Spec checks → tests: list file read/write/missing/BOM/CRLF/spaces/bad bytes/duplicates/line-break titles (T1, T2 `duplicate_titles_hide_and_do_not_error`, T4 `titles_with_line_breaks_cannot_be_archived`), unknown entry kept and ignored (T4 `stale_entry_is_kept_and_ignored_and_creation_clears_it`), rename/delete/merge (T4); each hidden surface on and off with paging and totals (T2, T3, T5, T6, T7, T8); locked note (T4 `archived_survives_lock_unlock_and_relaunch_without_key`: archive and unarchive by path without a key); bytes and mtime (T3 `archiving_leaves_the_file_untouched`); MCP default, flag, read by title, backlinks (T8); two processes (T3 `equal_length_rewrite_is_seen_at_the_next_query`, T8 `app_archive_is_seen_by_next_mcp_query_and_mcp_rename_by_the_app`, `agent_rename_in_app_mode_keeps_archived`); unreadable list, log only (T3 `unreadable_list_keeps_the_loaded_set_and_only_logs`); failed TEMP reload rolls back (T2 `failed_reload_keeps_the_previous_table`); unlocked notes (T2, T3); controller (T11).
- "Keeps the list in step" rows: rename owner/agent (T4, T8), rename onto a stale entry (T4), lock/unlock (T4), delete (T4), merge (T4), extract/new (T4), conflict copy (T4 `conflict_copy_of_an_archived_note_is_not_archived`), edit/save/agent write (T4 `save_keeps_archived`), folder changed (T3 `each_folder_has_its_own_list`), unwritable list (T4 `rename_succeeds_and_reports_when_the_list_is_unwritable`, `delete_merge_and_create_succeed_and_report_when_the_list_is_unwritable`, T6 `emit_archive_error_sends_once_then_nothing`, T7 `a list-write failure is shown`).
- "Hidden" table rows: list/search/timeline/tasks/tags (T2, T3), `[[` suggestions and Create (T7), Related with an archived centre (T5, T8), merge picker (T7 `merge picker follows the switch…`), export (T6), MCP (T8), Tasks rows re-render (T12 `sameTask`).
- Type check across tasks: `archive::{FILE, parse, read, update}` (T1) is consumed only by `Vault::{sync_archive, archive_edit}` (T3); `Vault.archive_error: Cell<Option<String>>` (T3) is set by T3 and T4 and taken by T6 `emit_archive_error(&Vault, emit)`; `archive_follow` (T4); `include_archived` order is `(.., no_links, include_archived, ..)` in Index, Vault, commands and `NoteOps`; TS `includeArchived` is always the last argument; the open note's `archived` flows `NoteDoc.archived` (T3 Rust, T7 TS) → `AppState.archived` (T11) → `PaletteState.archived` (T10) and the TitleBar (T12); `toggleArchive()` (T11) takes no argument everywhere.
- Task numbering: PR 1 is T1-T9 (T6 Rust commands, T7 TS API, T8 MCP, T9 gate); PR 2 is T10-T13.
- Proportion: about 3.8 times the spec's length; mostly concrete test code from the review rounds.
- Verified against the code this round: every call-site line cited in Tasks 3, 6, 7 and 8 (`commands.rs`, `export.rs`, `ops.rs`, `app_ops.rs`, `tools.rs`, `controller.ts`) and the literal counts in Task 2; `Controller.refreshTitles` exists (`controller.ts:217`).
- Not verified: compiled or ran nothing; `listener.rs` line ~83 is where `tools::call` runs today; `parse_note_file` (names.rs:47) does accept `A\nB.md`; real-window rendering of dimmed rows and the toggle.
