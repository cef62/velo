import type { MenuEntry } from "../contextmenu";
import type { AppState } from "./store";

/** A native menu entry with the action it runs when picked. */
export type MenuSpec = (Exclude<MenuEntry, "separator"> & { action: () => void }) | "separator";

/** Every side effect the controller needs from the UI or the platform. */
export interface UiPort {
  focusSearch(): void; // focus + select text
  confirm(message: string, o: { title: string; okLabel?: string; kind?: "warning" | "info" }): Promise<boolean>;
  passphrase(req: { mode: "create" | "unlock"; context: string | null; submit: (pw: string) => Promise<void> }): Promise<boolean>;
  chooseDirectory(): Promise<string | null>;
  saveFile(defaultName: string): Promise<string | null>; // native save dialog: the chosen path, null = cancelled
  nextFrame(): Promise<void>; // resolves after the next animation frame, once React has committed
  openUrl(url: string): Promise<void>;
  reveal(path: string): Promise<void>;
  copyText(t: string): Promise<void>;
  /**
   * Native menu. Resolves once the menu is shown (not when it closes), so the implementation must close the
   * previous menu and its items (freeing their Rust-side resources) before building the next one, swallowing close errors.
   */
  popupMenu(items: MenuSpec[], anchor: { x: number; y: number } | null): Promise<void>;
  rowAnchor(i: number): { x: number; y: number } | null; // keyboard menu anchor (bottom-left of row + 16px)
  focusAnchor(): { x: number; y: number } | null; // keyboard menu anchor at the focused element (bottom-left + 16px)
  setWindowTheme(t: "light" | "dark" | null): void;
  applyLook(s: { theme: AppState["theme"]; fontSize: number; layout: AppState["layout"] }): void; // data-theme, font scale, layout
}
