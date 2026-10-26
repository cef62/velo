import type { Settings } from "./api";
import { eventToBinding, isAltGraph, validateBinding, type Action } from "./shortcuts";

export const layoutClass = (l: string): Settings["layout"] => (l === "horizontal" ? "horizontal" : "vertical");

export function clampFont(raw: string, fallback: number): number {
  const n = Math.round(Number(raw));
  return raw.trim() === "" || !Number.isFinite(n) ? fallback : Math.min(32, Math.max(10, n));
}

export interface SettingsForm { layout: string; fontSize: string; sort: string; shortcuts: Record<Action, string> }

/** Form values -> Settings, keeping `cur` where input is blank or invalid. notes_dir is untouched. */
export function toSettings(cur: Settings, f: SettingsForm): Settings {
  return {
    ...cur,
    shortcuts: f.shortcuts,
    layout: f.layout === "horizontal" || f.layout === "vertical" ? f.layout : cur.layout,
    font_size: clampFont(f.fontSize, cur.font_size),
    sort: f.sort === "modified" || f.sort === "title" ? f.sort : cur.sort,
  };
}

// Keys with fixed meanings in the UI; they can't be the key of a binding.
const FIXED = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape", "Tab"];

/** Message if the binding's key is a fixed key, else null. */
export function fixedKeyRefusal(binding: string): string | null {
  const key = binding.split("+").pop()!;
  return FIXED.includes(key) ? `${key} has a fixed meaning and can't be remapped` : null;
}

export interface RecorderStep { recording: Action | null; assign?: string; msg?: string }

/** Recorder state machine: next state for one keydown. `recording: null` = recording ended; keys while idle are ignored. */
export function recorderStep(
  recording: Action | null,
  e: Parameters<typeof eventToBinding>[0] & { getModifierState?: (k: string) => boolean },
  isMac: boolean,
  draft: Record<Action, string>,
): RecorderStep {
  if (!recording || e.code === "Escape") return { recording: null };
  const b = isAltGraph(e, isMac) ? null : eventToBinding(e, isMac);
  if (!b) return { recording }; // bare modifier press
  const v = validateBinding(draft, recording, b, isMac);
  const reason = v.ok ? fixedKeyRefusal(b) : v.reason;
  return reason ? { recording, msg: reason } : { recording: null, assign: b, msg: "" };
}

/** Apply layout class and font size live. */
export function applyLook(s: Settings) {
  const app = document.getElementById("app")!;
  app.classList.remove("vertical", "horizontal");
  app.classList.add(layoutClass(s.layout));
  document.documentElement.style.setProperty("--font-size", `${s.font_size}px`);
}
