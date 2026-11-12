# Archived notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Archive and unarchive notes; archived notes leave every listing (app and MCP) until "show archived" is on, and then show dimmed with an "archived" badge.

**Architecture:** The archived state is a title list in `<notes folder>/.velo/archived`, owned by a new module `src-tauri/src/archive.rs`. Each `Index` connection mirrors the list into a per-connection `TEMP` table `archived(title_folded)`, and every listing query gains one SQL condition against it, so paging, `has_more` and totals stay in SQL. The table is keyed by folded title, not by path, so rescans, watcher batches, lock and unlock need no refresh: a re-indexed file matches by its title. `Vault` reloads the table when the list file's (mtime, size) changed, at the start of every query method, and rewrites the file itself on archive, rename, delete, merge and note creation. Every listing takes `include_archived: bool`: the front end passes the `show_archived` setting, MCP passes its per-call flag.

**Tech Stack:** Tauri 2 (Rust, rusqlite), React 19, Park UI v1 / Panda CSS 1.12.1, Vitest. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-12-velo-archived-notes-design.md`

## Global Constraints

- List file: `<notes folder>/.velo/archived`, UTF-8, one title per line, `\n` line ends, no header. A missing file means nothing is archived. velo creates the file on the first archive.
- Entries match titles case-folded with `crate::text::fold`, the function `index.rs` uses for `title_folded`. Spec name `title_folded` is the column; the function is `fold`.
- Entries are removed only by velo's own events: unarchive, delete, merge source, creation of a note with that title; rename moves the entry. An entry that matches no note is kept and ignored (no pruning). Writes are atomic (temporary file, then rename) and re-read the file first.
- Archiving never changes a note file, its content or its dates. It never needs the passphrase and writes no plaintext.
- Not filtered in any state: link resolution (`list_titles`, `find_titles`), opening by path, title uniqueness, the "No links" condition, an archived note's own Related panel.
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
| 1 | `feat/archived-notes-backend` | 1-8 | Nothing visible: no UI can archive, the README does not mention the file, no changeset. A hand-made `.velo/archived` already works end to end, and MCP gains the flag. A release cut between the PRs is safe. |
| 2 | `feat/archived-notes-ui` (from `main` after PR 1) | 9-12 | The whole feature, one `minor` changeset, README. |

## Review Focus

1. **Two files with one title** (`Foo.md` beside `Foo.md.age`, or `Foo.md` plus `Foo.txt`): one entry hides both. Renaming one of them must keep the other archived. MCP `list_tags`, which subtracts a locked note's plain-twin tags, must not subtract them a second time when the twin is already hidden. Tests: Task 4 `rename_of_one_twin_keeps_the_other_archived`, Task 7 `list_tags_does_not_double_subtract_an_archived_twin`.
2. **List file edited by hand or deleted while velo runs:** the next query reflects it, with no restart. Test: Task 3 `hand_edit_and_delete_of_list_seen_at_next_query`.
3. **A note archived in the app, then renamed by an agent while the app is open** (app mode, `AppOps`): it stays archived under the new title. Test: Task 7 `agent_rename_in_app_mode_keeps_archived`.
4. **Title case and whitespace:** the entry `meeting notes ` (CRLF line end, trailing blank) archives `Meeting Notes.md`; a case-only rename keeps it archived. Tests: Task 1 `read_trims_and_skips_blank_lines`, Task 4 `case_only_rename_keeps_archived`.
5. **Stale entry re-archives a new note:** a note archived, then deleted or renamed in Finder, leaves its title in the list; a new note created later with that title must not appear archived. Test: Task 4 `stale_entry_is_kept_and_ignored_and_creation_clears_it`.

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
  - `pub type Stamp = Option<(std::time::SystemTime, u64)>;` (mtime, size; `None` = no file)
  - `pub fn stamp(dir: &Path) -> Stamp`
  - `pub fn read(dir: &Path) -> std::io::Result<Vec<String>>`: missing file is `Ok(vec![])`; each line trimmed; blank lines skipped.
  - `pub fn update(dir: &Path, change: impl FnOnce(&mut Vec<String>)) -> std::io::Result<Vec<String>>`: re-reads the file, applies `change`, keeps the first of entries that fold the same (no pruning: an entry naming no note stays), writes each entry followed by `\n` (an empty list writes an empty file) through `.velo/archived.tmp` plus rename (creating `.velo/` if needed, like `settings::save`). Returns the entries now in effect. No write when the result equals what was read, so a missing file stays missing while nothing is archived.
- Do not use `Store::write_atomic`: it records a self-write the non-recursive watcher never consumes.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn read_missing_is_empty() { let d = tempfile::tempdir().unwrap(); assert_eq!(read(d.path()).unwrap(), Vec::<String>::new()); assert_eq!(stamp(d.path()), None); }
#[test] fn read_trims_and_skips_blank_lines() {
    let d = tempfile::tempdir().unwrap(); std::fs::create_dir(d.path().join(".velo")).unwrap();
    std::fs::write(d.path().join(FILE), "meeting notes \r\n\n  \nBar").unwrap();
    assert_eq!(read(d.path()).unwrap(), ["meeting notes", "Bar"]);
}
#[test] fn update_creates_file_and_dir() {
    let d = tempfile::tempdir().unwrap();
    assert_eq!(update(d.path(), |e| e.push("A".into())).unwrap(), ["A"]);
    assert_eq!(std::fs::read_to_string(d.path().join(FILE)).unwrap(), "A\n");
    assert!(!d.path().join(".velo/archived.tmp").exists());
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
- [ ] **Step 3: Implement** the four items above. `stamp` uses `std::fs::metadata(..).modified()` and `len()`.
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
  - `pub fn set_archived(&self, titles: &[String]) -> anyhow::Result<()>`: replaces the table's rows with `fold` of each title.
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
- Modify: callers the compiler flags in `src-tauri/src/commands.rs`, `src-tauri/src/export.rs`, `src-tauri/src/agent/ops.rs` (pass `false` until Tasks 6 and 7)
- Test: `src-tauri/src/vault.rs` tests (`setup`, `open` helpers)

**Interfaces:**
- Consumes: Task 1 `archive::{stamp, read, update, Stamp}`; Task 2 `Index::{set_archived, archived_titles}` and the `include_archived` parameters.
- Produces:
  - `Vault.archive_seen: std::cell::Cell<archive::Stamp>`, initialised `Cell::new(None)`. `Cell` keeps `Vault: Send` (it sits in `Mutex<Option<Vault>>`); the methods below stay `&self`.
  - `pub fn sync_archive(&self)`: when `archive::stamp(dir)` differs from `archive_seen`, `read` the list, `index.set_archived`, store the stamp. A read error is logged with `crate::log::line` and leaves the stamp alone (retried at the next query). Called first in `search_where`, `timeline`, `tasks`, `tags`, `link_targets`, `connections` (Task 5) and `open_note`. Rescan and `apply_fs_changes` need no call: the table is title-keyed.
  - `fn archive_edit(&mut self, change: impl FnOnce(&mut Vec<String>)) -> anyhow::Result<()>`: `archive::update`, then `index.set_archived(&entries)` and `archive_seen.set(archive::stamp(dir))` directly, so two edits within one mtime tick never leave the table stale.
  - `pub fn set_archived(&mut self, path: &str, on: bool) -> anyhow::Result<()>`: `self.note(path)?` validates the path (webview input); adds the title, or removes every entry folding to it. Never reads or decrypts the note.
  - `NoteDoc.archived: bool` (set in `open_note`), `TimelineRow.archived: bool` (from `Hit.archived`).
  - `pub fn search_where(&self, query, sort, offset, tags, no_links: bool, include_archived: bool) -> anyhow::Result<Page>`: when `!include_archived && offset == 0`, `page.hidden = <same call with include_archived = true and limit 0>.total - page.total` (limit 0 still returns `total`).
  - `pub fn timeline(&self, query, tags, no_links: bool, include_archived: bool, by, since_ms)`, `pub fn tasks(&self, query, tags, show_done: bool, include_archived: bool)` (the unlocked loop skips an archived title unless included and sets `TaskRow.archived`), `pub fn tags(&self, include_archived: bool)`, `pub fn link_targets(&self, include_archived: bool)`. `search` passes `false, false`.

- [ ] **Step 1: Write the failing tests**

```rust
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
- Modify: `src-tauri/src/vault.rs` (`rename_note`, `delete_note_with`, `create_from_selection`, `open_or_create_new`)
- Test: `src-tauri/src/vault.rs` tests (`merge_vault`, `rm` helpers exist for merge and delete)

**Interfaces:**
- Consumes: Task 3 `archive_edit`, `set_archived`.
- Produces (no new signatures):
  - `fn title_on_disk(&self, title: &str) -> bool`: some file in `self.store.list()` still has a title folding to `title` (a twin: `Foo.md` beside `Foo.md.age` or `Foo.txt`).
  - `rename_note`: after the file moved, `let twin = fold(&old.title) != fold(&nf.title) && self.title_on_disk(&old.title);` (a case-only rename finds itself on disk, so it never counts as a twin) then `self.archive_edit(|e| if e.iter().any(|t| fold(t) == fold(&old.title)) { if !twin { e.retain(|t| fold(t) != fold(&old.title)) } e.push(nf.title.clone()) }).ok()`. The old spelling is replaced unless a twin keeps it. `.ok()`: nothing may fail a rename once the file moved. Owner (`commands::rename_note`) and agent (`VaultOps::rename`, direct and app mode) both call this.
  - `delete_note_with`: after `remove_note`, unless `self.title_on_disk(&title)`, `self.archive_edit(|e| e.retain(|t| fold(t) != fold(&title))).ok()` (a remaining twin keeps the entry). `merge_notes_with` gets the source's removal through it; the target's entry is untouched.
  - `create_from_selection`, and `open_or_create_new` when it wrote the file: `self.archive_edit(|e| e.retain(|t| fold(t) != fold(title))).ok()`. Covers new note, extract, `[[` create, MCP `create_note`, `daily_note` and capture into a missing note. A conflict copy gets a new title, so no step.
  - Lock, unlock, save, agent write: no step (title-keyed).

- [ ] **Step 1: Write the failing tests**

```rust
fn shown(v: &Vault) -> Vec<String> { v.search_where("", Sort::Title, 0, &[], false, false).unwrap().hits.into_iter().map(|h| h.title).collect() }
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
- [ ] **Step 3: Implement** the four call sites.
- [ ] **Step 4: Run, see them pass.** `cargo test -q` → PASS.
- [ ] **Step 5: Commit** `feat(vault): keep .velo/archived in step on rename, delete, merge and create`.

### Task 5: Related panel (connections)

**Files:**
- Modify: `src-tauri/src/connections.rs` (`Node`, `node`, `build`), `src-tauri/src/vault.rs` (`connections`)
- Test: `src-tauri/src/connections.rs` tests (`vault`, `p`, `paths` helpers)

**Interfaces:**
- Consumes: Task 2 `Index::{archived_paths, tag_notes(.., include_archived)}`, `NodeRow.archived`.
- Produces:
  - `Node.archived: bool`.
  - `pub fn build(index, unlocked, path, text, hide: &dyn Fn(&str) -> bool, include_archived: bool) -> anyhow::Result<Connections>`: when `false`, take `archived_paths()` minus the centre and leave those paths out of `out`, `sources`, the unlocked `others`, the tag groups (`tag_notes(.., false)` gives the count) and mention matching (add them to `hide`). The centre itself is never filtered.
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
    assert_eq!(paths(&v.connections(&p(&d, "C.md"), &|_| false, false).unwrap().links_out), [p(&d, "A.md")]);
}
```

- [ ] **Step 2: Run, see it fail.** `cargo test -q connections::` → FAIL.
- [ ] **Step 3: Implement.** Existing callers pass `false` (Task 6 and 7 thread the real flag). Check the existing helper names `vault`, `p`, `paths` before use; adjust the fixture call if its signature differs.
- [ ] **Step 4: Run, see it pass.**
- [ ] **Step 5: Commit** `feat(connections): hide archived neighbours unless asked`.

### Task 6: Setting, commands, export, front-end API, demo

**Files:**
- Modify: `src-tauri/src/settings.rs` (`Settings.show_archived`, `Default`), `src-tauri/src/commands.rs` (`search`, `timeline`, `list_tags`, `list_link_targets`, `tasks`, `connections`, new `set_archived`), `src-tauri/src/lib.rs` (register `commands::set_archived`), `src-tauri/src/export.rs` (`ExportRequest.include_archived`, `build`, test `req`)
- Modify: `src/api.ts`, `src/app/fakes.ts`, `src/app/store.ts`, `src/app/controller.ts` (call sites only), `src/demo/api.ts`
- Test: `src-tauri/src/settings.rs`, `src-tauri/src/export.rs`, `src/app/controller.test.ts`, `src/demo/api.test.ts`

**Interfaces:**
- Consumes: Tasks 3 and 5 Vault signatures.
- Produces (Rust):
  - `Settings.show_archived: bool`, `false` in `Default` (comment: "show archived notes in every listing; only the UI reads it").
  - Commands gain `include_archived: bool` (camelCase `includeArchived` from TS): `search(.., no_links: Option<bool>, include_archived: bool)`, `timeline(.., no_links, include_archived, by, since_ms)`, `list_tags(include_archived)`, `list_link_targets(include_archived)`, `tasks(.., show_done, include_archived)`, `connections(path, include_archived)`.
  - `#[tauri::command(async)] pub fn set_archived(st: State<'_, AppState>, path: String, archived: bool) -> Res<()>` via `with_vault`. App commands need no capability entry (`build.rs` is plain `tauri_build::build()`).
  - `ExportRequest.include_archived: bool` with `#[serde(default)]`; `build` passes it to `Vault::timeline`.
- Produces (TS, `src/api.ts`):
  - Fields: `Hit.archived: boolean`, `Page.hidden: number`, `TimelineRow.archived`, `TaskItem.archived`, `GraphNode.archived`, `NoteDoc.archived`, `ExportRequest.include_archived`, `Settings.show_archived`.
  - `search(query, sort, offset, tags, noLinks, includeArchived: boolean)`, `timeline(query, tags, noLinks, by, sinceMs, includeArchived: boolean)`, `listTags(includeArchived: boolean)`, `listLinkTargets(includeArchived: boolean)`, `tasks(query, tags, showDone, includeArchived: boolean)`, `connections(path, includeArchived: boolean)`, `setArchived(path: string, archived: boolean): Promise<void>` (`"set_archived"`).
  - `listTitles()` unchanged: link existence (resolution) and the create checks keep archived titles.
- Produces (store/controller): `AppState.showArchived: boolean` (initial `false`), loaded in `start()` as `s.show_archived === true` and in the settings-saved `store.set` (today's line with `tasksByNote: next.tasks_by_note !== false`). Every call site passes `this.store.get().showArchived`: `Results` fetch, `loadLinkTargets`, `doLoadTimeline`, `exportRequest`, `loadRelated`, `doLoadTasks` (both `tasks` calls, so the Dock badge follows the switch too), `refreshTags`. `mergeCandidates` and `[[` completion read `linkIndex`, so they follow `listLinkTargets`.
- Produces (fakes): `fakeApi` keeps `archived = new Set<string>()` (titles): `setArchived` adds or deletes; `search` drops archived unless `includeArchived` and returns `hidden: includeArchived ? 0 : <archived count>`; `docOf` sets `archived`; `hit()` sets `archived: false`; settings literal gets `show_archived: false`.
- Produces (demo): `src/demo/api.ts` same signatures; an in-memory `archived: Set<string>` of folded titles cleared by `resetDemo`; `filtered(query, tags, noLinks, includeArchived)` drops archived notes; `search` returns `hidden` like Rust; `timeline`, `tasks`, `listTags`, `listLinkTargets`, `connections`, `exportPreview` follow the flag; `setArchived`; `renameNote` moves the title, `deleteNote` and `mergeNotes` (source) delete it, `createFromSelection` and `openOrCreate` clear it; `show_archived: false` in the demo settings. No archived note is seeded (screenshots archive one in-session).

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
```

```ts
// controller.test.ts
test("listings pass show_archived from the settings", async () => {
  const { c, api } = setup();
  api.getSettings.mockResolvedValue({ ...(await api.getSettings()), show_archived: true });
  await c.start(); await settle();
  expect(api.search.mock.calls.at(-1)?.[5]).toBe(true);
  expect(api.tasks.mock.calls.every((a) => a[3] === true)).toBe(true);
  expect(api.listTags).toHaveBeenLastCalledWith(true);
  expect(api.listLinkTargets).toHaveBeenLastCalledWith(true);
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

- [ ] **Step 2: Run, see them fail.** `cd src-tauri && cargo test -q settings:: export::` and `pnpm vitest run src/app/controller.test.ts src/demo/api.test.ts` → FAIL.
- [ ] **Step 3: Implement** the Interfaces. `pnpm build` must typecheck: every TS `Hit`, `TimelineRow`, `TaskItem`, `GraphNode`, `NoteDoc` literal in tests and the demo gets `archived`.
- [ ] **Step 4: Run, see them pass.** `cargo test -q`, `pnpm test`, `pnpm build`, `pnpm exec tsc -p e2e --noEmit` → PASS.
- [ ] **Step 5: Commit** `feat(archive): include_archived on commands, export and the front-end API`.

### Task 7: MCP

**Files:**
- Modify: `src-tauri/src/agent/ops.rs` (`NoteOps::{search, tags, tasks, connections}`, `VaultOps` impls), `src-tauri/src/agent/app_ops.rs` (forwarding impls), `src-tauri/src/agent/tools.rs` (`TOOL_SPECS` for the four tools, `call`)
- Regenerate: `site/src/content/reference/mcp-tools.json` (`cd src-tauri && VELO_UPDATE_DOCS=1 cargo test dump_tool_specs`)
- Test: `src-tauri/src/agent/tools.rs`, `src-tauri/src/agent/app_ops.rs` tests

**Interfaces:**
- Consumes: Task 3 and 5 Vault signatures.
- Produces:
  - `fn search(&self, query: &str, tags: &[String], offset: usize, no_links: bool, include_archived: bool) -> anyhow::Result<Page>`, `fn tags(&self, include_archived: bool)`, `fn tasks(&self, query, tags, show_done: bool, include_archived: bool)`, `fn connections(&self, path: &str, include_archived: bool)` on `NoteOps`, `VaultOps` and `AppOps`. `VaultOps::connections` passes the flag to `tag_notes` in its locked-group recount.
  - `VaultOps::tags`: skip the plain-twin subtraction for a locked note whose title is archived when `!include_archived` (its twin's tags were never counted).
  - `tools::call`: reads `include_archived` (`as_bool`, default `false`) on the four tools. With it set: each note object in `search_notes` and in `get_connections` (`links_out`, `links_in`, `mentions`) carries `"archived": bool`; each `get_connections` tag group keeps `titles` as strings and adds `"archived_titles": [..]`; `list_tasks` keeps `archived` on each task. Without it, none of these keys appear (`list_tasks` removes `archived` next to `path`). `read_note` and every write tool are unchanged (`find` is unfiltered).
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
    // archive through the app's vault, then rename through AppOps with an editor route answering "not-open"
    // (renamed reply ignored); the app's own search must hide the new title and list it archived with the flag
}
```

Write the body with the harness the file already uses (`state()`, `AppOps::new(&st, &route)`, `json!("not-open")` replies); assert `search_where(.., false, false)` lacks the new title and `search_where(.., false, true)` has it with `archived == true`.

- [ ] **Step 2: Run, see them fail.** `cargo test -q agent::` → FAIL; `dump_tool_specs` FAIL (stale json) once schemas change.
- [ ] **Step 3: Implement**, then `VELO_UPDATE_DOCS=1 cargo test dump_tool_specs` to rewrite `mcp-tools.json`.
- [ ] **Step 4: Run, see them pass.** `cargo test -q` → PASS.
- [ ] **Step 5: Commit** `feat(mcp): include_archived on search_notes, list_tasks, list_tags and get_connections`.

### Task 8: PR 1 gate and review

- [ ] **Step 1: Quality gate** (`CONTRIBUTING.md`), reported as a table: `pnpm build`, `pnpm exec tsc -p e2e --noEmit`, `pnpm test`, `cd src-tauri && cargo test`, `pnpm docs:check`, `cd src-tauri && cargo build --release`; capabilities unchanged.
- [ ] **Step 2: No changeset, no README change.** State in the PR body why: no user entry point yet; PR 2 adds the changeset and docs.
- [ ] **Step 3: Open the PR** `feat: archived notes backend (list file, filters, MCP flag)`, body `## Summary` / `## Test plan`, ending with the attribution line from the session.
- [ ] **Step 4: Adversarial review** by a fresh Opus agent (data integrity, two processes). Attack list: every listing path that can leak an archived note (each row of the spec's "hidden" table, `unlocked_hits`, `Vault::tasks` unlocked loop, `tag_notes` counts, MCP `tags` twin subtraction); paging and totals with archived rows on both sides of a page edge; `.velo/archived` missing, empty, CRLF, duplicated, hand-edited, deleted, unreadable, replaced within one mtime tick; rename, case-only rename, twin rename, delete, merge, create with stale entries, lock/unlock, relaunch without key; app and direct MCP on one folder; `hidden` count under tags, `no_links` and unlocked notes. Post the report on the PR; fix Critical/Major with regression tests; strike rule.

---

## PR 2: UI (`feat/archived-notes-ui`, from `main` after PR 1)

### Task 9: Actions, palette, generated docs

**Files:**
- Modify: `src/shortcuts.ts` (`Action`, `DEFAULTS`, `LABELS`), `src-tauri/src/settings.rs` (`ACTIONS: [&str; 31]`), `scripts/gen-docs.ts` (`GROUPS`), `src/palette.ts` (`NOTE_ACTIONS`, `PaletteState.archived`, `paletteItem`), `src/ui/CommandPalette.tsx` (state gets `archived`)
- Regenerate: `site/src/content/reference/shortcuts.json` (`pnpm docs:gen`)
- Test: `src/shortcuts.test.ts`, `src/palette.test.ts`, the Rust ACTIONS parity test

**Interfaces:**
- Produces: actions `"toggle_archived"` (label "Show / hide archived notes", group "View") and `"archive_note"` (label "Archive / unarchive note", group "Notes"), both `NONE`. `NOTE_ACTIONS = ["rename", "extract_note", "merge_note", "toggle_front_matter", "toggle_lock", "archive_note", "delete_note"]`. `PaletteState.archived: boolean`; `paletteItem` labels `archive_note` "Unarchive note" when `s.archived`, else "Archive note".

- [ ] **Step 1: Failing tests.** `palette.test.ts`: update the note-group expectation to `["extract_note", "merge_note", "toggle_front_matter", "toggle_lock", "archive_note", "delete_note"]` (base gets `archived: false`); new test:

```ts
test("archive entry reads Archive or Unarchive and needs an open note", () => {
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

### Task 10: Controller

**Files:**
- Modify: `src/app/store.ts` (`archived`, `hiddenArchived`), `src/app/controller.ts`, `src/list.ts` (`Results.hidden`)
- Test: `src/app/controller.test.ts`, `src/list.test.ts`

**Interfaces:**
- Consumes: Task 6 `api.setArchived`, `Page.hidden`, `NoteDoc.archived`, `AppState.showArchived`; Task 9 action ids.
- Produces:
  - `AppState.archived: boolean` (the open note; `loadedDoc` sets `doc.archived`, `closedDoc` sets `false`), `AppState.hiddenArchived: number` (from `Results.hidden` in `listChanged`).
  - `Results.hidden: number`: `page.hidden` of the latest first page (`reset` and `refresh`, like `total`).
  - `async setShowArchived(on: boolean): Promise<void>`: persists `show_archived` through `updateSettings` (as `toggleFrontMatter`), sets `showArchived`, then refreshes every listing: `filterChanged(true)`, `loadTasks()`, `refreshTimeline()`, `refreshTags()`, `loadLinkTargets()`, `loadRelated()`. Errors go to `setErr(errText(e))`.
  - `async toggleArchive(): Promise<void>`: no open note → `setErr("Open a note to archive")`; `busy` or indexing → `BUSY_MSG`; else `api.setArchived(path, !archived)`, set `archived`, then `runSearch(false)` (the open note stays in the editor; `reselect` leaves `sel` at `-1` when its row left), `loadTasks()`, `refreshTimeline()`, `refreshTags()`, `loadLinkTargets()`.
  - `actions.toggle_archived: () => void this.setShowArchived(!this.store.get().showArchived)`, `actions.archive_note: () => void this.toggleArchive()`.
  - `src/list.ts`: `hiddenText(hidden: number, showArchived: boolean, filtering: boolean): string | null` → `null` unless `!showArchived && filtering && hidden > 0`; else "1 archived note hidden" / "N archived notes hidden".

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
// list.test.ts
test("hiddenText only with a filter, the switch off and something hidden", () => {
  expect(hiddenText(3, false, true)).toBe("3 archived notes hidden");
  expect(hiddenText(1, false, true)).toBe("1 archived note hidden");
  expect(hiddenText(3, false, false)).toBeNull();
  expect(hiddenText(3, true, true)).toBeNull();
  expect(hiddenText(0, false, true)).toBeNull();
});
```

- [ ] **Step 2: Run, see them fail.** `pnpm vitest run src/app/controller.test.ts src/list.test.ts`.
- [ ] **Step 3: Implement** the Interfaces.
- [ ] **Step 4: Run, see them pass.** `pnpm test`.
- [ ] **Step 5: Commit** `feat(archive): archive the open note and the show-archived switch`.

### Task 11: UI

**Files:**
- Modify: `src/ui/PaneBar.tsx` (toggle), `src/ui/NoteList.tsx` (row badge and dim, hidden line), `src/ui/TimelineView.tsx` (row badge and dim), `src/ui/TaskList.tsx` (heading or row badge and dim, aria labels), `src/ui/TitleBar.tsx` (badge, `⋯` item), `src/theme/recipes/velo/list-row.ts` (root `'&[data-archived]': { opacity: '0.6' }`)
- Test: covered by Task 10's logic tests; a manual demo pass (Step 3)

**Interfaces:**
- Consumes: Task 10 `setShowArchived`, `toggleArchive`, `hiddenText`, store `archived`, `showArchived`, `hiddenArchived`; `Hit.archived`, `TimelineRow.archived`, `TaskItem.archived`.
- Produces (no exports):
  - PaneBar: one toggle after each mode's controls, in all three modes: `<button type="button" className={menuButton({ iconOnly: true })} aria-pressed={showArchived} aria-label="Show archived notes">` with lucide `Archive`, inside `Tooltip` `tip("toggle_archived", "Show archived notes")`. Always icon-only, so `paneBarMode` widths stay as they are. `aria-pressed` reuses the "Show done" lit style in `menu-button.ts`.
  - Rows: `data-archived` on `listRow` roots (NoteList, TimelineView) and on TaskList's `row` and note heading (add the same selector to the `row` css object there); a `<Badge size="sm" variant="subtle">archived</Badge>` (`@/components/ui`) after the title. Text badge inside the row gives the accessible name; TaskList heading `aria-label` gets ", archived"; a flat task row's checkbox `aria-label` gets ", archived".
  - NoteList: below the list (and below the "No notes match" empty state), when `hiddenText(hiddenArchived, showArchived, query.trim() !== "" || selectedTags.length > 0 || noLinks)` is not null, `<Button variant="plain" size="sm" onClick={() => void controller.setShowArchived(true)}>{text}</Button>`. Not in timeline or Tasks.
  - TitleBar: `<Badge size="sm" variant="subtle">archived</Badge>` next to the title when `s.archived`; `⋯` menu item `value="archive"` (`disabled={noNote}`), icon `Archive` / `ArchiveRestore`, text "Archive note" / "Unarchive note", `kbd("archive_note")`, before "Move to Trash".
  - CommandPalette: `archived` in `state` and in the `useMemo` deps.

- [ ] **Step 1: Implement** the Interfaces.
- [ ] **Step 2: Typecheck and tests.** `pnpm build`, `pnpm test` → PASS.
- [ ] **Step 3: Demo check.** `pnpm demo:build` and open the demo in a browser (never the app): archive the open note from `⋯` (it stays open, its row leaves, title badge shows); search a word it contains → hidden line, click → switch lit, row dimmed with badge; check timeline and Tasks; toggle from the palette. Record what was seen in the PR's Test plan; real-window rendering stays unverified.
- [ ] **Step 4: Commit** `feat(archive): archive toggle, badges and hidden-matches line`.

### Task 12: PR 2 gate, docs, changeset, review

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

- [ ] **Step 2: README.** New section `## Archived notes` after `## Saved searches`: what archiving does, the `⋯` and palette entries, the pane-bar toggle and its persistence, the hidden-matches line, links still open archived notes, rename/lock keep the state, a Finder rename un-archives, and that it is stored in `.velo/archived`. `## Storage`: add a `.velo/archived` bullet. Shortcut table: two `— | — |` rows ("Show / hide archived notes (set in Settings)", "Archive / unarchive the current note (set in Settings)"). `## Agents (MCP)`: on `search_notes`, `list_tasks`, `list_tags`, `get_connections` say archived notes are hidden unless `include_archived`; `read_note` and writes work on them; agents cannot archive. No site page change: the feature cards in `site/src/pages/index.astro` need a capture, out of scope.
- [ ] **Step 3: Quality gate** as in Task 8 Step 1, plus `pnpm docs:check`; report the table.
- [ ] **Step 4: PR** `feat: archived notes`, body `## Summary` / `## Test plan` (demo checks ticked, real-window checks unticked).
- [ ] **Step 5: Adversarial review** by a fresh Opus agent. Attack list: the invariant "an archived note never shows in a default view": every code path that fills the list, timeline, Tasks (grouped and flat), tags panel and counts, `[[` completion, merge picker, Related, export, Dock badge, including refreshes after watcher events, agent writes, lock/unlock hand-offs and switching notes folders; the open note archived then renamed, locked, deleted or merged; the switch toggled while a search, task or timeline load is in flight (`latest()` guards); hidden line with tags only, `no_links` only, and an empty result; keyboard and screen-reader use of the toggle, badge and line. Post each round on the PR; fix Critical/Major with regression tests; strike rule.

---

## Self-review notes

- Spec checks → tests: list file read/write/missing (T1), unknown entry kept and ignored (T4 `stale_entry_is_kept_and_ignored_and_creation_clears_it`), rename/delete/merge (T4); each hidden surface on and off with paging and totals (T2, T3, T5, T6, T7); locked note (T4 `archived_survives_lock_unlock_and_relaunch_without_key`); bytes and mtime (T3 `archiving_leaves_the_file_untouched`); MCP (T7); two processes (T7); unlocked notes (T2, T3); controller (T10).
- "Keeps the list in step" rows: rename owner/agent (T4, T7), lock/unlock (T4), delete (T4), merge (T4), extract/new/conflict copy (T4), edit/save/agent write (T4 `save_keeps_archived`), folder changed (T3 `each_folder_has_its_own_list`).
- Not verified against the code: the exact names of the test helpers in `connections.rs` (`vault`, `p`, `paths`) and `export.rs` (`vault` argument shape) and the `app_ops.rs` harness; the implementer adjusts the test bodies to them. Real-window rendering of dimmed rows and the toggle.
