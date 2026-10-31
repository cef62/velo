# velo

## 0.12.0

### Minor Changes

- 8e89e1e: Switched to the "clear" look: neutral grays with a graphite accent, green only for primary buttons, done ticks and updates, red only for errors; selection, focus and links are now shades of gray.
- b3ba62b: Added a command palette (⌘P / Ctrl+P, remappable) that lists every action by name with its current shortcut, recent ones first; the header's ⋯ menu is gone.
- fcf1409: Active tag filters, No links and an applied saved search now show as chips inside the search field (Backspace at the start removes the last one, × clears them; many chips fold into "+N"), and the tag panel became a Filters panel with Saved and Tags rows; the "Filtered by" banner is gone.
- 54dde6c: Decluttered the header to search, Filters and Settings so it fits the default window; the Filters button shows how many filters are active; the pane switch, sort, edit style, preview, lock, lock all and trash moved to the ⋯ menu for now, and the update banner became a pill in the header with a popover.
- 2859036: Added a bar on top of the left pane with Notes, Tasks and Timeline tabs; Sort, Show done and the Timeline date and range menu moved there, the Export dialog now states what it exports, and every list uses the same group headers.
- 3b1f620: Replaced the Connections graph with a Related tab in the side panel beside the note: notes linking here with the sentence that links, links out (missing targets can be created), unlinked mentions with Link it, and shared tags, all walkable from the keyboard; the Info tab keeps dates, words, aliases and revisions.
- 5f13022: The title bar now holds the note's controls: a Rich · Plain · Preview switch (the preview strip is gone), the lock, the side panel toggle and a ⋯ menu with Rename, Move selection to new note, Merge into…, Show front matter and Move to Trash; a locked note opened without the key asks for the passphrase in place of the note instead of in a dialog.

### Patch Changes

- e3c2751: Removed the settings the v2 design made redundant ("Show labels on header buttons", Sort and Connections order: sort lives in the Notes bar) and the info panel's "linked from" count, which the Related tab replaces; old settings files still load.

## 0.11.0

### Minor Changes

- 7f75a42: Added saved searches (name a search with its tags and No links filter, apply it from the tag panel), a timeline of notes by created or updated date (⌘⇧L), and export of the timeline to Markdown or PDF, as full notes or tasks only, with locked notes never exported.

### Patch Changes

- 7f75a42: The Shift+F10 context-menu shortcut can now be changed or turned off in Settings → Keyboard shortcuts ("Open context menu"); the Menu key always opens the menu.

## 0.10.1

### Patch Changes

- 871a70c: Fix `velo --mcp` answering "busy" forever after a crash when the leftover agent file pointed at a reused process id: it now works directly on the notes again. "Copy setup command" now gives the AppImage's real path instead of its temporary mount path on Linux.
- 481dffe: Keyboard use of the note list and the Tasks view is smoother: focus now follows the selection when you move through the notes with the arrow keys, and the Tasks list is a single tab stop with ↑/↓ to move, Space to tick and Enter to open. Searching in Tasks and focusing the editor also do much less background work.
- b57f87a: Tags, tag removal, links and tasks now share one rule for what counts as code: fenced blocks, following CommonMark (a ```` ```` ```` fence is not closed by an inner ```` ``` ````). A `#tag` inside such a block no longer shows up in the tag panel, and an agent's tag removal now removes every tag the panel shows. Renaming or merging a note no longer rewrites `[[links]]` inside fenced code, and links there no longer count as backlinks. New titles and renames can no longer contain `]`, which broke every `[[link]]` to the note; existing files with `]` keep working. On macOS, a note whose file name the volume stores decomposed (HFS+, SMB shares) no longer appears twice in the list, and its saves are no longer reported as outside changes.
- c4e9407: Made the notes folder safer: renaming or merging a note no longer garbles linked notes that aren't UTF-8; a locked `.txt` note's leftover plain copy stays hidden from AI agents; locking or unlocking no longer reports a failure after the note has already moved; files left in the notes folder by a crash are cleaned up when the vault opens (a stray plaintext temp file is deleted and a note hidden mid-rename comes back); agent summaries of a note are wiped when it is locked; Lock all now refreshes the Connections view; changing the notes folder closes the note from the old folder instead of leaving it editable with failing saves; and with front-matter dates off, a note's created date no longer jumps to the last save.

## 0.10.0

### Minor Changes

- 367b6f7: Ticking a task now writes `@done(YYYY-MM-DD)` instead of `✅ YYYY-MM-DD`. Existing `✅` dates are still read, and replaced the next time the task is toggled.
- 95bf217: Added writing helpers: a tag bar under the note title, autocomplete for [[links]] and #tags, Move to new note (⌘⇧N) and Merge into…, plus a merge_notes tool for agents.

### Patch Changes

- 95bf217: Fix the note list resize snapping back to its smallest size after switching to Tasks or Connections, and show which tag pills are selected in the tag panel and info panel.

## 0.9.0

### Minor Changes

- 67da1bb: Added a Connections view that showed the links, backlinks, shared tags and unlinked mentions around a note, with one-click Link it, a No links filter for orphans, and MCP support for agents to read connections and find orphans.

## 0.8.3

### Patch Changes

- 58f5d72: Re-indexing many changed notes (after a git checkout or a sync) took seconds instead of minutes, and search and editing stayed responsive while it ran; locking a note stayed instant. If velo quit or crashed during such a re-index, the next launch rebuilt the search index once.

## 0.8.2

### Patch Changes

- e73e7fb: Indexing a notes folder now writes far less to disk and finishes about twice as fast.
- 1428df2: Fixed several Tasks and quick-capture rough edges: Enter no longer creates a stray note or opens a stale task after a refresh, capture retries and conflict copies are reported correctly, the capture shortcut returns you to the previous app, code blocks and dates are read more strictly, and task rows tick instantly and highlight the search.

## 0.8.1

### Patch Changes

- 162ea60: Stopped building velo for Intel Macs; macOS releases are now Apple silicon only.
- 356aca7: Agent access got sturdier: a stale link no longer blocks a rename, tags and CRLF notes are handled more carefully, failed agent changes leave no stray revisions, and the setup command can be copied once access is saved.
- 52233c5: Added download progress and install errors to the update banner, and a velo.log file that records update steps and crashes.

## 0.8.0

### Minor Changes

- cae0616: Added agent access: with it turned on in Settings, Claude Code could search, read, create and edit notes through velo's MCP server, with every change saved as a revision you could restore.

## 0.7.0

### Minor Changes

- 37c08f8: Added a Tasks view listing every open task across notes with due and done dates, quick capture from anywhere, a daily note, and new task-list notes.

## 0.6.1

### Patch Changes

- 83b9ec7: Documented that in-app updates also worked for the Linux .deb and .rpm packages, which asked for your password to install.

## 0.6.0

### Minor Changes

- c913535: Added in-app updates: velo checked GitHub for a new release daily and offered to install it and restart from a banner, with a manual check in the velo menu and in Settings, and a setting to turn the daily check off.

## 0.5.0

### Minor Changes

- 5f4fa32: Added created and modified dates that velo stores in a front-matter block inside each note so they travel through sync and git, kept 30 days of local revisions that you can preview and restore, and added a note info panel (⌘I) that showed the dates, word count, backlinks, tags, aliases and revisions of the open note; `aliases:` also worked as note titles.

### Patch Changes

- 4712589: Fixed the macOS DMG being reported as damaged on other Macs, ⌘Z after switching notes bringing back the previous note's text, and Lock all leaving locked notes readable. velo also stopped losing notes from the list when iCloud evicts or a sync client holds a file, kept up with large syncs and changes made while indexing, synced every save to disk, removed plaintext revisions of notes locked on another computer, stopped asking for the passphrase while you type in search, and rewrote links to the title a renamed note actually got.

## 0.4.0

### Minor Changes

- 0bbea28: velo has a new look, built on Park UI with Inter and JetBrains Mono and refined light and dark themes. The tag panel and the filter line now show note counts, search matches are highlighted in the list, shortcuts can be cleared with ⌫ in Settings and conflicting shortcuts are shown instead of refused, and failed saves offer a Retry button. Passphrase dialogs are clearer: velo only asks when it needs to create or unlock your key, and opening a locked note on a computer without your key now explains how to copy `.velo/identity.age` instead of creating a new key.
- 4498667: Settings has a new "Show labels on header buttons" option, the Sort and Rich/Plain switches show tooltips with their shortcuts, Esc in the search box clears the search, and on macOS the search field no longer crowds the window buttons.

### Patch Changes

- f61c23e: velo has a new app icon.

## 0.3.0

### Minor Changes

- e72e0d7: The preview now renders GitHub-flavored Markdown in full: task lists (click a checkbox to tick it in the note), GitHub alerts (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`) and footnotes (click a footnote number to jump to it and ↩ to jump back), alongside tables, strikethrough and autolinks, with proper styling for tables, code blocks and quotes.

## 0.2.0

### Minor Changes

- 937cd11: The editor is readable in dark mode and looks like a writing app instead of a code editor, and a new **Rich** editing style (now the default; toggle with the toolbar button or ⌘⇧R) hides markdown marks except on the line you are editing, with clickable task checkboxes and ⌘-click on links, wikilinks and tags. Settings gained a **Theme** choice (System / Light / Dark). The note title is larger, the divider between list and note can be dragged (in the vertical layout the title bar drags too), and ⌘⇧J switches between vertical and horizontal layout. ⌘J / ⌘K now go back / forward through the notes you visited; ↑ / ↓ in the search box move through the list. The one-time index upgrade after installing tags no longer looks stuck: it takes under a second instead of a minute.
