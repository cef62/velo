import { describe, expect, it } from 'vitest'
import { paneBarMode, showSearchHint, sidePanelMode, titleBarMode } from './layout'

// The sizes the v2 mocks are drawn at (design/park-ui/v2/reference/V2Small, V2Wide, V2Main*).
describe('v2 layout rules', () => {
  it('default window 1000×700, horizontal: list 280, note ~711', () => {
    expect(paneBarMode(280)).toEqual({ labels: 'active', menusIconOnly: true }) // a labelled menu would truncate next to the tabs
    expect(titleBarMode(711)).toEqual({ viewSwitch: 'segments', lockInMenu: false })
    expect(sidePanelMode(711)).toBe('overlay') // 711 − 300 < 480
  })
  it('wide window 1600×900: three panes dock', () => {
    expect(sidePanelMode(1251, 320)).toBe('docked')
  })
  it('vertical layout: the list is full width, every tab labelled', () => {
    expect(paneBarMode(1000).labels).toBe('all')
  })
  it('small window 600×400, horizontal: list 200, note 391', () => {
    expect(paneBarMode(200)).toEqual({ labels: 'none', menusIconOnly: true })
    expect(paneBarMode(240).labels).toBe('active')
    expect(titleBarMode(391)).toEqual({ viewSwitch: 'menu', lockInMenu: true })
    expect(showSearchHint(600)).toBe(false)
  })
})
