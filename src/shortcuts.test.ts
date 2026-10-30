import { expect, test } from "vitest";
import settingsRs from "../src-tauri/src/settings.rs?raw";
import { DEFAULTS, GLOBAL_ACTIONS, LABELS, NONE, overrides, eventToBinding, formatBinding, isAltGraph, matches, normalizeBinding, resolve, validateBinding } from "./shortcuts";

const ev = (code: string, m: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) =>
  ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m });
test("eventToBinding mac", () => {
  expect(eventToBinding(ev("KeyE", { metaKey: true, altKey: true }), true)).toBe("Mod+Alt+KeyE");
  expect(eventToBinding(ev("MetaLeft", { metaKey: true }), true)).toBeNull();
});
test("eventToBinding win uses ctrl as Mod", () => expect(eventToBinding(ev("BracketLeft", { ctrlKey: true }), false)).toBe("Mod+BracketLeft"));
test("matches by code (option dead keys)", () => expect(matches(ev("KeyE", { metaKey: true, altKey: true }), "Mod+Alt+KeyE", true)).toBe(true));
test("matches requires exact modifiers", () => expect(matches(ev("KeyL", { metaKey: true, shiftKey: true }), "Mod+KeyL", true)).toBe(false));
test("format", () => {
  expect(formatBinding("Mod+Alt+KeyE", true)).toBe("⌥⌘E");
  expect(formatBinding("Mod+Shift+KeyP", true)).toBe("⌘⇧P");
  expect(formatBinding("Mod+Shift+KeyP", false)).toBe("Ctrl+Shift+P");
  expect(formatBinding("Mod+BracketLeft", true)).toBe("⌘[");
});
test("validate", () => {
  const m = resolve(undefined);
  expect(validateBinding(m, "back", "KeyA")).toEqual({ ok: false, reason: "needs a modifier" });
  expect(validateBinding(m, "back", "Mod+KeyQ")).toEqual({ ok: false, reason: "reserved by the system" });
  expect(validateBinding(m, "back", "Mod+KeyL")).toEqual({ ok: false, reason: "already used by Focus search" });
  expect(validateBinding(m, "back", "F5")).toEqual({ ok: true });
  expect(validateBinding(m, "back", "Mod+KeyJ")).toEqual({ ok: true }); // its own current binding
});
test("resolve drops unknown and invalid", () => expect(resolve({ bogus: "Mod+KeyB", back: "" }).back).toBe("Mod+KeyJ"));
test("back / forward on ⌘J / ⌘K; old full snapshots move to them, real choices stay", () => {
  expect([DEFAULTS.back, DEFAULTS.forward]).toEqual(["Mod+KeyJ", "Mod+KeyK"]);
  const old = { next_note: "Mod+KeyJ", prev_note: "Mod+KeyK", back: "Mod+BracketLeft", forward: "Mod+BracketRight", rename: "Mod+KeyR" };
  expect(resolve(old)).toMatchObject({ back: "Mod+KeyJ", forward: "Mod+KeyK" });
  expect(resolve(old)).not.toHaveProperty("next_note");
  expect(resolve({ ...old, rename: "Mod+KeyB" }).rename).toBe("Mod+KeyB");
  expect(resolve({ back: "Mod+BracketLeft" }).back).toBe("Mod+BracketLeft"); // chosen after the change: kept
});
test("overrides keeps only non-default bindings", () => {
  expect(overrides({ ...DEFAULTS, rename: "Mod+KeyB" })).toEqual({ rename: "Mod+KeyB" });
});
test("normalizeBinding maps legacy plugin format", () => {
  expect(normalizeBinding("CommandOrControl+Shift+Space")).toBe("Mod+Shift+Space");
  expect(normalizeBinding("cmd+alt+n")).toBe("Mod+Alt+KeyN");
  expect(normalizeBinding("Shift+Option+Control+Super+5")).toBe("Mod+Ctrl+Alt+Shift+Digit5");
  expect(normalizeBinding("CmdOrCtrl+bracketleft")).toBe("Mod+BracketLeft");
  expect(normalizeBinding("Mod+f5")).toBe("Mod+F5");
  expect(normalizeBinding("Mod+KeyB")).toBe("Mod+KeyB");
  for (const bad of ["", "Mod", "Mod+Nope", "Mod+A+B", "Mod+F13"]) expect(normalizeBinding(bad)).toBeNull();
});
test("resolve normalizes saved legacy values", () => expect(resolve({ toggle_window: "Cmd+Alt+N" }).toggle_window).toBe("Mod+Alt+KeyN"));
test("resolve rejects saved bindings that fail the rules", () => {
  expect(resolve({ rename: "KeyR" }).rename).toBe("Mod+KeyR");
  expect(resolve({ rename: "Mod+KeyC" }).rename).toBe("Mod+KeyR");
});
test("AltGr (reported as Ctrl+Alt) never matches on non-mac", () => {
  const altGr = { ...ev("KeyE", { ctrlKey: true, altKey: true }), getModifierState: (k: string) => k === "AltGraph" };
  expect(isAltGraph(altGr, false)).toBe(true);
  expect(matches(altGr, "Mod+Alt+KeyE", false)).toBe(false);
  expect(matches(ev("KeyE", { ctrlKey: true, altKey: true }), "Mod+Alt+KeyE", false)).toBe(true);
});
test("menu accelerators ⌘W/⌘H/⌘M are reserved on mac only", () => {
  const m = resolve(undefined);
  for (const b of ["Mod+KeyW", "Mod+KeyH", "Mod+KeyM"]) {
    expect(validateBinding(m, "rename", b, true)).toEqual({ ok: false, reason: "reserved by the system" });
    expect(validateBinding(m, "rename", b, false)).toEqual({ ok: true });
  }
  expect(resolve({ rename: "Mod+KeyW" }, true).rename).toBe("Mod+KeyR");
  expect(resolve({ rename: "Mod+KeyW" }, false).rename).toBe("Mod+KeyW");
});

test("delete_note defaults to Mod+Backspace and formats as ⌘⌫", () => {
  expect(DEFAULTS.delete_note).toBe("Mod+Backspace");
  expect(formatBinding("Mod+Backspace", true)).toBe("⌘⌫");
});

test("toggle_tags default", () => expect(DEFAULTS.toggle_tags).toBe("Mod+Shift+KeyT"));
test("toggle_layout default", () => expect(DEFAULTS.toggle_layout).toBe("Mod+Shift+KeyJ"));
test("toggle_rich default", () => expect(DEFAULTS.toggle_rich).toBe("Mod+Shift+KeyR"));

test("none clears a shortcut", () => {
  expect(resolve({ back: "none" }).back).toBe("none");
  expect(matches(ev("KeyJ", { metaKey: true }), "none", true)).toBe(false);
  expect(formatBinding("none", true)).toBe("—");
  expect(overrides({ ...DEFAULTS, back: "none" })).toEqual({ back: "none" });
  expect(validateBinding({ ...DEFAULTS, forward: "none" }, "back", "none", true)).toEqual({ ok: true });
});

test("metadata shortcut defaults", () => { expect(DEFAULTS.toggle_info).toBe("Mod+KeyI"); expect(DEFAULTS.toggle_front_matter).toBe("none"); expect(LABELS.toggle_info).toBe("Note info"); });
test("capture is a global action with a non-conflicting default", () => {
  expect(GLOBAL_ACTIONS).toEqual(["toggle_window", "capture"]);
  expect(LABELS.capture).toBe("Quick capture (global)");
  expect(DEFAULTS.capture).toBe("Mod+Alt+Shift+KeyN");
  expect(normalizeBinding(DEFAULTS.capture)).toBe(DEFAULTS.capture); // canonical: a recorded ⌥⇧⌘N must compare equal
  expect(validateBinding(DEFAULTS, "capture", DEFAULTS.capture)).toEqual({ ok: true });
  expect(Object.values(DEFAULTS).filter((b) => b === DEFAULTS.capture)).toHaveLength(1);
});

test("toggle_connections defaults to Mod+Shift+KeyC and does not clash", () => {
  expect(DEFAULTS.toggle_connections).toBe("Mod+Shift+KeyC");
  expect(LABELS.toggle_connections).toBe("Connections");
  const all = Object.values(DEFAULTS).filter((b) => b !== "none");
  expect(new Set(all).size).toBe(all.length);
  expect(validateBinding(DEFAULTS, "toggle_connections", DEFAULTS.toggle_connections)).toEqual({ ok: true });
});

test("extract_note defaults to Mod+Shift+KeyN and does not clash", () => {
  expect(DEFAULTS.extract_note).toBe("Mod+Shift+KeyN");
  expect(LABELS.extract_note).toBe("Move to new note");
  const all = Object.values(DEFAULTS).filter((b) => b !== "none");
  expect(new Set(all).size).toBe(all.length);
});

test("merge_note has no default", () => {
  expect(DEFAULTS.merge_note).toBe(NONE);
  expect(LABELS.merge_note).toBe("Merge into…");
  expect(formatBinding(DEFAULTS.merge_note, true)).toBe("—");
});

test("upgrade: a saved binding equal to a new default wins, the new action gets none", () => {
  const m = resolve({ toggle_sort: "Mod+Shift+KeyD", toggle_window: "Mod+Shift+Alt+KeyN", rename: "Mod+Shift+KeyX" });
  expect(m).toMatchObject({ toggle_sort: "Mod+Shift+KeyD", daily_note: "none", toggle_window: "Mod+Alt+Shift+KeyN", capture: "none", rename: "Mod+Shift+KeyX", toggle_tasks: "none" });
  expect(resolve({ toggle_sort: "Mod+Shift+KeyD", daily_note: "Mod+Shift+KeyD" }).daily_note).toBe("Mod+Shift+KeyD"); // both chosen: a real conflict, shown
});

test("the backend knows the same action ids and capture default (#8)", () => {
  const ids = /pub const ACTIONS: \[&str; \d+\] = \[([^\]]*)\]/.exec(settingsRs)![1].match(/"(\w+)"/g)!.map((q) => q.slice(1, -1));
  expect(ids.sort()).toEqual(Object.keys(DEFAULTS).sort());
  expect(settingsRs).toContain(`const DEFAULT_CAPTURE: &str = "${DEFAULTS.capture}";`);
  expect(settingsRs).toContain(`const DEFAULT_TOGGLE: &str = "${DEFAULTS.toggle_window}";`);
});

test("timeline, export and save_search actions", () => {
  expect(DEFAULTS.toggle_timeline).toBe("Mod+Shift+KeyL");
  expect(DEFAULTS.export).toBe(NONE);
  expect(DEFAULTS.save_search).toBe(NONE);
  expect([LABELS.toggle_timeline, LABELS.export, LABELS.save_search]).toEqual(["Toggle timeline", "Export…", "Save search…"]);
});
