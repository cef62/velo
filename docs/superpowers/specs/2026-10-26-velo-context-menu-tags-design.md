# velo — right-click menu on notes + tag browser (design)

Requested by Matteo: "right click menu to the entries in the list" and "a way to see all the existing tags and toggle them visually". He asked for it to be built without his input up front and reviewed afterwards, so every behavior below is **my call** unless noted. v1 and v1.1 invariants still bind: no user text lost (every switch through flush-then-load that refuses while unsaved; `busy` guard during lock hand-offs), locked-note plaintext never on disk or in SQLite, files are the source of truth, the index is rebuildable, and note commands are blocked while indexing.

## 1. Right-click menu on list rows

- **Native menu**, built with Tauri's JS menu API (`@tauri-apps/api/menu`: `Menu.new({ items })` + `menu.popup()`), so it looks and behaves like a macOS menu and needs no custom positioning or keyboard code.
- **Right-click a row** opens that note first, through the normal flush-then-load path, with history recorded as an explicit open. Then the menu appears and its actions apply to the open note. If the switch is refused (unsaved edits, busy, indexing), the menu does not appear and the usual message shows.
- **Keyboard:** the ContextMenu key, or Shift+F10, on the search field or list opens the menu for the highlighted row (same rules).
- **Items:**
  1. Open in editor (focus the editor; leaves preview if the editor is hidden, same rule as Enter)
  2. Rename… (same as ⌘R)
  3. Lock / Unlock (label follows the note's state; same as ⌘⇧E)
  4. Copy link: puts `[[Title]]` on the clipboard
  5. Show in Finder (Windows: "Show in Explorer"; Linux: "Show in folder"), via the opener plugin's `revealItemInDir`
  6. separator
  7. Move to Trash… (same as ⌘⌫, with its confirmation)
- Menu items show their current shortcuts where they have one (from the remapped bindings).
- Permissions: add `core:menu:default` and the opener reveal permission. Keep the existing http(s)-only open-url scope.

## 2. Tags

**What a tag is:** `#word` in a note's body, which is how v1 already treats tags (plain text, found by search).
- A tag starts at the start of a line, after whitespace, or after `(`.
- It continues with letters, digits, `_`, `-` and `/`. `/` makes a nested tag such as `#work/clients`, which counts as one tag.
- It must contain at least one letter, so `#1` and `#2024` are not tags.
- A Markdown heading (`# Title`, where `#` is followed by a space) is not a tag.
- Text inside fenced code blocks is ignored.
- Tags compare case- and accent-insensitively (the same `fold` as search). The first spelling seen is the one displayed.

**Index:**
- A new `tags(path, tag_folded, tag_display)` table is filled on upsert for plain notes only.
- Locked notes contribute no tags to SQLite (plaintext invariant). An unlocked locked note's tags are matched in memory only.
- An index schema version (`PRAGMA user_version`) is bumped. Opening an older index clears it, so every note is reindexed once and gets its tags. That one-off reindex shows the normal progress line.

**Tag browser:**
- A "#" toggle button next to the search field, plus a new remappable action `toggle_tags` (default ⌘⇧T), shows or hides a tag panel under the search field.
- The panel lists every tag as a chip with its note count, sorted A→Z, and wraps onto several lines.
- Clicking a chip toggles it on or off, with a clear "selected" style. A "Clear" link turns all off.
- Selected tags **filter the list**: only notes that have *all* selected tags (AND). The filter combines with the search text and the sort mode, and paging and the "title matches first" grouping keep working.
- A filter line ("Filtered by #work #idea · Clear") stays visible when the panel is hidden, so the list is never filtered by an invisible rule.
- In the preview, `#tag` renders as a clickable chip. Clicking it turns that tag on in the filter and opens the panel.
- Tag counts and chips refresh on note changes. A selected tag that no longer exists is dropped from the selection.
- The selection and the panel's open/closed state last for the session only.

**Enter while filtered:** Enter or Shift+Enter keep their meaning. A note created while tags are selected is *not* auto-tagged.

## Non-goals
- Renaming or merging tags across notes, tag colours, tags in YAML front matter, the macOS Finder/OpenMeta tags from the v1 spec.
- OR filtering, or excluding tags.
- Custom HTML menus.

## Constraints
- Search with tag filters stays under 50 ms (slowest 5% of searches) at 10k notes; the perf test gains a tag-filter case.
- No new dependencies beyond what Tauri already ships (menu API, opener plugin).
