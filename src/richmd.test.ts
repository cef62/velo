import { expect, test } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { buildDecorations } from "./richmd";

/** Hidden text and marked (class → text) spans, with the cursor at `cursor`. */
function decos(doc: string, cursor = doc.length, exists = (_: string) => true) {
  const state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor), extensions: [markdown({ base: markdownLanguage })] });
  ensureSyntaxTree(state, doc.length, 5000);
  const hidden: string[] = [], marks: string[] = [], lines: string[] = [], widgets: string[] = [];
  buildDecorations(state, { exists }).between(0, doc.length, (from, to, d) => {
    const spec = d.spec as { class?: string; widget?: { constructor: { name: string } } };
    if (from === to && spec.class) lines.push(`${spec.class}@${state.doc.lineAt(from).number}`);
    else if (spec.widget) widgets.push(`${spec.widget.constructor.name}:${doc.slice(from, to)}`);
    else if (spec.class) marks.push(`${spec.class}:${doc.slice(from, to)}`);
    else hidden.push(doc.slice(from, to));
  });
  return { hidden, marks, lines, widgets };
}

test("marks hidden off the cursor line, shown on it", () => {
  const doc = "# Title\n\nsome **bold** and *it* ~~x~~ `c`\n\nend";
  expect(decos(doc).hidden).toEqual(["# ", "**", "**", "*", "*", "~~", "~~", "`", "`"]);
  expect(decos(doc, 3).hidden).toEqual(["**", "**", "*", "*", "~~", "~~", "`", "`"]); // cursor in the heading
  expect(decos(doc, 12).hidden).toEqual(["# "]); // cursor on the paragraph
});

test("links: label marked with its url, brackets hidden off-line", () => {
  const { hidden, marks } = decos("see [docs](https://x.y) ok\n\nz");
  expect(marks).toEqual(["cm-rich-link:docs"]);
  expect(hidden).toEqual(["[", "](https://x.y)"]);
});

test("wikilinks: title marked, missing ones flagged, brackets hidden off-line; inner [x] not a link", () => {
  const { hidden, marks } = decos("a [[Here]] b [[ Gone ]]\n\nz", undefined, (t) => t === "Here");
  expect(marks).toEqual(["cm-rich-wikilink:Here", "cm-rich-wikilink cm-rich-missing: Gone "]);
  expect(hidden).toEqual(["[[", "]]", "[[", "]]"]);
});

test("tags follow the tag rule and skip code and urls", () => {
  const { marks } = decos("#work and (#idea) a#no #123 `#code` [l](#anchor)\n\n```\n#fenced\n```\n\nz");
  expect(marks).toEqual(["cm-rich-tag:#work", "cm-rich-tag:#idea", "cm-rich-link:l"]);
});

test("lists: bullets and task checkboxes off-line, raw on the cursor line", () => {
  const doc = "- a\n- [ ] todo\n- [x] done\n1. one\n\nz";
  expect(decos(doc).widgets).toEqual(["Bullet:-", "Check:- [ ]", "Check:- [x]"]);
  expect(decos(doc, 6).widgets).toEqual(["Bullet:-", "Check:- [x]"]); // cursor on the todo line
});

test("block styling: quotes, code blocks, rules", () => {
  const { lines, hidden } = decos("> q\n> r\n\n```\nx\n```\n\n---\n\nz");
  expect(lines).toEqual(["cm-rich-quote@1", "cm-rich-quote@2", "cm-rich-code@4", "cm-rich-code@5", "cm-rich-code@6", "cm-rich-hr@8"]);
  expect(hidden).toEqual(["> ", "> ", "---"]);
});
