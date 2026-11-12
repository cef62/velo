# velo: archived notes

Date: 2026-11-12. Status: design approved by the owner on 2026-11-12.

## Why

Some notes belong to an event. The owner's example: a list of TODOs and background facts written to prepare a meeting. After the meeting the note is still worth keeping, because a fact in it or what was discussed may be needed weeks later. But from then on it is noise: it shows up in the note list, in search results, in the timeline and in the Tasks list next to the notes that still matter.

Archiving takes such a note out of the way without deleting it. The owner goes back to archived notes on purpose, to retrieve one fact or to review one meeting.

## Goals

- A note can be archived and unarchived.
- Archived notes are hidden everywhere by default and visible only when the owner turns on "show archived".
- With "show archived" on, archived notes are mixed in with the others and easy to tell apart.
- Agents (MCP) do not see archived notes unless they ask for them.

## Non-goals (this version)

- Agents archiving or unarchiving notes.
- Archiving several notes at once.
- Archiving automatically (by date, by "all tasks done", and so on).
- A separate "archive" view that shows only archived notes.

## Anti-goals

The feature has failed, even if it works, when any of these happens:

- Archiving changes the note file, its content or its dates.
- An archived note or one of its tasks shows up in a default view (list, search, timeline, Tasks, tags, link suggestions, Related, merge picker, export, MCP results).
- A note loses its archived state because it was renamed, locked or unlocked inside velo.
- A note or its content is lost or becomes unreachable.

## Decisions made by the owner

### Where the archived state lives

A list in `.velo/archived` inside the notes folder, next to the existing `.velo/identity.age`. The note file does not move and is not edited.

Reasons, from reading the code:

- A front-matter field cannot work for locked notes: a `.md.age` file is encrypted whole, front matter included, and plaintext never reaches the index. It would also bump the modified date on every archive.
- A subfolder works for locked notes but is the largest change: velo scans a flat folder and ignores subfolders, the watcher is non-recursive, every path-keyed state would have to follow the move, and title uniqueness would have to span two folders.
- Only velo, agents through velo's MCP server, and the owner by hand touch the folder. The owner does not need to see in Finder which notes are archived.

### Default: hidden

Archived notes are hidden from the note list, search results, the timeline and the Tasks list.

Tasks inside an archived note stay as written in the file. They leave the Tasks list and come back only while "show archived" is on.

### Show archived

- One global switch. When on, archived notes appear mixed in with the others, in their normal position, dimmed, with an "archived" badge.
- It stays on until the owner switches it off, including across quit and relaunch.
- Control 1: a toggle button in the bar above the list (the pane bar), next to Sort. It is in the same place in the list, timeline and Tasks views and is visibly "lit" while archived notes are showing.
- Control 2: a command palette command that toggles the same switch.

### Archiving a note

- "Archive note" in the command palette and in the note's `⋯` menu. On an archived note the same entry reads "Unarchive note".
- The note that was just archived stays open in the editor while it leaves the list.
- Archiving does not change the note's dates, so with "show archived" on it keeps its place in Recent and in the timeline.
- Locked notes can be archived like any other, without unlocking.
- Editing an archived note keeps it archived.

### Links

A link to an archived note keeps working, and opening the note through a link shows it even while archived notes are hidden.

### Agents (MCP)

Archived notes are hidden by default. A flag on the tools includes them.

## Decisions made by the designer, confirmed by the owner

- The switch is one global setting. Saved searches do not store it.
- Everything that lists notes follows the switch: tags and their counts, `[[` link suggestions, the Related panel, the merge picker, export.
- An agent can still read an archived note when it names it by title.
- When a search hides archived matches, one line under the results says how many are hidden. Clicking it turns "show archived" on.
- Rename, lock, unlock and delete inside velo keep `.velo/archived` in step. A rename done by hand in Finder un-archives the note; nothing is lost.
- `.velo/archived` is plain text, one entry per line.

## Behaviour in detail

These are the designer's calls. The owner has not ruled on them one by one; each can be changed in review.

### The list file

- Path: `<notes folder>/.velo/archived`. UTF-8, one entry per line, `\n` line ends, no header.
- An entry is the note's title, which is its file name without the extension. Reason: lock and unlock change only the extension (`.md` to `.md.age` and back), so the entry survives them with no extra work.
- Entries are matched the way velo already matches titles: case-folded (`title_folded` in `index.rs`).
- velo itself never creates two notes with the same title (`vault.rs` refuses), but two files with one title can exist on disk: a stale lock twin (`Foo.md` next to `Foo.md.age`) or a file added by hand (`Foo.txt`). An entry applies to every file with that title. Archiving must not make such twins behave differently from today in any other way.
- A missing file means no note is archived. velo creates the file on the first archive.
- Entries that match no note are ignored when read and dropped the next time velo writes the file.
- Writes are atomic (write a temporary file, then rename), like `settings.json`.
- Two processes use the file: the app, and the headless MCP server (`velo --mcp`), which renames, deletes and merges notes for agents. Neither may trust a copy read earlier:
  - before answering a query, a process re-reads the file if its modified time changed;
  - a write re-reads the file first, applies its one change, then writes. The remaining window (two writes in the same instant) is accepted.
- An edit made to the file by hand is picked up the same way, at the next query.

### What keeps the list in step

| Event inside velo | Effect on the entry |
|---|---|
| Rename (owner or agent) | entry follows the new title |
| Lock, unlock | unchanged (title-keyed) |
| Delete (to the OS trash) | entry removed |
| Merge | source's entry removed; an archived target stays archived |
| Extract to a new note, new note, conflict copy | the new note is not archived |
| Edit, save, agent write | unchanged |
| Notes folder changed in Settings | the new folder's own list applies |

A note restored from the OS trash by hand comes back not archived.

### Where archived notes are hidden (switch off)

| Surface | Rule |
|---|---|
| Note list, search results | hidden |
| Timeline | hidden |
| Tasks list | tasks of archived notes hidden |
| Tags list and tag counts | archived notes not counted |
| `[[` link suggestions | archived titles not suggested |
| Related panel | archived notes not listed as connections |
| Merge picker | archived notes not offered |
| Export | archived notes not exported |
| MCP tools that list or search | hidden unless the flag is set |

Not filtered, in any state:

- Link resolution: an existing `[[link]]` to an archived note resolves and opens it. It is not shown as a missing link.
- Opening by path: history (back and forward), saved positions, an agent's request to show a note.
- Title uniqueness: a new note cannot take the title of an archived note, same as today.
- The "No links" filter: links are counted as they are on disk, whatever the archive state of either end.
- The Related panel of an open archived note shows its connections normally (the other notes still follow the switch).

### With the switch on

- Rows of archived notes are dimmed and carry an "archived" badge, in the list, in search results, in the timeline and in the Tasks list (on the note heading when tasks are grouped by note, on the task row otherwise).
- The badge must not rely on colour alone: it is text, and the row's accessible name includes "archived".
- Tasks of an archived note can be ticked as usual.

### The open note

- When the open note is archived, the title bar shows the same "archived" badge, whatever the switch says.
- Archiving the open note with the switch off: the note stays open and editable, its row leaves the list, the list selection is cleared. "Unarchive note" is one step away in the `⋯` menu and the palette.

### The hidden-matches line

- Shown only when the switch is off, a search query or a filter is active, and at least one archived note matches.
- Text along the lines of "3 archived notes hidden". It is a button; activating it turns the switch on.
- Not shown for the plain, unfiltered list: there it would be permanent noise.
- Only in the note list and search results. The timeline and the Tasks list do not show it.

### Commands and shortcuts

Two new actions, both without a default shortcut and both bindable in Settings › Shortcuts:

- Show or hide archived notes (global).
- Archive or unarchive the current note (per note; disabled when no note is open).

### Setting

A boolean in velo's settings file (`settings.json`), off by default, next to the other persisted view toggles (`tasks_by_note`, `info_panel`, `show_front_matter`).

The Rust side does not read it. The front end passes "include archived" with each request, the way it passes `no_links` today, including in `ExportRequest`. The MCP server takes its own per-call flag and ignores the setting.

### MCP

- `include_archived` (boolean, default false) on the four tools that list or search: `search_notes`, `list_tasks`, `list_tags`, `get_connections`. The other 13 tools take a title and are listed below.
- `get_connections` takes a title. It answers for an archived note as for any other; the flag decides only whether archived neighbours are returned.
- With the flag set, each returned note says whether it is archived, so an agent can tell.
- Tools that take a title (`read_note` and the write tools) work on archived notes unchanged. A write does not unarchive.
- The generated tool reference (`site/src/content/reference/mcp-tools.json`) and the README tool list are updated.

## Constraints

- Follow `AGENTS.md` and `CONTRIBUTING.md`: feature branches, quality gate, changeset (`minor`), adversarial review per PR.
- Smallest complete change. The existing "No links" filter already runs end to end (index query, API, chips, panel); reuse its path where it fits rather than building a parallel one.
- No new dependency.
- Never launch the real app during automated work: it uses the owner's notes. The browser demo (`src/demo/`) must support archiving in memory so the UI can be exercised and captured there.
- Locked notes: nothing about archiving may require the passphrase or write plaintext anywhere new.

## Pointers for the builder

From a read of the code on 2026-11-12. Verify before relying on them.

- Flat scan: `Store::list` (`src-tauri/src/store.rs`); watcher is non-recursive (`watch.rs`).
- Index: SQLite with `notes`, `notes_fts`, `links`, `tags`, `aliases`, `tasks` (`index.rs`); bumping `SCHEMA_VERSION` rebuilds it. Central query `search_page_where` with the shared `tag_cond` hook; the timeline (`vault.rs`) and export (`export.rs`) reuse it. Tasks: `task_rows` and `Vault::tasks`, which also loops over unlocked notes held in memory.
- Other enumerators: `Index::tags`, `tag_notes`, `link_targets`, `titles`, `names`, `linked_from`, `connections::build`, `unlocked_hits`.
- Rename: `Vault::rename_note`; delete: `delete_note_with`; lock and unlock in `vault.rs` and `src/app/controller.ts`.
- Front end: `Filters` (`src/saved.ts`), `api.search` / `timeline` / `tasks` / `exportPreview` (`src/api.ts`), `mergeCandidates`, `listTitles`, `listLinkTargets`, `listTags` in `src/app/controller.ts`, demo twin in `src/demo/api.ts`.
- UI: the "Show done" toggle in `src/ui/PaneBar.tsx` is the closest existing control (`aria-pressed` button).
- A new action needs: `src/shortcuts.ts` (`Action`, `DEFAULTS`, `LABELS`), `ACTIONS` in `src-tauri/src/settings.rs` (fixed-length array), a handler in the controller's `actions`, a group in `scripts/gen-docs.ts` followed by `pnpm docs:gen`, the README shortcut table.
- MCP: tool schemas in `src-tauri/src/agent/tools.rs`, operations in `agent/ops.rs` and `app_ops.rs`.

## Left to the builder

- How the index knows a note is archived. `search_page_where` pages in SQL, so filtering results afterwards in memory would break `has_more` and totals. The expected answer is a column in `notes` filled from the list file (a `SCHEMA_VERSION` bump and one full reindex on upgrade are accepted), but any approach that keeps paging and totals correct is fine.
- Notes unlocked in memory bypass the SQL query (`Vault::tasks`, `unlocked_hits`); the archived rule must be applied there too.
- Exact wording of labels, the badge and the hidden-matches line; the icon of the toggle.
- How the hidden count is computed and carried to the front end.
- Whether to seed an archived note in the demo vault for the docs screenshots.
- How to split the work into PRs. A natural cut: list file plus index and filters plus MCP first, then the UI.

## Checks the work must leave behind

- List file: read, write, missing file, unknown entries dropped, rename, delete, merge.
- Each surface in the "hidden" table: an archived note is absent with the switch off and present with it on. Paging and totals are right in both states.
- Locked note: archive, lock, unlock, relaunch; still archived, never decrypted for it.
- Archiving leaves the note file's bytes and modified time unchanged.
- MCP: default hides, `include_archived` shows and marks; reading by title works.
- Two processes: an archive made in the app is seen by the next MCP query, and an agent rename of an archived note keeps it archived in the app.
- Unlocked notes: tasks and search hits of an archived, unlocked note follow the switch.
- Controller: archive the open note with the switch off; unarchive; the hidden-matches line turns the switch on.

## Not verified

- How the real window renders the dimmed rows and the toggle; only the demo can be checked automatically.
