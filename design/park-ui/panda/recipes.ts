/**
 * velo custom recipes (Panda). Use alongside Park UI's own recipes
 * (button, iconButton, input, badge, dialog, field, select, table, tooltip,
 * menu, kbd, tabs) — these cover what Park UI has no recipe for.
 *
 * All behaviour is plain DOM: state comes from native attributes
 * (aria-selected, aria-pressed, aria-checked, disabled) or data-* set by app code.
 */
import { defineRecipe, defineSlotRecipe } from '@pandacss/dev'

/** Shared focus ring: 2px indigo.9, offset 2px. ≥3:1 on both canvases. */
const focusRing = {
  _focusVisible: { outline: '2px solid', outlineColor: 'velo.accent', outlineOffset: '2px' },
} as const

/* ------------------------------------------------------------------ */
/* List row — fixed height for virtualization.                          */
/* Heights come from CSS vars set by applyFontScale() (font-scale.ts).  */
/* The list element gets data-active="true" while the search field or   */
/* the list has focus; otherwise the selected row shows the idle style. */
/* ------------------------------------------------------------------ */
export const listRow = defineSlotRecipe({
  className: 'listRow',
  slots: ['root', 'line', 'title', 'snippet', 'date', 'lock'],
  base: {
    root: {
      display: 'flex',
      alignItems: 'center',
      gap: '2.5',
      px: '2.5',
      borderRadius: 'l2',
      color: 'velo.fg',
      fontSize: 'var(--velo-list-fs)',
      lineHeight: '1.2',
      minWidth: '0',
      boxSizing: 'border-box',
      cursor: 'default',
      _hover: { bg: 'velo.subtle' },
      '&[aria-selected=true]': { bg: 'velo.selectionIdle' },
      '[data-active=true] > &[aria-selected=true]': {
        bg: 'velo.selection',
        color: 'velo.selectionFg',
        '& :is(.listRow__snippet, .listRow__date, .listRow__lock)': { color: 'velo.selectionMuted' },
      },
      // keyboard cursor when the list itself has focus (roving tabindex)
      _focusVisible: { outline: '2px solid', outlineColor: 'velo.accent', outlineOffset: '-2px' },
    },
    line: { display: 'flex', alignItems: 'baseline', gap: '2', minWidth: '0' },
    title: { fontWeight: '500', truncate: true, flex: '0 1 auto' },
    snippet: { color: 'velo.fgMuted', truncate: true, flex: '1 1 0', minWidth: '0', fontSize: 'var(--velo-snippet-fs)' },
    date: {
      color: 'velo.fgMuted',
      fontSize: 'var(--velo-date-fs)',
      fontVariantNumeric: 'tabular-nums',
      flex: 'none',
      ml: 'auto',
      pl: '2',
    },
    lock: { color: 'velo.fgMuted', display: 'inline-flex', flex: 'none', '& svg': { width: '14px', height: '14px' } },
  },
  variants: {
    layout: {
      // vertical window layout: title · snippet · date on one line
      compact: { root: { height: 'var(--velo-row-h)' }, title: { maxWidth: '48%' } },
      // horizontal window layout: title + date, then snippet
      twoLine: {
        root: { height: 'var(--velo-row2-h)', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'center', gap: '1', px: '3' },
        title: { flex: '1 1 auto' },
        snippet: { flex: 'none', display: 'block' },
      },
    },
    kind: {
      note: {},
      loading: { root: { color: 'velo.fgMuted', gap: '2', _hover: { bg: 'transparent' } } },
    },
  },
  defaultVariants: { layout: 'compact', kind: 'note' },
})

/** Search-match highlight inside row titles/snippets: <mark class={searchMatch()}> */
export const searchMatch = defineRecipe({
  className: 'searchMatch',
  base: {
    bg: 'velo.accentHalo',
    color: 'inherit',
    borderRadius: '2px',
    px: '1px',
    '[data-active=true] > [aria-selected=true] &': { bg: 'rgba(255,255,255,.24)', color: 'white' },
  },
})

/* ------------------------------------------------------------------ */
/* Tag chip — toggle button "#tag 12" in the tag panel.                 */
/* ------------------------------------------------------------------ */
export const tagChip = defineSlotRecipe({
  className: 'tagChip',
  slots: ['root', 'count'],
  base: {
    root: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '1.5',
      h: '26px',
      px: '2.5',
      borderRadius: 'full',
      borderWidth: '1px',
      borderColor: 'velo.border',
      bg: 'velo.canvas',
      color: 'velo.fg',
      fontSize: 'uiSm',
      fontWeight: '500',
      whiteSpace: 'nowrap',
      cursor: 'pointer',
      _hover: { bg: 'velo.subtle' },
      '&[aria-pressed=true]': {
        bg: 'velo.accent',
        borderColor: 'velo.accent',
        color: 'white',
        '& .tagChip__count': { color: 'white' },
      },
      ...focusRing,
    },
    count: { color: 'velo.fgMuted', fontWeight: '400', fontVariantNumeric: 'tabular-nums' },
  },
})

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

/* ------------------------------------------------------------------ */
/* Key-cap button — shortcut editor in Settings › Keyboard shortcuts.   */
/* data-state="idle|recording|conflict", data-modified when ≠ default.  */
/* ------------------------------------------------------------------ */
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
    _hover: { bg: 'velo.subtle' },
    '&[data-state=recording]': {
      borderColor: 'velo.accent',
      bg: 'velo.accentSubtle',
      color: 'velo.accentText',
      letterSpacing: '0',
      boxShadow: '0 0 0 3px var(--colors-velo-accent-halo)',
    },
    '&[data-state=conflict]': { borderColor: 'velo.dangerBorder', bg: 'velo.dangerSubtle', color: 'velo.danger' },
    '&[data-modified]::after': {
      content: '""',
      w: '6px',
      h: '6px',
      borderRadius: 'full',
      bg: 'velo.accent',
      ml: '1.5',
    },
    ...focusRing,
  },
})

/* ------------------------------------------------------------------ */
/* Segmented control — Recent/A→Z, Rich/Plain, Layout, Theme.           */
/* Markup: <div role="radiogroup"><button role="radio" aria-checked>…   */
/* ------------------------------------------------------------------ */
export const segmented = defineSlotRecipe({
  className: 'segmented',
  slots: ['root', 'item'],
  base: {
    root: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '0.5',
      h: 'control',
      p: '2px',
      borderRadius: 'l2',
      bg: 'velo.subtle',
      borderWidth: '1px',
      borderColor: 'velo.divider',
      flex: 'none',
    },
    item: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '1',
      h: '26px',
      px: '2',
      borderRadius: 'l1',
      color: 'velo.fgMuted',
      fontSize: 'uiSm',
      fontWeight: '500',
      whiteSpace: 'nowrap',
      cursor: 'pointer',
      _hover: { color: 'velo.fg' },
      '&[aria-checked=true]': { bg: 'velo.segmentOn', color: 'velo.fg', boxShadow: '0 1px 2px rgba(0,0,0,.16)' },
      ...focusRing,
    },
  },
  variants: {
    iconOnly: { true: { item: { px: '1.5' } } }, // used below 900 px window width
  },
})

/* ------------------------------------------------------------------ */
/* Note title bar + inline rename + status.                             */
/* ------------------------------------------------------------------ */
export const titleBar = defineSlotRecipe({
  className: 'titleBar',
  slots: ['root', 'title', 'rename', 'status', 'progress'],
  base: {
    root: {
      display: 'flex',
      alignItems: 'center',
      gap: '3',
      h: 'titleBar',
      px: '5',
      borderBottomWidth: '1px',
      borderColor: 'velo.muted',
      bg: 'velo.canvas',
      minW: '0',
      flex: 'none',
    },
    title: {
      fontSize: 'var(--velo-title-fs)',
      fontWeight: '650',
      letterSpacing: '-0.01em',
      lineHeight: '1.2',
      color: 'velo.fg',
      truncate: true,
      flex: '1',
      minW: '0',
    },
    rename: {
      flex: '1',
      minW: '0',
      h: 'control',
      ml: '-9px', // text stays where the title was
      px: '2',
      borderWidth: '1px',
      borderColor: 'velo.accentBorder',
      boxShadow: '0 0 0 1px var(--colors-velo-accent-border)',
      borderRadius: 'l2',
      bg: 'velo.canvas',
      fontSize: 'var(--velo-title-fs)',
      fontWeight: '650',
      letterSpacing: '-0.01em',
      color: 'velo.fg',
      outline: 'none',
    },
    status: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '1.5',
      color: 'velo.fgMuted',
      fontSize: 'uiSm',
      whiteSpace: 'nowrap',
      fontVariantNumeric: 'tabular-nums',
      flex: 'none',
      '&[data-tone=error]': { color: 'velo.danger' },
    },
    progress: {
      w: '64px',
      h: '4px',
      borderRadius: '2px',
      bg: 'velo.muted',
      overflow: 'hidden',
      '& > i': { display: 'block', h: 'full', bg: 'velo.accent', borderRadius: '2px' },
    },
  },
})

/* ------------------------------------------------------------------ */
/* List/note divider — 1px line, 36×5 grip, 9px hit area.               */
/* role="separator" tabindex="0" aria-orientation aria-valuenow;        */
/* ↑/↓ (or ←/→) move one row, Shift moves ten. data-dragging while drag.*/
/* ------------------------------------------------------------------ */
export const divider = defineRecipe({
  className: 'divider',
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

/* ------------------------------------------------------------------ */
/* Banners: conflict (amber), filter line (indigo), preview strip.      */
/* ------------------------------------------------------------------ */
export const banner = defineRecipe({
  className: 'banner',
  base: { display: 'flex', alignItems: 'center', gap: '2.5', flex: 'none', fontSize: 'ui' },
  variants: {
    tone: {
      conflict: {
        py: '2',
        px: '5',
        bg: 'velo.warningBg',
        borderBottomWidth: '1px',
        borderColor: 'velo.warningBorder',
        color: 'velo.warningFg',
        '& a': { color: 'velo.warningFg', fontWeight: '600', textDecoration: 'underline', textUnderlineOffset: '2px' },
      },
      filter: {
        h: '30px',
        px: '3.5',
        gap: '1.5',
        bg: 'velo.accentSubtle',
        borderBottomWidth: '1px',
        borderColor: 'velo.accentHalo',
        color: 'velo.fgMuted',
        fontSize: 'uiSm',
        '& b': { fontWeight: '500', color: 'velo.accentText' },
      },
      preview: {
        h: '30px',
        px: '5',
        gap: '2',
        bg: 'velo.accentSubtle',
        borderBottomWidth: '1px',
        borderColor: 'velo.accentHalo',
        color: 'velo.accentText',
        fontSize: 'uiSm',
        fontWeight: '500',
      },
    },
  },
})

/** Header "Preview" indicator when preview is on (off = plain ghost iconButton with eye). */
export const previewPill = defineRecipe({
  className: 'previewPill',
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '1.5',
    h: 'controlSm',
    px: '2.5',
    borderRadius: 'l2',
    bg: 'velo.accent',
    color: 'white',
    fontSize: 'uiSm',
    fontWeight: '600',
    flex: 'none',
    cursor: 'pointer',
    '&::before': { content: '""', w: '6px', h: '6px', borderRadius: 'full', bg: 'white' },
    _hover: { bg: 'velo.accentHover' },
    ...focusRing,
  },
})
