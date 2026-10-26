/**
 * Example panda.config.ts wiring for velo. Merge into the existing config.
 */
import { defineConfig } from '@pandacss/dev'
import { parkPreset, veloPreset } from './velo-preset'
import {
  banner,
  divider,
  inlineTag,
  keyCap,
  listRow,
  previewPill,
  searchMatch,
  segmented,
  tagChip,
  titleBar,
} from './recipes'
import { editorGlobalCss } from './editor-styles'

export default defineConfig({
  preflight: true,
  // velo is plain TS + DOM: no JSX
  jsxFramework: undefined,
  include: ['./src/**/*.{ts,html}'],
  outdir: 'styled-system',

  // Park UI first, then velo's extensions on top
  presets: ['@pandacss/preset-base', parkPreset, veloPreset],

  // System / Light / Dark from Settings: the app always writes data-theme="light|dark"
  // on <html>. For "System" it resolves the value from
  // matchMedia('(prefers-color-scheme: dark)') and updates it on the change event,
  // so one simple selector condition covers every case.
  conditions: {
    extend: {
      dark: '[data-theme=dark] &',
    },
  },

  globalCss: {
    'html, body': { bg: 'velo.canvas', color: 'velo.fg', fontFamily: 'ui', fontSize: 'ui' },
    ...editorGlobalCss,
  },

  theme: {
    extend: {
      recipes: { searchMatch, inlineTag, keyCap, divider, banner, previewPill },
      slotRecipes: { listRow, tagChip, segmented, titleBar },
    },
  },
})
