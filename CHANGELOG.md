# velo

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
