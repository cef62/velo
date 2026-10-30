import { fold } from "./search";
import { formatBinding, GLOBAL_ACTIONS, LABELS, NONE, type Action } from "./shortcuts";

/** One line of the command palette (v2 §2, §3 #7–#8): an action by name with its live binding. */
export type PaletteItem = { action: Action; label: string; binding: string; context?: string; disabled?: string };
export type PaletteGroup = { title: string; items: PaletteItem[] };

const NOTE_ACTIONS: Action[] = ["rename", "extract_note", "merge_note", "toggle_front_matter", "toggle_lock", "delete_note"];
const HIDDEN = new Set<Action>([...GLOBAL_ACTIONS, "context_menu", "command_palette"]); // OS-level keys and the palette itself
export const RECENT_MAX = 5;

export type PaletteState = {
  keys: Record<Action, string>;
  isMac: boolean;
  noteOpen: boolean;
  title: string;
  encrypted: boolean;
  hasSelection: boolean;
  recent: Action[];
};

/** Every runnable action as an item; the note's own actions say why they are disabled. */
export function paletteItem(a: Action, s: PaletteState): PaletteItem {
  const it: PaletteItem = { action: a, label: LABELS[a], binding: s.keys[a] === NONE ? "" : formatBinding(s.keys[a], s.isMac) };
  if (NOTE_ACTIONS.includes(a)) {
    if (!s.noteOpen) it.disabled = "open a note first";
    else if (a === "extract_note" && !s.hasSelection) it.disabled = "select text first";
    else if ((a === "extract_note" || a === "merge_note") && s.encrypted) it.disabled = "locked note";
    else it.context = s.title;
  }
  return it;
}

/** Empty query: Recent (last run), then the open note's actions, then everything else. */
export function paletteGroups(s: PaletteState): PaletteGroup[] {
  const all = (Object.keys(LABELS) as Action[]).filter((a) => !HIDDEN.has(a));
  const recent = s.recent.filter((a) => all.includes(a));
  const note = s.noteOpen ? NOTE_ACTIONS.filter((a) => !recent.includes(a)) : [];
  const rest = all.filter((a) => !recent.includes(a) && !note.includes(a));
  return [
    { title: "Recent", items: recent.map((a) => paletteItem(a, s)) },
    { title: s.title || "Note", items: note.map((a) => paletteItem(a, s)) },
    { title: "All commands", items: rest.map((a) => paletteItem(a, s)) },
  ].filter((g) => g.items.length);
}

/** A query: every action whose label holds it (folded), those starting with it first; disabled ones stay listed. */
export function paletteSearch(query: string, s: PaletteState): PaletteItem[] {
  const q = fold(query.trim());
  if (!q) return paletteGroups(s).flatMap((g) => g.items);
  const all = (Object.keys(LABELS) as Action[]).filter((a) => !HIDDEN.has(a));
  const hits = all.map((a) => ({ a, at: fold(LABELS[a]).indexOf(q) })).filter((x) => x.at >= 0);
  hits.sort((x, y) => (x.at === 0 ? 0 : 1) - (y.at === 0 ? 0 : 1) || LABELS[x.a].localeCompare(LABELS[y.a]));
  return hits.map((x) => paletteItem(x.a, s));
}

/** The recent list after running `a`: most recent first, no repeats, RECENT_MAX long. */
export const pushRecent = (recent: Action[], a: Action): Action[] => [a, ...recent.filter((x) => x !== a)].slice(0, RECENT_MAX);
