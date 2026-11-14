import { defineSlotRecipe } from '@pandacss/dev'

// Note title bar: [lead: title (or inline rename input in its place), error, rename hint, archived badge, Indexing/Saving] [Retry] [actions].
// Fail-safe by construction (#115): Retry and the actions never shrink; the lead takes what is left and clips its own
// content, so nothing inside it can push a control. The lead wraps: an item that does not fit at its floor moves to a
// second, clipped line and disappears whole (never half an icon). The title takes the free space first, up to its full
// text; the statuses get the rest. The error always stays: it comes right after the title, the title's floor yields to it
// ([data-err]), and the gap shrinks on a lead under 42 px, so its 14 px icon fits any lead of 14 px or more (the narrowest
// reachable is 18: bar 300, Preview, Retry).
const line = { content: '""', h: 'full', w: '0' } // a full-height first item: the first line is as tall as its box, so its items centre in it
const gap = 'max(0px, min(12px, 100% - 30px))' // % = the lead's width
export const titleBar = defineSlotRecipe({
  className: 'titleBar',
  slots: ['root', 'lead', 'title', 'status', 'actions'],
  base: {
    root: {
      display: 'flex',
      alignItems: 'center',
      gap: '3',
      h: 'titleBar',
      pl: '2.5', // + the lead's 10 px: the title starts 20 px in
      pr: '2.5', // icon buttons sit at the edge (v2 §7)
      borderBottomWidth: '1px',
      borderColor: 'velo.muted',
      bg: 'velo.canvas',
      minW: '0',
      flex: 'none',
    },
    lead: {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      alignContent: 'flex-start',
      columnGap: gap,
      flex: '1 1 0',
      minW: '0',
      alignSelf: 'stretch',
      pl: '2.5', // the rename input's -8 px margin and its ring sit in the padding, which the clip keeps
      pr: '0.5',
      // clip: not a scroll container, so focus or a selection drag cannot scroll the second line in; hidden where clip is unknown
      overflow: 'hidden',
      '@supports (overflow: clip)': { overflow: 'clip' },
      containerType: 'inline-size', // the archived badge and the rename hint query it
      fontSize: 'var(--velo-title-fs)', // em in those queries = the title font
      '&::before': { ...line, mr: `calc(-1 * ${gap})` }, // cancels its own gap
    },
    title: {
      fontSize: 'var(--velo-title-fs)',
      fontWeight: '650',
      letterSpacing: '-0.01em',
      lineHeight: '1.2',
      color: 'velo.fg',
      truncate: true,
      flex: '1000 1 0',
      minW: 'min(2.5em, 100%)', // about two characters and the ellipsis at every font size
      maxW: 'max-content',
      '[data-err] > &': { minW: '0' }, // an error outranks the title's floor
    },
    status: {
      display: 'inline-flex',
      flexWrap: 'wrap', // the text moves to the clipped second line when a few characters do not fit: icon only
      alignItems: 'center',
      alignContent: 'flex-start',
      columnGap: '1.5',
      h: '5',
      overflow: 'hidden',
      '@supports (overflow: clip)': { overflow: 'clip' },
      color: 'velo.fgMuted',
      fontSize: 'uiSm',
      whiteSpace: 'nowrap',
      fontVariantNumeric: 'tabular-nums',
      flex: '1 1 0',
      minW: '4', // its icon (14 px) or spinner (16 px); with less room it leaves the line
      maxW: 'max-content',
      '&::before': { ...line, mr: '-1.5' },
      '&[data-tone=error]': { color: 'velo.danger', minW: '3.5' }, // its 14 px icon
    },
    actions: { display: 'inline-flex', alignItems: 'center', gap: '1', flex: 'none' },
  },
})
