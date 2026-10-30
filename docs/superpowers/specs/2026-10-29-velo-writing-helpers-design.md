# velo — Writing helpers design

Requested by Matteo as Project 3 of 4 (roadmap: tasks, connections, writing helpers, saved searches). He asked for the design to be written straight from the roadmap, with no further questions. Decisions from the roadmap are his. Everything marked **(my call)** is mine, and he checks those while reading.

## 1. Why and what

- **Goal:** make notes easier to write, clean up and connect, without leaving the editor:
  - a **tag bar** that always shows a note's tags;
  - **autocomplete** for `[[links]]` and `#tags`;
  - **Move to new note** (extract);
  - **Merge notes**.
- **Why:**
  - Tags sit at the bottom of long notes, out of sight.
  - Typing a link by hand makes near-duplicate notes ("Meeting notes" vs "Meetings notes").
  - Clean-up today means copy, paste and fixing links by hand.
- **Non-goals:**
  - Editing tags from the tag bar (it is read-only).
  - Autocomplete for headings or block references (`[[note#heading]]`).
  - Splitting a note by headings in one go.
  - Merging more than two notes at once.
  - Undoing a merge as one action (section 5 says how to recover).
- **Anti-goals:**
  - A completion popup that gets in the way of plain typing: it opens only after `[[` or a `#` in tag position, and Esc always closes it.
  - Losing text: a merge or extract that fails partway must leave every note readable and unchanged, or fully done.
  - Writing a locked note's plaintext into an unencrypted file.
  - A slow popup: under 50 ms on a 10k-note vault.

## 2. Tag bar

- One row under the note title, above the text, in both rich and plain modes. It shows the note's tags as pills: front-matter `tags:` plus inline `#tags`, deduplicated case-insensitively.
- **Source:** the existing `info.tags` in the controller (`controller.ts`, word-count/tag refresh). It is already merged and folded, and refreshes on load and save, not on every keystroke **(my call: same cadence as the info panel)**.
- Clicking a pill sets the tag filter, like the info panel chips (`controller.toggleTagFilter`). A pill in the current filter shows as selected.
- **Sticky:** the row stays visible while the text scrolls.
- **Empty:** a note with no tags shows no row, so no space is lost **(my call)**.
- **Locked:** a locked note shows no row. An unlocked encrypted note shows its tags, like the info panel.
- No setting to hide it **(my call; add one only if it proves noisy)**.

## 3. Autocomplete

**Library:** `@codemirror/autocomplete`, the official CodeMirror package from the same family as the 6 already installed **(my call)**. Writing a keyboard-accessible popup by hand would be far more code. This is the only new dependency.

### 3.1 `[[` links

- **Opens:** after typing `[[`, outside code (fenced or inline) and outside front matter. It filters as you type until `]]`, Esc or a line break.
- **Candidates:** every note title and every alias.
  - An alias shows as `Alias → Title`.
  - Locked notes are included: their titles are file names, already visible in the list **(my call)**.
- **Order:** fuzzy, case- and accent-insensitive (same `fold` as search):
  1. exact match;
  2. prefix;
  3. word-start;
  4. substring;
  5. in-order letters.
  - Ties go to aliases and titles alike, then most recently modified **(my call)**.
  - Showing aliases with titles is Matteo's point: you link to the note you already have instead of making a near-duplicate.
  - At most 20 rows **(my call)**.
- **Pick:** writes `[[Name]]`, using the title or the alias exactly as shown, and puts the caret after `]]`. An alias already resolves to its note, so the writer's wording is kept **(my call)**.
- **Last row, `Create "…"`:**
  - Shown when the typed text matches no title or alias exactly (folded).
  - It writes `[[typed]]` and creates an empty note with that title. The new note gets front matter if the setting is on.
  - The editor stays on the current note.
  - A title the file system can't take (`names.rs` rules) shows the same error as New note.
- **Source data:** a new command `list_link_targets` returns `{ name, title, modified }` for titles and aliases. It is loaded when the editor gets focus and after any create, rename or delete, not per keystroke **(my call)**. `list_titles` stays as it is.

### 3.2 `#` tags

- **Opens:** on a `#` where `readTag` (`src/tags.ts`) would start a tag: at line start or after whitespace or `(`. Not in code, front matter or URLs.
- **Candidates:** existing tags from `list_tags`, fuzzy-filtered with the same order as links. Ties go to the higher note count, which shows on the right.
- **Pick:** writes the tag's display spelling and a space.
- **No match:** there is no Create row; typing the new tag creates it.
- A heading (`# Title`) never triggers it, because `#` followed by a space is not a tag.

## 4. Move to new note (extract)

- **Trigger:** select text, then the `extract_note` action. The default is `Mod+Shift+KeyN`, remappable **(my call)**. There is no editor right-click entry, because the editor has no custom context menu today **(my call)**.
- **Steps:**
  1. A small dialog asks for the new note's title. It is pre-filled from the selection's first line, with leading `#`, `-`, `[ ]` and spaces stripped, cut to 60 characters **(my call)**.
  2. On OK, velo creates the note with the selected text as its body. The note gets front matter if the setting is on.
  3. The selection is replaced by `[[Title]]` as one isolated undo step (`applyChange(…, true)`, as Link it does).
  4. The editor stays on the source note. ⌘Z restores the text but does not delete the new note **(my call)**.
- **Order and safety:**
  - The new note is written and saved first. The source note changes only after that succeeds. A failure leaves the source untouched.
  - A title that already exists is refused in the dialog ("A note with this title exists"). Extract never appends to an existing note.
- **Refused:**
  - In an encrypted note (locked or unlocked). Encrypting the new note is possible, but out of scope **(my call)**.
  - On an empty selection.
  - In a read-only editor (indexing, lock hand-off).
- **Front matter:** a selection inside the front-matter block is refused **(my call)**.

## 5. Merge notes

- **Trigger:**
  - "Merge into…" in the note list's context menu (`contextmenu.ts`, `menuModel`), on the note to merge away. That note is the **source**.
  - Also the `merge_note` action, with no default key **(my call)**, for the open note.
- **Pick target:** a dialog with a search field over note titles, using the same fuzzy match as `[[` autocomplete. The source itself and locked notes are not listed.
- **Confirm:** the dialog says "Merge **Source** into **Target**? *N* links will be updated. Source goes to the Trash." N comes from `backlink_count`.
- **Result:**
  - **Body:** the target's body is kept. Then a blank line, `## Source title`, and the source's body (front matter removed) are appended **(my call)**.
  - **Front matter:** the target's front matter is kept. The source's `tags` and `aliases` are added to the target's, deduplicated case-insensitively, and the source's title becomes an alias of the target **(my call)**. Links anyone types from memory still resolve, and the source's aliases keep resolving. The target's `created` is kept.
  - **Links:** `[[Source]]` and `[[Source|label]]` in every other note become `[[Target]]`. This reuses `rename_note`'s rewrite loop (`rewrite_links`, `rewritable`, batched index commit). Links through the source's aliases need no rewrite, because those aliases now live on the target.
  - **Source:** moved to the Trash (`move_to_trash`), so it can be recovered.
  - **Revisions:** a snapshot of the target is taken before the merge (`snapshot_text`). The target's revision list can then restore the pre-merge text.
- **Order (backend, one command `merge_notes(source, target)`):**
  1. Snapshot the target.
  2. Write the merged target.
  3. Rewrite links.
  4. Trash the source.
  - Any failure in step 1 or 2 stops with nothing changed. A failure in step 3 or 4 leaves the merged target in place and reports what was not done.
  - Steps 3 and 4 follow rename's rule: once the target is written, nothing undoes it.
- **Open notes:**
  - The editor flushes first.
  - If the open note is the source, the editor moves to the target.
  - If the open note is the target, it reloads.
- **Refused:**
  - Either note is encrypted.
  - Source and target are the same note.
  - Either note has unsaved changes that fail to flush.

## 6. Agents (MCP)

- **No new tool for extract (my call):** agents already have `create_note` and `edit_note`.
- **New write tool `merge_notes { source, target }` (my call):** agents can't rewrite links safely with the existing tools. It calls the same backend function and refuses locked notes, as the other write tools do. That makes 17 tools.
- **Autocomplete and the tag bar:** UI only, with nothing for MCP.

## 7. Backend summary

- `list_link_targets()`: titles and aliases (index `notes` + `aliases`, display spellings, plus the note's title and modified time).
- `create_from_selection(title, text)`: creates the note and refuses an existing title. The frontend then applies the `[[link]]` in the editor.
- `merge_notes(source, target)`: as section 5. It returns `{ path, rewritten }`.
- The Tauri commands and the MCP tool all go through `Vault` methods, so there is one implementation of each.
- No schema change.

## 8. Docs and settings

- **README:** a short section per helper, plus the new actions in the shortcut table and `merge_notes` in the MCP tool list.
- **Settings:** no new settings. `extract_note` and `merge_note` appear in the shortcut editor like the other actions.
- **Changeset:** one, `"velo": minor`.

## 9. Constraints

- Follow AGENTS.md / CONTRIBUTING.md: quality gate (tsc, vitest, cargo test, `pnpm build:app`), changeset, adversarial review.
- Never touch real velo data in tests. Use temp dirs.
- Keyboard-only use must work for every new UI: popup, dialogs and tag bar. Screen-reader labels must not repeat words.

## 10. Left to the builder

- The fuzzy scorer's exact weights, within the order in 3.1.
- Popup styling, within the existing Park UI tokens (light and dark).
- How `list_link_targets` is cached in the controller.
- Task split and order. Suggested order: tag bar, autocomplete, extract, merge, MCP.

## 11. Owner checks

1. Open a long note with tags at the bottom. The tag bar shows them, and a pill click filters the list.
2. Type `[[mee`. Existing "Meeting notes" and its aliases are listed first. Pick one, and the link is written.
3. Type `[[Brand new idea`, pick Create. The link is written, the note exists and is empty, and the editor stays put.
4. Type `#pro` mid-sentence. Your tags are offered. A `# Heading` line offers nothing.
5. Select a paragraph and press ⌘⇧N. The new note holds it, and the paragraph becomes a link. ⌘Z brings the paragraph back.
6. Merge a note with backlinks into another. Its text is appended under its title, the links point to the target, and the source is in the Trash.
7. Ask Claude to merge two notes through MCP.
