# velo Note Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trustworthy created/modified dates in front matter (with file-date fallback), front matter hidden by default, `tags:`/`aliases:` support, 30-day local revisions, and a note info panel.

**Architecture:**
- **Rust:**
  - A pure front-matter module (parse, body, lenient dates, in-place stamping).
  - `save_note` stamps and returns the stamped block plus the note's metadata.
  - The index stores effective dates and aliases (schema v3).
  - A revisions module stores snapshots in the app data dir (FNV-keyed by folded title, ciphertext for locked notes).
- **UI:**
  - The editor applies the backend's stamped block as a non-user change and hides the block (atomic decoration).
  - The preview strips it.
  - A Park UI info panel (⌘I) shows dates, stats, tags, aliases and revisions with restore.

**Tech Stack:** Rust (rusqlite, chrono 0.4.45 already a dependency, age), React 19 + Park UI v1 + Panda 1.12.1, CodeMirror 6, vitest (node).

**Spec:** `docs/superpowers/specs/2026-10-27-velo-note-metadata-design.md` (binding).

## Global Constraints

- **Dependencies:** none new. Front matter is parsed by hand. Time handling uses `chrono` (already in `src-tauri/Cargo.toml`). Hashes for revision paths use a hand-written FNV-1a 64-bit hex.
- **Date format velo writes:** RFC 3339, seconds precision, local offset, never `Z`, e.g. `2026-10-27T09:14:05+01:00` (`DateTime<Local>` → `to_rfc3339_opts(SecondsFormat::Secs, false)`).
- **Front matter:**
  - Line 1 is exactly `---`. The block closes at the next line that is exactly `---`, within the first 200 lines. Otherwise there is no front matter.
  - velo touches only the `created` and `modified` lines and preserves everything else byte for byte.
  - It never overwrites an existing `created:` value; an empty value is filled.
  - It rewrites the first `modified:` value.
  - It never adds a duplicate key.
- **Settings:** `write_front_matter` (default true), `show_front_matter` (default false), `info_panel` (default false).
- **Shortcuts:** `toggle_info` default `Mod+KeyI`; `toggle_front_matter` default `none`.
- **Revisions:**
  - Stored at `<app data dir>/revisions/<fnv(vault dir)>/<fnv(fold(title))>/<epoch-ms>.md|.md.age`.
  - Ciphertext only for locked notes.
  - A snapshot is taken on save when the newest one is older than 10 minutes (600 000 ms); identical hashes are skipped. Retention is 30 days.
  - `snapshot_text` is not throttled.
- **Invariants:**
  - No user text lost.
  - Locked plaintext never on disk (including revisions).
  - Stamping never triggers another save.
  - Files are the source of truth.
  - Indexing gate respected.
  - Search < 50 ms p95 at 10k notes, with front matter in the fixture.
- **Commits:** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. A changeset (minor) is added in the last task.

## Review Focus

1. **A user typing while a save that stamps `modified` is in flight:** the body edit must survive, and the block update applies only if the block is unchanged. Pinned in Task 5: saver test "stamp applies only to an unchanged block, late body edits kept".
2. **A note written by Obsidian** with `created: 2023-01-05`, extra keys and comments: velo keeps `created`, rewrites only `modified`, and keeps the other bytes. Pinned in Task 1 (`stamp` cases).
3. **Locking a note that has plaintext revisions:** afterwards no `.md` snapshot remains for it. Pinned in Task 4: "lock re-encrypts snapshots".
4. **External change reload of a locked, unlocked note:** the snapshot is encrypted. Pinned in Task 4: "snapshot_text encrypts for locked notes".
5. **A note with front matter only, or front matter with no closing `---`:** search, snippet and word count don't break, and an unclosed block is treated as body. Pinned in Task 1 (`parse`) and Task 2 (index body).

---

### Task 1: Front-matter module (Rust + TS)

**Files:**
- Create: `src-tauri/src/frontmatter.rs` (registered in `src-tauri/src/lib.rs` as `pub mod frontmatter`), `src/frontmatter.ts`, `src/frontmatter.test.ts`

**Interfaces:**
- **Rust:**
  - `pub struct FrontMatter { pub end: usize /* byte offset just past the closing "---" line incl. its newline */, pub created: Option<DateTime<FixedOffset>>, pub modified: Option<DateTime<FixedOffset>>, pub tags: Vec<String>, pub aliases: Vec<String> }`
  - `pub fn parse(text: &str) -> Option<FrontMatter>`
  - `pub fn body(text: &str) -> &str`: text after the block, or the whole text.
  - `pub fn parse_date(v: &str) -> Option<DateTime<FixedOffset>>`: RFC 3339, `YYYY-MM-DD`, `YYYY-MM-DD HH:MM[:SS]` (local), optional surrounding quotes.
  - `pub fn stamp(text: &str, now: DateTime<FixedOffset>, created_fallback: DateTime<FixedOffset>) -> String` applies the spec §2 writing rules:
    - No block → prepend `---\ncreated: <fallback>\nmodified: <now>\n---\n`.
    - A block → rewrite the first `modified:` value (or append the line before the closing `---`).
    - Add `created:` only if no `created:` key exists, and fill an empty `created:` value.
  - `pub fn format(dt: DateTime<FixedOffset>) -> String`.
- **TS:**
  - `frontMatterRange(text: string): { from: 0; to: number } | null` (same rules; `to` is past the closing line's newline).
  - `stripFrontMatter(text: string): string`.
  - `wordCount(text: string): number`: body only, whitespace-separated tokens.

- [ ] **Step 1:** Rust tests in `frontmatter.rs`:
  - `parse` reads created/modified/tags (flow `[a, b]`, block `- a`, scalar) and aliases.
  - Unclosed block → `None`; line 1 `--- ` (trailing space) → `None`.
  - CRLF line endings work.
  - `body` of a block-only note is `""`.
  - `parse_date` accepts the three forms and rejects junk.
  - `stamp`:
    - (a) no block prepends;
    - (b) an Obsidian block with `created: 2023-01-05`, `# comment`, `tags: [x]` keeps every byte except the `modified` line;
    - (c) empty `created:` is filled;
    - (d) duplicate `modified:` rewrites only the first;
    - (e) a missing `modified` is inserted before the closing `---`;
    - (f) stamping twice with the same `now` is idempotent.
- [ ] **Step 2:** TS tests: `frontMatterRange` cases mirror Rust (none, closed, unclosed, CRLF); `stripFrontMatter`; `wordCount("---\ncreated: x\n---\nhello big world") === 3`.
- [ ] **Step 3:** Run `cd src-tauri && cargo test frontmatter` and `pnpm vitest run src/frontmatter.test.ts`. Expected: FAIL.
- [ ] **Step 4:** Implement both.
- [ ] **Step 5:** Run both. Expected: PASS. Commit `feat: front-matter parsing and stamping`.

### Task 2: Index schema v3 (dates, body, tags, aliases)

**Files:**
- Modify: `src-tauri/src/index.rs`, `src-tauri/src/vault.rs`, `src-tauri/src/text.rs` (if tag extraction needs the body), `src-tauri/tests/perf.rs`, `scripts/seed.mjs` (front matter on ~half the fixture notes), `src/api.ts`

**Interfaces:**
- Consumes: Task 1 `parse`, `body`.
- Produces:
  - **`notes` table:** gains `created INTEGER NOT NULL, created_src TEXT NOT NULL, modified INTEGER NOT NULL, modified_src TEXT NOT NULL` (epoch ms; src `"frontmatter" | "file"`). Effective values: front matter, else file times (created = min(birth time, mtime); birth time via `Metadata::created()`, ignored if unavailable).
  - **New table** `aliases(path TEXT NOT NULL, alias_folded TEXT NOT NULL, alias_display TEXT NOT NULL)` with an index on `alias_folded`.
  - **Search:** FTS body and snippet use `frontmatter::body`. Front-matter `tags:` merge into the `tags` rows. Locked notes get file-based dates only.
  - **`user_version` = 3:** drop and recreate as in v2 (DROP, not DELETE).
  - **`Hit.mtime`:** now carries the **effective modified**. The Recent sort orders by `notes.modified`.
  - **Aliases count as titles:**
    - `find_title` falls back to aliases;
    - `titles()` (used for wikilink existence) includes alias display names;
    - search puts alias matches in the title group.
  - **`pub struct NoteMeta { created: i64, created_src: String, modified: i64, modified_src: String, tags: Vec<String>, aliases: Vec<String> }`** (serde camel/snake as the codebase does). `NoteDoc` gains `meta: NoteMeta`, computed in `open_note` from the plaintext (so unlocked locked notes show their front-matter dates). TS `NoteDoc.meta` and `NoteMeta` types follow.
- [ ] **Step 1:** Rust tests:
  - Front-matter dates win over file times; `_src` values are correct.
  - A note without front matter uses file times.
  - Search for a word only in front matter finds nothing.
  - The snippet excludes front matter.
  - Front-matter `tags: [Work]` lists under `work` in `tags()`.
  - `[[alias]]`: `titles()` contains the alias, and `find_title("alias")` returns the note.
  - Searching an alias puts the note in the title group.
  - Schema upgrade from 2 → 3 reindexes.
  - Recent sort follows front-matter `modified`, not mtime.
- [ ] **Step 2:** Run `cargo test`. Expected: FAIL.
- [ ] **Step 3:** Implement; update `src/api.ts` types (`NoteMeta`, `NoteDoc.meta`).
- [ ] **Step 4:** Seed a fixture with front matter on half the notes (`node scripts/seed.mjs 10000 fixtures/notes` after updating the script, re-seeding into an emptied folder). Run the perf test (`cd src-tauri && cargo test --release --test perf -- --ignored --nocapture`). Expected: p95 < 50 ms; report the numbers.
- [ ] **Step 5:** Run `cargo test && pnpm test && pnpm build`. Expected: PASS. Commit `feat: index stores effective dates, aliases and front-matter tags`.

### Task 3: Stamping on save, new notes, settings

**Files:**
- Modify: `src-tauri/src/vault.rs` (`save_note`, `open_or_create`), `src-tauri/src/store.rs` (`SaveResult`), `src-tauri/src/settings.rs`, `src-tauri/src/commands.rs`, `src/api.ts`, `src/shortcuts.ts` (+ tests), `src/app/store.ts`, `src/app/controller.ts`, `src/app/fakes.ts`, `src/ui/SettingsDialog.tsx`, `src/settingsform.ts`

**Interfaces:**
- **`SaveResult::Saved`:** `{ hash: String, front_matter: Option<String>, meta: NoteMeta }`.
  - `front_matter` is the full stamped block (from `---` through the closing line and newline), present when stamping changed the text.
  - `Conflict` is unchanged; the conflict copy is stamped too.
- **`save_note`:** when `write_front_matter` is on, stamp with `now = Local::now().fixed_offset()` and `created_fallback` = the effective file-based created date of the file before the write (now if missing). Encrypt the stamped text for locked notes. Reindex with the stamped text.
- **`open_or_create`:** new files get `---\ncreated: <now>\nmodified: <now>\n---\n` when the setting is on (empty otherwise).
- **Settings:**
  - Rust `Settings` gains `write_front_matter: bool` (default true), `show_front_matter: bool` (false), `info_panel: bool` (false).
  - TS `Settings` type and fakes follow.
  - `toSettings` / the Settings form carries `write_front_matter` as a General checkbox labelled "Add created/modified dates to notes (front matter)".
  - Store fields: `writeFrontMatter`, `showFrontMatter`, `infoOpen`, set on start and after `saveSettings`.
- **Shortcuts:** `toggle_info` (`Mod+KeyI`, label "Note info"), `toggle_front_matter` (`none`, label "Show / hide front matter").
- **The vault reads `write_front_matter` how? (my call):** `AppState` holds settings; `save_note` / `open_or_create` commands pass `settings.write_front_matter` into the vault calls as a parameter.
- [ ] **Step 1:** Rust tests:
  - Save of a plain note with the setting on returns `Saved` with `front_matter` starting `---\ncreated: `, and the file starts with it.
  - Save with the setting off writes the text as is and returns `front_matter: None`.
  - Save of a note whose block is already current with the same second → `front_matter: None` (nothing changed).
  - `created` on first stamping equals the file's earliest time (set mtime in the test with `filetime`, if available in dev-deps; otherwise compare to the read metadata).
  - A locked note's ciphertext decrypts to stamped text.
  - `open_or_create` writes the block for new notes.
  - The settings round-trip covers the defaults.
  - TS: shortcut defaults; settings form carries the checkbox.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `cargo test && pnpm test && pnpm build`. Expected: PASS. Commit `feat: stamp created/modified on save and new notes`.

### Task 4: Revisions backend

**Files:**
- Create: `src-tauri/src/revisions.rs`
- Modify: `src-tauri/src/vault.rs` (hooks in save / rename / lock / unlock), `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs` (register commands; prune on open + daily via the vault), `src/api.ts`

**Interfaces:**
- **Rust:**
  - `pub struct Revisions { root: PathBuf }`: `<app data dir>/revisions/<fnv64(vault dir string)>`.
  - `fn fnv64(s: &str) -> String`: hex, hand-written.
  - `key_for(title: &str) -> String` = `fnv64(&fold(title))` (`fold` from text/index).
  - Methods:
    - `snapshot_bytes(&self, title, bytes: &[u8], encrypted: bool, now_ms: i64, throttle: bool) -> io::Result<bool>`. Skips if the newest snapshot has the same hash, or if `throttle` and the newest is < 600 000 ms old. Writes `<now_ms>.md` or `.md.age`.
    - `list(&self, title) -> Vec<RevisionInfo { id: String /* file name */, ts: i64, size: u64 }>`, newest first.
    - `read(&self, title, id) -> io::Result<(Vec<u8>, bool /*encrypted*/)>`.
    - `rename(&self, old_title, new_title)`.
    - `encrypt_all(&self, title, encrypt: impl Fn(&[u8]) -> anyhow::Result<Vec<u8>>)`: rewrite `.md` → `.md.age`, deleting the plaintext.
    - `prune(&self, now_ms)`: delete files older than 30 days and empty folders.
- **Vault hooks:**
  - After a successful save, `snapshot_bytes(title, written_bytes, encrypted, now, throttle=true)`.
  - Rename → `rename`.
  - `lock_note` → `encrypt_all` with the same identity.
  - `unlock_note` → nothing.
  - Vault open → `prune`, then at most once per 24 h on later saves.
- **Commands:**
  - `list_revisions(path) -> Vec<RevisionInfo>`.
  - `read_revision(path, id) -> String` (decrypts `.md.age` with the identity, or errors `"locked"`).
  - `snapshot_text(path, text)`: encrypts for locked notes; not throttled.
  - All gated like the other note commands.
- **TS:** `RevisionInfo` type plus `listRevisions`, `readRevision`, `snapshotText` in `src/api.ts`.
- [ ] **Step 1:** Rust tests (tempdir root):
  - A throttled snapshot is skipped within 10 minutes and written after.
  - Identical content is skipped.
  - `list` is newest-first.
  - `prune` drops > 30 days.
  - "lock re-encrypts snapshots": after `lock_note`, the folder has no `.md` files and `read_revision` decrypts.
  - "snapshot_text encrypts for locked notes": the file is `.md.age`, not plaintext.
  - Rename moves history; `fnv64` is stable (a known vector, e.g. `fnv64("") == "cbf29ce484222325"`).
  - The key ignores case and accents (fold).
- [ ] **Step 2:** Run `cargo test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `cargo test && pnpm test && pnpm build`. Expected: PASS. Commit `feat: local revisions with 30-day retention`.

### Task 5: Editor integration (stamp apply, hiding, preview, reload snapshot)

**Files:**
- Modify: `src/saver.ts` (+ `saver.test.ts`), `src/editor.ts`, `src/editortheme.ts` or a new `src/fmhide.ts`, `src/preview.ts` (+ test), `src/app/controller.ts` (+ tests), `src/app/fakes.ts`

**Interfaces:**
- **`SaverDeps.saveNote`** result `Saved` carries `front_matter` / `meta`. `SaverDeps` gains `applyFrontMatter?(block: string, sentBlock: string | null): void` and `onMeta?(meta: NoteMeta): void`.
  - The saver calls `applyFrontMatter(result.front_matter, <block of the text it sent>)` after a successful save. Then it sets the base hash to the returned hash **without** marking dirty.
  - The editor implements `applyFrontMatter` by dispatching a change over the current `frontMatterRange` with `Transaction.addToHistory.of(false)` and an annotation the update listener ignores (no `onEdit`, no `ctrl.edit()`). It skips if the editor's current block text !== `sentBlock` (the user changed it during the save).
  - A late body edit during the save stays dirty and saves normally (existing logic).
- **Hiding:** `frontMatterHide(show: () => boolean)`, a CodeMirror extension.
  - When hidden, it adds a replace decoration over `frontMatterRange` (block-level, the whole lines) plus `EditorView.atomicRanges`, so the caret skips it. The cursor is placed after the block on load.
  - Active in both Rich and Plain.
  - `Editor` gains `setShowFrontMatter(on: boolean)`.
- **Preview:** `renderMarkdown` strips front matter first (test: front matter text doesn't appear in the output).
- **Controller:**
  - `onNotesChanged` for the open, clean note calls `api.snapshotText(path, editor.getText())` **before** `editor.onExternalChange(path)`. Errors are ignored and logged.
  - `restoreRevision(id)`: flush; read the revision; `snapshotText(current)`; then replace the editor text as a user edit (`editor.replaceText(text)`, new method, dirty → autosave).
  - `store.showFrontMatter` drives `editor.setShowFrontMatter`.
  - The `toggle_front_matter` action flips and persists the setting.
- [ ] **Step 1:** Tests:
  - saver: "stamp applies only to an unchanged block, late body edits kept"; "stamp application doesn't mark dirty or trigger another save".
  - preview strip.
  - controller: "external change snapshots the old text before reload"; "restore snapshots current text then replaces it as an edit"; "toggle_front_matter persists".
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test && pnpm build`. Then the WebKit smoke (stub `save_note` returning a `front_matter`): typing keeps the caret, the block stays hidden, the toggle shows it, and the preview has no front matter. Commit `feat: editor applies stamped dates and hides front matter`.

### Task 6: Note info panel

**Files:**
- Create: `src/ui/InfoPanel.tsx`
- Modify: `src/ui/App.tsx` (layout: the panel to the right of the note pane), `src/ui/TitleBar.tsx` (ⓘ button), `src/app/controller.ts` / `store.ts` (info state, `toggleInfo`, `loadInfo`, `selectRevision`, `restoreRevision`), `src/app/controller.test.ts`

**Interfaces:**
- **Store:** `info: { meta: NoteMeta | null; words: number; backlinks: number | null; revisions: RevisionInfo[] | null; preview: { id: string; text: string } | null }`.
- **Controller loading:** `loadInfo()` runs on note load, after each save (meta from the `Saved` result via `onMeta`), and when the panel opens. It fetches `backlinkCount(title)` and `listRevisions(path)`, but only while `infoOpen` (no backend calls when closed).
- **Controller actions:** `toggleInfo()` flips and persists `info_panel`; `selectRevision(id)` → `readRevision` → `info.preview`; `restoreRevision(id)` confirms via `ui.confirm("Replace the note with this version from <time>? The current text is kept as a revision.", { title: "Restore revision", okLabel: "Restore" })`.
- **Panel** (Park UI; 280 px; velo.chrome background; left border velo.divider), with sections:
  - **Dates:** absolute local plus relative. A file-based source shows a muted "from file" hint with the tooltip copy from spec §4.
  - **Info:** words, "Linked from N notes", tags (merged front-matter tags and body `#tags`, as chips → `toggleTagFilter`), aliases.
  - **Revisions:** a list; selecting one shows the read-only preview and a Restore button. The empty state reads "No revisions yet".
  - A "Show front matter in the editor" checkbox.
- **Title bar:** an ⓘ `IconButton` (`aria-pressed`, tooltip "Note info" + binding).
- [ ] **Step 1:** Controller tests: "info loads only while open"; "meta updates after save"; "restore asks for confirmation and does nothing when declined".
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test && pnpm build`. Then the WebKit smoke with the stub (extended for `list_revisions`, `read_revision`, `backlink_count`, `meta`): open the panel with ⌘I, dates with a "from file" hint, a revision preview, restore confirm, tag chip click; light and dark; both layouts. Commit `feat: note info panel with dates and revisions`.

### Task 7: Docs and changeset

**Files:** `README.md`, `.changeset/note-metadata.md`

- [ ] **Step 1:** README: a "Dates and front matter" section (what velo writes and when, the setting, hidden by default with the toggle, `tags:`/`aliases:` support) and "Revisions" (local only, 30 days, info panel ⌘I).
- [ ] **Step 2:** Changeset (minor), one past-tense paragraph from the user's point of view.
- [ ] **Step 3:** Run `pnpm test && pnpm build && (cd src-tauri && cargo test)`, plus the perf test. Commit `docs: note metadata and revisions`.
