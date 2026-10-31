// In-memory stand-in for src/api.ts (the Tauri backend) in the browser demo build: same exports, same types.
// vite.demo.config.ts swaps it in for src/api.ts; the Rust rules it mirrors are simplified (see each function).
import type { AgentReply, Connections, ExportCounts, ExportRequest, GraphNode, Hit, LinkTarget, MergeResult, Mention, NoteDoc, NoteMeta, Page, RenameResult, RevisionInfo, SaveResult, Settings, TagCount, TagGroup, TaskItem, TaskView, TimelineRow } from "../api";
import { fold } from "../search";
import { extractTags } from "../tags";
import { frontMatterRange, stripFrontMatter } from "../frontmatter";
import { TASK_ITEM } from "../preview";
import { localToday, toggleTaskLine } from "../tasks";
import { version } from "../../package.json";

export type * from "../api";

export const DIR = "/Users/sam/Notes";
const PAGE = 50;
const TAG_MAX = 15; // connections.rs
const CONTEXT_CHARS = 120;
const PASSPHRASE = "demo";
const INVALID = /[/\\:*?"<>|\]]|^\./;

const seed = import.meta.glob("./vault/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

type Rev = RevisionInfo & { text: string };
type Note = { path: string; text: string; created: number; modified: number; hash: string; revs: Rev[] };

let notes = new Map<string, Note>();
let unlocked = false;
let hashSeq = 0;
let settings: Settings;

const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** `{{-3}}` → the date 3 days ago, `{{+2 09:30}}` → in 2 days at 09:30: the seed vault always looks fresh. */
export function expandDates(text: string, now: Date): string {
  return text.replace(/\{\{([+-]\d+)(?: (\d\d:\d\d))?\}\}/g, (_, n: string, time?: string) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + Number(n));
    return time ? `${isoDay(d)}T${time}` : isoDay(d);
  });
}

const fmValue = (text: string, key: string): string | null => {
  const r = frontMatterRange(text);
  return r ? (new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(text.slice(0, r.to))?.[1].trim() ?? null) : null;
};

const newHash = () => `h${++hashSeq}`;
const urlTheme = () => {
  const t = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("theme");
  return t === "dark" || t === "light" ? t : "system";
};

/** Rebuilds the seed vault and settings as of `now`. */
export function resetDemo(now = new Date()) {
  notes = new Map();
  unlocked = false;
  for (const [file, raw] of Object.entries(seed)) {
    const name = file.slice("./vault/".length, -".md".length);
    const path = name.endsWith(".locked") ? `${DIR}/${name.slice(0, -".locked".length)}.md.age` : `${DIR}/${name}.md`;
    const text = expandDates(raw, now);
    const at = (k: string, fallback: number) => {
      const t = new Date(fmValue(text, k) ?? "").getTime();
      return Math.min(isNaN(t) ? fallback : t, now.getTime() - 60_000); // a seed time later today would be in the future
    };
    const modified = at("modified", now.getTime());
    const created = Math.min(at("created", modified), modified);
    notes.set(path, { path, text, created, modified, hash: newHash(), revs: fakeRevisions(text, created, modified) });
  }
  settings = {
    notes_dir: DIR, layout: "horizontal", font_size: 14, sort: "modified", editor_style: "rich", theme: urlTheme(), shortcuts: {},
    write_front_matter: true, show_front_matter: false, info_panel: false, auto_update_check: false, capture_target: "inbox",
    inbox_title: "Inbox", agent_access: false, timeline_sort: "updated",
    saved_searches: [
      { name: "Work", query: "", tags: ["work"], no_links: false },
      { name: "Travel plans", query: "", tags: ["travel"], no_links: false },
    ],
  };
}

/** Two or three earlier versions: the note with its last lines cut off. */
function fakeRevisions(text: string, created: number, modified: number): Rev[] {
  const lines = text.split("\n");
  const n = 2 + (lines.length % 2);
  return Array.from({ length: n }, (_, i) => {
    const t = lines.slice(0, Math.max(1, lines.length - (i + 1) * 3)).join("\n");
    const ts = Math.round(modified - ((i + 1) * (modified - created)) / (n + 1));
    return { id: `${ts}.md`, ts, size: t.length, summary: i === 0 && n === 3 ? "Agent: tidied the task list" : null, agent: i === 0 && n === 3, text: t };
  });
}

// ---- helpers ----

const titleOf = (path: string) => path.slice(DIR.length + 1).replace(/\.md(\.age)?$/, "");
const isLocked = (path: string) => path.endsWith(".age");
const readable = (n: Note) => !isLocked(n.path) || unlocked;
const bodyOf = (n: Note) => stripFrontMatter(n.text);
const termsOf = (q: string) => q.split(/\s+/).map(fold).filter(Boolean);
const get = (path: string): Note => {
  const n = notes.get(path);
  if (!n) throw "not-found";
  return n;
};
const getReadable = (path: string): Note => {
  const n = get(path);
  if (!readable(n)) throw "locked";
  return n;
};
const byTitle = (t: string) => [...notes.values()].find((n) => fold(titleOf(n.path)) === fold(t.trim()));

function tagsOf(n: Note): string[] {
  const fm = (fmValue(n.text, "tags") ?? "").replace(/^\[|\]$/g, "").split(",").map((t) => t.trim().replace(/^#/, "")).filter(Boolean);
  const seen = new Set<string>();
  return [...fm, ...extractTags(bodyOf(n))].filter((t) => !seen.has(fold(t)) && seen.add(fold(t)));
}

const LINK = /\[\[([^\]\n]+?)\]\]/g;
const linkTarget = (inner: string) => inner.split("|")[0].split("#")[0].trim();
/** Distinct [[targets]] in order (first spelling kept). */
function linksOf(body: string): string[] {
  const seen = new Set<string>();
  return [...body.matchAll(LINK)].map((m) => linkTarget(m[1])).filter((t) => t && !seen.has(fold(t)) && seen.add(fold(t)));
}
const linksTo = (n: Note, title: string) => linksOf(bodyOf(n)).some((t) => fold(t) === fold(title));
const hasLinks = (n: Note) => linksOf(bodyOf(n)).some((t) => byTitle(t)) || [...notes.values()].some((o) => o !== n && readable(o) && linksTo(o, titleOf(n.path)));

/** Rust index::preview: the body minus a leading `# title` line, first 120 chars. */
function preview(n: Note): string {
  const body = bodyOf(n);
  const [first, ...rest] = body.split("\n");
  return [...(first.trimEnd() === `# ${titleOf(n.path)}` ? rest.join("\n") : body)].slice(0, 120).join("");
}

/** Rust index::snippet: ~12-word window around the first word containing `term`. */
function snippet(body: string, term: string, fallback: string): string {
  const words = body.split(/\s+/).filter(Boolean);
  const i = words.findIndex((w) => fold(w).includes(term));
  if (i < 0) return fallback;
  const start = Math.max(0, i - 3);
  const end = Math.min(start + 12, words.length);
  return `${start > 0 ? "…" : ""}${words.slice(start, end).join(" ")}${end < words.length ? "…" : ""}`;
}

/** Rust text::context_line: the line holding [a, b), trimmed, cut to `max` chars around the span. */
function contextLine(body: string, a: number, b: number, max = CONTEXT_CHARS): string {
  const ls = Math.max(body.lastIndexOf("\n", a - 1) + 1, 0);
  const nl = body.indexOf("\n", b);
  const line = body.slice(ls, nl < 0 ? body.length : nl);
  if (line.length <= max) return line.trim();
  const before = Math.floor(Math.max(0, max - (b - a)) / 2);
  const ws = Math.max(0, a - ls - before);
  const we = Math.min(line.length, ws + max);
  return `${ws > 0 ? "…" : ""}${line.slice(ws, we).trim()}${we < line.length ? "…" : ""}`;
}

/** Notes passing the shared search filters (query over title + body, every tag, orphans only). */
function filtered(query: string, tags: string[], noLinks: boolean): Note[] {
  const terms = termsOf(query);
  return [...notes.values()].filter((n) => {
    const hay = fold(readable(n) ? `${titleOf(n.path)}\n${bodyOf(n)}` : titleOf(n.path)); // a locked note's text is not indexed
    if (!terms.every((t) => hay.includes(t))) return false;
    if (tags.length && (isLocked(n.path) || !tags.every((t) => tagsOf(n).some((x) => fold(x) === fold(t))))) return false;
    return !noLinks || (!isLocked(n.path) && !hasLinks(n));
  });
}

const meta = (n: Note): NoteMeta => ({ created: n.created, created_src: "frontmatter", modified: n.modified, modified_src: "frontmatter", tags: readable(n) ? tagsOf(n) : [], aliases: [] });
const doc = (n: Note): NoteDoc => ({ path: n.path, title: titleOf(n.path), text: n.text, hash: n.hash, encrypted: isLocked(n.path), meta: meta(n) });
const node = (n: Note, context = ""): GraphNode => ({ path: n.path, title: titleOf(n.path), created: n.created, modified: n.modified, preview: readable(n) ? preview(n) : "", locked: isLocked(n.path), context });

function write(n: Note, text: string) {
  n.text = text;
  n.modified = Date.now();
  n.hash = newHash();
}

function create(title: string, text: string): Note {
  if (!title.trim() || INVALID.test(title)) throw "invalid-title";
  if (byTitle(title)) throw "already-exists";
  const path = `${DIR}/${title.trim()}.md`;
  const now = Date.now();
  const n: Note = { path, text, created: now, modified: now, hash: newHash(), revs: [] };
  notes.set(path, n);
  return n;
}

/** Rewrites [[from]] / [[from|label]] to `to` in every readable note but `skip`; the count of notes changed. */
function rewriteLinks(from: string, to: string, skip?: Note): number {
  let count = 0;
  for (const n of notes.values()) {
    if (n === skip || !readable(n)) continue;
    const text = n.text.replace(LINK, (m, inner: string) => (fold(linkTarget(inner)) === fold(from) ? `[[${to}${inner.slice(inner.split(/[|#]/)[0].length)}]]` : m));
    if (text !== n.text) (write(n, text), count++);
  }
  return count;
}

/** Unlinked whole-word mentions of `name` in `body`, outside [[links]] (simplified Rust text::find_mentions). */
function mentionSpans(body: string, name: string): [number, number][] {
  // shortcut: fold() keeps string length only for precomposed accents; good enough for the demo vault
  const masked = fold(body.replace(LINK, (m) => " ".repeat(m.length)));
  const esc = fold(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...masked.matchAll(new RegExp(`(?<![\\p{L}\\p{N}#/])${esc}(?![\\p{L}\\p{N}])`, "gu"))].map((m) => [m.index, m.index + name.length]);
}

// ---- the API surface (same names and signatures as src/api.ts) ----

export const getSettings = async (): Promise<Settings> => structuredClone(settings);
export const setSettings = async (s: Settings): Promise<void> => void (settings = structuredClone(s));

export const search = async (query: string, sort: "modified" | "title", offset: number, tags: string[], noLinks: boolean): Promise<Page> => {
  const terms = termsOf(query);
  const long = terms.filter((t) => t.length >= 3).sort((a, b) => b.length - a.length)[0];
  const inTitle = (n: Note) => terms.length > 0 && terms.every((t) => fold(titleOf(n.path)).includes(t));
  const rows = filtered(query, tags, noLinks).sort(
    (a, b) => Number(inTitle(b)) - Number(inTitle(a)) || (sort === "title" ? fold(titleOf(a.path)).localeCompare(fold(titleOf(b.path))) : b.modified - a.modified),
  );
  const hits = rows.slice(offset, offset + PAGE).map((n): Hit => {
    const fallback = readable(n) ? preview(n) : "";
    return { path: n.path, title: titleOf(n.path), snippet: long && readable(n) && !inTitle(n) ? snippet(bodyOf(n), long, fallback) : fallback, mtime: n.modified, encrypted: isLocked(n.path) };
  });
  return { hits, has_more: offset + PAGE < rows.length, total: rows.length };
};

export const timeline = async (query: string, tags: string[], noLinks: boolean, by: "created" | "updated", sinceMs: number | null): Promise<TimelineRow[]> =>
  filtered(query, tags, noLinks)
    .map((n): TimelineRow => ({ path: n.path, title: titleOf(n.path), date: by === "created" ? n.created : n.modified, snippet: readable(n) ? preview(n) : "", locked: isLocked(n.path) }))
    .filter((r) => sinceMs === null || r.date >= sinceMs)
    .sort((a, b) => b.date - a.date);

const noCounts = (): ExportCounts => ({ notes: 0, open: 0, done: 0, locked: 0, over_limit: 0, no_tasks: 0, unreadable: 0 });
export const exportPreview = async (r: ExportRequest): Promise<ExportCounts> => {
  const ns = filtered(r.query, r.tags, r.no_links).filter((n) => r.since_ms === null || (r.by === "created" ? n.created : n.modified) >= r.since_ms);
  return { ...noCounts(), notes: ns.length, locked: ns.filter((n) => isLocked(n.path)).length };
};
export const exportText = async (_r: ExportRequest): Promise<string> => ""; // demo: export is a no-op
export const printPage = async (): Promise<void> => {};
export const exportMarkdown = async (_path: string, r: ExportRequest): Promise<ExportCounts> => exportPreview(r);

export const listTags = async (): Promise<TagCount[]> => {
  const counts = new Map<string, TagCount>();
  for (const n of notes.values()) {
    if (isLocked(n.path)) continue; // locked notes are not indexed
    for (const t of tagsOf(n)) {
      const c = counts.get(fold(t)) ?? { tag: t, count: 0 };
      c.count++;
      counts.set(fold(t), c);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
};
export const listTitles = async (): Promise<string[]> => [...notes.keys()].map(titleOf);
export const listLinkTargets = async (): Promise<LinkTarget[]> =>
  [...notes.values()].map((n) => ({ name: titleOf(n.path), title: titleOf(n.path), path: n.path, modified: n.modified, locked: isLocked(n.path) }));
export const createFromSelection = async (title: string, text: string): Promise<string> => create(title, text).path;
export const openNote = async (path: string): Promise<NoteDoc> => doc(getReadable(path));
export const openOrCreate = async (title: string): Promise<NoteDoc & { created: boolean }> => {
  const n = byTitle(title);
  return n ? { ...doc(getReadable(n.path)), created: false } : { ...doc(create(title, "")), created: true };
};
export const saveNote = async (path: string, text: string, _baseHash: string): Promise<SaveResult> => {
  const n = notes.get(path) ?? create(titleOf(path), "");
  if (!readable(n)) throw "locked";
  write(n, text);
  return { kind: "saved", hash: n.hash, front_matter: null, meta: meta(n) };
};

export const tasks = async (query: string, tags: string[], showDone: boolean): Promise<TaskView> => {
  const today = localToday();
  const terms = termsOf(query);
  const all: TaskItem[] = [];
  for (const n of filtered("", tags, false)) {
    if (isLocked(n.path)) continue; // a locked note's tasks leave the index
    const first = n.text.length - bodyOf(n).length;
    const skip = n.text.slice(0, first).split("\n").length - 1;
    bodyOf(n).split("\n").forEach((l, i) => {
      const m = TASK_ITEM.exec(l);
      if (!m) return;
      const due = /📅 (\d{4}-\d{2}-\d{2})/.exec(l)?.[1] ?? null;
      const done_on = /@done\((\d{4}-\d{2}-\d{2})\)/.exec(l)?.[1] ?? null;
      const text = l.slice(m[0].length).replace(/\s*📅 \d{4}-\d{2}-\d{2}/g, "").replace(/\s*@done\(\d{4}-\d{2}-\d{2}\)/g, "").trim();
      const item = { path: n.path, title: titleOf(n.path), line: skip + i, text, due, done: m[2] !== " ", done_on, line_text: l };
      if (terms.every((t) => fold(`${item.title}\n${text}`).includes(t))) all.push(item);
    });
  }
  const open = all.filter((t) => !t.done);
  const byDue = (a: TaskItem, b: TaskItem) => a.due!.localeCompare(b.due!);
  const overdue = open.filter((t) => t.due && t.due < today).sort(byDue);
  const dueToday = open.filter((t) => t.due === today);
  return {
    overdue,
    today: dueToday,
    upcoming: open.filter((t) => t.due && t.due > today).sort(byDue),
    no_date: open.filter((t) => !t.due),
    done: showDone ? all.filter((t) => t.done).sort((a, b) => (b.done_on ?? "").localeCompare(a.done_on ?? "")) : [],
    due_count: overdue.length + dueToday.length,
  };
};
export const toggleTask = async (path: string, line: number, expected: string): Promise<{ line: number; line_text: string }> => {
  const n = getReadable(path);
  const lines = n.text.split("\n");
  const next = lines[line] === expected ? toggleTaskLine(expected, localToday()) : null;
  if (next === null) throw "task-moved";
  lines[line] = next;
  write(n, lines.join("\n"));
  return { line, line_text: next };
};
const captureTitle = () => (settings.capture_target === "daily" ? localToday() : settings.inbox_title);
export const captureTask = async (text: string): Promise<string> => {
  if (!text.trim()) throw "empty";
  const n = byTitle(captureTitle()) ?? create(captureTitle(), `# ${captureTitle()}\n`);
  if (!readable(n)) throw "locked";
  write(n, `${n.text}${n.text.endsWith("\n") ? "" : "\n"}- [ ] ${text.trim()}\n`);
  return n.path;
};
export const captureTargetTitle = async (): Promise<{ title: string; path: string | null }> => ({ title: captureTitle(), path: byTitle(captureTitle())?.path ?? null });
export const captureDone = async (_hide: boolean): Promise<void> => {};
export const setBadge = async (_count: number): Promise<void> => {};

export const renameNote = async (path: string, newTitle: string, rewrite: boolean): Promise<RenameResult> => {
  const n = getReadable(path);
  const old = titleOf(path);
  if (!newTitle.trim() || INVALID.test(newTitle)) throw "invalid-title";
  const clash = byTitle(newTitle);
  if (clash && clash !== n) throw "already-exists";
  notes.delete(path);
  n.path = `${DIR}/${newTitle.trim()}${isLocked(path) ? ".md.age" : ".md"}`;
  notes.set(n.path, n);
  return { path: n.path, rewritten: rewrite ? rewriteLinks(old, newTitle.trim(), n) : 0 };
};

export const connections = async (path: string): Promise<Connections> => {
  const c = getReadable(path);
  const title = titleOf(path);
  const body = bodyOf(c);
  const others = [...notes.values()].filter((n) => n !== c);
  const targets = linksOf(body);
  const out = targets.map(byTitle).filter((n): n is Note => !!n && n !== c);
  const links_in = others
    .filter((n) => readable(n) && linksTo(n, title))
    .map((n) => {
      if (isLocked(n.path)) return node(n); // a locked source shows its title and nothing else
      const b = bodyOf(n);
      const m = [...b.matchAll(LINK)].find((x) => fold(linkTarget(x[1])) === fold(title))!;
      return node(n, contextLine(b, m.index, m.index + m[0].length));
    });
  const tags = tagsOf(c).map((tag): TagGroup => {
    const ns = others.filter((n) => readable(n) && tagsOf(n).some((t) => fold(t) === fold(tag)));
    return { tag, count: ns.length, notes: ns.length > TAG_MAX ? [] : ns.map((n) => node(n)) };
  });
  const mentions: Mention[] = [];
  for (const n of others) {
    if (out.includes(n)) continue;
    const spans = mentionSpans(body, titleOf(n.path));
    if (!spans.length) continue;
    const [a, b] = spans[0];
    mentions.push({ node: node(n), name: body.slice(a, b), count: spans.length, context: isLocked(path) ? "" : contextLine(body, a, b) });
  }
  mentions.sort((x, y) => y.node.modified - x.node.modified);
  return { centre: node(c), links_out: out.map((n) => node(n)), links_in, tags, mentions, missing: targets.filter((t) => !byTitle(t)) };
};
export const linkMention = async (path: string, targetTitle: string, expectedCount: number, editorText: string | null): Promise<string | null> => {
  const n = getReadable(path);
  const text = editorText ?? n.text;
  const start = text.length - stripFrontMatter(text).length;
  const spans = mentionSpans(text.slice(start), targetTitle);
  if (spans.length !== expectedCount) throw "mention-moved";
  const [a, b] = spans[0].map((x) => x + start);
  const next = `${text.slice(0, a)}[[${text.slice(a, b)}]]${text.slice(b)}`;
  if (editorText !== null) return next;
  write(n, next);
  return null;
};
export const backlinkCount = async (title: string): Promise<number> => [...notes.values()].filter((n) => readable(n) && fold(titleOf(n.path)) !== fold(title) && linksTo(n, title)).length;

function move(path: string, to: string): string {
  const n = getReadable(path);
  if (notes.has(to)) throw "already-exists";
  notes.delete(path);
  n.path = to;
  notes.set(to, n);
  return to;
}
export const lockNote = async (path: string): Promise<string> => move(path, `${path}.age`);
export const unlockNote = async (path: string): Promise<string> => move(path, path.replace(/\.age$/, ""));
export const lockAll = async (): Promise<void> => void (unlocked = false);
export const deleteNote = async (path: string): Promise<void> => void notes.delete(get(path).path);
export const mergeNotes = async (source: string, target: string): Promise<MergeResult> => {
  if (source === target) throw "same-note";
  const s = get(source);
  const t = get(target);
  if (isLocked(source) || isLocked(target)) throw "locked";
  write(t, `${t.text.replace(/\n*$/, "")}\n\n${bodyOf(s).trim()}\n`);
  notes.delete(source);
  return { path: target, rewritten: rewriteLinks(titleOf(source), titleOf(target)), trash_error: null };
};
export const listRevisions = async (path: string): Promise<RevisionInfo[]> => getReadable(path).revs.map(({ text: _, ...r }) => r);
export const readRevision = async (path: string, id: string): Promise<string> => {
  const r = getReadable(path).revs.find((x) => x.id === id);
  if (!r) throw "not-found";
  return r.text;
};

// agents and the updater do not exist in the demo
export const agentWriteClaim = async (_id: number): Promise<boolean> => false;
export const agentWriteDone = async (_id: number, _result: AgentReply): Promise<void> => {};
export const snapshotAgent = async (_path: string, _summary: string): Promise<string | null> => null;
export const dropAgentSnapshot = async (_path: string, _id: string): Promise<void> => {};
export const snapshotText = async (_path: string, _text: string): Promise<void> => {};
export const agentSetupCommand = async (): Promise<string> => "claude mcp add velo -- /Applications/velo.app/Contents/MacOS/velo --mcp";
export const hasIdentity = async (): Promise<boolean> => unlocked;
export const setupPassphrase = async (passphrase: string): Promise<string | null> => {
  if (passphrase !== PASSPHRASE) throw "wrong-passphrase";
  unlocked = true;
  return null;
};
export const identityFileExists = async (): Promise<boolean> => true;
export const indexStatus = async (): Promise<[number, number] | null> => null;
export const checkUpdate = async (): Promise<{ version: string } | null> => null;
export const installUpdate = async (): Promise<void> => {};
export const appVersion = async (): Promise<string> => version;

resetDemo();
