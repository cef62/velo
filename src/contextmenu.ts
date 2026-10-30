import { matches, type Action } from "./shortcuts";

export type MenuAction = "open" | "rename" | "toggle_lock" | "copy_link" | "reveal" | "delete_note" | "link_it" | "merge_note";
export type MenuEntry = { id: MenuAction; text: string; accelerator?: string } | "separator";

const MODS: Record<string, string> = { Mod: "CmdOrCtrl", Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift" };
const GLYPHS: Record<string, string> = {
  BracketLeft: "[", BracketRight: "]", Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Semicolon: ";",
  Quote: "'", Backquote: "`", Minus: "-", Equal: "=",
};
const NAMES = new Set("Space Enter Tab Backspace Delete Insert Home End PageUp PageDown ArrowUp ArrowDown ArrowLeft ArrowRight Escape".split(" "));

/** Shortcut binding → Tauri accelerator string, or undefined when the syntax can't express it. */
export function toAccelerator(binding: string): string | undefined {
  const parts = binding.split("+");
  const code = parts.pop()!;
  const mods = parts.map((m) => MODS[m]);
  const key = /^(Key|Digit)(.)$/.exec(code)?.[2] ?? GLYPHS[code] ?? (NAMES.has(code) || /^F([1-9]|1[0-2])$/.test(code) ? code : undefined);
  return key === undefined || mods.includes(undefined as never) ? undefined : [...mods, key].join("+");
}

const REVEAL = { mac: "Show in Finder", windows: "Show in Explorer", linux: "Show in folder" };

// Accelerators are display hints: the popup only fires them while it is open, and the app's capture handler does the real work.
export function menuModel(o: {
  encrypted: boolean;
  platform: "mac" | "windows" | "linux";
  keys: Record<Action, string>;
  isMac: boolean;
}): MenuEntry[] {
  const acc = (a: Action) => {
    const accelerator = toAccelerator(o.keys[a]);
    return accelerator ? { accelerator } : {};
  };
  return [
    { id: "open", text: "Open in editor" },
    { id: "rename", text: "Rename…", ...acc("rename") },
    ...(o.encrypted ? [] : [{ id: "merge_note" as const, text: "Merge into…", ...acc("merge_note") }]),
    { id: "toggle_lock", text: o.encrypted ? "Unlock" : "Lock", ...acc("toggle_lock") },
    { id: "copy_link", text: "Copy link" },
    { id: "reveal", text: REVEAL[o.platform] },
    "separator",
    { id: "delete_note", text: "Move to Trash…", ...acc("delete_note") },
  ];
}

export const linkFor = (title: string): string => `[[${title}]]`;

/** The ContextMenu key always; else the remappable `context_menu` binding (default Shift+F10; "none" = that key only). */
export const isMenuKey = (e: Parameters<typeof matches>[0] & { key: string }, binding: string, isMac: boolean): boolean =>
  e.key === "ContextMenu" || matches(e, binding, isMac);
