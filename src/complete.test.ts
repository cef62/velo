import { expect, test, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { linkContext, linkInsert, linkSource, tagContext, tagInsert, tagSource, type CompleteSource } from "./complete";
import { prepare } from "./fuzzy";
import type { LinkTarget } from "./api";

const st = (doc: string, pos = doc.length) => {
  const state = EditorState.create({ doc, selection: { anchor: pos }, extensions: [markdown({ base: markdownLanguage })] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
};
const ctx = (doc: string) => linkContext(st(doc), doc.length);

test("linkContext after [[", () => expect(ctx("see [[Mee")).toEqual({ from: 6, query: "Mee" }));

test("linkContext null in code, front matter, after ]] and after |", () => {
  expect(ctx("`[[x`")).toBeNull();
  expect(linkContext(st("`[[x`"), 4)).toBeNull();
  const fm = "---\ntitle: [[x\n---\n";
  expect(linkContext(st(fm), fm.indexOf("x") + 1)).toBeNull();
  expect(ctx("[[a]] b")).toBeNull();
  expect(ctx("[[a|lab")).toBeNull();
  const fenced = "```\n[[x\n```";
  expect(linkContext(st(fenced), fenced.indexOf("x") + 1)).toBeNull();
});

test("link apply writes name and closing brackets", () => {
  let s = st("[[mee");
  let r = s.update(linkInsert(s, 2, 5, "Meeting notes")).state;
  expect(r.doc.toString()).toBe("[[Meeting notes]]");
  expect(r.selection.main.head).toBe(17);
  s = st("[[mee]]", 5);
  r = s.update(linkInsert(s, 2, 5, "Meeting notes")).state;
  expect(r.doc.toString()).toBe("[[Meeting notes]]");
  expect(r.selection.main.head).toBe(17);
});

const target = (name: string, title = name, modified = 0): LinkTarget => ({ name, title, path: `/n/${title}.md`, modified, locked: false });
const source = (targets: LinkTarget[]): CompleteSource => ({ links: () => prepare(targets, (t) => t.name), tags: () => [], onCreate: vi.fn() });
const options = (src: CompleteSource, doc: string) => {
  const s = st(doc);
  return (linkSource(src)(new CompletionContext(s, doc.length, false)) as CompletionResult).options;
};

test("create row only without an exact folded match", () => {
  const src = source([target("Meeting notes"), target("Standup", "Daily standup")]);
  expect(options(src, "[[meeting NOTES").map((o) => o.label)).toEqual(["Meeting notes"]);
  expect(options(src, "[[Brand new idea").map((o) => o.label)).toEqual(['Create "Brand new idea"']);
});

test("alias rows show their title; empty query lists the newest first", () => {
  const src = source([target("Old", "Old", 1), target("Standup", "Daily standup", 5)]);
  const opts = options(src, "[[");
  expect(opts.map((o) => [o.label, o.detail])).toEqual([["Standup", "→ Daily standup"], ["Old", undefined]]);
});

const tctx = (doc: string, pos = doc.length) => tagContext(st(doc, pos), pos);

test("tagContext mid-sentence", () => {
  expect(tctx("see #pro")).toEqual({ from: 5, query: "pro" });
  expect(tctx("(#pro")).toEqual({ from: 2, query: "pro" });
});

test("tagContext null for headings and non-tag hashes", () => {
  for (const d of ["# Title", "## x", "#", "[[a#b", "x#pro", "https://x.io/#pro", "`#pro`"]) expect(tctx(d), d).toBeNull();
  expect(tctx("`#pro`", 5)).toBeNull();
  const fm = "---\ntags: #pro\n---\n";
  expect(tctx(fm, fm.indexOf("pro") + 3)).toBeNull();
});

test("tag apply writes the display spelling and a space", () => {
  let s = st("see #pro");
  let r = s.update(tagInsert(s, 5, 8, "Project")).state;
  expect(r.doc.toString()).toBe("see #Project ");
  s = st("see #pro next", 8);
  r = s.update(tagInsert(s, 5, 8, "Project")).state;
  expect(r.doc.toString()).toBe("see #Project next");
  s = st("see #prox next", 8); // rest of the word is replaced too
  expect(s.update(tagInsert(s, 5, 8, "Project")).state.doc.toString()).toBe("see #Project next");
});

test("tag source ranks by count, label and detail", () => {
  const tags = prepare([{ tag: "proj", count: 1 }, { tag: "Project", count: 3 }], (t) => t.tag);
  const s = st("see #pro");
  const res = tagSource({ ...source([]), tags: () => tags })(new CompletionContext(s, 8, false)) as CompletionResult;
  expect(res.options.map((o) => [o.label, o.detail])).toEqual([["Project", "3"], ["proj", "1"]]);
});
