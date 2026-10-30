import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as api from "../api";
import { Controller } from "../app/controller";
import { createStore, initialState } from "../app/store";
import { isSearchInput, platform } from "./platform";
import { App } from "./App";

const isMac = navigator.platform.startsWith("Mac");
const store = createStore(initialState(isMac));
const controller = new Controller(store, api, platform, {
  isMac,
  platform: isMac ? "mac" : /Windows/.test(navigator.userAgent) ? "windows" : "linux",
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App controller={controller} store={store} />
  </StrictMode>,
);

// One capture-phase handler: runs before CodeMirror's keymap and the webview defaults (so e.g. ⌘R works from the editor).
window.addEventListener(
  "keydown",
  (e) => {
    const t = e.target as HTMLElement;
    // the focused divider keeps ↑/↓ (and ←/→): they resize instead of stepping the list
    if (t.closest?.("[data-divider]") && e.key.startsWith("Arrow") && !(e.metaKey || e.ctrlKey || e.altKey)) return;
    // a focused saved-search chip opens its own menu, not the selected note's
    if (t.closest?.("[data-saved]") && controller.isMenuKey(e)) return;
    const handled = controller.onKeyDown({
      key: e.key,
      code: e.code,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      getModifierState: (k) => e.getModifierState(k),
      inEditor: !!t.closest?.("[data-editor-host]"),
      inSearchWithText: isSearchInput(t) && (t as HTMLInputElement).value !== "",
      inSearch: isSearchInput(t),
      inDialog: !!t.closest?.("[role=menu]") || !!document.querySelector("dialog[open], [role=dialog][data-state=open], [role=alertdialog][data-state=open]"),
      inRename: !!t.closest?.("[data-rename]"),
    });
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true,
);

void listen<{ paths: string[] }>("notes-changed", (ev) => void controller.onNotesChanged(ev.payload.paths));
void listen("focus-search", () => controller.focusSearch());
void listen("capture", () => void controller.startCapture());
void listen<{ done: number; total: number }>("index-progress", (ev) => controller.onIndexProgress(ev.payload.done, ev.payload.total));
void listen("index-done", () => void controller.onIndexDone());
void listen<{ message: string }>("index-error", (ev) => controller.onIndexError(ev.payload.message));
void listen<{ version: string }>("update-available", (ev) => controller.onUpdateAvailable(ev.payload.version));
void listen<{ downloaded: number; total: number | null }>("update-progress", (ev) => controller.onUpdateProgress(ev.payload.downloaded, ev.payload.total));
void listen("update-installing", () => controller.onUpdateInstalling());
void listen("check-updates", () => void controller.checkUpdates());
void listen<api.AgentWrite>("agent-write", (ev) => void controller.onAgentWrite(ev.payload));

// "today" rolls over at local midnight: refresh the Tasks groups and the due count/badge then.
const armMidnight = () => {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  setTimeout(() => {
    void controller.loadTasks();
    armMidnight();
  }, next.getTime() - now.getTime() + 1000); // +1 s: never fire a hair before midnight
};
armMidnight();
// timers stall while the Mac sleeps: catch a missed midnight when the window comes back
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && controller.refreshIfNewDay());
window.addEventListener("focus", () => controller.refreshIfNewDay());

window.addEventListener("blur", () => controller.onBlur());
void getCurrentWindow().onCloseRequested(async (e) => {
  if (!(await controller.requestClose())) e.preventDefault();
});
