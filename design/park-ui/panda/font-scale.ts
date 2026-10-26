/**
 * User font size (Settings › General › Font size, 10–32 px, default 14) drives
 * the editor and the note list. Header chrome stays at 13 px.
 *
 * Row heights are computed here (not in CSS) because the virtualized list
 * needs the same numbers in JS. Call applyFontScale() on startup and whenever
 * the setting changes, then re-measure the virtual list with rowHeight().
 *
 *   size  editor  rowV (compact)  rowH (two-line)  title bar
 *    12   14/24        26               40              15
 *    14   16/27        30               46              17
 *    20   22/37        43               66              24
 */
export type ListLayout = 'vertical' | 'horizontal'

export const FONT_MIN = 10
export const FONT_MAX = 32
export const FONT_DEFAULT = 14

export function fontScale(size: number) {
  const s = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(size)))
  return {
    editor: s + 2, // body text, line-height 1.7
    listTitle: s,
    snippet: s - 1,
    date: Math.max(11, Math.round(s * 0.86)),
    rowCompact: Math.round(2.15 * s), // vertical layout: one line
    rowTwoLine: Math.round(3.3 * s), // horizontal layout: title + snippet
    title: Math.round((17 * s) / 14), // note title bar
  }
}

export function rowHeight(size: number, layout: ListLayout): number {
  const f = fontScale(size)
  return layout === 'vertical' ? f.rowCompact : f.rowTwoLine
}

export function applyFontScale(size: number, root: HTMLElement = document.documentElement) {
  const f = fontScale(size)
  const set = (k: string, v: number) => root.style.setProperty(k, `${v}px`)
  set('--velo-editor-fs', f.editor)
  set('--velo-list-fs', f.listTitle)
  set('--velo-snippet-fs', f.snippet)
  set('--velo-date-fs', f.date)
  set('--velo-row-h', f.rowCompact)
  set('--velo-row2-h', f.rowTwoLine)
  set('--velo-title-fs', f.title)
}
