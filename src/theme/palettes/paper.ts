import { defineSemanticTokens } from '@pandacss/dev'

// velo palette "Paper" — Peach, sand and rose on warm paper; a warm charcoal at night.
// Same token names as src/theme/tokens/velo.ts, plus the six match tokens. Contrast is light / dark (WCAG 2.x);
// the full table is in design/palettes/README.md. Park UI mapping: gray → sand; accent → orange (bronze-leaning custom 9–11);
// green → olive / grass → solid = velo.positive; red → crimson; default colorPalette: orange.
const c = (light: string, dark: string) => ({ value: { _light: light, _dark: dark } })

export const meta = { slug: 'paper', name: 'Paper', mood: 'Peach, sand and rose on warm paper; a warm charcoal at night.' } as const

export const colors = defineSemanticTokens.colors({
  // surfaces
  canvas: c('#fffdf9', '#171513'),
  chrome: c('#f7f2ea', '#1e1b18'),
  panel: c('#fffdf9', '#211e1a'),
  subtle: c('#f3ece2', '#25211d'),
  muted: c('#ebe3d7', '#2c2722'),
  segmentOn: c('#fffdf9', '#3a332c'),

  // edges
  hairline: c('rgba(90,60,30,.10)', 'rgba(255,235,210,.08)'),
  highlight: c('rgba(255,255,255,.75)', 'rgba(255,240,220,.06)'),
  divider: c('#e6dccd', '#332d27'),
  border: c('#ddd2c2', '#3b342d'),
  inputBorder: c('#968670', '#7a6e60'), // vs canvas 3.5:1 / 3.7:1
  grip: c('#968670', '#7a6e60'), // vs canvas 3.5:1 / 3.7:1

  // text
  fg: c('#2b2420', '#efe8df'), // on canvas 15.0:1 / 15.0:1
  fgMuted: c('#685c52', '#bdb2a5'), // on canvas 6.4:1 / 8.7:1
  mark: c('#74675b', '#a09386'), // on canvas 5.4:1 / 6.1:1

  // accent
  accent: c('#ad5530', '#f0a57c'), // focus ring vs canvas 5.0:1 / 9.0:1
  accentHover: c('#9a4a29', '#f6b893'),
  accentFg: c('#ffffff', '#2a170c'), // on accent 5.1:1 / 8.5:1
  accentText: c('#954624', '#f4b08a'), // links on canvas 6.5:1 / 9.9:1
  accentSubtle: c('#fbeadf', '#3a2a20'),
  accentSubtleHover: c('#f6dccb', '#4a3426'),
  accentLine: c('#e0b196', '#8a5a40'),
  accentBorder: c('#c0714b', '#c98760'), // vs canvas 3.6:1 / 6.2:1
  accentHalo: c('#fde2a6', '#5e4a1c'),

  // list selection
  selection: c('#e9bfa9', '#5a3e30'),
  selectionFg: c('#2b2420', '#ffffff'), // on selection 9.1:1 / 9.7:1
  selectionMuted: c('#4f3d34', '#ecd8cb'), // on selection 6.1:1 / 7.0:1
  selectionIdle: c('#f6eee6', '#2e2823'),

  // search match (NEW): one pair per row state; hovered rows use matchBg / matchFg
  matchBg: c('#fbd47e', '#5e4a1c'),
  matchFg: c('#2b2420', '#ffe9b3'), // on matchBg 10.8:1 / 7.1:1
  matchOnSelectionBg: c('#fff3d6', '#fde2a6'),
  matchOnSelectionFg: c('#2b2420', '#2b2420'), // on its bg 13.8:1 / 12.1:1
  matchOnIdleBg: c('#f8cb66', '#6a5420'),
  matchOnIdleFg: c('#2b2420', '#ffe9b3'), // on its bg 10.0:1 / 6.1:1

  // positive: primary action, done, update ready, Link it
  positive: c('#4a7a2c', '#9ccc6b'),
  positiveHover: c('#416b27', '#afd985'),
  positiveFg: c('#ffffff', '#1a2a0c'), // on positive 5.1:1 / 8.2:1
  positiveText: c('#426d27', '#a6d477'), // on canvas 6.0:1 / 10.7:1
  positiveSubtle: c('#edf3e1', '#24301a'),
  positiveBorder: c('#c4d8a8', '#4a6332'),

  // danger: errors, overdue, missing wikilinks
  danger: c('#c0174f', '#ff8fb1'), // on canvas 5.9:1 / 8.5:1
  dangerBorder: c('#d63b6e', '#e0457b'),
  dangerSubtle: c('#fce8ef', '#3d1624'),

  // warning: conflict banner
  warningBg: c('#f3ece2', '#25211d'),
  warningBorder: c('#ddd2c2', '#3b342d'),
  warningFg: c('#2b2420', '#efe8df'), // on warningBg 13.0:1 / 13.1:1

  // scrim
  overlay: c('rgba(40,25,10,.30)', 'rgba(20,12,4,.6)'),
})

// semanticTokens.shadows.veloPopover
export const popover = { value: { _light: '0 0 0 1px rgba(90,60,30,.08), 0 12px 32px rgba(90,60,30,.16)', _dark: '0 0 0 1px rgba(255,235,210,.07), 0 16px 40px rgba(10,6,2,.6)' } }
