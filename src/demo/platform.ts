// Demo UiPort: the real one (src/ui/platform.ts) with every native dialog, menu and window call made in-page.
// vite.demo.config.ts swaps this file in for src/ui/platform.ts everywhere except here, so the import below is the real module.
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { UiPort } from "../app/ports";
import { applyPalette, platform as real } from "../ui/platform";
import { DIR, pinnedNow } from "./api";
import { DemoChrome, demoChrome } from "./DemoChrome";

export * from "../ui/platform";

export const platform: UiPort = {
  ...real,
  // window.confirm would block automation: auto-confirm, and say so
  confirm: async (message) => (demoChrome.toast(`${message} Confirmed — this is a demo.`), true),
  chooseDirectory: async () => DIR,
  saveFile: async (name) => `${DIR}/${name}`,
  openUrl: async (url) => void window.open(url, "_blank", "noopener"),
  reveal: async () => demoChrome.toast("Showing files in Finder isn't available in the demo"),
  popupMenu: async (items, anchor) => demoChrome.menu(items, anchor),
  setWindowTheme: () => {},
};

applyPalette(new URLSearchParams(location.search).get("palette")); // ?palette=<slug>: checks and captures

createRoot(document.body.appendChild(document.createElement("div"))).render(createElement(DemoChrome));

declare global {
  interface Window {
    /**
     * For Playwright: `ready` resolves once the note list has rows; `reset()` reloads the seed vault; `now` is the
     * `?now=` instant in ms (null = real clock). The UI's relative ages read the browser clock, so a capture pins
     * both: `page.clock.setFixedTime(now)` before `goto(".../?now=<same ISO>")`.
     */
    __veloDemo: { ready: Promise<void>; reset(): void; now: number | null };
  }
}
window.__veloDemo = {
  ready: new Promise((resolve) => {
    const check = () => (document.querySelector("[data-row]") ? resolve() : requestAnimationFrame(check));
    check();
  }),
  reset: () => location.reload(), // nothing persists, so a reload is a fresh seed vault
  now: pinnedNow,
};
