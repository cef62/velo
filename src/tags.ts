import type { TagCount } from "./api";
import { fold } from "./search";

// Mirrors Rust text::extract_tags: '#' at line start or after whitespace/'(', body [alphanumeric _ - /], >=1 letter.
export const BODY = /^[\p{Alphabetic}\p{N}_\-/]+/u;

/** True when a '#' at src[i] is in tag position: line start, whitespace or '(' before it. */
export const tagStartOk = (src: string, i: number): boolean => {
  const prev = src[i - 1];
  return prev === undefined || prev === "(" || /\s/.test(prev);
};

/** The tag whose '#' is at src[i], or null (prefix rule, char class, at least one letter). */
export function readTag(src: string, i: number): string | null {
  if (src[i] !== "#") return null;
  if (!tagStartOk(src, i)) return null;
  const tag = BODY.exec(src.slice(i + 1))?.[0];
  return tag && /\p{Alphabetic}/u.test(tag) ? tag : null;
}

/** Display spellings of the distinct tags in a note body, fenced code ignored (same as Rust; tests only). */
export function extractTags(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    const t = line.trimStart();
    if (t.startsWith("```") || t.startsWith("~~~")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (let i = 0; i < line.length; i++) {
      const tag = readTag(line, i);
      if (tag && !seen.has(fold(tag))) {
        seen.add(fold(tag));
        out.push(tag);
      }
    }
  }
  return out;
}

export const toggleTag = (sel: string[], tag: string): string[] =>
  sel.some((s) => fold(s) === fold(tag)) ? sel.filter((s) => fold(s) !== fold(tag)) : [...sel, tag];

export const pruneSelection = (sel: string[], available: TagCount[]): string[] =>
  sel.filter((s) => available.some((a) => fold(a.tag) === fold(s)));


/** Chips for the tag bar: note tags in order, flagged when in the active filter. */
export const tagBarItems = (tags: string[], selected: string[]): { tag: string; selected: boolean }[] =>
  tags.map((tag) => ({ tag, selected: selected.some((s) => fold(s) === fold(tag)) }));
