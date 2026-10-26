import { expect, test } from "vitest";
import { isLockedPath, passphraseDialogMode, passphraseError } from "./passphrase";
import { DEFAULTS } from "./shortcuts";
import { clampFont, fixedKeyRefusal, layoutClass, recorderStep, toSettings } from "./settingsform";

const base = { notes_dir: "/n", layout: "vertical" as const, font_size: 14, sort: "modified" as const, editor_style: "rich" as const, theme: "system" as const, shortcuts: { toggle_window: "Mod+KeyA", rename: "Mod+KeyR" } };

test("dialog wording follows identity file", () => {
  expect(passphraseDialogMode(true)).toEqual({ title: "Enter your velo passphrase", confirm: false });
  expect(passphraseDialogMode(false)).toEqual({ title: "Create your velo passphrase", confirm: true });
});

test("passphrase validation", () => {
  expect(passphraseError(false, "", "")).toBe("Passphrase required");
  expect(passphraseError(false, "a", "")).toBeNull();
  expect(passphraseError(true, "a", "b")).toBe("Passphrases don't match");
  expect(passphraseError(true, "a", "a")).toBeNull();
});

test("recorder: a conflicting key is assigned (the draft may hold conflicts)", () => {
  expect(recorderStep("back", ev("KeyK"), true, draft)).toEqual({ recording: null, assign: "Mod+KeyK", msg: "" });
});

test("locked path detection", () => {
  expect(isLockedPath("/n/x.md.age")).toBe(true);
  expect(isLockedPath("/n/x.md")).toBe(false);
});

test("font clamps to 10-32, junk falls back", () => {
  expect(clampFont("5", 14)).toBe(10);
  expect(clampFont("99", 14)).toBe(32);
  expect(clampFont("18.4", 14)).toBe(18);
  expect(clampFont("abc", 14)).toBe(14);
});

test("form to settings", () => {
  const f = { layout: "horizontal", fontSize: "40", sort: "title", theme: "dark", shortcuts: { ...base.shortcuts, rename: "Mod+KeyB" } as never };
  expect(toSettings(base, f)).toEqual({ ...base, shortcuts: f.shortcuts, layout: "horizontal", font_size: 32, sort: "title", theme: "dark" });
  expect(toSettings(base, { ...f, layout: "bogus", fontSize: "12", sort: "bogus", theme: "bogus" })).toEqual({ ...base, shortcuts: f.shortcuts, font_size: 12 });
});

test("recorder refuses fixed keys", () => {
  for (const k of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape", "Tab"])
    expect(fixedKeyRefusal(`Mod+${k}`)).toBeTruthy();
  expect(fixedKeyRefusal("Mod+KeyL")).toBeNull();
  expect(fixedKeyRefusal("Mod+Backspace")).toBeNull(); // delete-note default; bare Backspace is refused as "needs a modifier"
});

const ev = (code: string, o = {}) => ({ code, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...o });
const draft = { ...DEFAULTS };

test("recorder: valid key records and ends", () => {
  expect(recorderStep("rename", ev("KeyB"), true, draft)).toEqual({ recording: null, assign: "Mod+KeyB", msg: "" });
});

test("recorder: fixed key refused, stays recording", () => {
  const s = recorderStep("rename", ev("Enter"), true, draft);
  expect(s.recording).toBe("rename");
  expect(s.msg).toBeTruthy();
  expect(s.assign).toBeUndefined();
});

test("recorder: modifier alone keeps recording; Escape cancels; idle ignores", () => {
  expect(recorderStep("rename", ev("MetaLeft"), true, draft)).toEqual({ recording: "rename" });
  expect(recorderStep("rename", ev("Escape"), true, draft)).toEqual({ recording: null });
  expect(recorderStep(null, ev("KeyB"), true, draft)).toEqual({ recording: null });
});

test("layout class", () => {
  expect(layoutClass("horizontal")).toBe("horizontal");
  expect(layoutClass("x")).toBe("vertical");
});

test("recorder: ⌘W refused on mac, Ctrl+W allowed elsewhere", () => {
  expect(recorderStep("rename", ev("KeyW"), true, draft)).toEqual({ recording: "rename", msg: "reserved by the system" });
  expect(recorderStep("rename", ev("KeyW", { metaKey: false, ctrlKey: true }), false, draft)).toEqual({ recording: null, assign: "Mod+KeyW", msg: "" });
});

test("recorderStep: Backspace / Delete clears the shortcut", () => {
  expect(recorderStep("back", ev("Backspace", { metaKey: false }), true, draft)).toEqual({ recording: null, assign: "none", msg: "" });
  expect(recorderStep("back", ev("Delete", { metaKey: false }), true, draft)).toEqual({ recording: null, assign: "none", msg: "" });
});
