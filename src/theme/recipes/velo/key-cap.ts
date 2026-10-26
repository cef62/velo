import { defineRecipe } from '@pandacss/dev'
import { focusRing } from './focus-ring'

// Shortcut editor button in Settings › Keyboard shortcuts; `changed` = differs from default.
export const keyCap = defineRecipe({
  className: 'keyCap',
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5',
    h: '28px',
    minW: '72px',
    px: '2.5',
    borderRadius: 'l2',
    borderWidth: '1px',
    borderBottomWidth: '2px',
    borderColor: 'velo.inputBorder',
    bg: 'velo.canvas',
    color: 'velo.fg',
    fontSize: 'ui',
    fontWeight: '500',
    letterSpacing: '0.04em',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    ...focusRing,
  },
  variants: {
    state: {
      idle: { _hover: { bg: 'velo.subtle' } },
      recording: {
        borderColor: 'velo.accent',
        bg: 'velo.accentSubtle',
        color: 'velo.accentText',
        letterSpacing: '0',
        boxShadow: '0 0 0 3px var(--colors-velo-accent-halo)',
      },
      conflict: { borderColor: 'velo.dangerBorder', bg: 'velo.dangerSubtle', color: 'velo.danger' },
    },
    changed: {
      true: { _after: { content: '""', w: '6px', h: '6px', borderRadius: 'full', bg: 'velo.accent', ml: '1.5' } },
      false: {},
    },
  },
  defaultVariants: { state: 'idle', changed: false },
})
