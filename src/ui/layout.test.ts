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
    const edges = { notes: [269, 341, 443], tasks: [227, 308, 410], timeline: [271, 360, 447] } as const
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
    expect(noteCount(99999)).toBe('100K')
    expect(dueText(99)).toBe('99')
    expect(dueText(100)).toBe('99+')
    expect(dueText(999)).toBe('99+')
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
