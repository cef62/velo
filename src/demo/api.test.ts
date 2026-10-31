import { beforeEach, describe, expect, it } from "vitest";
import * as demo from "./api";
import * as real from "../api";
import type { Api } from "../app/controller";
import { groupByDay } from "../timeline";
import { localToday } from "../tasks";

// Type-level: the demo module must satisfy the controller's Api (= typeof src/api.ts); tsc fails on drift.
const _typed: Api = demo;
void _typed;

const p = (title: string) => `${demo.DIR}/${title}.md`;
const LOCKED = `${demo.DIR}/Private journal.md.age`;
const titles = async (...a: Parameters<typeof demo.search>) => (await demo.search(...a)).hits.map((h) => h.title);

beforeEach(() => demo.resetDemo());

describe("demo api", () => {
  it("exports every function of the real api", () => {
    const missing = Object.keys(real).filter((k) => typeof (real as Record<string, unknown>)[k] === "function" && !(k in demo));
    expect(missing).toEqual([]);
  });

  it("seeds a fresh vault with dates in the last 60 days", async () => {
    const page = await demo.search("", "modified", 0, [], false);
    expect(page.total).toBeGreaterThanOrEqual(28);
    const oldest = Math.min(...page.hits.map((h) => h.mtime));
    expect(Date.now() - oldest).toBeLessThan(61 * 86_400_000);
    expect(page.hits.every((h, i) => i === 0 || page.hits[i - 1].mtime >= h.mtime)).toBe(true);
    expect((await demo.openNote(p("Inbox"))).text).not.toContain("{{");
  });

  it("search: query, tags, no-links and snippets", async () => {
    expect(await titles("lisbon", "title", 0, [], false)).toEqual(expect.arrayContaining(["Trip — Lisbon in spring", "Lisbon packing list"]));
    const recipes = await titles("", "title", 0, ["Recipes"], false);
    expect(recipes).toContain("Recipe — Weeknight dal");
    expect(recipes).not.toContain("Inbox");
    expect(await titles("lentils", "modified", 0, ["recipes"], false)).toEqual(["Recipe — Weeknight dal"]);
    const orphans = await titles("", "title", 0, [], true);
    expect(orphans).toContain("Gift ideas");
    expect(orphans).not.toContain("Project Lantern");
    expect(orphans).not.toContain("Private journal");
    const hit = (await demo.search("coconut", "modified", 0, [], false)).hits[0];
    expect(hit.snippet).toMatch(/coconut/i);
    expect(hit.snippet.startsWith("…")).toBe(true);
  });

  it("tags with counts", async () => {
    const tags = await demo.listTags();
    expect(tags.find((t) => t.tag === "recipes")?.count).toBeGreaterThanOrEqual(4);
    expect(tags.find((t) => t.tag === "personal")?.count).toBe(1); // the locked journal is not counted
  });

  it("connections: links in/out, missing, mentions, shared tags", async () => {
    const c = await demo.connections(p("Project Lantern"));
    expect(c.centre.title).toBe("Project Lantern");
    expect(c.links_out.map((n) => n.title)).toEqual(expect.arrayContaining(["Lantern — sync design", "CRDT reading notes"]));
    const fromPlan = c.links_in.find((n) => n.title === "Weekly plan");
    expect(fromPlan?.context).toContain("[[Project Lantern]]");
    expect(c.tags.find((t) => t.tag === "side-project")?.notes.map((n) => n.title)).toContain("Lantern — sync design");
    expect((await demo.connections(p("Trip — Dolomites hut-to-hut"))).missing).toEqual(["Gear list"]);
    const m = (await demo.connections(p("Interview loop notes"))).mentions.find((x) => x.node.title === "Project Lantern");
    expect(m).toMatchObject({ name: "Project Lantern", count: 1 });
    expect(m?.context).toContain("Project Lantern in disguise");
  });

  it("linkMention wraps the first mention", async () => {
    await demo.linkMention(p("Interview loop notes"), "Project Lantern", 1, null);
    expect((await demo.openNote(p("Interview loop notes"))).text).toContain("it is [[Project Lantern]] in disguise");
    await expect(demo.linkMention(p("Interview loop notes"), "Project Lantern", 1, null)).rejects.toBe("mention-moved");
  });

  it("timeline: newest first, grouped by day, since filter", async () => {
    const rows = await demo.timeline("", [], false, "updated", null);
    const groups = groupByDay(rows, new Date());
    expect(groups[0].label).toBe("Today");
    expect(groups.length).toBeGreaterThan(10);
    const week = await demo.timeline("", [], false, "updated", Date.now() - 7 * 86_400_000);
    expect(week.length).toBeLessThan(rows.length);
    const created = await demo.timeline("", [], false, "created", null);
    expect(created[created.length - 1].title).toBe("Reading list"); // the oldest note
  });

  it("tasks: grouped by due date, toggled in place", async () => {
    const v = await demo.tasks("", [], false);
    expect(v.overdue.length).toBeGreaterThan(0);
    expect(v.due_count).toBe(v.overdue.length + v.today.length);
    expect(v.done).toEqual([]);
    expect((await demo.tasks("", [], true)).done.length).toBeGreaterThan(0);
    const t = v.upcoming[0];
    const r = await demo.toggleTask(t.path, t.line, t.line_text);
    expect(r.line_text).toContain(`@done(${localToday()})`);
    await expect(demo.toggleTask(t.path, t.line, t.line_text)).rejects.toBe("task-moved");
  });

  it("locked note opens only after the passphrase 'demo'", async () => {
    await expect(demo.openNote(LOCKED)).rejects.toBe("locked");
    expect(await titles("part-time", "modified", 0, [], false)).toEqual([]);
    expect((await demo.search("journal", "modified", 0, [], false)).hits[0]).toMatchObject({ encrypted: true, snippet: "" });
    await expect(demo.setupPassphrase("nope")).rejects.toBe("wrong-passphrase");
    expect(await demo.setupPassphrase("demo")).toBeNull();
    expect(await demo.hasIdentity()).toBe(true);
    const doc = await demo.openNote(LOCKED);
    expect(doc).toMatchObject({ encrypted: true, title: "Private journal" });
    const unlockedHit = (await demo.search("part-time", "modified", 0, [], false)).hits;
    expect(unlockedHit.map((h) => h.title)).toEqual(["Private journal"]);
    expect(unlockedHit[0].snippet).toMatch(/^# Private journal/); // the first 120 body chars, as Rust's unlocked group
    expect((await demo.search("side", "modified", 0, [], false)).hits.slice(-1)[0]?.title).toBe("Private journal"); // after the indexed hits
    expect(await titles("", "modified", 0, ["personal"], false)).toContain("Private journal");
    expect((await demo.tasks("", [], false)).upcoming.map((t) => t.title)).toContain("Private journal");
    expect((await demo.timeline("", [], false, "updated", null)).find((r) => r.locked)?.snippet).toBe(""); // never a locked note's text
    expect((await demo.connections(p("Gift ideas"))).centre.preview).not.toBe("");
    await demo.lockAll();
    await expect(demo.openNote(LOCKED)).rejects.toBe("locked");
    expect(await titles("", "modified", 0, ["personal"], false)).not.toContain("Private journal");
  });

  it("rename rewrites links; merge folds one note into another", async () => {
    const r = await demo.renameNote(p("Reading list"), "Books to read", true);
    expect(r.rewritten).toBeGreaterThanOrEqual(3);
    expect((await demo.openNote(p("Welcome to velo"))).text).toContain("[[Books to read]]");
    const m = await demo.mergeNotes(p("Lisbon packing list"), p("Trip — Lisbon in spring"));
    expect(m.path).toBe(p("Trip — Lisbon in spring"));
    const merged = (await demo.openNote(m.path)).text;
    expect(merged).toContain("\n## Lisbon packing list\n\n# Lisbon packing list\n\nFor [[Trip — Lisbon in spring]].");
    expect(merged).toMatch(/^aliases: \[Lisbon packing list\]$/m);
    expect((await demo.openNote(m.path)).meta.aliases).toEqual(["Lisbon packing list"]);
    await expect(demo.openNote(p("Lisbon packing list"))).rejects.toBe("not-found");
  });

  it("mergedText matches Rust merged_text", () => {
    expect(demo.mergedText("---\ntags: [a]\naliases: [T2]\n---\nbody T\n", "Target", "---\ntags: [A, b]\naliases: [S2]\n---\nbody S\n", "Source"))
      .toBe("---\ntags: [a, b]\naliases: [T2, S2, Source]\n---\nbody T\n\n## Source\n\nbody S\n");
    expect(demo.mergedText("x", "Target", "---\ntags: []\n---\n\n\n", "Source")).toBe("---\naliases: [Source]\n---\nx\n\n## Source\n");
    expect(demo.mergedText("", "Target", "body S\n", "Source")).toBe("---\naliases: [Source]\n---\n## Source\n\nbody S\n");
  });

  it("short terms match titles only; export counts tasks", async () => {
    const pa = await titles("pa", "title", 0, [], false);
    expect(pa).toContain("Payments migration");
    expect(pa).not.toContain("Inbox"); // "passport" is in its body only
    const c = await demo.exportPreview({ query: "", tags: ["travel"], no_links: false, by: "updated", since_ms: null, tasks_only: false, title: "" });
    expect(c).toMatchObject({ notes: 3, locked: 0 });
    expect(c.open).toBeGreaterThan(0);
    expect(c.done).toBeGreaterThan(0);
  });

  it("a pinned now drives seed dates, Tasks and writes", async () => {
    const now = new Date(2026, 9, 30, 16, 0);
    demo.resetDemo(now);
    expect((await demo.openNote(p("Inbox"))).text).toContain("Book dentist appointment 📅 2026-11-03");
    const rows = await demo.timeline("", [], false, "updated", null);
    expect(rows[0]).toMatchObject({ title: "Welcome to velo", date: new Date(2026, 9, 30, 8, 5).getTime() });
    const v = await demo.tasks("", [], false);
    expect(v.today.map((t) => t.text)).toEqual(["Meal-prep [[Recipe — Weeknight dal]] for Tuesday"]);
    const r = await demo.toggleTask(v.today[0].path, v.today[0].line, v.today[0].line_text);
    expect(r.line_text).toContain("@done(2026-10-30)");
    expect((await demo.openNote(v.today[0].path)).meta.modified).toBe(now.getTime());
    // an early-morning now: seed times later today are pulled just before it, never hidden or in the future
    demo.resetDemo(new Date(2026, 9, 30, 6, 0));
    const early = await demo.timeline("", [], false, "updated", null);
    expect(early.length).toBe(30);
    expect(Math.max(...early.map((x) => x.date))).toBeLessThan(new Date(2026, 9, 30, 6, 0).getTime());
  });

  it("revisions and settings stay in memory", async () => {
    const revs = await demo.listRevisions(p("Payments migration"));
    expect(revs.length).toBeGreaterThanOrEqual(2);
    expect(await demo.readRevision(p("Payments migration"), revs[0].id)).toContain("# Payments migration");
    const s = await demo.getSettings();
    expect(s.layout).toBe("horizontal");
    await demo.setSettings({ ...s, font_size: 18 });
    expect((await demo.getSettings()).font_size).toBe(18);
    expect(await demo.checkUpdate()).toBeNull();
  });
});
