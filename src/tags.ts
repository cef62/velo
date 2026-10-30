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

/** Rust text::fence: [char, length, rest] of a code-fence line (a backtick fence's info has no backtick), or null. */
const fence = (line: string): [string, number, string] | null => {
  const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
  return m && !(m[1][0] === "`" && m[2].includes("`")) ? [m[1][0], m[1].length, m[2]] : null;
};

/** Display spellings of the distinct tags in a note body, fenced and indented code ignored (Rust text::lines rules). */
export function extractTags(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let open: [string, number] | null = null;
  let afterBlank = true;
  let icode = false;
  for (const line of body.split(/\r?\n/)) {
    const t = line.trimStart();
    const f = fence(line);
    const fenced = open !== null || f !== null;
    // CommonMark: only the same char, at least as long, with nothing after it, closes a fence
    if (open && f && f[0] === open[0] && f[1] >= open[1] && !f[2].trim()) open = null;
    else if (!open && f) open = [f[0], f[1]];
    // indented code: 4+ spaces (or a tab) after a blank line or more code; an indented list item is not code
    icode = /^( {4}|\t)/.test(line) && t !== "" && (afterBlank || icode) && !/^([-*+]|\d+[.)])(\[[xX]\])?$/.test(t.split(" ")[0]);
    afterBlank = t === "";
    if (fenced || icode) continue;
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
