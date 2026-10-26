import { expect, test } from "vitest";
import { eventToBinding, formatBinding, isAltGraph, matches, normalizeBinding, resolve, validateBinding } from "./shortcuts";

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
  expect(validateBinding(m, "back", "Mod+BracketLeft")).toEqual({ ok: true }); // its own current binding
});
test("resolve drops unknown and invalid", () => expect(resolve({ bogus: "Mod+KeyB", back: "" }).back).toBe("Mod+BracketLeft"));
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
