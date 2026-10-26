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
    return { hits: data.slice(offset, offset + PAGE), has_more: offset + PAGE < data.length, total: offset === 0 ? data.length : 0 };
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
  const r = new Results((offset) => (offset === 0 && !slow ? new Promise<Page>((res) => (slow = res)) : Promise.resolve({ hits: [hit(2)], has_more: false, total: 0 })));
  const first = r.reset();
  await r.reset();
  slow({ hits: [hit(1)], has_more: false, total: 0 });
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

test("ensure started during a slow reset leaves rows contiguous", async () => {
  const resolvers: Record<number, (p: Page) => void> = {};
  const all = Array.from({ length: 1000 }, (_, i) => hit(i));
  let first = true;
  const r = new Results((offset) => {
    if (first) { first = false; return Promise.resolve({ hits: all.slice(0, 600), has_more: true, total: 0 }); } // initial load of 600 rows
    return new Promise<Page>((res) => (resolvers[offset] = res));
  });
  await r.reset();
  const reset = r.reset(); // slow page 0
  const ens = r.ensure(700); // starts with stale offset 600
  resolvers[0]({ hits: all.slice(0, 200), has_more: true, total: 0 });
  await reset;
  resolvers[600]({ hits: all.slice(600, 800), has_more: true, total: 0 });
  resolvers[200]?.({ hits: all.slice(200, 400), has_more: true, total: 0 });
  await Promise.race([ens, new Promise((res) => setTimeout(res, 50))]);
  for (let i = 0; i < r.count; i++) expect(r.get(i)?.path).toBe(`n${i}.md`);
});
