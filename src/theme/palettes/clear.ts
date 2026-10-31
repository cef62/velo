import { defineSemanticTokens } from '@pandacss/dev'

// velo palette "Clear" — Graphite and quiet grays; color only where it means something.
// Same token names as src/theme/tokens/velo.ts, plus the six match tokens. Contrast is light / dark (WCAG 2.x);
// the full table is in design/palettes/README.md. Park UI mapping: gray → gray (neutral); accent → gray (graphite: gray.11 / gray.12);
// green → green → solid = velo.positive; red → red; default colorPalette: gray.
const c = (light: string, dark: string) => ({ value: { _light: light, _dark: dark } })

export const meta = { slug: 'clear', name: 'Clear', mood: 'Graphite and quiet grays; color only where it means something.' } as const

export const colors = defineSemanticTokens.colors({
  // surfaces
  canvas: c('#ffffff', '#111111'),
  chrome: c('#f7f7f7', '#1c1c1c'),
  panel: c('#ffffff', '#1c1c1c'),
  subtle: c('#f0f0f0', '#222222'),
  muted: c('#e8e8e8', '#2a2a2a'),
  segmentOn: c('#ffffff', '#3a3a3a'),

  // edges
  hairline: c('rgba(0,0,0,.09)', 'rgba(255,255,255,.08)'),
  highlight: c('rgba(255,255,255,.85)', 'rgba(255,255,255,.07)'),
  divider: c('#e0e0e0', '#313131'),
  border: c('#d9d9d9', '#3a3a3a'),
  inputBorder: c('#8a8a8a', '#707070'), // vs canvas 3.5:1 / 3.8:1
  grip: c('#8a8a8a', '#707070'), // vs canvas 3.5:1 / 3.8:1

  // text
  fg: c('#202020', '#eeeeee'), // on canvas 16.3:1 / 16.3:1
  fgMuted: c('#646464', '#b4b4b4'), // on canvas 5.9:1 / 9.1:1
  mark: c('#646464', '#959595'), // on canvas 5.9:1 / 6.3:1

  // accent
  accent: c('#3b3b3b', '#d4d4d4'), // focus ring vs canvas 11.2:1 / 12.7:1
  accentHover: c('#2a2a2a', '#eeeeee'),
  accentFg: c('#ffffff', '#111111'), // on accent 11.2:1 / 12.7:1
  accentText: c('#202020', '#eeeeee'), // links on canvas 16.3:1 / 16.3:1
  accentSubtle: c('#f0f0f0', '#222222'),
  accentSubtleHover: c('#dcdcdc', '#3a3a3a'),
  accentLine: c('#a8a8a8', '#6a6a6a'),
  accentBorder: c('#7c7c7c', '#7b7b7b'), // vs canvas 4.2:1 / 4.5:1
  accentHalo: c('#d4d4d4', '#3d3d3d'),

  // list selection
  selection: c('#646464', '#5a5a5a'),
  selectionFg: c('#ffffff', '#ffffff'), // on selection 5.9:1 / 6.9:1
  selectionMuted: c('#ececec', '#dcdcdc'), // on selection 5.0:1 / 5.0:1
  selectionIdle: c('#e8e8e8', '#313131'),

  // search match (NEW): one pair per row state; hovered rows use matchBg / matchFg
  matchBg: c('#cccccc', '#4d4d4d'),
  matchFg: c('#111111', '#ffffff'), // on matchBg 11.8:1 / 8.5:1
  matchOnSelectionBg: c('#f2f2f2', '#eeeeee'),
  matchOnSelectionFg: c('#111111', '#111111'), // on its bg 16.9:1 / 16.3:1
  matchOnIdleBg: c('#bdbdbd', '#5e5e5e'),
  matchOnIdleFg: c('#111111', '#ffffff'), // on its bg 10.1:1 / 6.5:1

  // positive: primary action, done, update ready, Link it
  positive: c('#218358', '#3dd68c'),
  positiveHover: c('#1d754f', '#4fe39b'),
  positiveFg: c('#ffffff', '#0b2a1c'), // on positive 4.7:1 / 8.2:1
  positiveText: c('#18794e', '#3dd68c'), // on canvas 5.4:1 / 10.1:1
  positiveSubtle: c('#e9f6e9', '#132d21'),
  positiveBorder: c('#b2ddb5', '#20573e'),

  // danger: errors, overdue, missing wikilinks
  danger: c('#ce2c31', '#ff9592'), // on canvas 5.2:1 / 9.0:1
  dangerBorder: c('#e5484d', '#e5484d'),
  dangerSubtle: c('#feebec', '#3b1219'),

  // warning: conflict banner
  warningBg: c('#f0f0f0', '#222222'),
  warningBorder: c('#d9d9d9', '#3a3a3a'),
  warningFg: c('#202020', '#eeeeee'), // on warningBg 14.3:1 / 13.7:1

  // scrim
  overlay: c('rgba(20,20,20,.32)', 'rgba(0,0,0,.6)'),
})

// semanticTokens.shadows.veloPopover
export const popover = { value: { _light: '0 0 0 1px rgba(0,0,0,.06), 0 12px 32px rgba(0,0,0,.14)', _dark: '0 0 0 1px rgba(255,255,255,.07), 0 16px 40px rgba(0,0,0,.6)' } }
