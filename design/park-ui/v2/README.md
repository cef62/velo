# velo v2 — declutter: rationale and handoff

Design canvas: https://claude.ai/artifact/LnAtMzFpUDstf8a6tkXo1k, page **“v2 · declutter”** (v1 is kept on its own page for comparison). Light and dark on every board.

**Status (2026-10-30): approved.** Matteo approved every "my call" and every removal in §9, and asked for a grayscale "clear" look (§12). Treat the whole document as the spec.

## 1. What's wrong today

Found by reading `src/ui/*` at 0.10.1.

- **Header overflow (the hard bug).** `breakpoints.ts › headerMode()` switches to "full" at ≥ 900 px. Those thresholds date from v1, before the four-way pane switch (~350 px with labels) existed. At the default 1000 px the header therefore renders all 14 controls, which need ~1130 px. `bar` has `minW: 0` and no overflow handling, so Trash and Settings are pushed off the end and become unreachable.
- **Redundant controls.**
  - Sort exists three times: header, overflow menu, Settings.
  - Edit style exists twice: header and overflow menu.
  - Tags appear three times: tag bar, Info panel, Tag panel.
  - "Save search…" appears twice: Tag panel and the Filtered-by banner.
  - "Linked from" is a count in Info and a graph in Connections.
- **Mislabelled actions.** The Notes and Tasks segments share one shortcut, `toggle_tasks`, whose label reads "Notes / Tasks".
- **Inconsistent panes.** The four modes share nothing:
  - Notes: a listbox with no toolbar; its sort control lives in the header.
  - Tasks: `role=list` with a footer.
  - Timeline: a listbox with two segment groups and a button in a toolbar.
  - Connections: an SVG with a toolbar, and the only mode that is disabled when no note is open.
- **Hidden actions.**
  - Lock all, Export and Save search have no default shortcut (only Lock all appears in the header).
  - Merge and Show front matter are only reachable from the context menu or the Info panel.
- **Stacked bands.** Header, tag panel, filter line, then title bar, update banner, conflict banner, preview strip and tag bar can all be on screen at once, above the first line of text.

## 2. The model

- **The header is global and fixed.** It holds search, Filters (#), the command palette (⌘P) and Settings, in one row at every width from 600 px up. It never folds.
- **The left pane is "a list with a bar".** Notes, Tasks and Timeline are tabs in a 36 px bar on top of the pane. The right side of the bar holds that mode's own controls. Every mode uses the same rows, the same section header, the same selection and the same keys.
- **The note area holds the note's controls.** The title bar has the view switch (Rich · Plain · Preview), Lock, the side-panel toggle and a ⋯ menu for everything else that acts on the note.
- **The side panel is beside the note.** It has two tabs: **Related** (replaces Connections) and **Info**.
- **Command palette for rare actions** (my call). Every action is listed by name with its live binding, so nothing rare needs a button.

## 3. Changes: problem → decision → what moved

| # | Problem | Decision | Moved |
|---|---|---|---|
| 1 | Header doesn't fit at 1000 px | Header keeps 4 controls; search is capped to 180–680 px | Everything else, below |
| 2 | The pane switch takes ~350 px of header and is global for no reason | Tabs in the left pane bar; Tasks keeps its due count. Labels on all tabs when the pane is ≥ 380 px, else only the active tab (my call) | Header → left pane bar |
| 3 | Connections replaces the list (in vertical layout it's a ~200 px strip) | Related tab in the side panel (my call; see §5) | Header mode → side panel |
| 4 | Sort ×3 | One menu button "Recent ▾" in the Notes bar | Header, overflow, Settings → Notes bar |
| 5 | Edit style ×2, Preview a separate toggle that turns into a pill | One view switch, Rich · Plain · Preview; Preview's segment is solid accent when on (my call). ⌘⇧R and ⌘⇧P unchanged | Header → title bar |
| 6 | Lock / Unlock away from the note it acts on | In the title bar; the icon shows the state | Header → title bar |
| 7 | Lock all, Export, Save search, Merge, Show front matter hidden or crowding | Command palette (all); note ⋯ menu (Merge, Move to new note, Rename, Show front matter, Trash) | Header / Info → palette, ⋯ |
| 8 | Overflow menu repeats header items | Removed; the palette is the overflow at every width (my call) | — |
| 9 | "Filtered by" banner adds a band | Chips inside the search field ("#work ×", or a saved search's name); Backspace at caret 0 removes the last one; a × clears all (my call). **Many filters:** chips take at most half the field; the rest fold into a dashed "+N" chip that opens Filters with focus on the tags. While typing, if the chips would leave under 160 px of text, they all collapse into one "6 filters" chip. Screen readers get the full list in the chip's label. | Banner → search field |
| 10 | Tag panel mixes saved searches, No links and tags in one row | Filters panel with two labelled rows: Saved (dashed until applied) · Tags (No links first) | Same panel, regrouped |
| 11 | Preview strip duplicates the indicator | Removed; the view switch says Preview and the caret is gone (my call) | — |
| 12 | Update banner sits in the note area | Header pill "velo 0.11 is ready" → popover with What's new / Install and restart (my call) | Note area → header |
| 13 | Info panel repeats tags; "Linked from" is just a count | Info keeps dates, words, aliases, revisions. Tags live in the tag bar; links in Related | Info → tag bar / Related |
| 14 | Unlocking a note is a modal over the note | Inline unlock in the editor area; the create-lock dialog stays (my call) | Dialog → editor area |
| 15 | Timeline: two segment groups + Export | One "Updated · 30d ▾" menu + an Export icon; the Export dialog states its scope | Toolbar → Timeline bar |
| 16 | Tasks footer for one checkbox | "Show done" toggle in the bar; Undo becomes a one-line status | Footer → bar |
| 17 | "Show labels on header buttons" | Not needed: 3 icon buttons, each with a tooltip | Recommend removing |

## 4. Flows, end to end

- **Search → open → write.** Unchanged and still the centre: ⌘L, type, ↩ opens and focuses the editor, ⇧↩ creates. What changes is everything around it: the hints stay in the field, active filters now show as chips in the same field, and nothing else in the header competes with it. Quick capture is unchanged.
- **Switching panes.** ⌘⇧X (Tasks) and ⌘⇧L (Timeline) toggle as today and return to Notes when pressed again. With the mouse it's the tabs. The search query filters whichever mode is showing, as today.
  - Labels: rename `toggle_tasks` to "Tasks" and `toggle_timeline` to "Timeline".
- **Filtering by tags and saved searches.** ⌘⇧T opens Filters. Tab enters the chips, ←/→ moves across both rows, Space toggles, Esc closes and returns to search.
  - Applying a saved search replaces the query and the tags, and shows as one named chip. Typing narrows it further.
  - "Save search…" lives in the panel and the palette; Clear in the panel and on the field's ×.
- **Tasks.** Same rows as Notes. Space ticks, ↩ opens at the task's line, "Show done" is in the bar. The due count stays visible on the tab in every mode.
- **Timeline → Export.** Export (icon in the bar, or the palette) exports exactly what the list shows. The dialog opens with that scope stated ("37 notes from the Timeline · Updated in the last 30 days · matching "roadmap" · #work"), so you only pick the format and content.
- **Lock and unlock.**
  - ⌘⇧E on a plain note opens the create dialog (passphrase + confirm, unchanged). On an encrypted, unlocked note the title-bar lock is shown pressed, and ⌘⇧E removes encryption, as today.
  - Opening a locked note shows the inline unlock with focus in the field. ↩ unlocks; a wrong passphrase shows an inline error.
  - Lock all: ⌥⌘E or the palette.

## 5. Connections — what's wrong, and Related

**What's wrong with the graph as a way to explore:**

1. **Wrong place.** It replaces the list, and in vertical layout the list is a ~30%-high strip. The graph gets the least space in the app, and you lose your search results to see it.
2. **Position carries no meaning.** In Ring, a node's angle is just its order. In the time layouts the x-axis is a date, but the edges then cross arbitrarily. You read the graph by hovering node by node, which makes it a slow list.
3. **It hides the most useful information.** *Why* a note links here (the sentence) is never shown. The card has dates and a preview, but not the context.
4. **The keyboard can't follow it.** SVG nodes as buttons give you Tab-through-every-node with no spatial meaning. Recentring takes a double-click, and "Link it" only appears on hover.
5. **One hop plus tags collapses to "+N" exactly where wandering would get interesting.** The "+N" node then sends you to a list anyway.

**Related** (my call): a keyboard tree in the side panel that follows the open note.

- **Sections, in this order:**
  1. **Linked from** — each row has the linking sentence, matched words in bold;
  2. **Links to** — a missing target shows red with "⇧↩ create";
  3. **Mentions** — "mentions "X" 2×" with **Link it**: ⇧↩, or the button on hover/focus;
  4. **Shared tags** — one group per tag, the 3 most recent notes, then "All 148 in the list", which applies the tag filter.
- **Wandering.** ↩ opens the note and keeps focus in the panel (my call), so ↑/↓ ↩ walks from note to note. A trail row shows where you came from (⌘J / ⌘K). ⌘↩ opens the note and jumps to the editor. Space peeks: preview and dates in place.
- **Keyboard.** One Tab stop for the panel's tabs and one for the tree. ↑/↓ move (section headers included); ←/→ collapse and expand; Esc returns to the editor. ⌘⇧C opens the panel on Related; ⌘I toggles the panel.
- **Where it lives.** Docked beside the note when the note keeps ≥ 480 px. Otherwise it opens over the note and Esc closes it. At the default 1000 px in horizontal layout it overlays; in vertical layout, or in horizontal layout at ≥ ~1070 px (with a 280 px list), it docks.
- **Data needed.**
  - `Connections.links_in[]` needs a `context: string` (the line holding the link, trimmed around it). Mentions need the same.
  - Everything else is already in `Connections`.
  - Until the backend sends context, the row can fall back to `GraphNode.preview`.
- **The graph.** I recommend removing it, together with Ring / Created / Updated (see the removal list). If you want a map later, give it the whole window from the palette ("Open map") rather than the list's slot.

## 6. Look and feel cleanup

- **Control heights:**
  - header 32 px (`control`);
  - inside bars and panels 28 px (`controlSm`, new alias `paneTab`).
  - One icon size per place: 16 px in the header and title bar, 14 px in pane bars, rows and menus.
- **Group headers:** one style everywhere (`sectionHeader`): Tasks groups, Timeline days, Related sections, Info sections, palette groups.
- **Counts:** one count pill (`countBadge`): `danger` for due tasks, `neutral` for the Related total.
- **Lines:** `velo.muted` for lines inside a region (pane bar, tabs); `velo.divider` between regions. Only the conflict banner remains as a full-width band.
- **Pressed and selected look the same everywhere:**
  - `accentSubtleHover` background + `accentText` for pressed toggles, the selected pane tab and open menu buttons;
  - solid accent only for the one thing that changes what you see: the Preview segment and applied chips.

## 7. Tokens and recipes

**Colors: no changes.** Every v2 surface uses the existing `velo.*` semantic colors. Contrast for the new pairs:

| Pair | Light | Dark |
|---|---|---|
| Search chip (`accentText` on `accentSubtle`) | 5.4:1 | 7.3:1 |
| Due count (`danger` on `dangerSubtle`) | 4.5:1 | 7.8:1 |
| Selected pane tab (`accentText` on `accentSubtleHover`) | 4.9:1 | 6.3:1 |
| Neutral count, hovered Related row (`fgMuted` on `muted`) | 4.9:1 | 6.9:1 |

**New size tokens:** `panda/tokens.ts` → `paneBar` 36, `paneTab` 28, `sidePanel` 300, `searchMin` 180, `searchMax` 680, `palette` 560, `relatedRow` 44. Width thresholds are in `v2Widths`.

**New recipes:** `panda/recipes/`, in the style of `src/theme/recipes/velo/`.

| Recipe | Type | Where |
|---|---|---|
| `paneBar` | slot (`labels: all/active`) | left pane bar |
| `menuButton` | recipe (`iconOnly`) | Sort, Timeline range, compact view switch, Show done |
| `sectionHeader` | recipe | every list group |
| `countBadge` | recipe (`tone`) | Tasks tab, Related tab |
| `sidePanel` | slot (`mode: docked/overlay`) | Related · Info |
| `relatedRow` | slot (`kind: note/missing/mention/nested`) | Related rows |
| `searchChip` | recipe (`kind: tag/saved`) | chips in the search field |
| `commandPalette` | slot | ⌘P |
| `lockScreen` | slot | inline unlock |

**Changed recipes:**
- `tagChip`: add `kind: { saved: { root: { borderStyle: 'dashed', '&[aria-pressed=true]': { borderStyle: 'solid' } } } }` for saved-search chips.
- `segmentGroup` (view switch): when Preview is checked, the indicator and text become solid, i.e. `'&[data-value=preview][data-state=checked]': { color: 'white' }` and an indicator `bg: 'velo.accent'`.
- `banner`: only `conflict` stays. The `filter`, `update` and `preview` tones go once you accept #9, #11 and #12.
- `previewPill`: no longer used (#5).
- `titleBar`: right padding drops to `2.5` (icon buttons sit at the edge).

**Responsive logic:** `panda/layout.ts` (+ `layout.test.ts`, written against the mock sizes). It replaces `src/ui/breakpoints.ts › headerMode()`. Each part decides from its own width (ResizeObserver), so both layouts and the divider position work without window breakpoints.

## 8. Shortcuts

- **New:** `command_palette: "Mod+KeyP"` (my call). It's free in `DEFAULTS` and not reserved. Ctrl+P is "print" by convention on Windows/Linux, and Export covers PDF.
- **Relabel:**
  - `toggle_tasks` → "Tasks";
  - `toggle_connections` → "Related notes" (opens the side panel on Related);
  - `toggle_info` → "Side panel".
- **Nothing is removed.** All shortcuts stay remappable. The palette reads the live map, so remaps show up there.

## 9. Remove (approved)

1. "Show labels on header buttons" setting (`header_labels`)
2. Overflow menu (`OverflowMenu.tsx`)
3. Connections graph and its Ring / Created / Updated layouts (`ConnectionsView.tsx`, `connections_sort`, `ringLayout` and the time layouts)
4. Preview strip (`PreviewStrip.tsx`, `banner` tone `preview`)
5. Sort in Settings › General
6. Tags section in the Info panel
7. "Filtered by" banner (`FilterLine.tsx`)

## 10. Design calls (all approved)

- Command palette on ⌘P.
- Pane tabs in the left pane bar, with labels only on the active tab when narrow.
- Related in the side panel instead of a left-pane graph; ↩ keeps focus in the panel.
- Side panel overlays the note below 480 px of note width (so it overlays at 1000 px horizontal).
- Preview as a third view segment; strip removed.
- Filter chips in the search field instead of the banner.
- Update as a header pill.
- Inline unlock.
- Front-matter toggle moved to the note menu.

## 12. Clear — graphite and grays (supersedes the colors in §6–7)

**Look:** shades of gray in the spirit of macOS's "clear" icon style. Color only carries meaning: **red** for errors, overdue tasks and missing links; **green** for important positive things (primary action, done ticks, update ready, Link it). Canvas board: "v2 · Clear — graphite and grays". Every v2 board now renders in this look.

**Theme changes:**

- **Gray scale.** `gray: slate` → `gray: neutral` in `panda.config.ts`; `panda/clear/neutral.ts` is Radix gray in the same shape as `slate.ts`. Park UI's equivalent is `grayColor: neutral`.
- **Semantic colors.** `src/theme/tokens/velo.ts` → replace it with `panda/clear/velo.ts`.
  - Every `accent*` token becomes graphite, so selection, focus, pressed and links turn gray without touching any component code.
  - New tokens: `accentFg`, `hairline`, `highlight`, and `positive`, `positiveHover`, `positiveFg`, `positiveText`, `positiveSubtle`, `positiveBorder`.
  - `warning*` becomes neutral.
- **Default palette.** In `global-css.ts`, change `colorPalette: 'indigo'` to `'gray'`. Primary buttons pass `colorPalette="green"` (Save, Unlock, Export…, Install and restart, Lock note). The `indigo` palette can be dropped once nothing references it.
- **Shadows.** `veloPopover` loses its blue tint; the values are in `panda/clear/velo.ts`.

**Recipe touch-ups:**

- Any `color: 'white'` on `velo.accent` becomes `velo.accentFg`. That covers `tagChip` selected, the Preview segment, the Filters count dot and `searchMatch` on a selected row.
- Done checkboxes, the task tick and `accentColor` in the editor use `velo.positive`.
- The update pill uses `positiveSubtle` / `positiveText` / `positiveBorder`.
- "Link it" is `Button variant="subtle" colorPalette="green"`.
- **Links:** `.md-link` and `.md-wikilink` use `velo.fg` with a `velo.accentLine` underline. Missing wikilinks stay `velo.danger`, dashed.
- **Search match:** `searchMatch` gets `fontWeight: 600` on top of `accentHalo`, because a gray highlight alone is too faint.
- **Clear surfaces:**
  - header, side panel and Filters: `boxShadow: inset 0 1px 0 {velo.highlight}`;
  - pressed toggles and the selected pane tab: `inset 0 0 0 1px {velo.hairline}, inset 0 1px 0 {velo.highlight}`;
  - window, segments, chips and kbd: borders use `velo.hairline`.
- **macOS vibrancy (optional, my call):** the header and side panel can sit on native vibrancy (Tauri window effects, `sidebar` / `headerView` materials) with `velo.chrome` at ~85% alpha. The opaque grays above are the fallback and the Windows/Linux look.

**Contrast (light / dark), WCAG AA:**

| Pair | Light | Dark |
|---|---|---|
| Body | 16.3:1 | 16.3:1 |
| Muted on canvas / chrome | 5.9 / 5.5:1 | 9.1 / 8.2:1 |
| Markdown marks | 5.9:1 | 6.3:1 |
| Selected row title / snippet | 5.9 / 4.8:1 | 6.9 / 4.9:1 |
| Muted on idle selection | 4.8:1 | 6.3:1 |
| Pressed toggle text | 11.9:1 | 9.8:1 |
| Primary button (`positiveFg` on `positive`) | 4.7:1 | 8.2:1 |
| `positiveText` on canvas / on `positiveSubtle` | 5.4 / 4.9:1 | 10.1 / 7.9:1 |
| Focus ring (`accent`) vs canvas | 11.2:1 | 12.7:1 |
| Errors (`danger`) | 5.2:1 | 9.0:1 |

## 11. Files

- `panda/tokens.ts`
- `panda/layout.ts`, `panda/layout.test.ts`
- `panda/recipes/*.ts`
- `panda/clear/velo.ts`, `panda/clear/neutral.ts` — the clear theme (§12)
- `reference/velo-clear.css` — the clear theme as plain CSS; loads after `velo-v2.css`
- `reference/V2Clear.dc.html` — the clear foundations board
- `reference/*.dc.html` — reference markup per board, exported from the canvas. They need the canvas runtime to render, so read them for structure, classes, copy and states.
- `reference/velo-v2.css` — the plain-CSS version of every new v2 class. It loads after v1's `../reference/velo-park.css`.
