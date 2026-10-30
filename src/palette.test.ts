import { expect, test } from "vitest";
import { paletteGroups, paletteSearch, pushRecent, type PaletteState } from "./palette";
import { resolve } from "./shortcuts";

const base: PaletteState = { keys: resolve(undefined, true), isMac: true, noteOpen: true, title: "Velo roadmap", encrypted: false, hasSelection: false, recent: [] };

test("empty query: Recent, then the note's actions, then the rest; nothing twice; OS-level keys and the palette itself are not listed", () => {
  const groups = paletteGroups({ ...base, recent: ["lock_all", "rename"] });
  expect(groups.map((g) => g.title)).toEqual(["Recent", "Velo roadmap", "All commands"]);
  expect(groups[0].items.map((i) => i.action)).toEqual(["lock_all", "rename"]);
  expect(groups[1].items.map((i) => i.action)).toEqual(["extract_note", "merge_note", "toggle_front_matter", "toggle_lock", "delete_note"]);
  const all = groups.flatMap((g) => g.items.map((i) => i.action));
  expect(new Set(all).size).toBe(all.length);
  expect(all).not.toContain("toggle_window");
  expect(all).not.toContain("capture");
  expect(all).not.toContain("context_menu");
  expect(all).not.toContain("command_palette");
  expect(groups[0].items[0]).toMatchObject({ label: "Lock all notes", binding: "⌥⌘E" });
});

test("no note open: no note group, and the note's actions say why they are disabled", () => {
  const groups = paletteGroups({ ...base, noteOpen: false, title: "" });
  expect(groups.map((g) => g.title)).toEqual(["All commands"]);
  expect(groups[0].items.find((i) => i.action === "rename")?.disabled).toBe("open a note first");
});

test("disabled reasons: select text first, locked note", () => {
  expect(paletteSearch("move", base).find((i) => i.action === "extract_note")).toMatchObject({ disabled: "select text first" });
  const ok = paletteSearch("move", { ...base, hasSelection: true }).find((i) => i.action === "extract_note")!;
  expect(ok.context).toBe("Velo roadmap");
  expect(ok.disabled).toBeUndefined();
  expect(paletteSearch("merge", { ...base, encrypted: true })[0]).toMatchObject({ action: "merge_note", disabled: "locked note" });
});

test("typing: label matches, starts-with first, unbound actions show no binding", () => {
  const hits = paletteSearch("lock", base);
  expect(hits.map((i) => i.action)).toEqual(["toggle_lock", "lock_all"]);
  expect(paletteSearch("EXPORT", base)[0]).toMatchObject({ action: "export", binding: "" });
  expect(paletteSearch("zzz", base)).toEqual([]);
});

test("pushRecent: most recent first, no repeats, five long", () => {
  expect(pushRecent(["a", "b"] as never, "b" as never)).toEqual(["b", "a"]);
  expect(pushRecent(["1", "2", "3", "4", "5"] as never, "6" as never)).toEqual(["6", "1", "2", "3", "4"]);
});
