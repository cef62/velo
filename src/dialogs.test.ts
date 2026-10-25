import { expect, test } from "vitest";
import { isLockedPath, passphraseDialogMode, passphraseError } from "./passphrase";
import { clampFont, layoutClass, toSettings } from "./settingsform";

const base = { notes_dir: "/n", hotkey: "A", layout: "vertical" as const, font_size: 14 };

test("dialog wording follows identity file", () => {
  expect(passphraseDialogMode(true)).toEqual({ title: "Enter your velo passphrase", confirm: false });
  expect(passphraseDialogMode(false)).toEqual({ title: "Create a passphrase (used to unlock on other computers)", confirm: true });
});

test("passphrase validation", () => {
  expect(passphraseError(false, "", "")).toBe("Passphrase required");
  expect(passphraseError(false, "a", "")).toBeNull();
  expect(passphraseError(true, "a", "b")).toBe("Passphrases do not match");
  expect(passphraseError(true, "a", "a")).toBeNull();
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
  expect(toSettings(base, { hotkey: " B ", layout: "horizontal", fontSize: "40" })).toEqual({ ...base, hotkey: "B", layout: "horizontal", font_size: 32 });
  expect(toSettings(base, { hotkey: "", layout: "bogus", fontSize: "12" })).toEqual({ ...base, font_size: 12 });
});

test("layout class", () => {
  expect(layoutClass("horizontal")).toBe("horizontal");
  expect(layoutClass("x")).toBe("vertical");
});
