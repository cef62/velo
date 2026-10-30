import { describe, expect, it } from "vitest";
import { resolve } from "../shortcuts";
import { searchHint } from "./breakpoints";

describe("searchHint", () => {
  const base = (isMac: boolean) => ({ query: "", sel: -1, exactTitleMatch: false, keys: resolve(undefined, isMac), isMac });
  it("empty query shows the focus binding", () => {
    expect(searchHint(base(true))).toEqual(["⌘L"]);
    expect(searchHint(base(false))).toEqual(["Ctrl+L"]);
  });
  it("a highlighted row offers Open", () => {
    expect(searchHint({ ...base(true), query: "a", sel: 0, exactTitleMatch: true })).toEqual(["↩ Open"]);
  });
  it("no exact match offers Create, with matches both", () => {
    expect(searchHint({ ...base(true), query: "a" })).toEqual(["⇧↩ Create"]);
    expect(searchHint({ ...base(true), query: "a", sel: 0 })).toEqual(["↩ Open", "⇧↩ Create"]);
    expect(searchHint({ ...base(false), query: "a", sel: 0 })).toEqual(["Enter Open", "Shift+Enter Create"]);
  });
  it("a none binding shows nothing", () => {
    expect(searchHint({ ...base(true), keys: { ...base(true).keys, focus_search: "none" } })).toEqual([]);
  });
});
