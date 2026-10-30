import { expect, test } from "vitest";
import { isMenuKey, linkFor, menuModel, toAccelerator } from "./contextmenu";
import { DEFAULTS, NONE, resolve } from "./shortcuts";

const keys = resolve(undefined, true);
const item = (m: ReturnType<typeof menuModel>, id: string) => m.find((x) => x !== "separator" && x.id === id);

test("model order and labels (mac, plain note)", () => {
  const m = menuModel({ encrypted: false, platform: "mac", keys, isMac: true });
  expect(m.map((x) => (x === "separator" ? "-" : x.id))).toEqual(["open", "rename", "merge_note", "toggle_lock", "copy_link", "reveal", "-", "delete_note"]);
  expect(item(m, "merge_note")).toMatchObject({ text: "Merge into…" });
  expect(item(m, "toggle_lock")).toMatchObject({ text: "Lock" });
  expect(item(m, "reveal")).toMatchObject({ text: "Show in Finder" });
  expect(item(m, "delete_note")).toMatchObject({ text: "Move to Trash…", accelerator: "CmdOrCtrl+Backspace" });
});

test("merge entry hidden for encrypted notes", () => {
  expect(item(menuModel({ encrypted: true, platform: "mac", keys, isMac: true }), "merge_note")).toBeUndefined();
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

test("menu key: the default Shift+F10 needs exactly Shift", () => {
  const k = { key: "F10", code: "F10", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true };
  expect(DEFAULTS.context_menu).toBe("Shift+F10");
  expect(isMenuKey(k, DEFAULTS.context_menu, true)).toBe(true);
  expect(isMenuKey({ ...k, ctrlKey: true }, DEFAULTS.context_menu, true)).toBe(false);
  expect(isMenuKey({ ...k, shiftKey: false }, DEFAULTS.context_menu, true)).toBe(false);
  expect(isMenuKey({ ...k, key: "ContextMenu", code: "ContextMenu", shiftKey: false }, DEFAULTS.context_menu, true)).toBe(true);
});

test("menu key: a custom binding replaces Shift+F10; none leaves only the ContextMenu key", () => {
  const ev = { key: "m", code: "KeyM", metaKey: true, ctrlKey: false, altKey: true, shiftKey: false };
  const f10 = { key: "F10", code: "F10", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true };
  const menuKey = { key: "ContextMenu", code: "ContextMenu", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
  expect(isMenuKey(ev, "Mod+Alt+KeyM", true)).toBe(true);
  expect(isMenuKey(ev, "Mod+Alt+KeyM", false)).toBe(false); // Mod = Ctrl off-mac
  expect(isMenuKey(f10, "Mod+Alt+KeyM", true)).toBe(false);
  expect(isMenuKey(menuKey, "Mod+Alt+KeyM", true)).toBe(true);
  expect(isMenuKey(f10, NONE, true)).toBe(false);
  expect(isMenuKey(ev, NONE, true)).toBe(false);
  expect(isMenuKey(menuKey, NONE, true)).toBe(true);
});
