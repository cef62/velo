// Demo stand-in for src/whatsnew/api.ts: the What's new page as a browser tab (whatsnew.html?update=big|patch).
// Install plays a fake download; nothing is installed. `?theme=` and `?palette=` set the look, as in the app demo.
import type { InstallEvent, WhatsNewInfo } from "../whatsnew/api";
import { demoUpdate } from "./updates";

export type * from "../whatsnew/api";

const q = new URLSearchParams(location.search);
let listener: (e: InstallEvent) => void = () => {};

export const info = async (): Promise<WhatsNewInfo> => ({
  update: demoUpdate,
  theme: q.get("theme") === "dark" ? "dark" : q.get("theme") === "light" ? "light" : "system",
  palette: q.get("palette") ?? "clear",
  font_size: Number(q.get("font")) || 14,
});

export async function install(): Promise<void> {
  const total = 12e6;
  for (let done = 0; done <= total; done += 1.5e6) setTimeout(() => listener({ kind: "progress", downloaded: done, total }), 300 + done / 1e4);
  setTimeout(() => listener({ kind: "installing" }), 1800);
  setTimeout(() => listener({ kind: "failed", message: "This is a demo: nothing was installed." }), 4000);
}

export const close = async () => window.close(); // works only for a tab the demo opened
export const openUrl = async (url: string) => void window.open(url, "_blank", "noopener");
export const onInstall = async (cb: (e: InstallEvent) => void) => void (listener = cb);
