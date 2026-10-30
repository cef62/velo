import type { SavedSearch } from "./api";
import { fold } from "./search";

/** What a saved search keeps: the current search text, tag filter and No links chip. */
export type Filters = { query: string; tags: string[]; noLinks: boolean };

const tagSet = (tags: string[]) => [...new Set(tags.map(fold))].sort().join("\n");

/** The current filters equal the saved search (the chip shows as selected). */
export const sameFilters = (s: SavedSearch, f: Filters): boolean =>
  s.query.trim() === f.query.trim() && tagSet(s.tags) === tagSet(f.tags) && s.no_links === f.noLinks;

/** The saved search applied as one chip: the one applied last, while its tags and No links still hold (typing narrows it, so the text may differ). */
export function appliedSearch(saved: SavedSearch[], applied: string | null, f: Filters): SavedSearch | null {
  if (applied === null) return null;
  const s = saved.find((x) => fold(x.name) === fold(applied));
  return s && tagSet(s.tags) === tagSet(f.tags) && s.no_links === f.noLinks ? s : null;
}

/** Filters shown as active in the header: an applied saved search counts as one, else each tag and the No links chip. */
export const activeFilterCount = (saved: SavedSearch[], applied: string | null, f: Filters): number =>
  appliedSearch(saved, applied, f) ? 1 : f.tags.length + (f.noLinks ? 1 : 0);

/** Trimmed name, or null when empty or over 60 characters. */
export function cleanName(raw: string): string | null {
  const n = raw.trim();
  return n && [...n].length <= 60 ? n : null;
}

/** The Save dialog's suggestion: the search text, else the first tag, else "No links". */
export const defaultName = (f: Filters): string => f.query.trim() || (f.tags[0] ? `#${f.tags[0]}` : "No links");

const is = (name: string) => (x: SavedSearch) => fold(x.name) === fold(name);

/** Replace the search with the same (folded) name in place, else append. */
export function upsert(list: SavedSearch[], s: SavedSearch): SavedSearch[] {
  return list.some(is(s.name)) ? list.map((x) => (is(s.name)(x) ? s : x)) : [...list, s];
}

/** Rename `from` in place; another search already called `to` is replaced (dropped). */
export function renameIn(list: SavedSearch[], from: string, to: string): SavedSearch[] {
  return list.filter((x) => is(from)(x) || !is(to)(x)).map((x) => (is(from)(x) ? { ...x, name: to } : x));
}

export const removeFrom = (list: SavedSearch[], name: string): SavedSearch[] => list.filter((x) => !is(name)(x));
