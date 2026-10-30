# velo

A fast, keyboard-first notes app for macOS (Apple silicon), Windows and Linux, built with Tauri 2 and a React 19 UI (Park UI on Ark UI, styled with Panda CSS 1.12). One box searches and creates: type to filter your notes, press Enter to open the match or create a new note with that title.

Inspired by nvALT and Notational Velocity; not affiliated with or endorsed by their authors.

## Features

- Search-or-create box; results update on every keystroke (backend under 50 ms p95 at 10k notes, release build), with matches highlighted in the list.
- Plain files you own: a flat folder of `.md` / `.txt` notes, edited in a CodeMirror editor with autosave.
- `[[wikilinks]]`: following a link to a missing note creates it; renaming a note rewrites links to it.
- Markdown preview with clickable wikilinks and external links.
- Note counts next to every tag and in the filter line; the Filters button in the header shows how many filters are active; a Retry button when a save fails.
- Theme: System (follows the OS), Light or Dark, in Settings.
- Rich editing (default): markdown marks are hidden except on the line you are editing; ⌘/Ctrl-click opens links, wikilinks and tags; task checkboxes are clickable. Choose Rich, Plain or Preview in the title bar's view switch, or press ⌘⇧R / ⌘⇧P. The file text is never changed by the display.
- Per-note encryption with [age](https://age-encryption.org); locked notes are never written to disk or to the index as plaintext.
- Live reload of external edits; a concurrent edit produces a `(conflict ...)` copy instead of overwriting anything.
- Global hotkey (default ⌘⇧Space / Ctrl+Shift+Space) to bring velo up; remappable in Settings. Any shortcut can be cleared with ⌫ in Settings, and conflicting shortcuts are shown instead of refused.

## Keyboard shortcuts

All shortcuts below are remappable in Settings (click a shortcut, press the new keys; Esc cancels). Enter in search, Esc in the editor, ↑/↓ in search and the list, the Edit menu and ⌘Q are fixed. `Mod` is ⌘ on macOS and Ctrl on Windows/Linux.

| macOS | Windows/Linux | Action |
| --- | --- | --- |
| ⌘L | Ctrl+L | Focus the search box |
| ⌘R | Ctrl+R | Rename current note (also: double-click the title) |
| ⌘⇧P | Ctrl+Shift+P | Toggle Markdown preview |
| ⌘⇧E | Ctrl+Shift+E | Lock / unlock current note |
| ⌥⌘E | Ctrl+Alt+E | Lock all notes |
| ⌘⌫ | Ctrl+Backspace | Move the current note to the Trash, after confirming (from the list or an empty search box; in the editor and in a non-empty search box ⌘⌫ keeps its editing meaning) |
| ⌘⇧S | Ctrl+Shift+S | Toggle sort (last modified / title; also the Sort menu in the Notes bar) |
| ⌘J / ⌘K | Ctrl+J / Ctrl+K | Back / forward through visited notes (also from the editor; ↑/↓ in search move in the list) |
| ⌘, | Ctrl+, | Settings |
| ⌘⇧T | Ctrl+Shift+T | Show / hide the tag panel |
| ⌘⇧R | Ctrl+Shift+R | Rich / plain editing |
| ⌘⇧J | Ctrl+Shift+J | Vertical / horizontal layout |
| ⌘I | Ctrl+I | Show / hide the side panel (note info) |
| ⌘⇧X | Ctrl+Shift+X | Switch between Notes and Tasks |
| ⌘⇧C | Ctrl+Shift+C | Show / hide the Connections view |
| ⌘⇧D | Ctrl+Shift+D | Open today's daily note |
| ⌘⇧L | Ctrl+Shift+L | Show / hide the timeline |
| ⌘⇧Space | Ctrl+Shift+Space | Show / hide velo (system-wide) |
| ⌘⇧N | Ctrl+Shift+N | Move the selection to a new note |
| — | — | Merge the open note into another (set in Settings) |
| — | — | Export… the timeline (set in Settings) |
| — | — | Save search… (set in Settings) |
| ⌥⇧⌘N | Ctrl+Alt+Shift+N | Quick capture (system-wide) |
| ⇧F10 / Menu key | Shift+F10 / Menu key | Open the context menu of the highlighted row or chip (Shift+F10 can be changed in Settings; the Menu key always works) |

Right-click a note in the list (or press the Menu key / Shift+F10 on the highlighted row; Shift+F10 can be changed in Settings → Keyboard shortcuts as "Open context menu") for a menu: open, rename, lock/unlock, copy `[[link]]`, show in Finder/Explorer, move to Trash. It opens the note first, so no menu appears if the switch is refused.

Fixed: Enter (in search) opens the highlighted note, or creates a note titled with the query when nothing matches; Shift+Enter creates a note titled exactly as typed (or opens that exact title if it exists); Alt+Enter (⌥↩) does the same and starts the new note with an empty `- [ ]` task; ↑ / ↓ move the selection; Esc (in editor) returns to search.

## Tags

Write `#tag` anywhere in a note (at the start of a line, after a space, or after `(`; letters, digits, `_`, `-`, `/`; at least one letter; not in fenced code blocks; `# Heading` is not a tag). The Filters button in the header (or ⌘⇧T) shows every tag with its note count; click chips to filter the list to notes having all selected tags, combined with the search text. A "Filtered by" line stays visible while tags are selected. In the preview, click a `#tag` to filter by it. Locked notes are not listed in the tag panel.

## Saved searches

Keep a search you use often. With a search text, tags or the No links chip active, choose "Save search…" in the filter banner or in the tag panel (⌘⇧T) and give it a name of 1 to 60 characters; a name already in use asks to replace the old one. Saved searches sit as a row of chips above the tags in the tag panel. Click one to apply its search text, tags and No links, replacing the current filters; click the active one to clear them. Right-click a chip, or press Shift+F10 / the Menu key on it, for Rename… and Delete (which asks first). They are stored per machine in the settings. The list, Tasks, the timeline and export all follow the filters.

## Timeline

Press ⌘⇧L (Ctrl+Shift+L) or the Timeline tab of the left pane to list notes newest first, grouped by day (Today, Yesterday, the weekday, then the date). Choose Created or Updated (remembered) and 7 days, 30 days or All (not remembered) from the menu in the Timeline bar. Locked notes are listed by title only. Click a row, or press Enter on it, to open the note; the timeline stays. The list is one Tab stop; move with ↑/↓.

## Export

The Export button in the Timeline bar (or the Export action, which has no default shortcut) exports exactly what the timeline shows; the dialog states that scope (date, range and filters). Choose Markdown (a save dialog) or PDF (the system print dialog: choose Save as PDF), and Full notes or Tasks only. The file starts with a task summary, the open tasks and the tasks done within the range with their `@done` date, then one section per note. Locked notes are never exported, even while unlocked, and are counted as left out. An export holds at most 1,000 notes (the newest).

## Connections

Press ⌘⇧C (Ctrl+Shift+C, remappable in Settings) or choose Connections under Left pane in the header's ⋯ menu to see the links, backlinks, shared tags and unlinked mentions around the open note. Choose the layout in Settings: Ring, Created or Updated (saved as `connections_sort`).

- Click a note to open it; the graph stays. Double-click it, or press ⇧↩, to re-centre the graph on it. ↩ opens the focused node, and Esc returns to Notes.
- Click a tag node to filter Notes by that tag.
- **Link it.** Hover an unlinked mention and press Link it to wrap those words in `[[ ]]`. With the note open, ⌘Z (Ctrl+Z) undoes it. It is never offered for locked notes.
- **No links.** A chip next to the tag filter lists orphans: notes with no links in or out.
- **Alias links.** `[[Alias]]` counts as a backlink in the graph, in "Linked from" in the info panel and in the No links filter.

## Writing helpers

- **Tag bar.** A bar under the note title lists the note's tags; click one to filter the list by it.
- **`[[` autocomplete.** Typing `[[` opens a popup of notes, matched by title or alias (up to 20 rows). A Create row makes a new note with the typed title. Esc closes it.
- **`#` autocomplete.** Typing `#` in tag position opens a popup of existing tags with their note counts. Esc closes it.
- **Move to new note (⌘⇧N).** Moves the selected text into a new note, leaves a `[[link]]` in its place, and stamps the new note with created / updated front matter when that Settings option is on. The new note is written before the source changes. Encrypted notes are refused. ⌘Z undoes it in the source.
- **Merge into… (command, no default shortcut; set one in Settings).** Appends the open note to another note, rewrites `[[Title]]` links to point at the target (piped `[[Title|label]]` links are not supported by velo, so they are left alone), adds the source's title as an alias of the target, and moves the source to the Trash. The target is snapshotted first, so its Revisions list can restore the pre-merge text. Encrypted notes are refused on either side.

## Tasks

Any markdown task line is a task: `- [ ] buy milk` (also `*`, `+`, numbered lists and quotes; not inside fenced code blocks).

- Add a due date with `📅 2026-10-30`. Typing `due:` and a space in the editor turns into `📅 ` as a typing aid; you type the date. velo never writes a due date itself.
- Ticking a task through velo (the checkbox in the editor, in the preview or in the Tasks view) appends `@done(YYYY-MM-DD)` (local date); unticking removes it. An Obsidian-style `✅ YYYY-MM-DD` is still read as the done date. Typing `x` by hand adds no date.
- The Tasks view (⌘⇧X, or the Tasks tab of the left pane) lists open tasks from every note, grouped Overdue, Today, Upcoming and No date. Search and the tag filter apply to it. "Show done" in the Tasks bar adds tasks ticked in the last 7 days. Ticking or unticking a task of a note that is not open shows a "Ticked · Undo" (or "Unticked · Undo") toast for 5 seconds. A tick in the open note goes through the editor: undo it there with ⌘Z. Click a task to jump to its line; Enter in the search field opens the first task listed.
- The Dock icon shows the count of overdue and due-today tasks on macOS; other platforms show the count inside the app.
- Quick capture (⌥⇧⌘N, system-wide) shows velo with the search field in capture mode (`→ Inbox`); type the task, press Enter, and velo appends `- [ ] text` to your Inbox note, or to today's daily note. Choose in Settings, General. The Inbox note is called `Inbox` unless you rename it there.
- The daily note (⌘⇧D) opens or creates a note titled with today's date, `YYYY-MM-DD`.

## Dates and front matter

Notes sync through Drive, Dropbox, iCloud or git, which reset or rewrite file dates. So velo stores each note's dates inside the note, in a YAML front-matter block at the top:

```
---
created: 2026-10-27T09:14:05+01:00
modified: 2026-10-27T10:02:41+01:00
---
```

- New notes start with both dates. Saving a note without a block prepends one (`created` from the file's date, `modified` now); saving a note with a block updates `modified` and adds `created` if missing. Locked notes are stamped before encryption.
- Everything else in the block (other keys, comments, order) is left byte for byte. velo never overwrites an existing `created:` line, and edits only the first `modified:` line. Other date formats (`2026-10-27`, `2026-10-27 09:14`, quoted) are read; an unreadable value falls back to the file date, shown with a "from file" hint.
- Turn writing off in Settings, General ("Add created/modified dates to notes"). Existing blocks are still read.
- The block is hidden in the editor and preview. Show it with "Show front matter" in the note's ⋯ menu (title bar) or the checkbox in the info panel, or bind a key to "Show / hide front matter" in Settings (unbound by default).
- `tags:` and `aliases:` (flow list `[a, b]`, block list or single value) are read. velo writes them only when merging notes (the source's tags and aliases, plus its title as an alias, go to the target); otherwise only an agent's `add_tags` / `remove_tags` tools change the `tags:` list. Tags merge with `#tags`. Aliases work as titles for `[[wikilinks]]`, opening by name, and search.
- The list's date and the Recent sort use the modified date from the note.

## Revisions

velo keeps local snapshots of each note: on save when the last one is over 10 minutes old (the version the save replaces), before an external change replaces the editor text, and before a restore. They are kept for 30 days, stored in the app data directory (never in the notes folder, never synced), and encrypted for locked notes.

Press ⌘I (Ctrl+I) for the info panel: created and modified dates, word count, "linked from N notes", tags, aliases and the revision list. Select a revision to preview it, then Restore; the current text is kept as a revision first.

## Agents (MCP)

velo can act as an MCP server, so Claude Code can search, read, create and edit your notes. It is off by default.

**Setup.** Turn on Settings → General → Agent access (MCP) and save, then reopen Settings, press Copy setup command and paste it into a terminal. It runs `claude mcp add velo -- <path to velo> --mcp`.

**Open or closed.** Claude Code starts `velo --mcp` itself, with no window. If velo is running, the request is forwarded to the app; otherwise velo reads and writes the notes folder directly. The switch is checked on every call.

**Tools (17).**

- `search_notes`: search like the search field, with tag filters, `no_links` to list orphans, and paging (50 per page).
- `get_connections`: one hop around a note by title: links, backlinks, shared tags and unlinked mentions. Read-only, titles only, never locked notes. To link a mention, use `edit_note`.
- `list_tags`: tags with counts.
- `read_note`: full text, with hash, dates, tags, aliases, links and backlinks.
- `create_note`: a new note.
- `append_to_note`: add text at the end (creates the note if missing).
- `edit_note`: replace text that occurs exactly once.
- `replace_note`: replace the whole note, guarded by the hash from `read_note`.
- `add_tags`, `remove_tags`: up to 50 tags on up to 200 notes per call.
- `list_tasks`: the Tasks view.
- `add_task`: add a `- [ ]` line to a note, or to the capture target.
- `set_task_done`: tick or untick a task.
- `rename_note`: rename, with link updates.
- `merge_notes`: merge one note into another, rewriting links; the source goes to the Trash.
- `move_to_trash`: move a note to the Trash.
- `daily_note`: the daily note for a date, created if missing.

**Safety.**

- Locked notes are never listed, searched or returned, and the agent never decrypts anything.
- Deletes go to the Trash. There is no permanent delete.
- Edits are anchored (`old_text` must match once) or hash-guarded (`replace_note` fails if the note changed since you read it).
- A note open in velo is edited through the editor, so nothing is overwritten behind it. If velo does not take the change within 5 seconds the call fails with "velo is busy, retry" and nothing changes. Once velo has taken it, the call waits up to 60 seconds; if no answer comes back, it fails with "velo did not answer; the change may have been applied — read the note before retrying".
- Off by default. The running app listens on 127.0.0.1 only, and every request needs a random token.

**Seeing and undoing changes.** Every write needs a summary (for `daily_note` it is optional). Before it, velo saves a revision of the note with that summary, marked as an agent change in the info panel (⌘I). Select it and press Restore.

**Platforms.** macOS and Linux. Windows is not supported yet.

## How it's built

Rust backend in `src-tauri` (Tauri 2); UI in `src` with React 19, Park UI v1 (Ark UI) and Panda CSS 1.12. Panda generates `styled-system/` (git-ignored) from `panda.config.ts`: `pnpm test` and `pnpm build` run `panda codegen` first; `pnpm install` runs it too (`pnpm codegen` to rerun).

## Storage

- Your notes folder is flat: only `*.md`, `*.txt` and `*.md.age` files directly inside it are notes. Subfolders and dotfiles are ignored. New notes are `Title.md`.
- Files are the source of truth. Locked notes are `Title.md.age`.
- `.velo/identity.age` (inside the notes folder) holds your encryption identity, wrapped with your passphrase.
- The search index is a SQLite file (`index-<hash>.sqlite`) in the app's data directory (Tauri app data dir for `dev.velo.app`, e.g. `~/Library/Application Support/dev.velo.app` on macOS), never in the notes folder. It is rebuildable: delete it and velo reindexes on next launch without losing anything. Settings live in the app config dir.

## Encryption

velo generates one age X25519 identity. It is kept in the OS keychain (so locked notes open without a prompt on this machine) and a passphrase-wrapped copy is stored in `.velo/identity.age` (so you can unlock on another machine, or recover). Each locked note is age-encrypted to that identity as `Title.md.age`.

Lock all (⌥⌘E) forgets the decrypted notes and the key until you enter your passphrase again (opening a locked note then shows the passphrase field in place of the note; Esc goes back to the list); quitting and relaunching unlocks from the keychain as usual.

Decrypt outside velo with the [`age` CLI](https://github.com/FiloSottile/age):

```sh
age -d .velo/identity.age > key.txt          # asks for your passphrase
age -d -i key.txt "Note.md.age" > "Note.md"
rm key.txt                                    # key.txt is your plaintext private key: delete it
```

On Linux the keychain needs a Secret Service provider such as gnome-keyring (or KeePassXC) running for automatic unlock. If no OS keychain/Secret Service is available, velo asks for your passphrase each time it starts and keeps the key in memory only for that session.

## Unsigned builds

Release builds are not notarized: on macOS they carry only an ad-hoc signature, on Windows none.

- macOS: open the app once, then in System Settings › Privacy & Security click "Open Anyway". Or run `xattr -dr com.apple.quarantine /Applications/velo.app`.
- Windows: on the SmartScreen dialog click "More info", then "Run anyway".

## Updates

velo checks GitHub for a new release 30 seconds after launch and then once a day. When one is out, a green "velo x.y is ready" pill in the header opens a popover with **What's new** and **Install and restart**: velo saves your note, installs the update and relaunches. Check by hand from **velo → Check for Updates…** (macOS) or **Settings → Updates → Check now**; turn the daily check off in Settings. Updates are verified against velo's signing key before they install. On Linux, in-app updates work for the AppImage, .deb and .rpm (the .deb and .rpm installs ask for your password); if one fails, download the new version from the Releases page. Versions before 0.6.0 have no updater: install 0.6.0 by hand once. 0.8.0 is the last build for Intel Macs: they stop getting updates (a manual check shows a "platform not found" error). If you installed the Intel (x64) build on an Apple silicon Mac, download the Apple silicon (aarch64) .dmg from the Releases page once.

velo writes each update step, and any crash, to `velo.log`: `~/Library/Logs/dev.velo.app/velo.log` on macOS, `~/.local/share/dev.velo.app/logs/velo.log` on Linux, `%LOCALAPPDATA%\dev.velo.app\logs\velo.log` on Windows. Attach it when you report an update problem.

## Known limitations

- Quitting from the Dock or at logout bypasses the unsaved-edits prompt; edits are autosaved within about 0.5 s. Cmd+Q (and closing the window) asks first.

## Development

Requires Node 24, pnpm, and a Rust toolchain (plus [Tauri's platform prerequisites](https://v2.tauri.app/start/prerequisites/)).

```sh
pnpm install
pnpm tauri dev          # run the app
pnpm test               # frontend tests
cd src-tauri && cargo test
pnpm build:app          # release bundles, signed for the updater with ~/.tauri/velo.key
```

Performance test (10k notes, release build only):

```sh
node scripts/seed.mjs 10000 fixtures/notes
cd src-tauri && cargo test --release --test perf -- --ignored --nocapture
```

Pushing a `v*` tag runs `.github/workflows/build-release.yml`, which tests and builds all platforms into a GitHub release.

Release builds also produce updater artifacts (`.sig` files and `latest.json`) signed with a minisign key stored in the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; the matching public key lives in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`. `pnpm tauri build` refuses to run without the private key; `pnpm build:app` (macOS/Linux shell) reads it and its password from `~/.tauri/velo.key` and `~/.tauri/velo.password`. Forks need their own keypair (`pnpm tauri signer generate`). Never lose or commit the private key: installed apps only accept updates signed with it.

## License

MIT, see [LICENSE](LICENSE).

## Versioning

Versions are managed with [Changesets](https://github.com/changesets/changesets). `package.json` is the version source.

- Every user-visible change ships with a changeset in the same commit or PR: `pnpm changeset`, pick `patch` or `minor`, and write one past-tense sentence from the user's point of view.
- `pnpm version-packages` applies pending changesets (bumps `package.json`, writes `CHANGELOG.md`) and mirrors the version into `src-tauri/tauri.conf.json`.
- `pnpm release:tag` creates the `vX.Y.Z` git tag.
- On GitHub: `ci.yml` builds and tests every PR and `main`. `release.yml` (Changesets action) opens a "Version Packages" PR while changesets are pending; merging it tags `vX.Y.Z` and dispatches `build-release.yml`, which builds macOS (Apple silicon), Linux and Windows one after the other into a draft GitHub Release and publishes it once `latest.json` lists all three platforms.
