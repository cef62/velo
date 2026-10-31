import { defineSemanticTokens } from '@pandacss/dev'

// velo semantic colors, "clear" (v2, design/park-ui/v2/README.md §12).
// Grays from Radix gray (neutral). The accent is graphite; color only carries meaning:
// red = errors / overdue / missing links, green = positive (primary action, done, update, Link it).
// Contrast (light / dark) checked with the WCAG formula; see design/park-ui/v2/README.md §12.
const c = (light: string, dark: string) => ({ value: { _light: light, _dark: dark } })

export const velo = defineSemanticTokens.colors({
  // surfaces
  canvas: c('#ffffff', '#111111'), // editor + list (white / gray.1)
  chrome: c('#f7f7f7', '#1c1c1c'), // header, pane bars, side panel, filters, first-run
  panel: c('#ffffff', '#1c1c1c'), // dialogs, menus, palette
  subtle: c('#f0f0f0', '#222222'), // row hover, segment track, code bg (gray.3)
  muted: c('#e8e8e8', '#2a2a2a'), // ghost hover, lines inside a region (gray.4)
  segmentOn: c('#ffffff', '#3a3a3a'),

  // edges: hairlines + a top highlight make surfaces read as clear glass
  hairline: c('rgba(0,0,0,.09)', 'rgba(255,255,255,.08)'), // NEW — window, segments, chips, pressed
  highlight: c('rgba(255,255,255,.85)', 'rgba(255,255,255,.07)'), // NEW — inset top highlight on chrome / pressed
  divider: c('#e0e0e0', '#313131'), // gray.5 — between regions
  border: c('#d9d9d9', '#3a3a3a'), // gray.6
  inputBorder: c('#cecece', '#484848'), // gray.7
  grip: c('#cecece', '#484848'),

  // text
  fg: c('#202020', '#eeeeee'), // 16.3:1 / 16.3:1
  fgMuted: c('#646464', '#b4b4b4'), // snippets, dates — 5.9:1 / 9.1:1
  mark: c('#646464', '#959595'), // markdown syntax marks — 5.9:1 / 6.3:1

  // graphite accent
  accent: c('#3b3b3b', '#d4d4d4'), // focus ring, caret, chip on, Preview segment — 11.2:1 / 12.7:1 vs canvas
  accentHover: c('#2a2a2a', '#eeeeee'),
  accentFg: c('#ffffff', '#111111'), // NEW — text on accent (was hard-coded white)
  accentText: c('#202020', '#eeeeee'), // links read by underline, not color
  accentSubtle: c('#f0f0f0', '#222222'), // inline #tag bg, search chip
  accentSubtleHover: c('#dcdcdc', '#3a3a3a'), // pressed toggles, selected pane tab
  accentLine: c('#bbbbbb', '#606060'), // link / wikilink underline
  accentBorder: c('#8d8d8d', '#7b7b7b'), // input focus, divider hover — 3.3:1 / 4.5:1 (non-text)
  accentHalo: c('#e0e0e0', '#313131'), // recording key-cap, search match bg (match is also bold)

  // list selection (graphite, like macOS Graphite accent)
  selection: c('#646464', '#5a5a5a'), // white text 5.9:1 / 6.9:1
  selectionFg: c('#ffffff', '#ffffff'),
  selectionMuted: c('#e8e8e8', '#d9d9d9'), // snippet/date on selection — 4.8:1 / 4.9:1
  selectionIdle: c('#e8e8e8', '#313131'), // selected, focus elsewhere — muted text 4.8:1 / 6.3:1

  // positive (NEW): primary action, done, update ready, Link it
  positive: c('#218358', '#3dd68c'), // solid bg
  positiveHover: c('#1d754f', '#4fe39b'),
  positiveFg: c('#ffffff', '#0b2a1c'), // text on positive — 4.7:1 / 8.2:1
  positiveText: c('#18794e', '#3dd68c'), // on canvas 5.4:1 / 10.1:1, on positiveSubtle 4.9:1 / 7.9:1
  positiveSubtle: c('#e9f6e9', '#132d21'),
  positiveBorder: c('#b2ddb5', '#20573e'),

  // danger (unchanged)
  danger: c('#ce2c31', '#ff9592'), // red.11 — errors, overdue, missing wikilinks
  dangerBorder: c('#e5484d', '#e5484d'), // red.9
  dangerSubtle: c('#feebec', '#3b1219'), // red.3

  // warning → neutral: the conflict banner is gray now (only errors are red)
  warningBg: c('#f0f0f0', '#222222'),
  warningBorder: c('#d9d9d9', '#3a3a3a'),
  warningFg: c('#202020', '#eeeeee'),

  overlay: c('rgba(20,20,20,.32)', 'rgba(0,0,0,.6)'),
})

// panda.config.ts › semanticTokens.shadows.veloPopover, neutral instead of blue-tinted:
export const veloPopoverClear = {
  value: {
    _light: '0 0 0 1px rgba(0,0,0,.06), 0 12px 32px rgba(0,0,0,.14)',
    _dark: '0 0 0 1px rgba(255,255,255,.07), 0 16px 40px rgba(0,0,0,.6)',
  },
}
