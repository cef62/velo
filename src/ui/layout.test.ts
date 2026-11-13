import { describe, expect, it } from 'vitest'
import { dueExtra, dueText, notesExtra, notesText, noteCount, paneBarMode, showSearchHint, sidePanelMode, titleBarMode } from './layout'

// The sizes the v2 mocks are drawn at (design/park-ui/v2/reference/V2Small, V2Wide, V2Main*).
describe('v2 layout rules', () => {
  it('default window 1000×700, horizontal: list 280, note ~711', () => {
    expect(paneBarMode(280)).toEqual({ labels: 'active', menusIconOnly: true }) // 331 needed for Sort in full
    expect(titleBarMode(711)).toEqual({ viewSwitch: 'segments', lockInMenu: false, renameHint: false, hideActions: false })
    expect(sidePanelMode(711)).toBe('overlay') // 711 − 300 < 480
  })
  it('rename hint only when the title input keeps its room', () => {
    expect(titleBarMode(799).renameHint).toBe(false)
    expect(titleBarMode(800).renameHint).toBe(true)
  })
  it('renaming at the 320px note minimum drops the actions, not outside rename', () => {
    expect(titleBarMode(320, true).hideActions).toBe(true)
    expect(titleBarMode(320).hideActions).toBe(false)
    expect(titleBarMode(419, true).hideActions).toBe(true)
    expect(titleBarMode(420, true).hideActions).toBe(false)
  })
  it('wide window 1600×900: three panes dock', () => {
    expect(sidePanelMode(1251, 320)).toBe('docked')
  })
  it('vertical layout: the list is full width, every tab labelled', () => {
    expect(paneBarMode(1000).labels).toBe('all')
  })
  it('small window 600×400, horizontal: list 216 (MIN_LIST_W), note 384', () => {
    expect(paneBarMode(216)).toEqual({ labels: 'none', menusIconOnly: true })
    expect(titleBarMode(384)).toEqual({ viewSwitch: 'menu', lockInMenu: true, renameHint: false, hideActions: false })
    expect(showSearchHint(600)).toBe(false)
  })
  it('pane bar labels: in full or icon-only, per mode, on both sides of each boundary', () => {
    // [mode, first width with labels, tabs active] / [first width with labelled controls] / [... with all tabs labelled]
    const edges = { notes: [269, 357, 460], tasks: [235, 308, 410], timeline: [271, 368, 456] } as const
    for (const [tab, [tabs, controls, controlsAll]] of Object.entries(edges) as [keyof typeof edges, readonly number[]][]) {
      expect(paneBarMode(tabs - 1, tab).labels).toBe('none')
      expect(paneBarMode(tabs, tab).labels).toBe('active')
      expect(paneBarMode(controls - 1, tab).menusIconOnly).toBe(true)
      expect(paneBarMode(controls, tab).menusIconOnly).toBe(false)
      expect(paneBarMode(379, tab).menusIconOnly).toBe(controls > 379) // still 'active' labels below 380
      expect(paneBarMode(380, tab).menusIconOnly).toBe(true) // tabs gain labels and take the room
      expect(paneBarMode(controlsAll - 1, tab).menusIconOnly).toBe(true)
      expect(paneBarMode(controlsAll, tab).menusIconOnly).toBe(false)
    }
  })
  it('counts beside the tabs have a fixed worst case the thresholds were measured with', () => {
    expect(noteCount(9999)).toBe('9,999')
    expect(noteCount(10004)).toBe('10K')
    expect(noteCount(10500)).toBe('10K') // truncates, never overstates
    expect(noteCount(99999)).toBe('99K')
    expect(noteCount(1000000)).toBe('1M')
    expect(dueText(99)).toBe('99')
    expect(dueText(100)).toBe('99+')
    expect(dueText(999)).toBe('99+')
  })
  it('noteCount boundaries: exact below 10,000, floored compact above, never more than the real count', () => {
    const table: [number, string][] = [
      [0, '0'], [1, '1'], [999, '999'], [1000, '1,000'], [9999, '9,999'],
      [10000, '10K'], [10999, '10K'], [99999, '99K'], [100000, '100K'], [999999, '999K'],
      [1000000, '1M'], [1049999, '1M'], [1999999, '1M'], [9999999, '9M'], [10000000, '10M'],
      [999999999, '999M'], [1000000000, '1B'], [999999999999, '999B'], [1000000000000, '1T'],
      [999999999999999, '999T'], [1000000000000000, '1000T'], [Number.MAX_SAFE_INTEGER, '9007T'],
    ]
    for (const [n, label] of table) expect(noteCount(n), String(n)).toBe(label)
  })
  it('noteCount does not depend on Intl roundingMode (old WebKitGTK ignores it)', () => {
    const Real = Intl.NumberFormat
    // Wrapper that drops roundingMode, as an engine without support does; the default mode rounds half up.
    const NoRounding = function (l?: string | string[], o?: Intl.NumberFormatOptions) {
      const { roundingMode: _ignored, ...rest } = (o ?? {}) as Intl.NumberFormatOptions & { roundingMode?: string }
      return new Real(l, rest)
    } as unknown as typeof Intl.NumberFormat
    Intl.NumberFormat = NoRounding
    try {
      expect(noteCount(99999)).toBe('99K')
      expect(noteCount(999999)).toBe('999K')
      expect(noteCount(1999999)).toBe('1M')
    } finally {
      Intl.NumberFormat = Real
    }
  })
  it('tooltip text for counts the bar hides or caps', () => {
    expect(notesText(1)).toBe('1 note')
    expect(notesText(9999)).toBe('9,999 notes')
    expect(notesText(10004)).toBe('10,004 notes')
    expect(notesText(99999)).toBe('99,999 notes')
    expect(notesExtra(10004, false)).toBe('10,004 notes') // hidden (tabs icon-only)
    expect(notesExtra(1, false)).toBe('1 note')
    expect(notesExtra(0, false)).toBe('')
    expect(notesExtra(9999, true)).toBe('') // shown in full: nothing to add
    expect(notesExtra(10004, true)).toBe('10,004 notes') // shown capped as 10K
    expect(dueExtra(99)).toBe('')
    expect(dueExtra(150)).toBe('150 due')
  })
})
