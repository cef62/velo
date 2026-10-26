import { expect, test } from "vitest";
import { isMenuKey, linkFor, menuModel, toAccelerator } from "./contextmenu";
import { resolve } from "./shortcuts";

const keys = resolve(undefined, true);
const item = (m: ReturnType<typeof menuModel>, id: string) => m.find((x) => x !== "separator" && x.id === id);

test("model order and labels (mac, plain note)", () => {
  const m = menuModel({ encrypted: false, platform: "mac", keys, isMac: true });
  expect(m.map((x) => (x === "separator" ? "-" : x.id))).toEqual(["open", "rename", "toggle_lock", "copy_link", "reveal", "-", "delete_note"]);
  expect(item(m, "toggle_lock")).toMatchObject({ text: "Lock" });
  expect(item(m, "reveal")).toMatchObject({ text: "Show in Finder" });
  expect(item(m, "delete_note")).toMatchObject({ text: "Move to Trash…", accelerator: "CmdOrCtrl+Backspace" });
});

test("unlock label and platform reveal text", () => {
  const m = menuModel({ encrypted: true, platform: "windows", keys: resolve(undefined, false), isMac: false });
  expect(item(m, "toggle_lock")).toMatchObject({ text: "Unlock" });
  expect(item(m, "reveal")).toMatchObject({ text: "Show in Explorer" });
  expect(item(menuModel({ encrypted: false, platform: "linux", keys, isMac: false }), "reveal")).toMatchObject({ text: "Show in folder" });
});

test("accelerator conversion", () => {
  expect(toAccelerator("Mod+Shift+KeyE")).toBe("CmdOrCtrl+Shift+E");
  expect(toAccelerator("Ctrl+Alt+Digit3")).toBe("Ctrl+Alt+3");
  expect(toAccelerator("Mod+BracketLeft")).toBe("CmdOrCtrl+[");
  expect(toAccelerator("Mod+Backspace")).toBe("CmdOrCtrl+Backspace");
  expect(toAccelerator("Mod+F5")).toBe("CmdOrCtrl+F5");
  expect(toAccelerator("Mod+IntlBackslash")).toBeUndefined();
});

test("link format", () => expect(linkFor("My Note")).toBe("[[My Note]]"));

test("menu key: Shift+F10 needs exactly Shift", () => {
  const k = { key: "F10", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true };
  expect(isMenuKey(k)).toBe(true);
  expect(isMenuKey({ ...k, ctrlKey: true })).toBe(false);
  expect(isMenuKey({ ...k, shiftKey: false })).toBe(false);
  expect(isMenuKey({ ...k, key: "ContextMenu", shiftKey: false })).toBe(true);
});
