// Release notes from the update feed (latest.json `notes`, written by scripts/release-notes.mjs) → What's new content.
// The feed is signed, but its text is still treated as untrusted: it is only parsed here, and rendered without HTML.
// shortcut: the feed carries the newest release's notes only, so an update that skips versions shows just that release
// (the window links to the full changelog); upgrade by fetching the skipped releases' notes if users ask for them.

export type Item = { title: string; detail: string[] };
export type ReleaseNotes = {
  /** `### Minor Changes` (or Major): new things, shown as highlight cards. */
  highlights: Item[];
  /** `### Patch Changes`: the Fixed list. */
  fixes: Item[];
  /** Bullets under an unknown heading, or with no heading at all. */
  other: Item[];
  /** Bullets left out by the caps below. */
  more: number;
  /** The notes above the separator, for when nothing above parses. */
  text: string;
};

/** Longer feeds are cut: the window shows a summary, the full notes are a link away. */
export const MAX_CHARS = 20_000;
export const MAX_ITEMS = 60;
const MAX_TITLE = 300;

const HEADING = /^#{1,6}\s+(.*)$/;
const BULLET = /^[-*+]\s+(.*)$/;
const HASH = /^[0-9a-f]{7,40}:\s+/; // changesets' commit prefix, in notes made before the release script dropped it
const SENTENCE = /^(.+?[.!?])\s+(\S.*)$/;

type Group = "highlights" | "fixes" | "other";
const groupOf = (heading: string): Group => (/major|minor|feature|new/i.test(heading) ? "highlights" : /patch|fix/i.test(heading) ? "fixes" : "other");

/** First sentence of the bullet's first line = title (its final "." dropped); the rest and later lines = detail. */
function item(first: string, rest: string[]): Item {
  const line = first.replace(HASH, "").trim();
  const m = SENTENCE.exec(line);
  const title = (m ? m[1] : line).replace(/\.$/, "");
  const detail = [...(m ? [m[2]] : []), ...rest].map((l) => l.trim()).filter(Boolean);
  return { title: title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE)}…` : title, detail };
}

export function parseReleaseNotes(notes: string): ReleaseNotes {
  const lines = notes.slice(0, MAX_CHARS).split(/\r?\n/);
  const cut = lines.map((l) => l.trim()).lastIndexOf("---"); // the install hints for GitHub readers follow it
  const body = cut < 0 ? lines : lines.slice(0, cut);
  const out: ReleaseNotes = { highlights: [], fixes: [], other: [], more: 0, text: body.join("\n").trim() };
  let group: Group = "other";
  let open: { first: string; rest: string[]; group: Group } | null = null;
  const flush = () => {
    if (!open) return;
    const list = out[open.group];
    if (list.length < MAX_ITEMS) list.push(item(open.first, open.rest));
    else out.more++;
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
      open.rest.push(line); // a changeset's later lines, indented under its bullet
    } else if (line.trim()) {
      flush(); // a loose paragraph: kept in `text` only
    }
  }
  flush();
  return out;
}

/** "3 fixes", "1 fix". */
export const fixesLabel = (n: number) => `${n} ${n === 1 ? "fix" : "fixes"}`;

/** The hero line: the first highlight, else the number of fixes, else null (the window says the version is ready). */
export function headline(n: ReleaseNotes): string | null {
  if (n.highlights.length) return n.highlights[0].title;
  if (n.fixes.length) return fixesLabel(n.fixes.length);
  return null;
}
