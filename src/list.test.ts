import { expect, test } from "vitest";
import type { Hit, Page } from "./api";
import { Results, visibleRange } from "./list";

const PAGE = 200;
const hit = (n: number): Hit => ({ path: `n${n}.md`, title: `Note ${n}`, snippet: "", mtime: n, encrypted: false });
function fakeOver(total: number) {
  let data = Array.from({ length: total }, (_, i) => hit(i));
  const calls: number[] = [];
  const fetch = async (offset: number): Promise<Page> => {
    calls.push(offset);
    return { hits: data.slice(offset, offset + PAGE), has_more: offset + PAGE < data.length };
  };
  return { fetch, calls, mutate: (f: (d: Hit[]) => Hit[]) => (data = f(data)) };
}

test("visibleRange clamps", () => {
  expect(visibleRange(0, 100, 20, 1000)).toEqual([0, 15]);
  expect(visibleRange(19900, 100, 20, 1000)).toEqual([985, 1000]);
  expect(visibleRange(0, 100, 20, 0)).toEqual([0, 0]);
});

test("ensure loads pages lazily", async () => {
  const f = fakeOver(1000);
  const r = new Results(f.fetch);
  await r.reset();
  expect(r.count).toBe(200);
  expect(r.hasMore).toBe(true);
  await r.ensure(450);
  expect(r.count).toBe(600);
  expect(f.calls).toEqual([0, 200, 400]);
  await r.ensure(5000);
  expect(r.count).toBe(1000);
  expect(r.hasMore).toBe(false);
});

test("concurrent ensure does not fetch a page twice", async () => {
  const f = fakeOver(1000);
  const r = new Results(f.fetch);
  await r.reset();
  await Promise.all([r.ensure(250), r.ensure(260)]);
  expect(f.calls).toEqual([0, 200]);
});

test("refresh keeps window and finds the open note", async () => {
  const f = fakeOver(1000);
  const r = new Results(f.fetch);
  await r.reset();
  await r.ensure(450);
  f.mutate((d) => [hit(9999), ...d]); // a new note appears on top
  await r.refresh();
  expect(r.count).toBe(600);
  expect(r.indexOf("n450.md")).toBe(451);
  expect(r.indexOf("gone.md")).toBe(-1);
});

test("stale reset ignored", async () => {
  let slow!: (p: Page) => void;
  const r = new Results((offset) => (offset === 0 && !slow ? new Promise<Page>((res) => (slow = res)) : Promise.resolve({ hits: [hit(2)], has_more: false })));
  const first = r.reset();
  await r.reset();
  slow({ hits: [hit(1)], has_more: false });
  await first;
  expect(r.get(0)?.path).toBe("n2.md");
  expect(r.count).toBe(1);
});

test("10k rows: paging and visible window stay bounded", async () => {
  const f = fakeOver(10_000);
  const r = new Results(f.fetch);
  await r.reset();
  await r.ensure(9_999);
  expect(r.count).toBe(10_000);
  expect(f.calls.length).toBe(50);
  const [a, b] = visibleRange(9_999 * 44, 600, 44, r.count);
  expect(b).toBe(10_000);
  expect(b - a).toBeLessThan(40);
});
