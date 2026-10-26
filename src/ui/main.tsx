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
      inDialog: !!document.querySelector("dialog[open], [role=dialog][data-state=open], [role=alertdialog][data-state=open]"),
      inRename: !!t.closest?.("[data-rename]"), // the title bar's rename field carries data-rename (Task 11)
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
void listen<{ done: number; total: number }>("index-progress", (ev) => controller.onIndexProgress(ev.payload.done, ev.payload.total));
void listen("index-done", () => void controller.onIndexDone());
void listen<{ message: string }>("index-error", (ev) => controller.onIndexError(ev.payload.message));

window.addEventListener("blur", () => controller.onBlur());
void getCurrentWindow().onCloseRequested(async (e) => {
  if (!(await controller.requestClose())) e.preventDefault();
});
