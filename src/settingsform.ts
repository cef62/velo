import type { Settings } from "./api";

export const layoutClass = (l: string): Settings["layout"] => (l === "horizontal" ? "horizontal" : "vertical");

export function clampFont(raw: string, fallback: number): number {
  const n = Math.round(Number(raw));
  return raw.trim() === "" || !Number.isFinite(n) ? fallback : Math.min(32, Math.max(10, n));
}

export interface SettingsForm { hotkey: string; layout: string; fontSize: string }

/** Form values -> Settings, keeping `cur` where input is blank or invalid. notes_dir is untouched. */
export function toSettings(cur: Settings, f: SettingsForm): Settings {
  return {
    ...cur,
    hotkey: f.hotkey.trim() || cur.hotkey,
    layout: f.layout === "horizontal" || f.layout === "vertical" ? f.layout : cur.layout,
    font_size: clampFont(f.fontSize, cur.font_size),
  };
}

/** Apply layout class and font size live. */
export function applyLook(s: Settings) {
  const app = document.getElementById("app")!;
  app.classList.remove("vertical", "horizontal");
  app.classList.add(layoutClass(s.layout));
  document.documentElement.style.setProperty("--font-size", `${s.font_size}px`);
}
