// Demo stand-in for src/whatsnew/api.ts: the What's new page as a browser tab (whatsnew.html?update=big|patch|…).
// Install asks the main demo tab, as the app asks the main window (src/demo/updates.ts `relay`): it refuses with a reason
// or starts the install, and the tab then plays a fake download through the same phase callback the app's Channel
// feeds; nothing is installed. Opened on its own (no main tab), Install stays on "Saving your notes…".
// `?theme=`, `?palette=` and `?font=` set the look, as in the app demo.
import type { Phase, WhatsNewInfo } from "../whatsnew/api";
import { demoUpdate, post, relay } from "./updates";

export type * from "../whatsnew/api";

const q = new URLSearchParams(location.search);
let channel: (p: Phase) => void = () => {};

function play() {
  const total = 12e6;
  for (let done = 0; done <= total; done += 1.5e6) setTimeout(() => channel({ kind: "downloading", downloaded: done, total }), 300 + done / 1e4);
  setTimeout(() => channel({ kind: "installing" }), 1800); // then main's install fails and posts `{ failed }`
}

relay().onmessage = (m) => {
  if (m.data?.failed) channel({ kind: "failed", message: m.data.failed, retry: true });
  else if (m.data?.play) play();
};

export const info = async (onPhase: (p: Phase) => void): Promise<WhatsNewInfo> => {
  channel = onPhase;
  return {
    update: demoUpdate,
    phase: { kind: "idle" },
    theme: q.get("theme") === "dark" ? "dark" : q.get("theme") === "light" ? "light" : "system",
    palette: q.get("palette") ?? "clear",
    font_size: Number(q.get("font")) || 14,
  };
};

export async function install(version: string): Promise<void> {
  channel({ kind: "starting" });
  post({ install: version });
}

export const close = async () => window.close(); // works only for a tab the demo opened
export const openUrl = async (url: string) => void window.open(url, "_blank", "noopener");
