// Release notes from the update feed (latest.json `notes`, written by scripts/release-notes.mjs) → What's new content.
// The feed is signed, but its text is still treated as untrusted: it is only parsed here, and rendered without HTML or
// images (render.ts).
// shortcut: the feed carries the newest release's notes only, so an update that skips versions shows just that release
// (the window links to the full changelog); upgrade by fetching the skipped releases' notes if users ask for them.

export type Item = { title: string; detail: string[] };
export type Group = "highlights" | "fixes" | "other";
export type ReleaseNotes = {
  /** `### Minor Changes` (or Major): new things, shown as highlight cards. */
  highlights: Item[];
  /** `### Patch Changes`: the Fixed list. */
  fixes: Item[];
  /** Bullets under an unknown heading, or with no heading at all. */
  other: Item[];
  /** How many bullets each group really has: the lists above stop at MAX_ITEMS. */
  count: Record<Group, number>;
  /** The notes above the separator (at most MAX_TEXT chars), for when nothing above parses. */
  text: string;
};

/** Items kept per group; the rest are only counted ("and N more" links to the full changelog). */
export const MAX_ITEMS = 60;
export const MAX_TEXT = 20_000;
const MAX_LINE = 1_000; // chars kept of one detail line
const MAX_DETAIL = 20; // detail lines kept per item
/** A first sentence longer than this is no title: it is cut at its colon, or shortened (the full text goes to the detail). */
export const MAX_TITLE = 80;

const HEADING = /^#{1,6}\s+(.*)$/;
const BULLET = /^[-*+]\s+(.*)$/;
const HASH = /^[0-9a-f]{7,40}:\s+/; // changesets' commit prefix, in notes made before the release script dropped it
// a sentence ends at . ! ? before a space and a capital, digit or opening mark: "e.g. this" does not end one
const SENTENCE = /^(.+?[.!?])\s+(?=[A-Z0-9"“'‘`([*_])(.*)$/s;

const groupOf = (heading: string): Group => (/major|minor|feature|new/i.test(heading) ? "highlights" : /patch|fix/i.test(heading) ? "fixes" : "other");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, "")}…` : s);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** First sentence of the bullet's first line = title (its final "." dropped); the rest and later lines = detail. `card`: a highlight,
 *  whose title must stay short (a fix keeps its whole sentence: it reads as a list line). */
export function item(first: string, rest: string[], card = false): Item {
  const line = first.slice(0, MAX_TEXT).replace(HASH, "").trim();
  const m = SENTENCE.exec(line);
  let title = (m ? m[1] : line).replace(/\.$/, "");
  const detail = [...(m ? [m[2]] : []), ...rest].map((l) => l.trim()).filter(Boolean);
  if (card && title.length > MAX_TITLE) {
    const colon = title.indexOf(": ");
    if (colon > 0 && colon <= MAX_TITLE) {
      detail.unshift(capital(`${title.slice(colon + 2)}.`)); // "Added X: what it does" → "Added X" + "What it does."
      title = title.slice(0, colon);
    } else {
      detail.unshift(`${title}.`); // the whole sentence, under a shortened title
      title = clip(title, MAX_TITLE);
    }
  }
  return { title: clip(title, MAX_LINE), detail: detail.slice(0, MAX_DETAIL).map((l) => clip(l, MAX_LINE)) };
}

export function parseReleaseNotes(notes: string): ReleaseNotes {
  const lines = notes.split(/\r?\n/);
  const cut = lines.map((l) => l.trim()).lastIndexOf("---"); // the install hints for GitHub readers follow it
  const body = cut < 0 ? lines : lines.slice(0, cut);
  const out: ReleaseNotes = { highlights: [], fixes: [], other: [], count: { highlights: 0, fixes: 0, other: 0 }, text: clip(body.join("\n").trim(), MAX_TEXT) };
  let group: Group = "other";
  let open: { first: string; rest: string[]; group: Group } | null = null;
  const flush = () => {
    if (!open) return;
    if (out[open.group].length < MAX_ITEMS) out[open.group].push(item(open.first, open.rest, open.group === "highlights"));
    out.count[open.group]++;
    open = null;
  };
  for (const line of body) {
    const h = HEADING.exec(line);
    const b = BULLET.exec(line);
    if (h) {
      flush();
      group = groupOf(h[1]);
    } else if (b) {
      flush();
      open = { first: b[1], rest: [], group };
    } else if (open && (line.trim() === "" || /^\s/.test(line))) {
      if (open.rest.length < MAX_DETAIL) open.rest.push(line); // a changeset's later lines, indented under its bullet
    } else if (line.trim()) {
      flush(); // a loose paragraph: kept in `text` only
    }
  }
  flush();
  return out;
}

/** "3 fixes", "1 fix". */
export const fixesLabel = (n: number) => `${n} ${n === 1 ? "fix" : "fixes"}`;

/** The hero line: the first highlight when its title is short, else the counts ("2 new things and 20 fixes"), else null. */
export function headline(n: ReleaseNotes): string | null {
  const { highlights: h, fixes: f } = n.count;
  if (h && n.highlights[0].title.length <= MAX_TITLE && !n.highlights[0].title.endsWith("…")) return n.highlights[0].title;
  const parts = [h ? (h === 1 ? "1 new thing" : `${h} new things`) : "", f ? fixesLabel(f) : ""].filter(Boolean);
  return parts.length ? parts.join(" and ") : null;
}

/** Whether the headline is the first highlight's title (its card then becomes the hero). */
export const headlineIsFirst = (n: ReleaseNotes) => n.highlights.length > 0 && headline(n) === n.highlights[0].title;
