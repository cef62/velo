# velo palettes — Settings › Appearance

Six palettes. Each has the same tokens as `src/theme/tokens/velo.ts`, in light and dark. **Clear** stays the default.

- **Mockups:** design canvas https://claude.ai/artifact/LnAtMzFpUDstf8a6tkXo1k, page **Palettes**. "Main window, light and dark" shows every palette. "Settings › Appearance picker" shows the picker cards.
- **Token files:** `src/theme/palettes/<slug>.ts`, plus `index.ts`. Each exports `meta`, `colors` and `popover`.
- **Source of truth:** the values here and in the TS files come from one script, so they agree. Every pair below was computed with the WCAG 2.x formula.

| Slug | Name | Mood (picker line) |
|---|---|---|
| `clear` | Clear | Graphite and quiet grays; color only where it means something. |
| `mist` | Mist | Periwinkle and mint on cool paper — calm for long writing sessions. |
| `paper` | Paper | Peach, sand and rose on warm paper; a warm charcoal at night. |
| `electric` | Electric | Electric blue on crisp white — sharp, fast, unmistakable. |
| `reef` | Reef | Teal for where you are, coral for what you found — lively, never loud. |
| `contrast` | High contrast | Black, white and pure signals — every text pair at 7:1 or more. |

My pick for palette 6 is **High contrast**. Clear, Mist, Paper, Electric and Reef cover moods; nothing in the set served low vision, bright rooms or projectors. Sepia overlapped with Paper, and Forest would have fought green-as-positive.

## 1. Clear, refined: what was wrong and what changed

1. **Search match in the idle selection.** `searchMatch` keys off `[data-selected=true]` for both selected states and paints `velo.selectionFg` (white) on a white-24% wash. On the light idle row (`#e8e8e8`) that is white on near-white, about 1.2:1.
   - Fix: new tokens `matchOnIdleBg` / `matchOnIdleFg`, now 10.1:1 / 6.5:1.
2. **The same rule fails on the focused selection too.** White on the 24% wash over `#646464` blends to about `#898989`, which is 3.5:1.
   - Fix: `matchOnSelectionBg` / `matchOnSelectionFg`, an inverted pill (near-white with dark text), now 16.9:1 / 16.3:1.
   - It is also the most visible state: 5.3:1 against the selection fill.
3. **Input and chip outlines failed WCAG 1.4.11 (non-text contrast).** `inputBorder` `#cecece` on white is 1.6:1.
   - Fix: `#8a8a8a` light (3.5:1 on canvas, 3.2:1 on chrome) and `#707070` dark (3.8:1 / 3.4:1).
   - Use `inputBorder` for tag-chip outlines as well; today the chips use `border`. That's a one-line change in `tag-chip.ts`.
4. **Divider grip was 1.6:1.** `grip` now matches `inputBorder`.
5. **Small adjustments:** `accentBorder` light `#8d8d8d` → `#7c7c7c`, so it clears 3:1 on chrome as well as canvas. `selectionMuted` was raised slightly (4.8 → 5.0:1). `accentHalo` dark moved to `#3d3d3d` so the recording key-cap stays visible.

Everything else in Clear is unchanged.

## 2. The search-match fix in code

The palettes add six tokens:

- `matchBg` / `matchFg` — normal and hovered rows;
- `matchOnSelectionBg` / `matchOnSelectionFg` — the focused selected row;
- `matchOnIdleBg` / `matchOnIdleFg` — a selected row while focus is elsewhere.

The recipe needs to tell focused from idle. `NoteList` already puts `data-active` on the scroller when the list (or the search field) drives it, and `data-selected` on the selected row. So:

```ts
// src/theme/recipes/velo/search-match.ts
export const searchMatch = defineRecipe({
  className: 'searchMatch',
  base: {
    bg: 'velo.matchBg',
    color: 'velo.matchFg',
    fontWeight: '600',
    borderRadius: '2px',
    px: '1px',
    '[data-selected=true] &': { bg: 'velo.matchOnIdleBg', color: 'velo.matchOnIdleFg' }, // selected, focus elsewhere
    '[data-active=true] [data-selected=true] &': { bg: 'velo.matchOnSelectionBg', color: 'velo.matchOnSelectionFg' }, // focused selection (more specific, wins)
  },
})
```

Timeline, Tasks, Related and the palette also highlight matches. Wherever they draw a selection, they need the same two attributes: `data-active` on the list, `data-selected` on the row. Keep `accentHalo` for the recording key-cap only.

## 3. Park UI mapping

The `velo.*` tokens carry the exact values. The Radix scales back Park UI's own components: Button, Checkbox, Tabs, Badge and so on, through `colors.gray`, the default `colorPalette`, `green` and `red`.

- **`green.solid`:** keep today's remap to `velo.positive` in every palette.
- **"custom 9–11":** for these accents no Radix step meets the contrast rules. Override steps 9–11 of the named scale with the `velo.accent` / `accentHover` / `accentText` values.

| Palette | gray | accent (default `colorPalette`) | green (positive) | red (danger) |
|---|---|---|---|---|
| Clear | gray (neutral) | gray (graphite) | green | red |
| Mist | slate | iris | jade | red |
| Paper | sand | orange (custom 9–11) | grass, olive-leaning (custom 9–11) | crimson |
| Electric | slate | blue (custom 9–11; Radix blue.9 fails white text) | grass | red |
| Reef | gray (neutral) | teal, blue-leaning (custom 9–11); tomato tints for matches | grass, yellow-leaning | crimson |
| High contrast | gray, ends pushed to #000 / #fff | blue (custom 11–12) | green (custom dark 11) | red (custom dark 11) |

Colour files to add next to `src/theme/colors/neutral.ts`, generated from Radix the same way: slate, iris, jade, sand, orange, grass, crimson, blue and teal (tomato is optional).

## 4. Keeping positive and danger unmistakable

Hue angles of `accent` / `positive` / `danger`:

- **Clear:** the accent is neutral; positive 154°, danger 358°.
- **Mist:** accent 240°, positive 162° (jade, a mint green), danger 352°.
- **Paper:** accent 18° (peach-terracotta), positive 97° (olive green), danger 340° (crimson).
  - Danger was moved from red to crimson to get away from the peach, but the gap is still only 38°. This is the tightest pair in the set.
  - Danger is never colour alone: it always comes with an icon, a dashed underline or the overdue badge. If it still reads too close on your screen, move the accent toward amber (~30°).
- **Electric:** accent 227°, positive 142°, danger 356°.
- **Reef:** accent 185° (teal, deliberately cyan-leaning), positive 122° / 102° (grass, yellow-leaning, so teal can't pass for "done"), danger 341° (crimson).
  - Coral appears only as the pale search-match fill, never as text or a badge, so it doesn't compete with danger.
- **High contrast:** accent 223°, positive 138°, danger 354°.

## 5. Quiet surfaces

Every canvas stays white or near-white, or near-black, so there is never a tint behind the text.

- **Light canvases:** clear `#ffffff`, mist `#fcfcfe`, paper `#fffdf9`, electric `#ffffff`, reef `#ffffff`, contrast `#ffffff`.
- **Dark canvases:** `#111111`, `#121420`, `#171513`, `#0e1015`, `#101213`, `#000000`.
- Tints live in the chrome, selection, chips and highlights.

## 6. Wiring hint (you said you'll wire it; this is just the shape)

Panda resolves semantic tokens to CSS variables. One way to switch palettes at runtime:

1. Add a condition per palette, e.g. `palette_mist: '[data-palette=mist] &'`.
2. Merge the files into one `velo` token set: `{ value: { base: clear, _paletteMist: { _light, _dark }, … } }`.
3. Set `data-palette` on `<html>`.

Palette and Theme (System / Light / Dark) are then independent. The picker mock shows that as two controls.

## 7. Contrast tables

Every pair, light and dark. Text pairs need ≥ 4.5:1 and UI pairs ≥ 3:1. High contrast targets ≥ 7:1 for text and ≥ 4.5:1 for UI. All pass.

### Clear (`clear`)

*Graphite and quiet grays; color only where it means something.*

Targets: text ≥ 4.5:1, UI ≥ 3:1.

| Pair | Tokens | Light | Dark |
|---|---|---|---|
| Body on canvas | `fg` on `canvas` | 16.29 | 16.28 |
| Body on chrome | `fg` on `chrome` | 15.21 | 14.69 |
| Body on panel | `fg` on `panel` | 16.29 | 14.69 |
| Body on hovered row | `fg` on `subtle` | 14.30 | 13.71 |
| Body on idle selection | `fg` on `selectionIdle` | 13.30 | 11.21 |
| Pressed toggle text | `fg` on `accentSubtleHover` | 11.88 | 9.80 |
| Muted on canvas | `fgMuted` on `canvas` | 5.92 | 9.11 |
| Muted on chrome | `fgMuted` on `chrome` | 5.52 | 8.22 |
| Muted on hovered row | `fgMuted` on `subtle` | 5.19 | 7.67 |
| Muted on idle selection | `fgMuted` on `selectionIdle` | 4.83 | 6.27 |
| Markdown marks | `mark` on `canvas` | 5.92 | 6.30 |
| Links | `accentText` on `canvas` | 16.29 | 16.28 |
| #tag / search chip | `accentText` on `accentSubtle` | 14.30 | 13.71 |
| Selected pane tab | `accentText` on `accentSubtleHover` | 11.88 | 9.80 |
| Text on accent | `accentFg` on `accent` | 11.20 | 12.74 |
| Text on accent, hover | `accentFg` on `accentHover` | 14.35 | 16.28 |
| Selected row title | `selectionFg` on `selection` | 5.92 | 6.90 |
| Selected row snippet/date | `selectionMuted` on `selection` | 5.01 | 5.03 |
| Match, normal row | `matchFg` on `matchBg` | 11.76 | 8.45 |
| Match, focused selection | `matchOnSelectionFg` on `matchOnSelectionBg` | 16.87 | 16.28 |
| Match, idle selection | `matchOnIdleFg` on `matchOnIdleBg` | 10.05 | 6.48 |
| Primary button | `positiveFg` on `positive` | 4.72 | 8.22 |
| Primary button, hover | `positiveFg` on `positiveHover` | 5.66 | 9.39 |
| Positive text | `positiveText` on `canvas` | 5.41 | 10.07 |
| Positive on subtle | `positiveText` on `positiveSubtle` | 4.85 | 7.86 |
| Danger text | `danger` on `canvas` | 5.21 | 8.96 |
| Danger on chrome | `danger` on `chrome` | 4.87 | 8.09 |
| Overdue badge | `danger` on `dangerSubtle` | 4.54 | 7.75 |
| Conflict banner | `warningFg` on `warningBg` | 14.30 | 13.71 |
| Input / chip outline on canvas (UI) | `inputBorder` on `canvas` | 3.45 | 3.81 |
| Input / chip outline on chrome (UI) | `inputBorder` on `chrome` | 3.22 | 3.44 |
| Focus ring on canvas (UI) | `accent` on `canvas` | 11.20 | 12.74 |
| Focus ring on chrome (UI) | `accent` on `chrome` | 10.46 | 11.50 |
| Input focus border (UI) | `accentBorder` on `canvas` | 4.17 | 4.46 |
| Divider grip (UI) | `grip` on `canvas` | 3.45 | 3.81 |
| Active chip fill (UI) | `accent` on `canvas` | 11.20 | 12.74 |
| Primary button edge (UI) | `positive` on `canvas` | 4.72 | 10.07 |
| Done check (UI) | `positive` on `canvas` | 4.72 | 10.07 |

Highlight visibility (luminance ratio between the match and its row; not a WCAG criterion — matches are also bold and differ in hue):

| Pair | Light | Dark |
|---|---|---|
| Match vs normal row | 1.61 | 2.23 |
| Match vs hovered row | 1.41 | 1.88 |
| Match vs focused selection | 5.29 | 5.94 |
| Match vs idle selection | 1.53 | 2.01 |
| Focused vs idle selection | 4.83 | 1.89 |

Hue separation — light: accent neutral, positive 154°, danger 358°; dark: accent neutral, positive 151°, danger 2°

### Mist (`mist`)

*Periwinkle and mint on cool paper — calm for long writing sessions.*

Targets: text ≥ 4.5:1, UI ≥ 3:1.

| Pair | Tokens | Light | Dark |
|---|---|---|---|
| Body on canvas | `fg` on `canvas` | 15.68 | 15.29 |
| Body on chrome | `fg` on `chrome` | 14.76 | 14.40 |
| Body on panel | `fg` on `panel` | 16.07 | 13.80 |
| Body on hovered row | `fg` on `subtle` | 14.11 | 13.29 |
| Body on idle selection | `fg` on `selectionIdle` | 13.92 | 11.75 |
| Pressed toggle text | `fg` on `accentSubtleHover` | 12.71 | 9.51 |
| Muted on canvas | `fgMuted` on `canvas` | 6.26 | 8.38 |
| Muted on chrome | `fgMuted` on `chrome` | 5.90 | 7.89 |
| Muted on hovered row | `fgMuted` on `subtle` | 5.64 | 7.28 |
| Muted on idle selection | `fgMuted` on `selectionIdle` | 5.56 | 6.44 |
| Markdown marks | `mark` on `canvas` | 5.36 | 6.27 |
| Links | `accentText` on `canvas` | 7.00 | 9.73 |
| #tag / search chip | `accentText` on `accentSubtle` | 6.34 | 7.34 |
| Selected pane tab | `accentText` on `accentSubtleHover` | 5.67 | 6.05 |
| Text on accent | `accentFg` on `accent` | 5.37 | 7.89 |
| Text on accent, hover | `accentFg` on `accentHover` | 6.47 | 9.63 |
| Selected row title | `selectionFg` on `selection` | 8.92 | 9.71 |
| Selected row snippet/date | `selectionMuted` on `selection` | 5.37 | 6.81 |
| Match, normal row | `matchFg` on `matchBg` | 12.39 | 7.33 |
| Match, focused selection | `matchOnSelectionFg` on `matchOnSelectionBg` | 14.82 | 14.00 |
| Match, idle selection | `matchOnIdleFg` on `matchOnIdleBg` | 11.74 | 6.19 |
| Primary button | `positiveFg` on `positive` | 4.92 | 8.31 |
| Primary button, hover | `positiveFg` on `positiveHover` | 6.00 | 9.70 |
| Positive text | `positiveText` on `canvas` | 5.64 | 10.94 |
| Positive on subtle | `positiveText` on `positiveSubtle` | 5.11 | 8.43 |
| Danger text | `danger` on `canvas` | 5.05 | 8.41 |
| Danger on chrome | `danger` on `chrome` | 4.75 | 7.92 |
| Overdue badge | `danger` on `dangerSubtle` | 4.53 | 7.34 |
| Conflict banner | `warningFg` on `warningBg` | 10.24 | 11.65 |
| Input / chip outline on canvas (UI) | `inputBorder` on `canvas` | 3.23 | 3.70 |
| Input / chip outline on chrome (UI) | `inputBorder` on `chrome` | 3.04 | 3.48 |
| Focus ring on canvas (UI) | `accent` on `canvas` | 5.24 | 8.30 |
| Focus ring on chrome (UI) | `accent` on `chrome` | 4.93 | 7.82 |
| Input focus border (UI) | `accentBorder` on `canvas` | 3.47 | 6.18 |
| Divider grip (UI) | `grip` on `canvas` | 3.23 | 3.70 |
| Active chip fill (UI) | `accent` on `canvas` | 5.24 | 8.30 |
| Primary button edge (UI) | `positive` on `canvas` | 4.81 | 9.90 |
| Done check (UI) | `positive` on `canvas` | 4.81 | 9.90 |

Highlight visibility (luminance ratio between the match and its row; not a WCAG criterion — matches are also bold and differ in hue):

| Pair | Light | Dark |
|---|---|---|
| Match vs normal row | 1.27 | 2.24 |
| Match vs hovered row | 1.14 | 1.95 |
| Match vs focused selection | 1.66 | 7.78 |
| Match vs idle selection | 1.19 | 2.04 |
| Focused vs idle selection | 1.56 | 1.45 |

Hue separation — light: accent 240°, positive 162°, danger 352° → accent↔positive 78°, accent↔danger 112°; dark: accent 238°, positive 157°, danger 355° → accent↔positive 81°, accent↔danger 117°

### Paper (`paper`)

*Peach, sand and rose on warm paper; a warm charcoal at night.*

Targets: text ≥ 4.5:1, UI ≥ 3:1.

| Pair | Tokens | Light | Dark |
|---|---|---|---|
| Body on canvas | `fg` on `canvas` | 15.02 | 14.98 |
| Body on chrome | `fg` on `chrome` | 13.70 | 14.10 |
| Body on panel | `fg` on `panel` | 15.02 | 13.66 |
| Body on hovered row | `fg` on `subtle` | 13.01 | 13.15 |
| Body on idle selection | `fg` on `selectionIdle` | 13.29 | 11.97 |
| Pressed toggle text | `fg` on `accentSubtleHover` | 11.64 | 9.54 |
| Muted on canvas | `fgMuted` on `canvas` | 6.38 | 8.74 |
| Muted on chrome | `fgMuted` on `chrome` | 5.81 | 8.22 |
| Muted on hovered row | `fgMuted` on `subtle` | 5.52 | 7.67 |
| Muted on idle selection | `fgMuted` on `selectionIdle` | 5.64 | 6.98 |
| Markdown marks | `mark` on `canvas` | 5.39 | 6.08 |
| Links | `accentText` on `canvas` | 6.50 | 9.91 |
| #tag / search chip | `accentText` on `accentSubtle` | 5.64 | 7.46 |
| Selected pane tab | `accentText` on `accentSubtleHover` | 5.04 | 6.31 |
| Text on accent | `accentFg` on `accent` | 5.10 | 8.46 |
| Text on accent, hover | `accentFg` on `accentHover` | 6.20 | 9.95 |
| Selected row title | `selectionFg` on `selection` | 9.08 | 9.69 |
| Selected row snippet/date | `selectionMuted` on `selection` | 6.09 | 7.04 |
| Match, normal row | `matchFg` on `matchBg` | 10.77 | 7.10 |
| Match, focused selection | `matchOnSelectionFg` on `matchOnSelectionBg` | 13.84 | 12.07 |
| Match, idle selection | `matchOnIdleFg` on `matchOnIdleBg` | 9.98 | 6.05 |
| Primary button | `positiveFg` on `positive` | 5.11 | 8.16 |
| Primary button, hover | `positiveFg` on `positiveHover` | 6.26 | 9.48 |
| Positive text | `positiveText` on `canvas` | 5.99 | 10.67 |
| Positive on subtle | `positiveText` on `positiveSubtle` | 5.37 | 8.13 |
| Danger text | `danger` on `canvas` | 5.95 | 8.51 |
| Danger on chrome | `danger` on `chrome` | 5.42 | 8.01 |
| Overdue badge | `danger` on `dangerSubtle` | 5.16 | 7.33 |
| Conflict banner | `warningFg` on `warningBg` | 13.01 | 13.15 |
| Input / chip outline on canvas (UI) | `inputBorder` on `canvas` | 3.48 | 3.67 |
| Input / chip outline on chrome (UI) | `inputBorder` on `chrome` | 3.17 | 3.45 |
| Focus ring on canvas (UI) | `accent` on `canvas` | 5.02 | 9.00 |
| Focus ring on chrome (UI) | `accent` on `chrome` | 4.57 | 8.47 |
| Input focus border (UI) | `accentBorder` on `canvas` | 3.62 | 6.17 |
| Divider grip (UI) | `grip` on `canvas` | 3.48 | 3.67 |
| Active chip fill (UI) | `accent` on `canvas` | 5.02 | 9.00 |
| Primary button edge (UI) | `positive` on `canvas` | 5.03 | 9.77 |
| Done check (UI) | `positive` on `canvas` | 5.03 | 9.77 |

Highlight visibility (luminance ratio between the match and its row; not a WCAG criterion — matches are also bold and differ in hue):

| Pair | Light | Dark |
|---|---|---|
| Match vs normal row | 1.39 | 2.14 |
| Match vs hovered row | 1.21 | 1.88 |
| Match vs focused selection | 1.52 | 7.66 |
| Match vs idle selection | 1.33 | 2.01 |
| Focused vs idle selection | 1.46 | 1.50 |

Hue separation — light: accent 18°, positive 97°, danger 340° → accent↔positive 79°, accent↔danger 38°; dark: accent 21°, positive 90°, danger 342° → accent↔positive 68°, accent↔danger 39°

### Electric (`electric`)

*Electric blue on crisp white — sharp, fast, unmistakable.*

Targets: text ≥ 4.5:1, UI ≥ 3:1.

| Pair | Tokens | Light | Dark |
|---|---|---|---|
| Body on canvas | `fg` on `canvas` | 18.29 | 16.82 |
| Body on chrome | `fg` on `chrome` | 17.07 | 15.70 |
| Body on panel | `fg` on `panel` | 18.29 | 15.05 |
| Body on hovered row | `fg` on `subtle` | 16.31 | 14.41 |
| Body on idle selection | `fg` on `selectionIdle` | 15.23 | 13.78 |
| Pressed toggle text | `fg` on `accentSubtleHover` | 14.27 | 11.39 |
| Muted on canvas | `fgMuted` on `canvas` | 6.22 | 8.55 |
| Muted on chrome | `fgMuted` on `chrome` | 5.80 | 7.98 |
| Muted on hovered row | `fgMuted` on `subtle` | 5.54 | 7.32 |
| Muted on idle selection | `fgMuted` on `selectionIdle` | 5.17 | 7.00 |
| Markdown marks | `mark` on `canvas` | 5.43 | 6.49 |
| Links | `accentText` on `canvas` | 6.92 | 8.53 |
| #tag / search chip | `accentText` on `accentSubtle` | 6.06 | 6.91 |
| Selected pane tab | `accentText` on `accentSubtleHover` | 5.40 | 5.78 |
| Text on accent | `accentFg` on `accent` | 5.59 | 5.49 |
| Text on accent, hover | `accentFg` on `accentHover` | 6.97 | 7.06 |
| Selected row title | `selectionFg` on `selection` | 5.59 | 5.86 |
| Selected row snippet/date | `selectionMuted` on `selection` | 4.74 | 4.74 |
| Match, normal row | `matchFg` on `matchBg` | 13.23 | 7.58 |
| Match, focused selection | `matchOnSelectionFg` on `matchOnSelectionBg` | 14.03 | 14.03 |
| Match, idle selection | `matchOnIdleFg` on `matchOnIdleBg` | 12.39 | 6.24 |
| Primary button | `positiveFg` on `positive` | 5.02 | 8.39 |
| Primary button, hover | `positiveFg` on `positiveHover` | 6.61 | 9.66 |
| Positive text | `positiveText` on `canvas` | 5.94 | 10.42 |
| Positive on subtle | `positiveText` on `positiveSubtle` | 5.32 | 8.49 |
| Danger text | `danger` on `canvas` | 5.91 | 6.89 |
| Danger on chrome | `danger` on `chrome` | 5.51 | 6.43 |
| Overdue badge | `danger` on `dangerSubtle` | 5.14 | 5.95 |
| Conflict banner | `warningFg` on `warningBg` | 10.73 | 12.57 |
| Input / chip outline on canvas (UI) | `inputBorder` on `canvas` | 3.42 | 3.57 |
| Input / chip outline on chrome (UI) | `inputBorder` on `chrome` | 3.19 | 3.33 |
| Focus ring on canvas (UI) | `accent` on `canvas` | 5.59 | 5.71 |
| Focus ring on chrome (UI) | `accent` on `chrome` | 5.22 | 5.33 |
| Input focus border (UI) | `accentBorder` on `canvas` | 5.59 | 5.71 |
| Divider grip (UI) | `grip` on `canvas` | 3.42 | 3.57 |
| Active chip fill (UI) | `accent` on `canvas` | 5.59 | 5.71 |
| Primary button edge (UI) | `positive` on `canvas` | 5.02 | 9.37 |
| Done check (UI) | `positive` on `canvas` | 5.02 | 9.37 |

Highlight visibility (luminance ratio between the match and its row; not a WCAG criterion — matches are also bold and differ in hue):

| Pair | Light | Dark |
|---|---|---|
| Match vs normal row | 1.38 | 2.21 |
| Match vs hovered row | 1.23 | 1.89 |
| Match vs focused selection | 4.29 | 4.49 |
| Match vs idle selection | 1.23 | 2.20 |
| Focused vs idle selection | 4.65 | 2.66 |

Hue separation — light: accent 227°, positive 142°, danger 356° → accent↔positive 85°, accent↔danger 129°; dark: accent 224°, positive 140°, danger 356° → accent↔positive 84°, accent↔danger 132°

### Reef (`reef`)

*Teal for where you are, coral for what you found — lively, never loud.*

Targets: text ≥ 4.5:1, UI ≥ 3:1.

| Pair | Tokens | Light | Dark |
|---|---|---|---|
| Body on canvas | `fg` on `canvas` | 17.61 | 16.44 |
| Body on chrome | `fg` on `chrome` | 16.45 | 15.43 |
| Body on panel | `fg` on `panel` | 17.61 | 14.79 |
| Body on hovered row | `fg` on `subtle` | 15.71 | 13.99 |
| Body on idle selection | `fg` on `selectionIdle` | 15.43 | 12.88 |
| Pressed toggle text | `fg` on `accentSubtleHover` | 14.31 | 10.89 |
| Muted on canvas | `fgMuted` on `canvas` | 6.22 | 8.62 |
| Muted on chrome | `fgMuted` on `chrome` | 5.81 | 8.09 |
| Muted on hovered row | `fgMuted` on `subtle` | 5.55 | 7.34 |
| Muted on idle selection | `fgMuted` on `selectionIdle` | 5.45 | 6.75 |
| Markdown marks | `mark` on `canvas` | 5.43 | 6.41 |
| Links | `accentText` on `canvas` | 5.82 | 10.57 |
| #tag / search chip | `accentText` on `accentSubtle` | 5.16 | 8.29 |
| Selected pane tab | `accentText` on `accentSubtleHover` | 4.73 | 7.00 |
| Text on accent | `accentFg` on `accent` | 4.95 | 7.80 |
| Text on accent, hover | `accentFg` on `accentHover` | 6.15 | 8.96 |
| Selected row title | `selectionFg` on `selection` | 5.98 | 7.37 |
| Selected row snippet/date | `selectionMuted` on `selection` | 5.18 | 6.14 |
| Match, normal row | `matchFg` on `matchBg` | 12.54 | 9.55 |
| Match, focused selection | `matchOnSelectionFg` on `matchOnSelectionBg` | 13.20 | 11.12 |
| Match, idle selection | `matchOnIdleFg` on `matchOnIdleBg` | 11.17 | 9.55 |
| Primary button | `positiveFg` on `positive` | 5.12 | 7.63 |
| Primary button, hover | `positiveFg` on `positiveHover` | 6.51 | 9.01 |
| Positive text | `positiveText` on `canvas` | 6.07 | 9.71 |
| Positive on subtle | `positiveText` on `positiveSubtle` | 5.41 | 7.83 |
| Danger text | `danger` on `canvas` | 5.69 | 7.65 |
| Danger on chrome | `danger` on `chrome` | 5.31 | 7.18 |
| Overdue badge | `danger` on `dangerSubtle` | 4.86 | 6.51 |
| Conflict banner | `warningFg` on `warningBg` | 10.66 | 12.57 |
| Input / chip outline on canvas (UI) | `inputBorder` on `canvas` | 3.46 | 3.46 |
| Input / chip outline on chrome (UI) | `inputBorder` on `chrome` | 3.23 | 3.24 |
| Focus ring on canvas (UI) | `accent` on `canvas` | 4.95 | 8.91 |
| Focus ring on chrome (UI) | `accent` on `chrome` | 4.62 | 8.36 |
| Input focus border (UI) | `accentBorder` on `canvas` | 4.95 | 8.91 |
| Divider grip (UI) | `grip` on `canvas` | 3.46 | 3.46 |
| Active chip fill (UI) | `accent` on `canvas` | 4.95 | 8.91 |
| Primary button edge (UI) | `positive` on `canvas` | 5.12 | 8.74 |
| Done check (UI) | `positive` on `canvas` | 5.12 | 8.74 |

Highlight visibility (luminance ratio between the match and its row; not a WCAG criterion — matches are also bold and differ in hue):

| Pair | Light | Dark |
|---|---|---|
| Match vs normal row | 1.40 | 9.44 |
| Match vs hovered row | 1.25 | 8.03 |
| Match vs focused selection | 4.48 | 4.32 |
| Match vs idle selection | 1.38 | 7.40 |
| Focused vs idle selection | 5.24 | 2.00 |

Hue separation — light: accent 185°, positive 122°, danger 341° → accent↔positive 63°, accent↔danger 156°; dark: accent 183°, positive 102°, danger 342° → accent↔positive 81°, accent↔danger 159°

### High contrast (`contrast`)

*Black, white and pure signals — every text pair at 7:1 or more.*

Targets: text ≥ 7:1, UI ≥ 4.5:1.

| Pair | Tokens | Light | Dark |
|---|---|---|---|
| Body on canvas | `fg` on `canvas` | 21.00 | 21.00 |
| Body on chrome | `fg` on `chrome` | 18.76 | 19.44 |
| Body on panel | `fg` on `panel` | 21.00 | 19.44 |
| Body on hovered row | `fg` on `subtle` | 17.62 | 17.40 |
| Body on idle selection | `fg` on `selectionIdle` | 13.75 | 11.37 |
| Pressed toggle text | `fg` on `accentSubtleHover` | 16.90 | 15.16 |
| Muted on canvas | `fgMuted` on `canvas` | 10.86 | 13.62 |
| Muted on chrome | `fgMuted` on `chrome` | 9.70 | 12.60 |
| Muted on hovered row | `fgMuted` on `subtle` | 9.11 | 11.28 |
| Muted on idle selection | `fgMuted` on `selectionIdle` | 7.11 | 7.37 |
| Markdown marks | `mark` on `canvas` | 9.59 | 11.79 |
| Links | `accentText` on `canvas` | 9.07 | 10.81 |
| #tag / search chip | `accentText` on `accentSubtle` | 7.69 | 8.44 |
| Selected pane tab | `accentText` on `accentSubtleHover` | 7.30 | 7.80 |
| Text on accent | `accentFg` on `accent` | 9.07 | 9.71 |
| Text on accent, hover | `accentFg` on `accentHover` | 11.85 | 12.26 |
| Selected row title | `selectionFg` on `selection` | 21.00 | 21.00 |
| Selected row snippet/date | `selectionMuted` on `selection` | 16.83 | 12.63 |
| Match, normal row | `matchFg` on `matchBg` | 16.57 | 16.57 |
| Match, focused selection | `matchOnSelectionFg` on `matchOnSelectionBg` | 16.57 | 11.70 |
| Match, idle selection | `matchOnIdleFg` on `matchOnIdleBg` | 16.57 | 16.57 |
| Primary button | `positiveFg` on `positive` | 8.24 | 12.83 |
| Primary button, hover | `positiveFg` on `positiveHover` | 10.54 | 14.43 |
| Positive text | `positiveText` on `canvas` | 8.24 | 13.65 |
| Positive on subtle | `positiveText` on `positiveSubtle` | 7.59 | 10.49 |
| Danger text | `danger` on `canvas` | 8.53 | 9.32 |
| Danger on chrome | `danger` on `chrome` | 7.62 | 8.62 |
| Overdue badge | `danger` on `dangerSubtle` | 7.71 | 7.89 |
| Conflict banner | `warningFg` on `warningBg` | 18.70 | 14.13 |
| Input / chip outline on canvas (UI) | `inputBorder` on `canvas` | 14.16 | 14.88 |
| Input / chip outline on chrome (UI) | `inputBorder` on `chrome` | 12.65 | 13.77 |
| Focus ring on canvas (UI) | `accent` on `canvas` | 9.07 | 9.71 |
| Focus ring on chrome (UI) | `accent` on `chrome` | 8.10 | 8.99 |
| Input focus border (UI) | `accentBorder` on `canvas` | 9.07 | 9.71 |
| Divider grip (UI) | `grip` on `canvas` | 14.16 | 14.88 |
| Active chip fill (UI) | `accent` on `canvas` | 9.07 | 9.71 |
| Primary button edge (UI) | `positive` on `canvas` | 8.24 | 12.83 |
| Done check (UI) | `positive` on `canvas` | 8.24 | 12.83 |

Highlight visibility (luminance ratio between the match and its row; not a WCAG criterion — matches are also bold and differ in hue):

| Pair | Light | Dark |
|---|---|---|
| Match vs normal row | 1.27 | 16.57 |
| Match vs hovered row | 1.06 | 13.73 |
| Match vs focused selection | 16.57 | 1.79 |
| Match vs idle selection | 1.20 | 8.98 |
| Focused vs idle selection | 13.75 | 11.37 |

Hue separation — light: accent 223°, positive 138°, danger 354° → accent↔positive 85°, accent↔danger 131°; dark: accent 216°, positive 140°, danger 355° → accent↔positive 76°, accent↔danger 139°
