import { defineSemanticTokens } from '@pandacss/dev'

// velo palette "Reef" — Teal for where you are, coral for what you found — lively, never loud.
// Same token names as src/theme/tokens/velo.ts, plus the six match tokens. Contrast is light / dark (WCAG 2.x);
// the full table is in design/palettes/README.md. Park UI mapping: gray → gray (neutral); accent → cyan / teal (custom 9–11, blue-leaning so it can't pass for green) + tomato tints for matches;
// green → grass (yellow-leaning) → solid = velo.positive; red → crimson; default colorPalette: teal.
const c = (light: string, dark: string) => ({ value: { _light: light, _dark: dark } })

export const meta = { slug: 'reef', name: 'Reef', mood: 'Teal for where you are, coral for what you found — lively, never loud.' } as const

export const colors = defineSemanticTokens.colors({
  // surfaces
  canvas: c('#ffffff', '#101213'),
  chrome: c('#f7f7f8', '#17191b'),
  panel: c('#ffffff', '#1b1d20'),
  subtle: c('#f1f2f3', '#1f2225'),
  muted: c('#e8e9eb', '#26292d'),
  segmentOn: c('#ffffff', '#33373c'),

  // edges
  hairline: c('rgba(0,0,0,.09)', 'rgba(255,255,255,.08)'),
  highlight: c('rgba(255,255,255,.85)', 'rgba(255,255,255,.06)'),
  divider: c('#e2e3e6', '#2a2d31'),
  border: c('#d9dadd', '#33363b'),
  inputBorder: c('#878a91', '#666a71'), // vs canvas 3.5:1 / 3.5:1
  grip: c('#878a91', '#666a71'), // vs canvas 3.5:1 / 3.5:1

  // text
  fg: c('#17191c', '#eef0f2'), // on canvas 17.6:1 / 16.4:1
  fgMuted: c('#5d6168', '#acb0b6'), // on canvas 6.2:1 / 8.6:1
  mark: c('#666a71', '#93979e'), // on canvas 5.4:1 / 6.4:1

  // accent
  accent: c('#0b7c86', '#3cc4cc'), // focus ring vs canvas 5.0:1 / 8.9:1
  accentHover: c('#086c75', '#5ad0d7'),
  accentFg: c('#ffffff', '#062326'), // on accent 5.0:1 / 7.8:1
  accentText: c('#09707a', '#5fd3da'), // links on canvas 5.8:1 / 10.6:1
  accentSubtle: c('#e2f5f5', '#122c2e'),
  accentSubtleHover: c('#cdeeee', '#18393b'),
  accentLine: c('#86c9cd', '#2c6d72'),
  accentBorder: c('#0b7c86', '#3cc4cc'), // vs canvas 5.0:1 / 8.9:1
  accentHalo: c('#ffd9cf', '#4a2a22'),

  // list selection
  selection: c('#0a6e77', '#0f5f66'),
  selectionFg: c('#ffffff', '#ffffff'), // on selection 6.0:1 / 7.4:1
  selectionMuted: c('#dcf3f4', '#d2f0f2'), // on selection 5.2:1 / 6.1:1
  selectionIdle: c('#e3f3f4', '#1a2b2d'),

  // search match (NEW): one pair per row state; hovered rows use matchBg / matchFg
  matchBg: c('#ffcfc2', '#ff9f86'),
  matchFg: c('#17191c', '#1a0d09'), // on matchBg 12.5:1 / 9.5:1
  matchOnSelectionBg: c('#ffd6cb', '#ffb4a1'),
  matchOnSelectionFg: c('#17191c', '#1a0d09'), // on its bg 13.2:1 / 11.1:1
  matchOnIdleBg: c('#ffbfae', '#ff9f86'),
  matchOnIdleFg: c('#17191c', '#1a0d09'), // on its bg 11.2:1 / 9.5:1

  // positive: primary action, done, update ready, Link it
  positive: c('#2f7d32', '#79c35a'),
  positiveHover: c('#286b2b', '#8fd173'),
  positiveFg: c('#ffffff', '#11240a'), // on positive 5.1:1 / 7.6:1
  positiveText: c('#2a7030', '#86cc68'), // on canvas 6.1:1 / 9.7:1
  positiveSubtle: c('#eaf5e6', '#1a2a14'),
  positiveBorder: c('#b5dbab', '#3d5e2e'),

  // danger: errors, overdue, missing wikilinks
  danger: c('#c8174f', '#ff7aa2'), // on canvas 5.7:1 / 7.7:1
  dangerBorder: c('#e03a6b', '#e64c7b'),
  dangerSubtle: c('#fde8ee', '#3c1422'),

  // warning: conflict banner
  warningBg: c('#fff4d6', '#2d2410'),
  warningBorder: c('#f0cf7c', '#5c4a16'),
  warningFg: c('#4b3410', '#ffe7a6'), // on warningBg 10.7:1 / 12.6:1

  // scrim
  overlay: c('rgba(10,20,22,.30)', 'rgba(0,6,8,.6)'),
})

// semanticTokens.shadows.veloPopover
export const popover = { value: { _light: '0 0 0 1px rgba(0,0,0,.06), 0 12px 32px rgba(0,30,34,.14)', _dark: '0 0 0 1px rgba(255,255,255,.07), 0 16px 40px rgba(0,0,0,.6)' } }
