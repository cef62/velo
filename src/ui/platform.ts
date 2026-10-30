import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyFontScale } from "../app/fontscale";
import type { UiPort } from "../app/ports";
import type { AppState } from "../app/store";

// Elements components register so the controller can move focus without knowing the DOM.
let searchInput: HTMLInputElement | null = null;
export const registerSearchInput = (el: HTMLInputElement | null) => void (searchInput = el);
export const isSearchInput = (t: EventTarget | null) => t !== null && t === searchInput;

// The passphrase dialog (Task 12) registers itself here; until then locked notes can't be opened.
type PassphraseFn = UiPort["passphrase"];
let passphrase: PassphraseFn = async () => false;
export const registerPassphrase = (fn: PassphraseFn) => void (passphrase = fn);

// data-theme is always written: "system" resolves through the OS preference and follows its changes.
const dark = window.matchMedia("(prefers-color-scheme: dark)");
let theme: AppState["theme"] = "system";
const writeTheme = () => {
  document.documentElement.dataset.theme = theme === "system" ? (dark.matches ? "dark" : "light") : theme;
};
writeTheme(); // first frame follows the OS before settings load
dark.addEventListener("change", writeTheme);

let lastMenu: { close(): Promise<void> }[] = []; // popup() resolves when shown, so free the previous menu's Rust-side resources on the next open

export const platform: UiPort = {
  focusSearch() {
    searchInput?.focus();
    searchInput?.select();
  },
  confirm: (message, o) => ask(message, { title: o.title, okLabel: o.okLabel, kind: o.kind }),
  passphrase: (req) => passphrase(req),
  async chooseDirectory() {
    const d = await open({ directory: true });
    return typeof d === "string" ? d : null;
  },
  saveFile: (defaultName) => save({ defaultPath: defaultName, filters: [{ name: "Markdown", extensions: ["md"] }] }),
  openUrl: (url) => openUrl(url),
  reveal: (path) => revealItemInDir(path),
  copyText: (t) => navigator.clipboard.writeText(t),
  async popupMenu(specs, anchor) {
    const old = lastMenu;
    lastMenu = [];
    for (const r of old) void r.close().catch(() => {});
    const items = await Promise.all(
      specs.map((m) => (m === "separator" ? PredefinedMenuItem.new({ item: "Separator" }) : MenuItem.new(m))),
    );
    const menu = await Menu.new({ items });
    lastMenu = [...items, menu];
    await menu.popup(anchor ? new LogicalPosition(anchor.x, anchor.y) : undefined);
  },
  rowAnchor(i) {
    // List rows carry data-row={index} (Task 10 keeps it).
    const r = document.querySelector(`[data-row="${i}"]`)?.getBoundingClientRect();
    return r ? { x: r.left + 16, y: r.bottom } : null;
  },
  focusAnchor() {
    const r = document.activeElement?.getBoundingClientRect();
    return r ? { x: r.left + 16, y: r.bottom } : null;
  },
  setWindowTheme(t) {
    void getCurrentWindow()
      .setTheme(t)
      .catch((e) => console.error("setTheme failed", e));
  },
  applyLook(s) {
    theme = s.theme;
    writeTheme();
    applyFontScale(s.fontSize);
    document.documentElement.dataset.layout = s.layout; // the App grid reads it
  },
};
