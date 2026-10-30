# velo — Saved searches, timeline, export design

Requested by Matteo as Project 4 of 4 (roadmap: tasks, connections, writing helpers, saved searches). He asked for the design to be written straight from the roadmap, with no further questions. Decisions from the roadmap are his. Everything marked **(my call)** is mine, and he checks those while reading.

## 1. Why and what

- **Goal:** get answers and reports out of the notes:
  - **saved searches**: a query kept under a name, one click away;
  - a **timeline** of the notes that match, in date order;
  - **export** of that set to Markdown or PDF.
- **Why (roadmap):** Matteo's fourth goal is "Markdown/PDF output from queries and timelines". The readers are mostly himself (a recap of a project or a week, task status: done and open) and sometimes someone else (a report).
- **Non-goals:**
  - A query language (`tag:x AND …`). A saved search is exactly what the filters already express: search text + tags + No links.
  - A whole-vault timeline view separate from the filters. The timeline always shows the current filters, saved or not.
  - Export formats other than one Markdown file and PDF (no HTML, DOCX, one file per note).
  - Sharing or publishing exports. Export writes a file; what happens next is up to Matteo.
  - Saved searches for agents (MCP) **(my call)**: agents already search with `search_notes` and tags.
- **Anti-goals:**
  - Writing a locked note's plaintext into an exported file, even while it is unlocked.
  - An export that silently drops notes: anything left out (locked, over the limit) is counted in the export dialog and in the file.
  - A slow timeline: switching to it on a 10k-note vault feels as quick as the Tasks view.

## 2. Saved searches

- **What is saved:** a name plus the current search text, selected tags and the No links chip. Sort, pane and timeline range are not saved **(my call: a saved search is "which notes", not "how to show them")**.
- **Where they live:** in `settings.json`, as `saved_searches: [{ name, query, tags, no_links }]` **(my call)**. They are per machine, like layout and shortcuts. Keeping them in the vault would sync them, but adds a non-note file the watcher, the index and other note apps would see. Revisit if Matteo wants them on every Mac.
- **Where they show:** the roadmap says "kept in the sidebar". velo has no sidebar; the closest place is the **tag panel** (⌘⇧T), which already holds the filter chips **(my call)**. A "Saved" row sits above the tag chips, one chip per saved search, in the order saved.
  - Clicking a chip applies it: it **replaces** the search text, tags and No links with the saved values **(my call)**. The chip shows as selected while the current filters equal it exactly.
  - Clicking a selected chip clears the filters (as "Clear" does).
  - Keyboard: the chips join the panel's existing roving tab stop (one Tab stop, arrow keys move).
- **Saving:** a "Save search…" button in the filter line (the banner that shows "Filtered by …") and in the tag panel, enabled when any filter or search text is set. A small dialog asks for the name, pre-filled with the search text or the first tag.
  - A name already used asks "Replace “Name”?" and overwrites on yes **(my call)**.
  - Names are trimmed, 1–60 characters **(my call)**.
- **Managing:** each chip's context menu (right-click, or Shift+F10 / Menu key, as the note list does) has **Rename…** and **Delete**. Delete asks for confirmation. No reordering **(my call)**.
- **Everything follows the filters:** the note list, the Tasks view, Connections' "No links" and the timeline already read the current search text and tags, so applying a saved search drives all of them with no extra wiring. This is the roadmap's "the Tasks filter, the timeline and export all run on it".
- **Tags that no longer exist:** a saved search keeps them. Applying it may then match nothing; the list says so as it does today.

## 3. Timeline

- **Opening it:** a new pane mode next to Notes, Tasks and Connections: `paneMode: "timeline"`, toggled by a new action `toggle_timeline` (default `Mod+Shift+KeyL` **(my call)**; it must not clash with an existing default) and a title-bar button like Tasks.
- **What it lists:** every note the current filters match (search text, tags, No links), locked notes included as rows (their titles are file names, already visible in the list) but with no snippet.
- **Order and grouping:**
  - A segmented toggle, **Created / Updated**, picks the date (roadmap). Default Updated **(my call)**. It is remembered in settings as `timeline_sort` **(my call)**.
  - Newest first **(my call)**.
  - Grouped by day under headers: "Today", "Yesterday", then the weekday and date for the last 7 days ("Monday 26 Oct"), then the full date ("12 Oct 2026") **(my call)**, in the local time zone.
- **Range:** a second small control, **7 days / 30 days / All**, default All **(my call)**. It narrows the timeline and export to notes whose chosen date falls in the range. A weekly recap is then: apply the saved search, Timeline, 7 days, Export.
- **Rows:** title, time of day, and the first line of the snippet (as the note list's two-line layout). Clicking a row opens the note in the editor and the timeline stays, as Connections does. ↑/↓ move between rows (one Tab stop, like the Tasks list after the audit fixes), Enter opens.
- **Size:** the timeline loads every match, not pages of 50. At 10k notes that is one index query; rendering must be windowed (only visible rows in the DOM) like the note list **(left to the builder, within the existing NoteList approach)**.
- **Empty:** "No notes match" with the filters named, as the list does.

## 4. Export

- **Trigger:** an "Export…" button in the timeline header, and a new action `export` (no default key **(my call)**). Export always works on what the timeline shows: current filters, range and order **(my call: one rule, "what you see is what you export")**. From the notes or tasks pane, the action switches to the timeline first.
- **Dialog:** format (**Markdown** / **PDF**), content (**Full notes** / **Tasks only**), and a line saying what goes in: "23 notes · 41 open tasks · 12 done · 2 locked notes left out".
  - **Tasks only** **(my call)**: the roadmap names "task status (done/open)" as a main use. It exports, per note, only the note heading and its task lines. Notes with no tasks are left out and counted.
- **Content of the file (both formats):**
  1. A title: the saved search's name when the filters equal a saved search, otherwise the search text and tags ("#proj velo"), plus the range and the export date.
  2. A **status summary**: counts of open and done tasks across the exported notes, then the open tasks as a checklist, each with its note's title; done tasks within the range follow with their `@done(date)` **(my call)**.
  3. One section per note, in timeline order: `## Title`, a line with the created and updated dates, then the body with front matter removed. Checklists keep their state (`- [ ]` / `- [x]`). `[[links]]` stay as text **(my call)**; images and attachments are not embedded.
- **Markdown:** a save dialog (Tauri dialog plugin, `save`) picks the file, default name `<title> <YYYY-MM-DD>.md`. The text is built in Rust from the index and the files (one place for the rules), and written by a new command `export_markdown(path, request)` **(my call)**. The frontend never gets file-system write access.
- **PDF:** the same content rendered to HTML with the preview's renderer (markdown-it, raw HTML off) into a print-only container, then the native print dialog via Tauri's `Webview::print()`, whose "Save as PDF" makes the file. No new dependency (roadmap). Print CSS: the app's light theme whatever the current theme, A4/Letter by the system, page breaks avoided inside a task list **(my call)**.
  - Risk to check first in the build: `print()` must print the export container, not the app UI. A print stylesheet hides everything else (`@media print`).
- **Locked notes:** never exported, locked or unlocked. They are counted as "left out" in the dialog and in a line at the end of the file **(my call; anti-goal)**.
- **Limit:** at most 1,000 notes per export **(my call)**. Beyond that the dialog says so and exports the newest 1,000, counting the rest as left out.

## 5. Backend summary

- Settings: `saved_searches`, `timeline_sort`. Unknown or malformed entries are dropped on load, as with shortcuts.
- `timeline(query, tags, no_links, by: created|updated, since_ms: Option<i64>)` → rows `{ path, title, date, snippet, locked }`, all matches, one query.
- `export_preview(request)` → the counts for the dialog; `export_markdown(path, request)` → writes the file; `export_html(request)` → the HTML for printing. One Rust builder produces the Markdown; HTML is rendered from it in the frontend with the preview renderer **(my call: one content rule, two outputs)**.
- New actions in `shortcuts.ts` and Rust `ACTIONS`: `toggle_timeline`, `export`, `save_search` (no default).
- Capability: `dialog:allow-save` if `dialog:default` does not include it.
- No index schema change: created and modified dates already exist.

## 6. Docs and settings

- README: a short section each for saved searches, the timeline and export; new rows in the shortcut table.
- Settings dialog: no new controls (saved searches are managed from their chips).
- Changeset: one, `"velo": minor`.

## 7. Constraints

- Follow AGENTS.md / CONTRIBUTING.md: quality gate (tsc, vitest, cargo test, `pnpm build:app`), changeset, adversarial review.
- Never touch real velo data in tests; temp dirs only. Never run the app against the real vault.
- Keyboard-only use must work for every new control: chips, timeline rows, both dialogs. Screen-reader labels must not repeat words.
- Panda recipe variants passed as variables need `staticCss` (the tag-pill bug).
- Exported files are written only where the save dialog says; no temp copies of note text outside the vault.

## 8. Left to the builder

- The timeline's windowed rendering (reuse the note list's approach).
- Day-header formatting details within section 3, using the system locale for month and weekday names.
- Print CSS details within section 4.
- Task split and order. Suggested order: saved searches, timeline, Markdown export, PDF export.

## 9. Owner checks

1. Search "velo" with tag #proj, Save search… as "velo work". The chip appears in the tag panel; clearing and clicking it brings both back; the Tasks view follows it.
2. Rename and delete a saved search from its chip's menu, keyboard only.
3. Open the timeline (⌘⇧L), switch Created/Updated and 7 days/All; days are grouped and newest first; clicking a row opens the note and the timeline stays.
4. Export Markdown, Full notes: the file has the title, the task summary and one section per note; a locked note is counted as left out and its text is nowhere in the file.
5. Export Tasks only: only headings and task lines, with done dates.
6. Export PDF: the print dialog shows only the export, light theme; Save as PDF gives a readable file.
