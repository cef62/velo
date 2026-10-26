# velo × Park UI — design handoff

A visual and UX refresh of velo. **No feature changes**: every control, shortcut and behaviour already exists. This folder holds what's needed to implement it with Panda CSS + the Park UI preset in velo's plain TypeScript/DOM UI (no React).

Design canvas (light + dark mocks of every screen): https://claude.ai/artifact/LnAtMzFpUDstf8a6tkXo1k (private to the owner's claude.ai account).

## What's in here

| Path | What it is |
|---|---|
| `panda/velo-preset.ts` | Park UI preset (indigo / slate / radius md) + `velo.*` semantic tokens with light/dark values |
| `panda/recipes.ts` | Custom recipes: `listRow`, `searchMatch`, `tagChip`, `inlineTag`, `keyCap`, `segmented`, `titleBar`, `divider`, `banner`, `previewPill` |
| `panda/editor-styles.ts` | Global CSS for the reading column: Plain, Rich, Preview, empty watermark |
| `panda/font-scale.ts` | User font size → editor size, row heights, title size (CSS vars + numbers for the virtual list) |
| `panda/panda.config.example.ts` | How to wire it all into `panda.config.ts` |
| `reference/*.dc.html` | Mock markup for each screen, exported from the canvas. **Reference only**: they need the canvas runtime to render (`sc-for`, `{{…}}` holes). Read them for structure, classes, copy and states. |
| `reference/velo-park.css` | Plain-CSS version of every token and component style used in the mocks. The most precise source for exact values. |

Reference file → screen: `Main` foundations/tokens · `Components` all component states + recipe map · `MainVertical` / `MainHorizontal` main window · `ListRows` rows + font sizes + empty results · `TagPanel` · `TitleBar` (+ conflict banner) · `Editor` Plain & Rich · `Preview` · `Settings` (tabs: General / Keyboard shortcuts) · `Passphrase` · `FirstRun` · `SmallWindow`.

## Repo state when this was written (velo 0.3.0) — read first

- **Panda CSS and Park UI are not installed yet.** Styling today is `src/styles.css` (~90 lines of CSS custom properties) plus the CodeMirror themes in `src/editortheme.ts` and `src/richmd.ts`. Adopting Panda + `@park-ui/panda-preset` means new dev dependencies, which AGENTS.md says to avoid. Decide that first. If you don't adopt them, `reference/velo-park.css` is a drop-in plain-CSS version of the same tokens and components. Map its variables onto the existing ones in `styles.css`: `--bg`, `--fg`, `--mute`, `--line`, `--sel`, `--warn`, `--accent`, `--missing`, `--row-h`.
- **Theme switching already matches the design.** `:root[data-theme="dark|light"]` plus a `prefers-color-scheme` fallback is the same System / Light / Dark model. Keep it; only the values change.
- **The editor is CodeMirror 6.** The class names in `panda/editor-styles.ts` (`.md-*`) describe what each element should look like. Map them onto the classes velo already emits:

  | Design | Existing |
  |---|---|
  | `.md-tag` | `.cm-rich-tag` |
  | `a.md-wikilink` | `.cm-rich-wikilink` |
  | `.is-missing` | `.cm-rich-missing` |
  | `a.md-link` | `.cm-rich-link` |
  | task checkbox | `.cm-rich-check` |
  | blockquote | `.cm-rich-quote` |
  | code | `.cm-rich-code` |
  | hr | `.cm-rich-hr` |
  | bullet | `.cm-rich-bullet` |

  Put CodeMirror styles in `EditorView.theme` / `baseTheme`. Plain-mode marks come from the `@lezer/highlight` tags (`processingInstruction`, `meta`) and get `velo.mark`. Preview keeps its `#preview` scope.
- **Row height.** The current `--row-h` formula (`font-size × 1.25 + 27px`) is replaced by the two fixed heights in `panda/font-scale.ts`.

## Before you start: check against the installed versions

- **`createPreset` signature.** Recent `@park-ui/panda-preset` releases take imported color objects; older ones take strings (`accentColor: 'indigo'`). `velo-preset.ts` uses the newer form, with the old one in a comment. Match `package.json`.
- **Token names.** The `velo.*` tokens use explicit hexes on purpose, so they don't depend on how a Park release names palette tokens. Once confirmed (e.g. `indigo.10`, `gray.11`), you may swap hexes for references.
- **Dark condition.** The example config sets `dark: '[data-theme=dark] &'`, and the app always writes `data-theme` (resolving "System" via `matchMedia`). This also drives Park's own `_dark` semantic tokens. If velo already toggles a `.dark` class, keep that and adapt the condition.
- **Park recipes as plain classes.** Park UI's recipes (button, iconButton, input, badge, dialog, field, select, table, tooltip, menu, kbd, tabs) are used as Panda recipe functions on native elements, e.g. `button({ variant: 'ghost', size: 'sm' })`. Don't pull in Ark UI components; they need React, Vue or Solid.

## Visual direction

- **Accent:** Radix Indigo. Used only for selection, links/wikilinks/#tags, focus ring, primary button, Preview pill. **Gray:** Radix Slate.
- **Fonts:** Inter (UI + writing), JetBrains Mono (code). Load both, or bundle them with the app.
- **Radii:** `l1` 4 px (kbd, inline tags, checkboxes) · `l2` 6 px (buttons, inputs, rows, segments) · 8–10 px (menus, dialogs) · `full` (tag chips).
- **Spacing:** Panda's 4 px scale. Header 48 px high, controls 32 px, title bar 48 px.
- **Surfaces:** editor and list = `velo.canvas` (white / slate.1); header, tag panel and first-run = `velo.chrome` (slate.2).

### Contrast (WCAG AA, computed)

| Pair | Light | Dark |
|---|---|---|
| Body text | 16.4:1 | 16.3:1 |
| Snippets, dates (`fgMuted`) | 5.9:1 | 9.1:1 |
| Markdown marks (`mark`) | 5.9:1 | 6.1:1 |
| Links, #tags (`accentText`) | 6.0:1 | 9.2:1 |
| Selected row title / snippet | 6.0 / 5.0:1 | 9.3 / 7.1:1 |
| Error text (`danger`) | 5.2:1 | 9.0:1 |
| Conflict banner | 10.5:1 | 13.0:1 |
| White on accent (buttons, chips on) | 5.2:1 | 5.2:1 |
| Focus ring vs canvas | 5.2:1 | 3.6:1 (non-text, ≥3:1) |

If you change a color, recheck. Light `slate.10` (`#80838d`) fails for small text, so don't use it for snippets or marks.

## Layout

**Header, left to right:** traffic lights (macOS overlay title bar) · search field (flex) · `#` tags toggle · Sort segmented (Recent / A→Z) · Edit-style segmented (Rich / Plain) · Preview indicator · separator · Lock · Lock all · Move to Trash · Settings.

**Vertical layout:** header → list → horizontal divider → title bar → editor.
**Horizontal layout:** header → [list | vertical divider | title bar + editor]. List min width 200 px, note min width 320 px.

**List rows** (fixed height, virtualized):
- Vertical layout = `compact`: title · snippet · date on one line; the title can take up to 48% of the width.
- Horizontal layout = `twoLine`: title + date, then the snippet.
- Locked rows: lock glyph + title only. In two-line mode the snippet line reads "Locked", so the height stays fixed.
- A "Loading…" row with a spinner sits at the end while the index is still loading.
- Empty results replace the list body: "No notes match "…"" · "Press ⇧↩ to create a note with that title" · "or Esc to clear the search".

## Font size scaling

One setting, 10–32 px, default 14. It scales the editor and the list; the header stays at 13 px. See `font-scale.ts`.

| Size | Editor (size / line) | Row, vertical | Row, horizontal | Title bar |
|---|---|---|---|---|
| 12 | 14 / 24 | 26 | 40 | 15 |
| 14 | 16 / 27 | 30 | 46 | 17 |
| 20 | 22 / 37 | 43 | 66 | 24 |

## Interaction states

- **Focus-visible** on every control: 2 px `velo.accent` outline, 2 px offset. List rows use a −2 px inset. Inputs use border + a 1 px ring in `accentBorder`.
- **Hover:** ghost buttons, icon buttons and menu items → `velo.muted`; rows and chips → `velo.subtle`.
- **Pressed toggles** (`aria-pressed=true`: tags button, overflow button) → `accentSubtleHover` bg + `accentText` icon.
- **Disabled:** 45% opacity, `not-allowed` cursor. Disabled menu items stay focusable for screen readers.
- **List selection** has two states:
  - search field or list active (`data-active="true"` on the list): solid `selection` with white text;
  - focus in the editor: `selectionIdle` (indigo.4) with normal text.
- **Search hint** at the right of the field: `⌘L` when empty · `↩ Open` when a row is highlighted · `⇧↩ Create` when no title matches exactly (both hints when there are matches). Matches are highlighted in titles and snippets (`searchMatch`).
- **Loading:** spinner + "Saving…", or "Indexing… 3,200 / 10,004" + a 64 px progress bar in the title bar; "Loading…" row at the end of the list.
- **Errors:** title-bar status in `danger` with an alert icon + Retry (outline, sm); field errors under the input (`aria-invalid` + `aria-describedby`).
- **Tooltips:** after 500 ms hover or on keyboard focus. Label + the live binding: ⌘⇧ glyphs on macOS, `Ctrl+Shift+…` on Windows/Linux. Read bindings from settings, never hard-code them.

## Components

- **Tag panel:** opens under the search field, on `velo.chrome`. Header line: "Tags · 2 selected · 214 notes", Clear (ghost sm), "⌘⇧T close". Chips wrap. Tab enters the group, ←/→ move, Space toggles, Esc closes and returns focus to search.
- **Filter line** (panel closed, filter active): 30 px `banner({ tone: 'filter' })`: "Filtered by **#work** **#idea** · Clear", with the note count on the right.
- **Title bar:** double-click or ⌘R swaps the title for an inline input in the same spot, with hint "↩ Rename · Esc Cancel". Long titles truncate before the status does; the status never wraps.
- **Conflict banner:** `banner({ tone: 'conflict' })` between the title bar and the editor: "This file changed on disk. Your edits were saved to <link to conflict note>" + dismiss ×. Stays until dismissed or the note changes.
- **Editor:** centered reading column, max 46em, line-height 1.7, size + 2 px.
  - Plain: all marks visible in `velo.mark`; headings, bold, italic and code are styled in place.
  - Rich: marks hidden except on the caret line; links and wikilinks in accent; a missing wikilink is red with a dashed underline; #tags are chips; tasks are real checkboxes; blockquote has a 3 px left bar; code blocks on `velo.subtle`; hr.
- **Preview:** same typography as Rich. Three cues: the header eye button becomes `previewPill`; a 30 px strip "Preview — read only · ⌘⇧P to edit" sits under the title bar; no caret. An empty note shows a centered watermark: "Empty note — press ⌘⇧P to edit".
- **Settings dialog** (native `<dialog>` + `showModal()`, 640 px):
  - Two tabs (Park `tabs` styling, `role=tablist`, ←/→ to switch).
  - **General:** Notes folder (read-only input + "Change…"), Layout segmented (+ ⌘⇧J hint), Theme segmented (System / Light / Dark), Font size (native number input, 10–32, "px" helper), Sort (native `<select>` with select-recipe styling).
  - **Keyboard shortcuts:** hint line + "Reset all". Table: Action | key-cap | Reset. Click a key-cap, then press keys; Esc cancels, ⌫ clears. Reset is disabled while the binding is the default; a blue dot marks a changed binding. A conflict turns the key-cap and the row red with "Already used by Forward" under the action name. The tab shows a red count badge.
  - Footer: "1 conflict — fix it to save" + Cancel / Save (⌘↩). Save is disabled while any conflict exists.
- **Passphrase dialog** (420 px, icon tile, title, one-line warning):
  - Create: "Lock "<note>"", passphrase + confirm, "Passphrases don't match", Cancel / Lock note. Lock all uses the same dialog, titled "Lock all notes".
  - Unlock: "Unlock "<note>"", one field, "Wrong passphrase — try again" (`role=alert`), Cancel / Unlock.
- **First run:** centered on `velo.chrome`: app mark, "Choose a notes folder", one sentence, primary lg button "Choose folder… ↩" focused by default, "You can change it later in Settings (⌘,)".
- **Overflow menu** (small windows only): plain DOM popover with Park `menu` styling. Arrow keys, Esc and typeahead work. Contents: Sort (radio items), Edit style (radio items), Lock note, Lock all, Move to Trash, each with its shortcut. Right-click row menus stay native.

## Small window (down to ~600×400)

| Window width | Header |
|---|---|
| ≥ 900 px | Full: labelled segments, separator, four icon buttons |
| 720–899 px | Segments go icon-only (`segmented({ iconOnly: true })`: clock / A→Z, type / code); separator drops; tooltips carry the labels |
| < 720 px | Sort, Edit style, Lock, Lock all and Trash fold into ⋯. Search, #, Preview, ⋯ and Settings stay. Search never goes below 180 px. All shortcuts keep working. |

Also below 720 px: the reading column padding drops to 20 px, the title-bar padding to 16 px, and the title truncates before the status.

## Keyboard map (defaults)

⌘L search · ⌘J / ⌘K back / forward · ⌘⇧P preview · ⌘⇧R rich/plain · ⌘⇧T tags · ⌘⇧J layout · ⌘R rename · ⌘⇧E lock · ⌥⌘E lock all · ⌘⌫ trash · ⌘, settings. Use Ctrl in place of ⌘ on Windows/Linux. In search: ↩ open, ⇧↩ create, ↑/↓ move the selection, Esc clear. Divider (focused): ↑/↓ or ←/→ move one row, Shift moves ten.

## Accessibility notes

- The list is `role="listbox"`, rows are `role="option"` with `aria-selected`, using a roving tabindex.
- The divider is `role="separator"` with `aria-orientation`, `aria-valuenow` and `tabindex="0"`.
- Segmented controls are `role="radiogroup"` / `role="radio"` + `aria-checked`.
- Toggles use `aria-pressed`; the tags button also sets `aria-expanded` + `aria-controls`.
- Icon-only buttons need an `aria-label` that includes the shortcut.
- Status text ("Saving…", "Indexing…") uses `role="status"`; errors use `role="alert"`.
