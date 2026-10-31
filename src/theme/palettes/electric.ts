import { defineSemanticTokens } from '@pandacss/dev'

// velo palette "Electric" — Electric blue on crisp white — sharp, fast, unmistakable.
// Same token names as src/theme/tokens/velo.ts, plus the six match tokens. Contrast is light / dark (WCAG 2.x);
// the full table is in design/palettes/README.md. Park UI mapping: gray → slate; accent → blue (custom electric 9–11; Radix blue.9 is too light for white text);
// green → grass → solid = velo.positive; red → red; default colorPalette: blue.
const c = (light: string, dark: string) => ({ value: { _light: light, _dark: dark } })

export const meta = { slug: 'electric', name: 'Electric', mood: 'Electric blue on crisp white — sharp, fast, unmistakable.' } as const

export const colors = defineSemanticTokens.colors({
  // surfaces
  canvas: c('#ffffff', '#0e1015'),
  chrome: c('#f6f7f9', '#15181f'),
  panel: c('#ffffff', '#191c24'),
  subtle: c('#f0f2f5', '#1c2029'),
  muted: c('#e7e9ee', '#232834'),
  segmentOn: c('#ffffff', '#2e3443'),

  // edges
  hairline: c('rgba(10,20,40,.10)', 'rgba(200,215,255,.09)'),
  highlight: c('rgba(255,255,255,.9)', 'rgba(255,255,255,.06)'),
  divider: c('#e1e4ea', '#262b37'),
  border: c('#d8dce4', '#2f3542'),
  inputBorder: c('#848b9a', '#636b7e'), // vs canvas 3.4:1 / 3.6:1
  grip: c('#848b9a', '#636b7e'), // vs canvas 3.4:1 / 3.6:1

  // text
  fg: c('#11151c', '#eef1f7'), // on canvas 18.3:1 / 16.8:1
  fgMuted: c('#5a6170', '#a7aebd'), // on canvas 6.2:1 / 8.5:1
  mark: c('#636a79', '#8f97a8'), // on canvas 5.4:1 / 6.5:1

  // accent
  accent: c('#2453ff', '#5b86ff'), // focus ring vs canvas 5.6:1 / 5.7:1
  accentHover: c('#1a44e6', '#7a9dff'),
  accentFg: c('#ffffff', '#0a1233'), // on accent 5.6:1 / 5.5:1
  accentText: c('#1f47e0', '#8eabff'), // links on canvas 6.9:1 / 8.5:1
  accentSubtle: c('#eaf0ff', '#17224a'),
  accentSubtleHover: c('#d9e3ff', '#1f2e63'),
  accentLine: c('#9db3ff', '#3a55b0'),
  accentBorder: c('#2453ff', '#5b86ff'), // vs canvas 5.6:1 / 5.7:1
  accentHalo: c('#ffe066', '#5c4a00'),

  // list selection
  selection: c('#2453ff', '#2f55e8'),
  selectionFg: c('#ffffff', '#ffffff'), // on selection 5.6:1 / 5.9:1
  selectionMuted: c('#e6ecff', '#dfe7ff'), // on selection 4.7:1 / 4.7:1
  selectionIdle: c('#e3eaff', '#1a2240'),

  // search match (NEW): one pair per row state; hovered rows use matchBg / matchFg
  matchBg: c('#ffd84d', '#5c4a00'),
  matchFg: c('#11151c', '#fff1b0'), // on matchBg 13.2:1 / 7.6:1
  matchOnSelectionBg: c('#ffe066', '#ffe066'),
  matchOnSelectionFg: c('#11151c', '#11151c'), // on its bg 14.0:1 / 14.0:1
  matchOnIdleBg: c('#ffcf2e', '#6b5600'),
  matchOnIdleFg: c('#11151c', '#fff1b0'), // on its bg 12.4:1 / 6.2:1

  // positive: primary action, done, update ready, Link it
  positive: c('#15803d', '#3ccf6e'),
  positiveHover: c('#116b33', '#5adb85'),
  positiveFg: c('#ffffff', '#06210f'), // on positive 5.0:1 / 8.4:1
  positiveText: c('#137337', '#4ad97a'), // on canvas 5.9:1 / 10.4:1
  positiveSubtle: c('#e7f6ec', '#10291a'),
  positiveBorder: c('#a6dbb8', '#1f5a34'),

  // danger: errors, overdue, missing wikilinks
  danger: c('#c41d29', '#ff6b74'), // on canvas 5.9:1 / 6.9:1
  dangerBorder: c('#ef3340', '#ff4d58'),
  dangerSubtle: c('#fdebec', '#3a1216'),

  // warning: conflict banner
  warningBg: c('#fff6d6', '#2d2410'),
  warningBorder: c('#f1d27a', '#5c4a16'),
  warningFg: c('#4a3510', '#ffe7a6'), // on warningBg 10.7:1 / 12.6:1

  // scrim
  overlay: c('rgba(10,15,30,.32)', 'rgba(0,2,10,.62)'),
})

// semanticTokens.shadows.veloPopover
export const popover = { value: { _light: '0 0 0 1px rgba(10,20,40,.07), 0 12px 32px rgba(10,20,40,.16)', _dark: '0 0 0 1px rgba(200,215,255,.08), 0 16px 40px rgba(0,2,10,.65)' } }
