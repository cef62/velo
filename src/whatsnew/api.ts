// The What's new window's whole backend surface. It imports nothing that reads or writes notes; the backend refuses
// every other velo command from this window anyway (src-tauri/src/whatsnew.rs). The demo swaps in src/demo/whatsnew-api.ts.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl as open } from "@tauri-apps/plugin-opener";

export type UpdateInfo = { version: string; current_version: string; notes: string };
export type WhatsNewInfo = { update: UpdateInfo | null; theme: "system" | "light" | "dark"; palette: string; font_size: number };
export type InstallEvent = { kind: "progress"; downloaded: number; total: number | null } | { kind: "installing" } | { kind: "failed"; message: string };

export const info = () => invoke<WhatsNewInfo>("whatsnew_info");
/** Asks the main window to save, then install; failures arrive as a `failed` event. */
export const install = () => invoke<void>("whatsnew_install");
export const close = () => getCurrentWindow().close();
export const openUrl = (url: string) => open(url);

/** Download progress, the install step, and a failure reported by the main window. Resolves once listening. */
export async function onInstall(cb: (e: InstallEvent) => void): Promise<void> {
  await Promise.all([
    listen<{ downloaded: number; total: number | null }>("update-progress", (e) => cb({ kind: "progress", ...e.payload })),
    listen("update-installing", () => cb({ kind: "installing" })),
    listen<string>("whatsnew-install-failed", (e) => cb({ kind: "failed", message: e.payload })),
  ]);
}
