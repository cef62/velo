# velo — note metadata (dates, front matter, revisions) design

Requested by Matteo: "One way or another I want to know when a note was created and last modified; it might be interesting to keep some revisions." He wants the information in the note view, and the list may stay as it is. Decisions below are his unless marked **(my call)**. He approved the design in chat and asked for it to be built end to end while he is away.

## 1. Why and what

- **The problem:** notes sync through Google Drive, Dropbox, iCloud or git.
  - Git doesn't keep file dates; a checkout stamps every file with "now".
  - Cloud sync often resets the creation date.
  - So file-system dates alone can't answer "when was this note created?".
- **Goals:**
  1. Every note has a trustworthy created and modified date that travels with the note.
  2. Local revisions you can browse and restore for 30 days.
  3. A note info panel showing the dates, a few stats, tags and aliases, and the revisions.
- **Non-goals:**
  - Syncing revisions.
  - velo writing `tags:` / `aliases:`.
  - A "created" sort or extra dates in the list (Matteo chose the list as it is today).
  - Restoring deleted notes.
  - A YAML editor UI.
- **Anti-goals:**
  - Rewriting or reformatting anything in a note beyond velo's two keys.
  - Plaintext of a locked note on disk, including in revisions.
  - Save loops: stamping `modified` must never trigger another save.
  - Losing text.
  - Slowing search below the 50 ms p95 budget at 10k notes.

## 2. Front matter

- **Format:** a YAML front-matter block at the very top of the note, between `---` lines (line 1 is exactly `---`, closed by the next line that is exactly `---`). velo reads and writes this subset:
  - `created: 2026-10-27T09:14:05+01:00`: RFC 3339 with the local offset; seconds precision.
  - `modified: …`: same format.
  - `tags:` and `aliases:`: read only. Accepted as a flow list (`[a, b]`), a block list (`- a`), or a single scalar. Quotes are optional.
  - Any other keys, comments, blank lines or ordering: preserved byte for byte. velo edits only the `created` / `modified` lines in place, or appends them at the end of the block if missing.
- **Parser (my call):** a small hand-written parser for this subset in Rust (`src-tauri/src/frontmatter.rs`), with a TS twin only for display, hiding and word count. No YAML dependency.
  - Malformed input never fails a load or save; velo ignores what it can't parse.
  - A note whose first line is `---` but has no closing `---` within the first 200 lines has no front matter.
- **Existing values in other formats (my call):**
  - velo **never overwrites an existing `created:` line**, whatever its value. An empty value (`created:` with nothing after it) is filled in place.
  - velo rewrites the **first** `modified:` line's value in place, and never appends a second `created:` or `modified:` key when one exists. Duplicate keys: only the first is read or touched.
  - Values parse leniently: RFC 3339; `YYYY-MM-DD`; `YYYY-MM-DD HH:MM[:SS]` (local time); optionally quoted.
  - An unparseable value is treated as unknown for display: velo falls back to the file date with the "from file" hint, and keeps the line untouched.
- **Effective dates:**
  - `created` = the front matter value, else the file's earliest of creation (birth) time and modification time.
  - `modified` = the front matter value, else the file's modification time.
  - Each carries a source: `"frontmatter" | "file"`.
- **Writing:** setting `write_front_matter` (default **true**).
  - **New notes** (open_or_create) start with a block holding `created` and `modified` = now.
  - **On save** of a note whose text has no front matter: velo prepends a block with `created` = the effective file-based created date of the file on disk before the write (now, if the file doesn't exist) and `modified` = now.
  - **On save** of a note with front matter: velo sets `modified` = now and adds `created` if missing (with the file-based date).
  - **Stamping happens in the Rust backend inside `save_note` (my call).** The backend owns the clock and the file-system dates, and it's the one place every save passes through.
    - The save response carries the stamped front-matter block.
    - The UI applies it to the editor document as a non-user change: no dirty flag, no new save, no undo entry for the user's text.
    - The UI replaces only the front-matter range, and skips this if the user changed the block while the save was in flight; the next save stamps again.
  - With the setting off, velo never adds or changes front matter. Reading still works.
  - Locked notes: the stamped text is what gets encrypted. Front matter stays inside the encryption.
  - Conflict copies (save conflict path) are stamped like a normal save.
- **External edits:**
  - An external editor that doesn't update `modified` leaves the old value in place. velo shows the front matter value as is (front matter wins) until velo next saves the note.
  - Accepted limitation (my call): mtime is unreliable across git and sync, so it can't override the front matter.
- **Hiding:**
  - The front-matter block is hidden in Rich, Plain and Preview.
  - A setting `show_front_matter` (default **false**) shows it. It's toggled from the info panel ("Show front matter in the editor") and also by a remappable action `toggle_front_matter` (default `none`).
  - Hidden means a replace decoration over the whole block in CodeMirror, so the caret skips it (atomic range), and the preview renderer strips it.
  - The editor document keeps the full text, so hashes, saves and conflicts are unchanged.
- **Index and search:**
  - The FTS body and the list snippet exclude the front-matter block.
  - `tags:` values merge with body `#tags`, with the same fold and display rules.
  - `aliases:` go into a new `aliases(path, alias_folded, alias_display)` table.
  - Aliases count as titles for:
    - wikilink resolution (`[[alias]]` exists and opens the note; open_or_create finds a note by alias before creating one);
    - search: a query matching an alias puts the note in the title-match group.
  - `notes` gets `created INTEGER` and `modified INTEGER` (epoch ms, the effective values) plus `created_src` / `modified_src`.
  - The list's date and the "Recent" sort use the effective modified date, so a git checkout no longer reorders everything (my call, consistent with goal 1).
  - Locked notes: their front matter is encrypted, so the index only has file-based dates for them; while unlocked, the panel shows the real values from memory.
  - The index schema `user_version` becomes 3, which triggers the one-time drop-and-reindex (fast path, as for version 2).
- **Rename:** front matter is untouched. Revisions follow the note (§3).

## 3. Revisions (local snapshots)

- **Where:** `<app data dir>/revisions/<vault id>/<note key>/<epoch-ms>.<ext>`. The hashes here use a stable hand-written FNV-1a 64-bit hex, not Rust's `DefaultHasher`, so folder names survive toolchain updates (my call).
  - `vault id` = the same hash used for the index file name.
  - `note key` = hash of the note's **folded title**, not its file name, so lock/unlock (which renames `Title.md` ↔ `Title.md.age`) keeps one history (my call).
  - `ext` = `md`, or `md.age` for locked notes, which store the ciphertext bytes exactly as written. Never plaintext.
  - Never inside the notes folder.
- **When (my call):**
  - On save, when the newest snapshot of that note is older than **10 minutes**, or none exists. The snapshot is of the file's bytes *before* the write, exactly as they were on disk (ciphertext for a locked note), so the state before an editing session is kept; nothing is snapshotted when the file didn't exist before (or was empty), or when the save became a conflict copy. (Owner ruling M5; this replaces the earlier "snapshot of the new content".)
  - Before an external change replaces the editor content (watcher reload): the old content.
  - Before a restore: the current content.
  - Identical content to the newest snapshot (same hash) is skipped.
- **Retention:** delete snapshots older than **30 days**, on vault open and then at most once a day.
- **Lock / unlock (my call):**
  - **Locking** re-encrypts that note's existing plaintext `.md` snapshots into `.md.age` in place, with the same identity as the note. No plaintext of a now-locked note stays on disk.
  - **Unlocking** leaves the existing snapshots encrypted (still readable with the identity); new snapshots are written plain.
- **Rename:** move the note's snapshot folder to the new key. **Delete:** keep its snapshots until they age out (no UI to reach them; my call).
- **Commands:**
  - `list_revisions(path) -> [{ id, ts, size }]`, newest first.
  - `read_revision(path, id) -> String`. Locked notes are decrypted with the identity, or fail with `"locked"`.
  - `snapshot_text(path, text)`: the UI sends the text to snapshot. Used before a watcher reload replaces the editor content (the UI still holds the old text; the disk no longer does) and before a restore. The backend encrypts it for locked notes (identity required, else `"locked"`) and applies the same identical-content skip. This is not throttled by the 10-minute rule (my call).
- **Restore:** the UI replaces the editor text with the revision's text as a normal user edit. It's saved normally, so the pre-restore content was snapshotted first and the restore can be undone through revisions too.

## 4. Note info panel (Matteo picked option B)

- **Toggle:** a side panel on the right of the note pane, toggled by an ⓘ button in the title bar and a remappable action `toggle_info` (default `Mod+KeyI`). Its open/closed state is a persisted setting `info_panel` (default false) (my call). It never covers the editor; the editor narrows.
- **Sections:**
  - **Dates:** "Created" and "Modified", absolute local date and time plus relative. A file-based date shows a muted "from file" hint with a tooltip: "Not stored in the note yet; it may change when the file is synced or checked out."
  - **Info:** word count (body without front matter, computed in the UI), "Linked from N notes" (existing `backlink_count`), tags (chips; clicking one sets the tag filter like elsewhere), aliases.
  - **Revisions:** the list (relative time + absolute in a tooltip). Selecting one shows a read-only preview in the panel (plain text, scrollable) with a **Restore** button (confirm: "Replace the note with this version from <time>? The current text is kept as a revision."). An empty state reads "No revisions yet".
  - **Setting:** "Show front matter in the editor" (bound to `show_front_matter`).
- **Panel rules:**
  - Follows the open note; hides its content when no note is open.
  - Refreshes after each save (dates) and when revisions change.
  - Uses Park UI components and the existing velo tokens and recipes. Styling follows `design/park-ui` conventions (velo.chrome surface, 280 px wide, resizable not required).
- **Settings dialog:** General gets "Add created/modified dates to notes (front matter)" for `write_front_matter`.

## 5. Constraints

- No new dependencies: the front-matter parser is hand-written, and time handling uses `chrono` 0.4.45, already a direct dependency in `src-tauri/Cargo.toml`.
- Invariants from earlier work hold:
  - No user text lost.
  - Locked plaintext never on disk.
  - Files are the source of truth and the index is rebuildable.
  - Indexing gate.
  - Search < 50 ms p95 at 10k notes; the perf test includes notes with front matter.
- Every user-visible change ships with a changeset (minor).

## 6. Left to the builder

- Exact module split.
- Revision folder hashing details.
- Panel layout details within the design system.
- How the editor marks the stamping transaction as non-user (CodeMirror annotation).

## 7. Owner checks

- Real sync (Drive, Dropbox, iCloud, git): dates survive.
- Revisions after a day of use.
- Restore feel.
- Front-matter block in Obsidian or another editor.
