import { defineRecipe } from '@pandacss/dev'

// List/note divider: 1px line, 36×5 grip, 9px hit area. data-dragging while dragging.
export const paneDivider = defineRecipe({
  className: 'paneDivider',
  base: {
    position: 'relative',
    flex: 'none',
    zIndex: '2',
    outline: 'none',
    '&::before': { content: '""', position: 'absolute', bg: 'velo.divider' },
    '&::after': {
      content: '""',
      position: 'absolute',
      borderRadius: '3px',
      bg: 'velo.grip',
      boxShadow: '0 0 0 2px var(--colors-velo-canvas)',
    },
    '&:is(:hover, :focus-visible)::before': { bg: 'velo.accentBorder' },
    '&:is(:hover, :focus-visible)::after': { bg: 'velo.accent' },
    '&[data-dragging]::before': { bg: 'velo.accent' },
    '&[data-dragging]::after': { bg: 'velo.accent', boxShadow: '0 0 0 3px var(--colors-velo-accent-halo)' },
  },
  variants: {
    orientation: {
      // vertical window layout: horizontal line between list and note
      horizontal: {
        h: '9px',
        my: '-4px',
        cursor: 'row-resize',
        '&::before': { left: '0', right: '0', top: '4px', h: '1px' },
        '&::after': { left: '50%', top: '2px', w: '36px', h: '5px', ml: '-18px' },
      },
      vertical: {
        w: '9px',
        mx: '-4px',
        cursor: 'col-resize',
        '&::before': { top: '0', bottom: '0', left: '4px', w: '1px' },
        '&::after': { top: '50%', left: '2px', h: '36px', w: '5px', mt: '-18px' },
      },
    },
  },
  defaultVariants: { orientation: 'horizontal' },
})
