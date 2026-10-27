# velo — Tasks, quick capture and daily note design

Requested by Matteo. velo should be where his TODOs live. Today they are `- [ ]` lines inside project notes, and some go to another app. He uses that app for due dates, faster capture and one list of everything. Decisions below are his unless marked **(my call)**. The roadmap is in the brainstorm plan: this is Project 1 of 4, and Project 2 (Connections) is designed in parallel. A ponytail audit of this design was applied: findings 3, 4, 5, 7, 8 and 9.

## 1. Why and what

- **Goal:** stop needing another app for TODOs.
  - One list of every open task across all notes.
  - Due dates you can see.
  - Capture in one keystroke from anywhere.
- **Non-goals:**
  - Notifications or reminders at a time (Matteo: "seeing is enough").
  - Recurring tasks, priorities, subtasks as a concept, a separate task store, task sync to other apps.
  - A separate capture window (audit 4).
- **Anti-goals:**
  - Tasks that exist only in velo's index. The note text is the only source of truth.
  - Rewriting a note beyond the tick itself (box character plus done date) or the one line appended.
  - Conflict copies caused by velo writing to a note that is open in the editor (audit 3).
  - Slowing search (the 50 ms p95 budget at 10k notes still holds).
  - Plaintext of locked notes in the index (existing invariant).

## 2. Task syntax

- **What counts as a task:** any line matching the existing `TASK_ITEM` rule (`src/preview.ts`): a list item, optionally inside blockquotes, starting `[ ]` (open) or `[x]`/`[X]` (done). Lines inside fenced code blocks are not tasks **(my call)**.
- **Text:** the rest of the line, with the due date and the done date removed for display.
- **Due date:** one form only, `📅 YYYY-MM-DD`, as in Obsidian Tasks, so notes stay compatible with Obsidian (audit 7). Anything else is no due date. The first match on a line wins.
  - **Typing aid:** in the editor, typing `due:` followed by a space turns into `📅 ` (one CodeMirror input rule).
  - velo never writes due dates.
- **Done date** (Matteo's decision): ticking a task through velo appends ` ✅ YYYY-MM-DD` (local date) to the line, as Obsidian Tasks does. Unticking removes it. Ticks that go through velo are the Tasks view, the preview checkbox and `Editor.toggleTask`.
  - Typing `x` into the brackets by hand adds no date **(my call)**. A done task without a date counts as done long ago.
  - An existing `✅ date` is replaced, never duplicated.
- **Today:** follows the local time zone.
  - Overdue: due before today and still open.
  - Today: due today.
  - Upcoming: due later.
  - No date: no due date.

## 3. Index

- New table in the index: `tasks(path, line, text, done, due, done_on)`.
  - `line` is the 0-based line number in the note's text.
  - `due` and `done_on` are ISO dates or NULL.
- Filled by the same upsert that indexes the body. The front-matter block is skipped, but line numbers count the whole text.
- The index `user_version` becomes 4, which triggers the existing one-time drop and reindex.
- **Locked notes:** their tasks are never written to the index. While a locked note is unlocked, its tasks are computed in memory from the unlocked cache and merged into the results, the same way search treats unlocked bodies.
  - One shared pure function does grouping, sorting and filtering for both sources. SQL returns raw rows only **(my call)**.
- **Line numbers:** full-text coordinates, front matter included, the same coordinates as `Editor.toggleTask(line)` and the preview. When front matter is hidden, caret placement maps through the same offsets.

## 4. Tasks view

- **Where:** the left pane gets a mode switch, **Notes | Tasks**, next to the search field **(my call)**. Connections (Project 2) adds a third mode to the same switch later.
  - Shortcut `toggle_tasks`: `Mod+Shift+KeyX`, remappable **(my call)**.
- **Rows:** grouped Overdue → Today → Upcoming → No date. Inside a group, rows sort by due date ascending, then by note modified date, newest first.
  - Each row: a checkbox, the task text with rich inline marks, the note title in muted text, and the due date as a pill (red when overdue).
  - Done tasks are hidden. A "Show done" toggle shows the ones whose `✅` date falls in the last 7 days (7 days is my call).
- **Filter:**
  - The tag filter applies to the task's note.
  - The search text matches the task's own text, or its note's title (substring, folded), not the note body: a body match is too broad **(my call)**.
  - Notes mode and Tasks mode share the search field and the tag filter, so switching modes keeps them.
- **Tick:**
  - If the note is open in the editor, the tick goes through the editor (`Editor.toggleTask`), so there is one writer and ⌘Z undoes it.
  - Otherwise it uses command `toggle_task(path, line, expected)`:
    - The backend checks that line `line` of the text on disk still matches `expected` (the line text the view showed).
    - It flips the box character, adds or removes the done date, and saves through the normal save path: front matter is stamped and a revision is taken, as for an edit.
    - The check runs on the pre-save text. Stamping may then insert a front-matter block above the task, which is fine: the view refreshes from the index after the save, so no line number is reused.
    - If the line moved or changed, it fails with `"task-moved"`. The view refreshes and shows "This task changed — refreshed".
    - On a locked note it requires the key, like a save; without it, it fails with `"locked"`.
  - **Undo** (audit 9): after a backend tick, the view shows "Ticked · Undo" for 5 seconds. Undo sends `toggle_task` again with the new line text as `expected`, so the same line check protects it.
- **Click:** opens the note and puts the caret on that line, scrolled into view.
- **Live:** the view refreshes on `notes-changed`, on save of the open note, and on index-done.

## 5. Due count

- The Tasks mode switch shows overdue + today as a count.
- On macOS the Dock badge shows the same number, or nothing when 0 **(my call)** (audit 5):
  - The frontend sets it whenever it refreshes the Tasks data, through a small `set_badge` command that calls Tauri's `set_badge_count`.
  - One frontend timer at the next local midnight refreshes the data, so "today" rolls over. The webview keeps running while velo is hidden.
  - There is no Rust-side recount or clock loop.
- On Windows and Linux only the in-app count is shown.

## 6. Quick capture

- **Shortcut:** global action `capture`, default `Mod+Shift+Alt+KeyN` **(my call: a rarely used combination; a global shortcut takes the keys from every app)**. Remappable.
- **Global shortcut registration** (audit 8): `register_hotkey` and the swap-on-change logic in `set_settings` handle a list of global actions (`toggle_window`, `capture`), not a single binding. Each action is registered, swapped and rolled back on failure independently. Tests cover changing either key.
- **Capture mode in the main window** (audit 4; no separate window):
  - The shortcut shows velo, if hidden, and puts the search field in **capture mode**. The field is labelled "→ Inbox" or "→ 2026-10-27", shows a task-box icon, and starts empty. The rest of the window is unchanged.
  - **Enter** appends the task and returns: if velo was hidden when the shortcut fired, it hides again, so the previous app is back in front (`app.hide()` on macOS, as `toggle_window` does). If velo was already in front, the search field leaves capture mode.
  - **Esc** leaves capture mode, and hides velo if it was hidden before. An empty Enter does the same.
  - Typed text is never dropped. Clicking elsewhere in velo leaves capture mode with the text kept in the field as a normal search query.
- **Append** (audit 3):
  - If the target note is open in the editor, the frontend appends `- [ ] <text>` as a new last line through the editor (`Editor.appendLine`, a user edit), so there is one writer and ⌘Z undoes it.
  - Otherwise command `capture_task(text)` appends the line to the target note on disk, creating the note if missing, through the normal save path.
- **Errors** (shown inline under the field, text kept):
  - No notes folder.
  - Still indexing: the append waits for the indexing gate.
  - The target note is locked and no key is loaded: "Inbox is locked".
- **Target:** setting `capture_target`, `"inbox"` (default) or `"daily"`.
  - Inbox: setting `inbox_title`, default `Inbox`.
    - Validated with the existing title rules; empty falls back to `Inbox`.
    - Renaming the setting leaves the old note as it is.
  - Daily: today's daily note (section 7).
  - Both live in Settings → General.

## 7. Daily note

- **Title:** `YYYY-MM-DD` in local time **(my call; no setting)**.
- Action `daily_note`, default `Mod+Shift+KeyD`, remappable. It opens today's note through `open_or_create`. A new note gets front matter like any new note, and no template **(my call)**.

## 8. Task-list note

- In the search field, **⌥↩** creates the note titled with the query, as **⇧↩** does, but the new note starts with `- [ ] ` and the caret after it **(my call)**. If the note already exists, it just opens.
- The ⇧↩ create hint in the list mentions ⌥↩.

## 9. Settings, shortcuts, docs

- New settings: `capture_target`, `inbox_title`.
- New actions: `toggle_tasks`, `daily_note`, `capture` (global).
- README: a Tasks section (syntax, due dates and the `due:` aid, view, capture, daily note) and the shortcut table.
- Changeset: minor.

## 10. Constraints

- No new dependencies.
- Existing invariants hold: no user text lost, locked plaintext never on disk or in the index, files are the source of truth, the indexing gate, search < 50 ms p95 at 10k notes. The perf test seeds tasks too.
- Workflow: AGENTS.md / CONTRIBUTING.md.

## 11. Left to the builder

- Module split.
- The capture-mode styling within the design system.
- How the view virtualises long lists.

## 12. Owner checks

- Capture from another app with velo hidden: Enter returns to that app.
- Capture while the Inbox is open with unsaved edits: no conflict copy.
- Ticking in the view while the note is open, and the Undo toast on a closed note.
- The badge after midnight.
- Due dates in a note synced from Obsidian.

## 13. First step

- Spike before the plan's main tasks: on macOS, confirm that `app.hide()` after a capture returns focus to the app that was in front (audit "not checked").
