# velo

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
