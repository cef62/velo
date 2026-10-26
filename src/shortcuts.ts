// Remappable shortcuts. Binding = "+"-joined modifiers (Mod, Ctrl, Alt, Shift, in that order) + one KeyboardEvent.code.
// Mod = ⌘ on macOS, Ctrl elsewhere. Ctrl = physical Control (macOS only).
export type Action =
  | "focus_search" | "toggle_preview" | "rename" | "toggle_lock"
  | "lock_all" | "settings" | "toggle_sort" | "back" | "forward" | "delete_note" | "toggle_tags" | "toggle_rich" | "toggle_layout" | "toggle_window";

export const DEFAULTS: Record<Action, string> = {
  focus_search: "Mod+KeyL",
  toggle_preview: "Mod+Shift+KeyP",
  rename: "Mod+KeyR",
  toggle_lock: "Mod+Shift+KeyE",
  lock_all: "Mod+Alt+KeyE",
  settings: "Mod+Comma",
  toggle_sort: "Mod+Shift+KeyS",
  back: "Mod+KeyK",
  forward: "Mod+KeyJ",
  delete_note: "Mod+Backspace",
  toggle_tags: "Mod+Shift+KeyT",
  toggle_rich: "Mod+Shift+KeyR",
  toggle_layout: "Mod+Shift+KeyJ",
  toggle_window: "Mod+Shift+Space",
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

// Older versions saved every binding. Their back/forward defaults (⌘[ / ⌘]) moved to ⌘K / ⌘J when list stepping
// (next_note/prev_note, on ⌘J / ⌘K) was dropped: a saved map with next_note is such a snapshot, so its old defaults are not choices.
const OLD_DEFAULTS: Partial<Record<string, string>> = { back: "Mod+BracketLeft", forward: "Mod+BracketRight" };

export function resolve(saved: Record<string, string> | undefined, isMac = false): Record<Action, string> {
  const out = { ...DEFAULTS };
  const legacy = saved !== undefined && "next_note" in saved;
  for (const a of Object.keys(DEFAULTS) as Action[]) {
    const s = legacy && saved[a] === OLD_DEFAULTS[a] ? undefined : saved?.[a];
    const n = s ? normalizeBinding(s) : null;
    if (n && !basicProblem(n, isMac)) out[a] = n;
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
  !isAltGraph(e, isMac) && eventToBinding(e, isMac) === binding;

const KEY_GLYPHS: Record<string, string> = {
  BracketLeft: "[", BracketRight: "]", Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Semicolon: ";",
  Quote: "'", Backquote: "`", Minus: "-", Equal: "=", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
};

export function formatBinding(binding: string, isMac: boolean): string {
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
  const problem = basicProblem(binding, isMac);
  if (problem) return { ok: false, reason: problem };
  const other = (Object.keys(map) as Action[]).find((a) => a !== action && map[a] === binding);
  return other ? { ok: false, reason: `already used by ${LABELS[other]}` } : { ok: true };
}
