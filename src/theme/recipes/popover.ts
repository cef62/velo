import { popoverAnatomy } from '@ark-ui/react/anatomy'
import { defineSlotRecipe } from '@pandacss/dev'

export const popover = defineSlotRecipe({
  className: 'popover',
  slots: popoverAnatomy.keys(),
  base: {
    positioner: {
      position: 'relative',
    },
    content: {
      bg: 'velo.panel',
      borderRadius: 'l3',
      borderWidth: '1px',
      borderColor: 'velo.border',
      boxShadow: 'veloPopover',
      display: 'flex',
      flexDirection: 'column',
      maxW: 'sm',
      p: '4',
      position: 'relative',
      zIndex: 'popover',
      _open: {
        animationStyle: 'slide-fade-in',
        animationDuration: 'fast',
      },
      _closed: {
        animationStyle: 'slide-fade-out',
        animationDuration: 'faster',
      },
      _hidden: {
        display: 'none',
      },
    },
    title: {
      fontWeight: 'semibold',
      textStyle: 'sm',
    },
    description: {
      color: 'fg.muted',
      textStyle: 'sm',
    },
    closeTrigger: {
      color: 'fg.muted',
    },
    arrow: {
      '--arrow-size': 'var(--sizes-3)',
      '--arrow-background': 'var(--colors-velo-panel)',
    },
    arrowTip: {
      borderTopWidth: '1px',
      borderLeftWidth: '1px',
      borderColor: 'velo.border',
    },
  },
})
