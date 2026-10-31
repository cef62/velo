import { defineSemanticTokens } from '@pandacss/dev'

// velo palette "High contrast" — Black, white and pure signals — every text pair at 7:1 or more.
// Same token names as src/theme/tokens/velo.ts, plus the six match tokens. Contrast is light / dark (WCAG 2.x);
// the full table is in design/palettes/README.md. Park UI mapping: gray → gray (neutral), endpoints pushed to #000 / #fff; accent → blue (custom deep 11–12);
// green → green (dark 11) → solid = velo.positive; red → red (dark 11); default colorPalette: gray.
const c = (light: string, dark: string) => ({ value: { _light: light, _dark: dark } })

export const meta = { slug: 'contrast', name: 'High contrast', mood: 'Black, white and pure signals — every text pair at 7:1 or more.' } as const

export const colors = defineSemanticTokens.colors({
  // surfaces
  canvas: c('#ffffff', '#000000'),
  chrome: c('#f2f2f2', '#0d0d0d'),
  panel: c('#ffffff', '#0d0d0d'),
  subtle: c('#ebebeb', '#1a1a1a'),
  muted: c('#e0e0e0', '#262626'),
  segmentOn: c('#ffffff', '#333333'),

  // edges
  hairline: c('rgba(0,0,0,.55)', 'rgba(255,255,255,.55)'),
  highlight: c('rgba(255,255,255,0)', 'rgba(255,255,255,0)'),
  divider: c('#767676', '#8a8a8a'),
  border: c('#595959', '#a6a6a6'),
  inputBorder: c('#2b2b2b', '#d9d9d9'), // vs canvas 14.2:1 / 14.9:1
  grip: c('#2b2b2b', '#d9d9d9'), // vs canvas 14.2:1 / 14.9:1

  // text
  fg: c('#000000', '#ffffff'), // on canvas 21.0:1 / 21.0:1
  fgMuted: c('#3d3d3d', '#d0d0d0'), // on canvas 10.9:1 / 13.6:1
  mark: c('#454545', '#c2c2c2'), // on canvas 9.6:1 / 11.8:1

  // accent
  accent: c('#0037c1', '#7fb2ff'), // focus ring vs canvas 9.1:1 / 9.7:1
  accentHover: c('#002a96', '#a3c8ff'),
  accentFg: c('#ffffff', '#000000'), // on accent 9.1:1 / 9.7:1
  accentText: c('#0037c1', '#8fbcff'), // links on canvas 9.1:1 / 10.8:1
  accentSubtle: c('#e6ecff', '#0d1f3d'),
  accentSubtleHover: c('#dfe6ff', '#10254a'),
  accentLine: c('#0037c1', '#8fbcff'),
  accentBorder: c('#0037c1', '#7fb2ff'), // vs canvas 9.1:1 / 9.7:1
  accentHalo: c('#ffe600', '#ffe600'),

  // list selection
  selection: c('#000000', '#ffffff'),
  selectionFg: c('#ffffff', '#000000'), // on selection 21.0:1 / 21.0:1
  selectionMuted: c('#e6e6e6', '#333333'), // on selection 16.8:1 / 12.6:1
  selectionIdle: c('#d1d1d1', '#3a3a3a'),

  // search match (NEW): one pair per row state; hovered rows use matchBg / matchFg
  matchBg: c('#ffe600', '#ffe600'),
  matchFg: c('#000000', '#000000'), // on matchBg 16.6:1 / 16.6:1
  matchOnSelectionBg: c('#ffe600', '#ffb300'),
  matchOnSelectionFg: c('#000000', '#000000'), // on its bg 16.6:1 / 11.7:1
  matchOnIdleBg: c('#ffe600', '#ffe600'),
  matchOnIdleFg: c('#000000', '#000000'), // on its bg 16.6:1 / 16.6:1

  // positive: primary action, done, update ready, Link it
  positive: c('#005c1c', '#5ee38a'),
  positiveHover: c('#004a17', '#85eba6'),
  positiveFg: c('#ffffff', '#000000'), // on positive 8.2:1 / 12.8:1
  positiveText: c('#005c1c', '#6ee896'), // on canvas 8.2:1 / 13.6:1
  positiveSubtle: c('#eef8f1', '#0a2614'),
  positiveBorder: c('#005c1c', '#5ee38a'),

  // danger: errors, overdue, missing wikilinks
  danger: c('#9e0010', '#ff8a94'), // on canvas 8.5:1 / 9.3:1
  dangerBorder: c('#9e0010', '#ff8a94'),
  dangerSubtle: c('#fff0f1', '#33080c'),

  // warning: conflict banner
  warningBg: c('#fff3b0', '#332b00'),
  warningBorder: c('#5c4a00', '#ffe600'),
  warningFg: c('#000000', '#ffffff'), // on warningBg 18.7:1 / 14.1:1

  // scrim
  overlay: c('rgba(0,0,0,.5)', 'rgba(0,0,0,.7)'),
})

// semanticTokens.shadows.veloPopover
export const popover = { value: { _light: '0 0 0 2px #000, 0 12px 32px rgba(0,0,0,.25)', _dark: '0 0 0 2px #fff, 0 16px 40px rgba(0,0,0,.8)' } }
