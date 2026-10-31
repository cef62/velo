// velo palettes: Settings › Appearance. Clear is the default.

import * as clear from './clear'
import * as mist from './mist'
import * as paper from './paper'
import * as electric from './electric'
import * as reef from './reef'
import * as contrast from './contrast'

export const palettes = { clear, mist, paper, electric, reef, contrast } as const
export type PaletteSlug = keyof typeof palettes
export const DEFAULT_PALETTE: PaletteSlug = 'clear'

/** Writes data-palette on <html> (the Panda palette conditions read it); Clear, unknown or empty removes it. */
export function applyPalette(slug: string | null | undefined, root: HTMLElement = document.documentElement) {
  if (slug && slug !== DEFAULT_PALETTE && Object.prototype.hasOwnProperty.call(palettes, slug)) root.dataset.palette = slug
  else delete root.dataset.palette
}
