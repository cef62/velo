// Remappable shortcuts. Binding = "+"-joined modifiers (Mod, Ctrl, Alt, Shift, in that order) + one KeyboardEvent.code.
// Mod = ⌘ on macOS, Ctrl elsewhere. Ctrl = physical Control (macOS only).
export type Action =
  | "focus_search" | "toggle_preview" | "rename" | "toggle_lock"
  | "lock_all" | "settings" | "toggle_sort" | "back" | "forward" | "delete_note" | "toggle_tags" | "toggle_rich" | "toggle_layout" | "toggle_window" | "toggle_info" | "toggle_front_matter" | "toggle_tasks" | "toggle_connections" | "capture" | "daily_note" | "extract_note";

/** Handled by the OS-level shortcut in the backend, never by the in-app key handler. */
export const GLOBAL_ACTIONS = ["toggle_window", "capture"] as const;

/** Saved binding meaning "no shortcut". */
export const NONE = "none";

export const DEFAULTS: Record<Action, string> = {
  focus_search: "Mod+KeyL",
  toggle_preview: "Mod+Shift+KeyP",
  rename: "Mod+KeyR",
  toggle_lock: "Mod+Shift+KeyE",
  lock_all: "Mod+Alt+KeyE",
  settings: "Mod+Comma",
  toggle_sort: "Mod+Shift+KeyS",
  back: "Mod+KeyJ",
  forward: "Mod+KeyK",
  delete_note: "Mod+Backspace",
  toggle_tags: "Mod+Shift+KeyT",
  toggle_rich: "Mod+Shift+KeyR",
  toggle_layout: "Mod+Shift+KeyJ",
  toggle_window: "Mod+Shift+Space",
  toggle_info: "Mod+KeyI",
  toggle_front_matter: NONE,
  toggle_tasks: "Mod+Shift+KeyX",
  toggle_connections: "Mod+Shift+KeyC",
  capture: "Mod+Alt+Shift+KeyN", // canonical modifier order, as recorded and as resolve() normalizes saved values
  daily_note: "Mod+Shift+KeyD",
  extract_note: "Mod+Shift+KeyN",
};

export const LABELS: Record<Action, string> = {
  focus_search: "Focus search",
  toggle_preview: "Toggle preview",
  rename: "Rename note",
  toggle_lock: "Lock / unlock note",
  lock_all: "Lock all notes",
  settings: "Settings",
  toggle_sort: "Toggle sort",
  back: "Back",
  forward: "Forward",
  delete_note: "Move note to Trash",
  toggle_tags: "Show / hide tags",
  toggle_rich: "Rich / plain editing",
  toggle_layout: "Vertical / horizontal layout",
  toggle_window: "Show / hide velo (global)",
  toggle_info: "Note info",
  toggle_front_matter: "Show / hide front matter",
  toggle_tasks: "Notes / Tasks",
  toggle_connections: "Connections",
  capture: "Quick capture (global)",
  daily_note: "Today's daily note",
  extract_note: "Move to new note",
};

type Ev = Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;
const MODS = ["Mod", "Ctrl", "Alt", "Shift"] as const;
const RESERVED = new Set(["Mod+KeyQ", "Mod+KeyC", "Mod+KeyV", "Mod+KeyX", "Mod+KeyZ", "Mod+Shift+KeyZ", "Mod+KeyA"]);
const MAC_RESERVED = new Set(["Mod+KeyW", "Mod+KeyH", "Mod+KeyM"]); // macOS menu accelerators win over app bindings
const MODIFIER_CODES = /^(Meta|Control|Alt|Shift|OS)(Left|Right)?$/;
const NAMED = ("Space Comma Period Slash Backslash Semicolon Quote Backquote Minus Equal BracketLeft BracketRight " +
  "Enter Tab Backspace Delete Insert Home End PageUp PageDown ArrowUp ArrowDown ArrowLeft ArrowRight Escape").split(" ");
const MOD_ALIASES: Record<string, string> = {
  mod: "Mod", commandorcontrol: "Mod", cmdorctrl: "Mod", cmdorcontrol: "Mod", command: "Mod", cmd: "Mod", super: "Mod", meta: "Mod",
  ctrl: "Ctrl", control: "Ctrl", alt: "Alt", option: "Alt", shift: "Shift",
};

const isFKey = (key: string) => /^F([1-9]|1[0-2])$/.test(key);

/** Canonical form of a binding (incl. old plugin-format hotkeys like "CommandOrControl+Shift+Space"), or null. */
export function normalizeBinding(s: string): string | null {
  const mods = new Set<string>();
  let key: string | null = null;
  for (const raw of s.split("+")) {
    const t = raw.trim().toLowerCase();
    if (MOD_ALIASES[t]) mods.add(MOD_ALIASES[t]);
    else if (key !== null) return null;
    else if (/^[a-z]$/.test(t)) key = "Key" + t.toUpperCase();
    else if (/^[0-9]$/.test(t)) key = "Digit" + t;
    else {
      const m = /^key([a-z])$/.exec(t) ?? /^digit([0-9])$/.exec(t);
      if (m) key = (t.startsWith("key") ? "Key" + m[1].toUpperCase() : "Digit" + m[1]);
      else key = NAMED.find((n) => n.toLowerCase() === t) ?? (isFKey(t.toUpperCase()) ? t.toUpperCase() : null);
      if (key === null) return null;
    }
  }
  if (key === null) return null;
  return [...MODS.filter((m) => mods.has(m)), key].join("+");
}

/** Defaults overlaid with saved entries that parse; unknown keys dropped. */
/** Settings store only bindings that differ from DEFAULTS, so a changed default reaches everyone who kept it. */
export function overrides(bindings: Record<Action, string>): Partial<Record<Action, string>> {
  return Object.fromEntries((Object.keys(bindings) as Action[]).filter((a) => bindings[a] !== DEFAULTS[a]).map((a) => [a, bindings[a]]));
}

// Older versions saved every binding. Back/forward moved from ⌘[ / ⌘] to ⌘J / ⌘K, taking over list stepping
// (next_note/prev_note, now arrows only), so in such a snapshot (recognised by all four old defaults) those old defaults are not choices.
const OLD_DEFAULTS: Partial<Record<string, string>> = { next_note: "Mod+KeyJ", prev_note: "Mod+KeyK", back: "Mod+BracketLeft", forward: "Mod+BracketRight" };

export function resolve(saved: Record<string, string> | undefined, isMac = false): Record<Action, string> {
  const out = { ...DEFAULTS };
  const mine = new Set<Action>(); // actions with a valid saved binding
  const legacy = saved !== undefined && Object.entries(OLD_DEFAULTS).every(([a, b]) => saved[a] === b);
  for (const a of Object.keys(DEFAULTS) as Action[]) {
    const s = legacy && saved[a] === OLD_DEFAULTS[a] ? undefined : saved?.[a];
    if (s === NONE) { out[a] = NONE; continue; }
    const n = s ? normalizeBinding(s) : null;
    if (n && !basicProblem(n, isMac)) {
      out[a] = n;
      mine.add(a);
    }
  }
  // a default added later (upgrade) never takes a key the user already chose: their binding wins
  for (const a of Object.keys(DEFAULTS) as Action[]) {
    if (!mine.has(a) && out[a] !== NONE && [...mine].some((b) => out[b] === out[a])) out[a] = NONE;
  }
  return out;
}

/** null for pure modifier presses. */
export function eventToBinding(e: Ev, isMac: boolean): string | null {
  if (MODIFIER_CODES.test(e.code)) return null;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const parts = [mod && "Mod", isMac && e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean);
  return [...parts, e.code].join("+");
}

// WebView2 reports AltGr as Ctrl+Alt: ignore it off-mac so typing AltGr characters never fires a Mod+Alt binding.
export const isAltGraph = (e: Ev & { getModifierState?: (k: string) => boolean }, isMac: boolean) =>
  !isMac && !!e.getModifierState?.("AltGraph");

export const matches = (e: Ev & { getModifierState?: (k: string) => boolean }, binding: string, isMac: boolean) =>
  binding !== NONE && !isAltGraph(e, isMac) && eventToBinding(e, isMac) === binding;

const KEY_GLYPHS: Record<string, string> = {
  BracketLeft: "[", BracketRight: "]", Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Semicolon: ";",
  Quote: "'", Backquote: "`", Minus: "-", Equal: "=", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
};

export function formatBinding(binding: string, isMac: boolean): string {
  if (binding === NONE) return "—";
  const parts = binding.split("+");
  const code = parts.pop()!;
  const key = isMac && code === "Backspace" ? "⌫" : (KEY_GLYPHS[code] ?? code.replace(/^(Key|Digit)/, ""));
  if (!isMac) return [...parts.map((m) => (m === "Mod" ? "Ctrl" : m)), key].join("+");
  // ⌃⌥⌘⇧ order, matching the app's existing hints (⌘⇧E, ⌥⌘E).
  const glyph: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Mod: "⌘", Shift: "⇧" };
  return ["Ctrl", "Alt", "Mod", "Shift"].filter((m) => parts.includes(m)).map((m) => glyph[m]).join("") + key;
}

function basicProblem(binding: string, isMac: boolean): string | null {
  const parts = binding.split("+");
  if (!isFKey(parts[parts.length - 1]) && !parts.some((p) => p === "Mod" || p === "Ctrl" || p === "Alt")) return "needs a modifier";
  return RESERVED.has(binding) || (isMac && MAC_RESERVED.has(binding)) ? "reserved by the system" : null;
}

export function validateBinding(
  map: Record<Action, string>,
  action: Action,
  binding: string,
  isMac = false,
): { ok: true } | { ok: false; reason: string } {
  if (binding === NONE) return { ok: true };
  const problem = basicProblem(binding, isMac);
  if (problem) return { ok: false, reason: problem };
  const other = (Object.keys(map) as Action[]).find((a) => a !== action && map[a] === binding);
  return other ? { ok: false, reason: `already used by ${LABELS[other]}` } : { ok: true };
}
