import { defineSemanticTokens } from '@pandacss/dev'

// velo palette "Mist" — Periwinkle and mint on cool paper — calm for long writing sessions.
// Same token names as src/theme/tokens/velo.ts, plus the six match tokens. Contrast is light / dark (WCAG 2.x);
// the full table is in design/palettes/README.md. Park UI mapping: gray → slate; accent → iris;
// green → jade → solid = velo.positive; red → red; default colorPalette: iris.
const c = (light: string, dark: string) => ({ value: { _light: light, _dark: dark } })

export const meta = { slug: 'mist', name: 'Mist', mood: 'Periwinkle and mint on cool paper — calm for long writing sessions.' } as const

export const colors = defineSemanticTokens.colors({
  // surfaces
  canvas: c('#fcfcfe', '#121420'),
  chrome: c('#f4f5fa', '#181a28'),
  panel: c('#ffffff', '#1b1e2d'),
  subtle: c('#eef0f7', '#1e2132'),
  muted: c('#e6e8f2', '#262a3e'),
  segmentOn: c('#ffffff', '#30344c'),

  // edges
  hairline: c('rgba(40,50,110,.10)', 'rgba(200,210,255,.09)'),
  highlight: c('rgba(255,255,255,.8)', 'rgba(255,255,255,.06)'),
  divider: c('#dfe2ee', '#2a2e44'),
  border: c('#d6d9e8', '#33384f'),
  inputBorder: c('#878ca9', '#686e93'), // vs canvas 3.2:1 / 3.7:1
  grip: c('#878ca9', '#686e93'), // vs canvas 3.2:1 / 3.7:1

  // text
  fg: c('#1d2033', '#e8eaf6'), // on canvas 15.7:1 / 15.3:1
  fgMuted: c('#585d7c', '#a9aecb'), // on canvas 6.3:1 / 8.4:1
  mark: c('#62678a', '#9095ba'), // on canvas 5.4:1 / 6.3:1

  // accent
  accent: c('#5b5bd6', '#a5a8f5'), // focus ring vs canvas 5.2:1 / 8.3:1
  accentHover: c('#4f4fc4', '#b9bbff'),
  accentFg: c('#ffffff', '#151735'), // on accent 5.4:1 / 7.9:1
  accentText: c('#4c48b8', '#b4b7ff'), // links on canvas 7.0:1 / 9.7:1
  accentSubtle: c('#eef0ff', '#262a4d'),
  accentSubtleHover: c('#e0e3ff', '#30356a'),
  accentLine: c('#aeb3ee', '#5a5fa8'),
  accentBorder: c('#7b7ee0', '#8a8fe0'), // vs canvas 3.5:1 / 6.2:1
  accentHalo: c('#fff0b3', '#4f4518'),

  // list selection
  selection: c('#b9bdf5', '#3a3f78'),
  selectionFg: c('#1d2033', '#ffffff'), // on selection 8.9:1 / 9.7:1
  selectionMuted: c('#3d4266', '#d3d6f7'), // on selection 5.4:1 / 6.8:1
  selectionIdle: c('#eceefb', '#262a42'),

  // search match (NEW): one pair per row state; hovered rows use matchBg / matchFg
  matchBg: c('#ffe07a', '#5a4f1f'),
  matchFg: c('#1d2033', '#fff3c4'), // on matchBg 12.4:1 / 7.3:1
  matchOnSelectionBg: c('#fff6d2', '#ffe58a'),
  matchOnSelectionFg: c('#1d2033', '#1b1a10'), // on its bg 14.8:1 / 14.0:1
  matchOnIdleBg: c('#ffd95e', '#665a22'),
  matchOnIdleFg: c('#1d2033', '#fff3c4'), // on its bg 11.7:1 / 6.2:1

  // positive: primary action, done, update ready, Link it
  positive: c('#1d7f62', '#5fd3a6'),
  positiveHover: c('#17705a', '#7ee0b9'),
  positiveFg: c('#ffffff', '#0b2a20'), // on positive 4.9:1 / 8.3:1
  positiveText: c('#16735a', '#6fdcb1'), // on canvas 5.6:1 / 10.9:1
  positiveSubtle: c('#e3f5ee', '#15302a'),
  positiveBorder: c('#a9dcc9', '#245c4a'),

  // danger: errors, overdue, missing wikilinks
  danger: c('#cc2f45', '#ff8f99'), // on canvas 5.0:1 / 8.4:1
  dangerBorder: c('#e5484d', '#e5484d'),
  dangerSubtle: c('#fdecee', '#3b1520'),

  // warning: conflict banner
  warningBg: c('#fff7dc', '#2e2714'),
  warningBorder: c('#f0d68a', '#5a4a1f'),
  warningFg: c('#4b3a12', '#f5e3b0'), // on warningBg 10.2:1 / 11.6:1

  // scrim
  overlay: c('rgba(20,24,48,.30)', 'rgba(0,0,10,.6)'),
})

// semanticTokens.shadows.veloPopover
export const popover = { value: { _light: '0 0 0 1px rgba(40,50,110,.08), 0 12px 32px rgba(40,50,110,.16)', _dark: '0 0 0 1px rgba(200,210,255,.08), 0 16px 40px rgba(0,0,10,.6)' } }
