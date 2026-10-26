import { expect, test } from "vitest";
import { DEFAULTS } from "../shortcuts";
import { conflictsOf } from "./settingsModel";

test("two actions on one binding point at each other", () => {
  expect(conflictsOf({ ...DEFAULTS, back: "Mod+KeyK" })).toEqual({ back: "forward", forward: "back" });
});

test("none is never a conflict; defaults have none", () => {
  expect(conflictsOf({ ...DEFAULTS, back: "none", forward: "none" })).toEqual({});
  expect(conflictsOf(DEFAULTS)).toEqual({});
});
