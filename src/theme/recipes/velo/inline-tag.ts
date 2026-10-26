import { defineRecipe } from '@pandacss/dev'

/** Inline #tag rendered in Rich/Preview — sized in em so it follows the editor font size. */
export const inlineTag = defineRecipe({
  className: 'inlineTag',
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    h: '1.45em',
    px: '0.45em',
    borderRadius: 'l1',
    bg: 'velo.accentSubtle',
    color: 'velo.accentText',
    fontSize: '0.8em',
    fontWeight: '500',
    lineHeight: '1',
    verticalAlign: '0.1em',
  },
})
