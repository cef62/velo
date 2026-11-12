import { describe, expect, it } from 'vitest'
import { paneBarMode, showSearchHint, sidePanelMode, titleBarMode } from './layout'

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
    expect(paneBarMode(330, 'notes').menusIconOnly).toBe(true)
    expect(paneBarMode(331, 'notes').menusIconOnly).toBe(false)
    expect(paneBarMode(379, 'notes').menusIconOnly).toBe(false)
    expect(paneBarMode(380, 'notes').menusIconOnly).toBe(true) // tabs gain labels and take the room
    expect(paneBarMode(432, 'notes').menusIconOnly).toBe(true)
    expect(paneBarMode(433, 'notes').menusIconOnly).toBe(false)
    expect(paneBarMode(262, 'notes').labels).toBe('none')
    expect(paneBarMode(263, 'notes').labels).toBe('active')
    expect(paneBarMode(226, 'tasks').labels).toBe('none')
    expect(paneBarMode(227, 'tasks').labels).toBe('active')
    expect(paneBarMode(263, 'timeline').labels).toBe('none')
    expect(paneBarMode(264, 'timeline').labels).toBe('active')
    expect(paneBarMode(300, 'tasks').menusIconOnly).toBe(true)
    expect(paneBarMode(301, 'tasks').menusIconOnly).toBe(false)
    expect(paneBarMode(403, 'tasks').menusIconOnly).toBe(true)
    expect(paneBarMode(404, 'tasks').menusIconOnly).toBe(false)
    expect(paneBarMode(359, 'timeline').menusIconOnly).toBe(true)
    expect(paneBarMode(360, 'timeline').menusIconOnly).toBe(false)
    expect(paneBarMode(446, 'timeline').menusIconOnly).toBe(true)
    expect(paneBarMode(447, 'timeline').menusIconOnly).toBe(false)
  })
})
