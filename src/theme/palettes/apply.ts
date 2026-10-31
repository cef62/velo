import { palettes, DEFAULT_PALETTE } from '.'

/** Writes data-palette on <html> (the Panda palette conditions read it); Clear, unknown or empty removes it. */
export function applyPalette(slug: string | null | undefined, root: HTMLElement = document.documentElement) {
  if (slug && slug !== DEFAULT_PALETTE && Object.prototype.hasOwnProperty.call(palettes, slug)) root.dataset.palette = slug
  else delete root.dataset.palette
}
