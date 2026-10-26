export const globalCss = {
  extend: {
    '*': {
      '--global-color-border': 'colors.border',
      '--global-color-placeholder': 'colors.fg.subtle',
      '--global-color-selection': 'colors.colorPalette.subtle.bg',
      '--global-color-focus-ring': 'colors.colorPalette.solid.bg',
    },
    html: {
      colorPalette: 'indigo',
    },
    body: {
      background: 'velo.canvas',
      color: 'velo.fg',
      fontFamily: 'ui',
      fontSize: 'ui',
    },
  },
}
