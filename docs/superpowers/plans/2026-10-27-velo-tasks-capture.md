# Tasks, quick capture and daily note Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** velo collects every `- [ ]` task across notes into a Tasks view with `📅` due dates and `✅` done dates, captures tasks from anywhere through the main window, and opens a daily note. TODOs stop needing another app.

**Architecture:**
- **Source of truth:** tasks stay as lines in the notes.
- **Rust (`tasks.rs`):** parses and toggles task lines. The index gets a `tasks` table, filled by the existing upsert (locked notes stay in memory only).
- **One pure grouping function:** builds the view from SQL rows plus unlocked notes.
- **One writer per note:** writes to a note that is open in the editor go through the editor; writes to closed notes go through new backend commands on the normal save path.
- **Frontend:** a Notes | Tasks mode in the left pane. Capture is a mode of the existing search field, triggered by a second global shortcut.

**Tech Stack:** Tauri 2 (Rust, rusqlite FTS5, chrono), React 19 + Park UI + Panda CSS, CodeMirror 6, vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-10-27-velo-tasks-capture-design.md`

## Global Constraints

- **Dependencies:** no new dependencies.
- **Task line rule:** `TASK_ITEM` in `src/preview.ts`: `/^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/`. Lines inside fenced code blocks are not tasks.
- **Dates:**
  - Due date: only `📅 YYYY-MM-DD`; the first match on the line wins. velo never writes it.
  - Done date: ticking through velo appends ` ✅ YYYY-MM-DD` (local date); unticking removes it. An existing `✅ date` is replaced, never duplicated. Typing `x` by hand adds no date.
  - Dates are local time. Groups are Overdue (due < today, open), Today, Upcoming, No date.
- **Line numbers:** 0-based, in full-text coordinates (front matter included).
- **Shortcuts:**
  - `toggle_tasks` = `Mod+Shift+KeyX`
  - `daily_note` = `Mod+Shift+KeyD`
  - `capture` (global) = `Mod+Shift+Alt+KeyN`
- **Settings:** `capture_target` = `"inbox"` (default) or `"daily"`. `inbox_title` = `Inbox` (default); empty or invalid falls back to `Inbox`.
- **Daily note title:** `YYYY-MM-DD`, local.
- **Show done:** done tasks whose `✅` date is within the last 7 days.
- **Undo toast:** "Ticked · Undo" for 5 seconds after a backend tick.
- **Index:** `user_version` = 4 (drop and reindex, as for version 3).
- **Invariants:** no user text lost; locked plaintext never on disk or in the index; files are the source of truth; the indexing gate; search < 50 ms p95 at 10k notes.
- **Workflow:** AGENTS.md / CONTRIBUTING.md: feature branch `feat/tasks`, quality gate, changeset (minor), PR with adversarial review.

## Review Focus

1. **CRLF notes:** a task in a note with `\r\n` line endings. Ticking keeps `\r\n` everywhere, and line numbers still match. Test in Task 2 and Task 4.
2. **Code fences:** a `- [ ]` line inside a fenced code block is never listed and never ticked by `toggle_task`. Test in Task 2.
3. **Repeated ticks:** tick, untick and tick again give exactly one `✅ <today>`, and the `📅` date is kept. Test in Task 2, mirrored in TS in Task 5.
4. **Locked notes:** their tasks never reach SQLite, but appear while unlocked. Test in Task 3.
5. **Capture into a dirty Inbox:** capturing while the target note is open with unsaved edits makes no conflict copy and keeps both texts. Test in Task 8 (controller).

---

### Task 1: Spike — does `app.hide()` give focus back after capture? (throwaway)

**Files:** none committed.

- [ ] **Step 1:** In a scratch copy, temporarily register a second global shortcut. Its handler shows the window and focuses the search field; on Enter it calls `app.hide()`, the same way `toggle_window` hides velo on macOS (`commands.rs` `toggle_window`).
- [ ] **Step 2:** Run `pnpm tauri dev`. Put TextEdit in front, press the shortcut, type, and press Enter.
  - Expected: TextEdit is frontmost again, with its caret where it was.
- [ ] **Step 3:** Record the result in the SDD ledger, then delete the scratch code. If focus does not return, stop and report: Task 8's return step needs another approach.

### Task 2: Task line parsing and toggling (Rust + shared fixture)

**Files:**
- Create: `src-tauri/src/tasks.rs` (add `pub mod tasks;` to `lib.rs`)
- Create: `tests/fixtures/task-toggle.json` (shared with Task 5)
- Test: inline `#[cfg(test)]` in `tasks.rs`

**Interfaces — Produces:**
- `pub struct TaskLine { pub line: usize, pub text: String, pub done: bool, pub due: Option<String>, pub done_on: Option<String> }`
  - `text` has the box, `📅 …` and `✅ …` removed and is trimmed.
- `pub fn parse_tasks(full_text: &str) -> Vec<TaskLine>`
  - Skips the front-matter block (`frontmatter::parse(..).end`) and fenced code (```` ``` ```` / `~~~`).
  - Line numbers count the whole text.
- `pub fn toggle_line(line: &str, today: &str) -> Option<String>`
  - Returns `None` if `line` is not a task.
  - Open → done: box becomes `x`, ` ✅ <today>` appended (an existing ✅ is replaced).
  - Done → open: box becomes a space, ` ✅ <date>` removed.
  - Keeps a trailing `\r`.
- `pub fn local_today() -> String` (`chrono::Local::now()`, `%Y-%m-%d`).

- [ ] **Step 1: Write the shared fixture** `tests/fixtures/task-toggle.json`: an array of `{ "in": string, "today": string, "out": string | null }`. It must include:
  - `"- [ ] a"` → `"- [x] a ✅ 2026-10-27"`
  - `"- [x] a ✅ 2026-10-01"` → `"- [ ] a"`
  - `"- [X] a"` → `"- [ ] a"`
  - `"- [ ] call 📅 2026-10-30"` → `"- [x] call 📅 2026-10-30 ✅ 2026-10-27"`
  - `"> - [ ] q\r"` → `"> - [x] q ✅ 2026-10-27\r"`
  - `"text - [ ] mid"` → `null`
  - `"- [x] a ✅ 2026-10-01 ✅ 2026-10-02"` → `"- [ ] a"`

  Use `"today": "2026-10-27"` throughout.
- [ ] **Step 2: Write failing tests**
  - `toggle_matches_fixture`: `include_str!("../../tests/fixtures/task-toggle.json")`, parsed with serde_json; every case satisfies `toggle_line(in, today) == out`.
  - `parse_skips_front_matter_and_code`: text `"---\ncreated: x\n---\n- [ ] a 📅 2026-11-01\n```\n- [ ] code\n```\n* [x] b ✅ 2026-10-20\r\n"` gives:
    - `line 3, text "a", done false, due Some("2026-11-01")`;
    - `line 7, text "b", done true, done_on Some("2026-10-20")`.
  - `toggle_twice_is_one_done_date`: open → `toggle_line` ×3 → exactly one `✅` with today, and the due date is kept.
- [ ] **Step 3: Run** `cd src-tauri && cargo test tasks::`. Expected: FAIL (module missing).
- [ ] **Step 4: Implement** the signatures above. Use one regex-free scanner per line, plus `str::find("📅 ")` / `find("✅ ")` followed by 10-char ISO validation (`chrono::NaiveDate::parse_from_str`).
- [ ] **Step 5: Run** `cargo test tasks::`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(tasks): parse and toggle task lines`.

### Task 3: Index `tasks` table and the grouped view

**Files:**
- Modify: `src-tauri/src/index.rs` (schema, `DELETES`, `upsert`, version 4)
- Modify: `src-tauri/src/vault.rs` (add `Vault::tasks`)
- Modify: `src-tauri/src/tasks.rs` (add the grouping function)
- Modify: `src-tauri/tests/perf.rs`, `scripts/seed.mjs` (seed tasks)

**Interfaces:**
- Consumes: `parse_tasks`, `TaskLine` (Task 2).
- Produces:
  - Schema: `CREATE TABLE IF NOT EXISTS tasks(path TEXT NOT NULL, line INTEGER NOT NULL, text TEXT NOT NULL, done INTEGER NOT NULL, due TEXT, done_on TEXT)`, plus `CREATE INDEX IF NOT EXISTS tasks_path ON tasks(path)`.
  - `Index::task_rows(&self, tags: &[String]) -> anyhow::Result<Vec<TaskRow>>`, where `TaskRow { path, title, modified: i64, line, text, done, due, done_on }`. Rows are filtered to notes carrying all `tags` (same rule as `search_page`).
  - `#[derive(Serialize)] pub struct TaskItem { path, title, line, text, due: Option<String>, done: bool, done_on: Option<String>, line_text: String }`, where `line_text` is the raw line (the `expected` for ticks).
  - `#[derive(Serialize)] pub struct TaskView { overdue: Vec<TaskItem>, today: Vec<TaskItem>, upcoming: Vec<TaskItem>, no_date: Vec<TaskItem>, done: Vec<TaskItem>, due_count: usize }`.
  - `pub fn group_tasks(rows: Vec<TaskRow>, query: &str, show_done: bool, today: &str) -> TaskView` (pure).
    - `query` matches the folded task text or note title.
    - Inside each group: due date ascending, then `modified` descending.
    - `done` holds tasks with `done_on` within the last 7 days, only when `show_done`.
    - `due_count = overdue + today`.
  - `Vault::tasks(&self, query: &str, tags: &[String], show_done: bool) -> anyhow::Result<TaskView>`.
    - Merges in rows from `parse_tasks` over the `unlocked` map entries, with their note's tags taken from the plaintext via `all_tags`.
    - Needs the raw line text, so `task_rows` also returns `line_text`, stored in a `line_text TEXT` column.

- [ ] **Step 1: Write failing tests** (`index.rs` / `vault.rs` / `tasks.rs`):
  - `upsert_fills_tasks_and_remove_clears`: upsert a note with 2 tasks → `task_rows(&[])` has 2 rows; after `remove`, it has 0.
  - `locked_tasks_never_in_sqlite_but_listed_while_unlocked`:
    - Lock a note with `- [ ] secretzebra` (as in `lock_keeps_plaintext_off_disk_and_db`).
    - No `tasks` row contains `secretzebra`.
    - With the note unlocked in the vault, `vault.tasks("", &[], false)` lists `secretzebra`; after `lock_all()` it doesn't.
  - `group_tasks_buckets_and_orders`: rows due 2026-10-20, 2026-10-27, 2026-11-02 and none, open, with today `2026-10-27`, give one each in overdue/today/upcoming/no_date and `due_count == 2`.
  - `show_done_only_last_7_days`: a done task with `done_on` 2026-10-21 is listed and one with 2026-10-19 isn't (today 2026-10-27, `show_done=true`); with `show_done=false`, `done` is empty.
  - `query_matches_task_text_or_title`.
  - `schema_v3_db_is_rebuilt_as_v4` (copy the existing v2→v3 test pattern).
- [ ] **Step 2: Run** `cargo test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Add `"DELETE FROM tasks WHERE path=?1"` to `DELETES` (size 6).
  - In `upsert`, when `text` is Some and the note is not encrypted, insert `parse_tasks(body)` rows. `body` here is the full text, which keeps the line numbers right.
  - Bump the version check to `< 4` and add `DROP TABLE IF EXISTS tasks`.
- [ ] **Step 4:** In the perf fixture, have `scripts/seed.mjs` add 1–3 task lines to 30% of notes. Add a perf assertion: `task_rows` + `group_tasks` p95 < 50 ms on 10k notes.
- [ ] **Step 5: Run** `cargo test`, then `node scripts/seed.mjs 10000 fixtures/notes && cargo test --release --test perf -- --ignored --nocapture`. Expected: PASS, with the tasks p95 printed under 50 ms.
- [ ] **Step 6: Commit** `feat(tasks): index tasks and group them`.

### Task 4: Backend commands — `tasks`, `toggle_task`, `capture_task`, `set_badge`

**Files:**
- Modify: `src-tauri/src/vault.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs` (handler list), `src/api.ts`

**Interfaces:**
- Consumes: `toggle_line`, `local_today` (Task 2); `Vault::tasks` (Task 3); the existing `save_note` path.
- Produces (Rust):
  - `Vault::toggle_task(&mut self, path: &str, line: usize, expected: &str, identity: Option<&str>, write_fm: bool) -> anyhow::Result<()>`
    - Reads the note (decrypting a locked note, or failing with `"locked"`).
    - Fails with `anyhow!("task-moved")` if line `line` (split on `\n`, `\r` kept) != `expected`, or if `toggle_line` returns None.
    - Otherwise replaces that line and saves through `save_note` with the disk hash.
  - `Vault::capture_task(&mut self, title: &str, text: &str, identity: Option<&str>, write_fm: bool) -> anyhow::Result<String>`
    - Finds or creates the note via `open_or_create`.
    - Appends `- [ ] <text>` as a new last line (adding `\n` first if the note doesn't end with one), saves with its hash, and returns the path.
- Produces (commands, all `#[tauri::command(async)]`):
  - `tasks(query, tags, show_done) -> TaskView`
  - `toggle_task(path, line, expected)`
  - `capture_task(text) -> String` (resolves the target from settings, see Task 8)
  - `set_badge(count: u32)`: `WebviewWindow::set_badge_count(if count == 0 { None } else { Some(count as i64) })`, macOS only; on other platforms it does nothing.
- Produces (TS, `src/api.ts`):
  - `tasks(query: string, tags: string[], showDone: boolean): Promise<TaskView>`
  - `toggleTask(path: string, line: number, expected: string): Promise<void>`
  - `captureTask(text: string): Promise<string>`
  - `setBadge(count: number): Promise<void>`
  - TS types `TaskItem` and `TaskView` mirror Rust (snake_case keys).

- [ ] **Step 1: Write failing tests** (`vault.rs`):
  - `toggle_task_flips_and_dates`: a note `"- [ ] a\n"` → `toggle_task(path, 0, "- [ ] a", None, false)` → the file reads `"- [x] a ✅ <today>\n"`.
  - `toggle_task_refuses_moved_line`: `expected "- [ ] b"` on a line holding `"- [ ] a"` → error text `"task-moved"`, and the file is unchanged.
  - `toggle_task_keeps_crlf`: `"x\r\n- [ ] a\r\n"` line 1 → `"x\r\n- [x] a ✅ <today>\r\n"`.
  - `toggle_task_in_code_fence_refused`: a fence line → `"task-moved"`.
  - `capture_appends_and_creates`: `capture_task("Inbox", "buy milk")` on a missing note creates `Inbox.md` whose text ends with `"- [ ] buy milk\n"`. A second capture appends a second line.
  - `capture_to_locked_without_key_fails_locked`.
- [ ] **Step 2: Run** `cargo test`. Expected: FAIL.
- [ ] **Step 3: Implement**, reusing `save_note` for the write so stamping, revisions and conflict handling stay identical.
- [ ] **Step 4: Run** `cargo test` and `pnpm exec tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tasks): toggle, capture and badge commands`.

### Task 5: Editor — done dates, `appendLine`, `due:` aid

**Files:**
- Create: `src/tasks.ts` (TS twin of `toggle_line`)
- Modify: `src/tasks.test.ts`, `src/editor.ts`, `src/app/fakes.ts`

**Interfaces — Produces:**
- `export function toggleTaskLine(line: string, today: string): string | null`, matching the Rust behaviour.
- `export const localToday = (): string`, giving `YYYY-MM-DD` from the local `Date`.
- Editor changes:
  - `Editor.toggleTask(line)` now replaces the whole line with `toggleTaskLine(text, localToday())` (a user edit).
  - New `Editor.appendLine(text: string): boolean`: a user edit that appends `text` as a new last line; returns false when not editable.
  - Input rule: typing a space right after `due:` replaces `due:` with `📅`.

- [ ] **Step 1: Write failing tests** in `src/tasks.test.ts`:
  - `toggleTaskLine matches the shared fixture`: import `../tests/fixtures/task-toggle.json`; every case holds.
  - `due: input rule`: build an `EditorState` with the exported `dueInputRule` extension and apply a typed `" "` after `"- [ ] call due:"`. The doc becomes `"- [ ] call 📅 "`.
- [ ] **Step 2: Run** `pnpm test src/tasks.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `toggleTaskLine` and `localToday` in `src/tasks.ts`.
  - `dueInputRule` (exported from `src/tasks.ts`): an `EditorView.inputHandler`, added to the editor's extensions in `editor.ts`.
  - Editor methods as above.
  - `FakeEditor.appendLine`: records the text and returns `this.path !== null && !this.suspended`.
- [ ] **Step 4: Run** `pnpm test && pnpm exec tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tasks): done dates in the editor and due: aid`.

### Task 6: Tasks view (left-pane mode), ticking, undo, badge

**Files:**
- Create: `src/ui/TaskList.tsx`
- Modify: `src/app/store.ts`, `src/app/controller.ts`, `src/app/controller.test.ts`, `src/ui/App.tsx`, `src/ui/Header.tsx` (mode switch), `src/shortcuts.ts`, `src/ui/main.tsx`

**Interfaces:**
- Consumes: `api.tasks`, `api.toggleTask`, `api.setBadge` (Task 4); `Editor.toggleTask` (Task 5).
- Produces:
  - Store fields:
    - `paneMode: "notes" | "tasks"`
    - `taskView: TaskView | null`
    - `showDone: boolean`
    - `tickUndo: { path: string; line: number; lineText: string } | null`
  - Controller methods:
    - `setPaneMode(m)`
    - `loadTasks()`: calls `api.tasks(query, selectedTags, showDone)`, sets `taskView`, then `api.setBadge(due_count)`.
    - `tickTask(item: TaskItem)`
    - `undoTick()`
    - `openTask(item)`
    - `toggleShowDone()`
  - New action `toggle_tasks` (default `Mod+Shift+KeyX`, label "Notes / Tasks").
  - A midnight timer in `main.tsx` (`setTimeout` to the next local midnight, then re-armed) calls `controller.loadTasks()`.

- [ ] **Step 1: Write failing controller tests:**
  - `tick on the open note goes through the editor`: `editor.path === item.path` → `editor.toggleTask(item.line)` is called and `api.toggleTask` isn't.
  - `tick on a closed note calls the backend and offers undo`: `api.toggleTask(path, line, line_text)` is called and `store.tickUndo` is set. Calling `undoTick()` calls `api.toggleTask(path, line, <new line text>)`, where the new line text is `toggleTaskLine(line_text, today)` from Task 5.
  - `task-moved refreshes and says so`: `api.toggleTask` rejects with `"task-moved"` → `loadTasks` is called and `err === "This task changed — refreshed"`.
  - `loadTasks sets the badge`: `due_count 3` → `api.setBadge(3)`.
  - `search and tags are shared between modes`: `setQuery("x")` in Tasks mode passes `"x"` to `api.tasks`.
  - `undo toast expires`: with fake timers, after 5000 ms `tickUndo` is null.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `TaskList.tsx`: groups with headers; each row has a Park UI `Checkbox`, the text, the muted note title and a due pill (`badge` recipe, red tone when overdue).
  - Footer: a "Show done" toggle and the undo toast.
  - Clicking a row runs `openTask`: show the note, then place the caret on that line, mapping through hidden front matter the way `afterOpen` does.
  - Refresh triggers: `onNotesChanged`, `onSaved`, `onIndexDone` call `loadTasks` when `paneMode === "tasks"`. The badge refreshes on the same triggers in either mode.
- [ ] **Step 4: Run** `pnpm test && pnpm exec tsc --noEmit && pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tasks): Tasks view with ticking, undo and badge`.

### Task 7: Global shortcuts as a list

**Files:**
- Modify: `src-tauri/src/settings.rs`, `src-tauri/src/commands.rs` (`register_hotkey`, `set_settings`), `src-tauri/src/lib.rs`, `src/shortcuts.ts`

**Interfaces — Produces:**
- `Settings::global_bindings(&self) -> Vec<(GlobalAction, String)>`, where `enum GlobalAction { ToggleWindow, Capture }`. The defaults are `Mod+Shift+Space` and `Mod+Shift+Alt+KeyN`, read from `shortcuts["toggle_window"]` and `shortcuts["capture"]`.
- `register_global(app, action, binding) -> Result<(), String>`:
  - `ToggleWindow` → the existing `toggle_window`.
  - `Capture` → `capture_requested(app)`: remember `was_hidden` in `AppState`, show and focus the window, emit `"capture"`.
- `set_settings` swaps each changed global binding independently, with the existing rollback-on-failure rule per action.
- `"capture"` is added to the TS `Action` type with `LABELS.capture = "Quick capture (global)"`, `DEFAULTS.capture = "Mod+Shift+Alt+KeyN"`, treated as global like `toggle_window`.

- [ ] **Step 1: Write failing tests** (`settings.rs` / `commands.rs` pure helpers):
  - `global_bindings_defaults_and_overrides`.
  - `changed_globals`: a pure `fn changed_globals(old: &Settings, new: &Settings) -> Vec<(GlobalAction, String, String)>` returns only the actions whose binding changed and that are not `same_shortcut`.
  - `shortcuts.test.ts`: `capture` is global and doesn't conflict with defaults.
- [ ] **Step 2: Run** `cargo test && pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement**, replacing the single-binding code paths in `lib.rs` setup and `set_settings`.
- [ ] **Step 4: Run** `cargo test && pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tasks): global capture shortcut`.

### Task 8: Capture mode in the search field

**Files:**
- Modify: `src/app/controller.ts`, `src/app/store.ts`, `src/app/controller.test.ts`, `src/ui/SearchField.tsx`, `src/ui/main.tsx`, `src-tauri/src/commands.rs` (`capture_task` target, `capture_done`), `src-tauri/src/settings.rs` (`capture_target`, `inbox_title`), `src/ui/SettingsDialog.tsx`, `src/settingsform.ts`, `src/api.ts`

**Interfaces:**
- Consumes:
  - the `"capture"` event and `was_hidden` (Task 7);
  - `Editor.appendLine` (Task 5);
  - `api.captureTask` (Task 4).
- Produces:
  - Settings fields `capture_target: String` (`"inbox"` | `"daily"`) and `inbox_title: String`, with defaults from Global Constraints.
  - `fn capture_title(settings: &Settings, today: &str) -> String` (pure): the target note title.
  - Command `capture_target_title() -> String`, for the field hint and the editor check.
  - Command `capture_done()`: hides the app if `was_hidden`, and resets it.
  - Store `capture: { target: string; err: string } | null`.
  - Controller methods:
    - `startCapture()`
    - `submitCapture(text)`:
      - If the editor's open note title folds equal to the target, `editor.appendLine("- [ ] " + text)`.
      - Otherwise `api.captureTask(text)`.
      - Then `api.captureDone()` and clear capture mode.
      - On error, set `capture.err` and keep the text.
    - `cancelCapture()`
- UI:
  - In capture mode, `SearchField` shows a task-box icon and the "→ <target>" placeholder; Enter calls `submitCapture` and Esc calls `cancelCapture`.
  - Blurring leaves capture mode with the text kept as the query.
  - Settings → General: "Quick capture goes to" (Inbox / Today's daily note), plus an "Inbox note" text field.

- [ ] **Step 1: Write failing tests:**
  - Rust: `capture_title_inbox_daily_and_fallback`:
    - `inbox` + `""` → `"Inbox"`;
    - `inbox` + `"Todo"` → `"Todo"`;
    - `daily` → `"2026-10-27"`;
    - `inbox` + `"a/b"` → `"a-b"` (existing `title_to_stem` rule).
  - Controller tests:
    - `capture into the open Inbox appends through the editor`: no `api.captureTask` call, `editor.appendLine` called with `"- [ ] buy milk"`, then `captureDone`. Covers Review Focus 5, with the editor dirty.
    - `capture into a closed note calls the backend`.
    - `capture error keeps the text`: `captureTask` rejects with `"locked"` → `capture.err === "Inbox is locked"` and the field text is still `"buy milk"`.
    - `Esc and empty Enter leave capture mode and call captureDone`.
- [ ] **Step 2: Run** `cargo test && pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** `capture_task` (Task 4) resolves its target with `capture_title`, so the backend and the hint always agree.
- [ ] **Step 4: Run** `cargo test && pnpm test && pnpm exec tsc --noEmit && pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tasks): quick capture through the search field`.

### Task 9: Daily note, task-list note, docs, release prep

**Files:**
- Modify: `src/shortcuts.ts`, `src/app/controller.ts`, `src/app/controller.test.ts`, `src/search.ts`, `src/ui/NoteList.tsx` (hint), `README.md`
- Create: `.changeset/tasks-capture.md`

**Interfaces — Produces:**
- Action `daily_note` (default `Mod+Shift+KeyD`, label "Today's daily note"): calls `controller.openTitle(localToday(), "enter")`.
- ⌥↩ in the search field: `enter(force = true, checklist = true)`. On create, the new note's text is `"- [ ] "` and the caret is placed after it. If the note exists, it just opens.

- [ ] **Step 1: Write failing controller tests:**
  - `daily_note opens today's note`: `api.openOrCreate` is called with `localToday()`.
  - `alt-enter creates a checklist note`: the created note is loaded, then `editor.replaceText("- [ ] ")`, or the front-matter-aware equivalent when a block exists, with the caret at the end.
  - `alt-enter on an existing title just opens it`.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Update the ⇧↩ hint text to mention ⌥↩.
- [ ] **Step 4:** README: add a "Tasks" section (syntax `- [ ]`, `📅 YYYY-MM-DD`, the `due:` aid, `✅` done dates, the Tasks view, the badge, quick capture and its setting, the daily note, ⌥↩) and the new shortcuts in the table.
  - Changeset (minor, past tense): "Added a Tasks view that collected every open task across notes with due and done dates, quick capture from anywhere, a daily note, and new task-list notes."
- [ ] **Step 5: Quality gate** (CONTRIBUTING): `pnpm exec tsc --noEmit`, `pnpm test`, `cd src-tauri && cargo test`, `pnpm build:app`, the perf test from Task 3, docs, staleness, capabilities. Report it as a table.
- [ ] **Step 6: Commit** `feat(tasks): daily note, checklist notes, docs`.

### Task 10: PR and adversarial review

- [ ] **Step 1:** Push `feat/tasks` and open the PR: title `feat: Tasks view, quick capture and daily note`, body with `## Summary` and `## Test plan`. The test plan's unticked items are the spec's owner checks (§12).
- [ ] **Step 2:** Run the adversarial review per CONTRIBUTING. The attack list must enumerate every writer to a note (editor, `toggle_task`, `capture_task`, watcher reload, Link it later) and every path that could create a conflict copy or lose typed capture text. Post each round on the PR, fix findings with regression tests, and follow the strike rule.
- [ ] **Step 3:** Reply to bot review comments. Merging needs the maintainer's go-ahead (`--admin`).
