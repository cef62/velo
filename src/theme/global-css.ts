import { editorGlobalCss } from './editor-css'
import { printGlobalCss } from './print-css'

export const globalCss = {
  extend: {
    '*': {
      '--global-color-border': 'colors.border',
      '--global-color-placeholder': 'colors.fg.subtle',
      '--global-color-selection': 'colors.velo.accentSubtleHover', // gray.a3 on canvas is ~1.1:1: too faint
      '--global-color-focus-ring': 'colors.velo.accent', // one ring colour for Park and velo controls
    },
    html: {
      colorPalette: 'gray',
    },
    body: {
      background: 'velo.canvas',
      color: 'velo.fg',
      fontFamily: 'ui',
      fontSize: 'ui',
    },
    ...editorGlobalCss,
    ...printGlobalCss,
  },
}
