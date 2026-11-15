// The What's new window's whole backend surface. It imports nothing that reads or writes notes; the backend refuses
// every other velo command from this window anyway (src-tauri/src/whatsnew.rs). The window has no event permission:
// install progress arrives over a Channel scoped to it. The demo swaps in src/demo/whatsnew-api.ts.
import { Channel, invoke } from "@tauri-apps/api/core";
import { openUrl as open } from "@tauri-apps/plugin-opener";

export type UpdateInfo = { version: string; current_version: string; notes: string };
/** update.rs `Phase`. `retry`: the update is still there to install. */
export type Phase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "downloading"; downloaded: number; total: number | null }
  | { kind: "installing" }
  | { kind: "failed"; message: string; retry: boolean };
export type WhatsNewInfo = { update: UpdateInfo | null; phase: Phase; theme: "system" | "light" | "dark"; palette: string; font_size: number };

/** The window's data and the install's current phase; `onPhase` gets every later change. */
export function info(onPhase: (p: Phase) => void): Promise<WhatsNewInfo> {
  const ch = new Channel<Phase>();
  ch.onmessage = onPhase;
  return invoke<WhatsNewInfo>("whatsnew_info", { onPhase: ch });
}
/** Asks the main window to save, then install `version`; the outcome arrives as phases. */
export const install = (version: string) => invoke<void>("whatsnew_install", { version });
export const close = () => invoke<void>("whatsnew_close");
export const openUrl = (url: string) => open(url);
