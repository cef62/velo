import { expect, test } from "vitest";
import { highlightRanges, markHtml } from "./highlight";

test("folded match maps back to original indices", () => expect(highlightRanges("Café crème", "cafe")).toEqual([[0, 4]]));
test("each term highlights, sorted", () => expect(highlightRanges("Café crème", "creme cafe")).toEqual([[0, 4], [5, 10]]));
test("overlapping matches merge", () => expect(highlightRanges("aaa", "aa")).toEqual([[0, 3]]));
test("empty query highlights nothing", () => expect(highlightRanges("x", "")).toEqual([]));
test("astral characters keep UTF-16 offsets", () => expect(highlightRanges("😀 cafe", "cafe")).toEqual([[3, 7]]));
test("compatibility forms stay in bounds", () => {
  const text = "Ｉstanbul";
  for (const [s, e] of highlightRanges(text, "istanbul")) {
    expect(s).toBeGreaterThanOrEqual(0);
    expect(e).toBeLessThanOrEqual(text.length);
    expect(s).toBeLessThan(e);
  }
});

test("markHtml marks matches in text, never inside tags or entities (#8)", () => {
  expect(markHtml('buy <a href="milk">milk</a> &amp; eggs', "milk", "m")).toBe('buy <a href="milk"><mark class="m">milk</mark></a> &amp; eggs');
  expect(markHtml("a &amp; b", "amp", "m")).toBe("a &amp; b");
  expect(markHtml("a &amp; b", "&", "m")).toBe('a <mark class="m">&amp;</mark> b');
  expect(markHtml("<code>x</code>", "", "m")).toBe("<code>x</code>");
});
