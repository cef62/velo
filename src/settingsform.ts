import type { Settings } from "./api";
import { FONT_MAX, FONT_MIN } from "./app/fontscale";
import { NONE, eventToBinding, isAltGraph, overrides, validateBinding, type Action } from "./shortcuts";

export function clampFont(raw: string, fallback: number): number {
  const n = Math.round(Number(raw));
  return raw.trim() === "" || !Number.isFinite(n) ? fallback : Math.min(FONT_MAX, Math.max(FONT_MIN, n));
}

export interface SettingsForm { layout: string; fontSize: string; theme: string; writeFrontMatter: boolean; autoUpdateCheck: boolean; agentAccess: boolean; captureTarget: string; inboxTitle: string; shortcuts: Record<Action, string> }

/** Form values -> Settings, keeping `cur` where input is blank or invalid. notes_dir is untouched. */
export function toSettings(cur: Settings, f: SettingsForm): Settings {
  return {
    ...cur,
    shortcuts: overrides(f.shortcuts) as Record<string, string>,
    layout: f.layout === "horizontal" || f.layout === "vertical" ? f.layout : cur.layout,
    font_size: clampFont(f.fontSize, cur.font_size),
    write_front_matter: f.writeFrontMatter,
    auto_update_check: f.autoUpdateCheck,
    agent_access: f.agentAccess,
    capture_target: f.captureTarget === "daily" ? "daily" : "inbox",
    inbox_title: f.inboxTitle.trim() || "Inbox",
    theme: f.theme === "system" || f.theme === "light" || f.theme === "dark" ? f.theme : cur.theme,
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
  if (b === "Backspace" || b === "Delete") return { recording: null, assign: NONE, msg: "" }; // clears the shortcut
  const v = validateBinding(draft, recording, b, isMac);
  const reason = v.ok || v.reason.startsWith("already used") ? fixedKeyRefusal(b) : v.reason; // conflicts stay in the draft and block Save
  return reason ? { recording, msg: reason } : { recording: null, assign: b, msg: "" };
}
