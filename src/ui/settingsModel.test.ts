import { expect, test } from "vitest";
import { DEFAULTS, resolve } from "../shortcuts";
import { conflictsOf } from "./settingsModel";

test("two actions on one binding point at each other", () => {
  expect(conflictsOf({ ...DEFAULTS, back: "Mod+KeyK" })).toEqual({ back: "forward", forward: "back" });
});

test("none is never a conflict; defaults have none", () => {
  expect(conflictsOf({ ...DEFAULTS, back: "none", forward: "none" })).toEqual({});
  expect(conflictsOf(DEFAULTS)).toEqual({});
});

test("upgrade: a saved binding equal to a new default does not block Save", () => {
  expect(conflictsOf(resolve({ toggle_sort: "Mod+Shift+KeyD", toggle_window: "Mod+Shift+Alt+KeyN" }))).toEqual({});
});
