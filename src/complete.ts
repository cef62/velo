import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, TransactionSpec } from "@codemirror/state";
import type { LinkTarget, TagCount } from "./api";
import { docFrontMatter } from "./fmhide";
import { rank, type Ranked } from "./fuzzy";
import { fold } from "./search";
import { BODY, tagStartOk } from "./tags";

const CODE = new Set(["FencedCode", "CodeBlock", "InlineCode"]);
const NO_TAG = new Set([...CODE, "URL", "Autolink"]);

/** The open `[[` before `pos` on its line: where the name starts and what is typed so far; null in code or front matter. */
export function linkContext(state: EditorState, pos: number): { from: number; query: string } | null {
  const line = state.doc.lineAt(pos);
  const before = state.sliceDoc(line.from, pos);
  const i = before.lastIndexOf("[[");
  if (i < 0) return null;
  const query = before.slice(i + 2);
  if (query.includes("]]") || query.includes("|")) return null;
  const fm = docFrontMatter(state.doc);
  if (fm && pos < fm.to) return null;
  const inner = syntaxTree(state).resolveInner(pos, -1);
  for (let n: typeof inner | null = inner; n; n = n.parent) if (CODE.has(n.name)) return null;
  return { from: line.from + i + 2, query };
}

/** The `#tag` being typed before `pos` (at least one character after the #); null in code, URLs or front matter. */
export function tagContext(state: EditorState, pos: number): { from: number; query: string } | null {
  const line = state.doc.lineAt(pos);
  const before = state.sliceDoc(line.from, pos);
  const m = /[\p{Alphabetic}\p{N}_\-/]+$/u.exec(before);
  if (!m) return null;
  const hash = m.index - 1;
  if (before[hash] !== "#" || !tagStartOk(before, hash)) return null;
  const fm = docFrontMatter(state.doc);
  if (fm && pos < fm.to) return null;
  const inner = syntaxTree(state).resolveInner(pos, -1);
  for (let n: typeof inner | null = inner; n; n = n.parent) if (NO_TAG.has(n.name)) return null;
  return { from: line.from + m.index, query: m[0] };
}

export interface CompleteSource {
  links(): Ranked<LinkTarget>[];
  tags(): Ranked<TagCount>[];
  onCreate(title: string): void;
}

/** Replace [from, pos) with `name]]`, eating a `]]` already after the caret; caret after the brackets. */
export function linkInsert(state: EditorState, from: number, pos: number, name: string): TransactionSpec {
  const to = state.sliceDoc(pos, pos + 2) === "]]" ? pos + 2 : pos;
  return { changes: { from, to, insert: name + "]]" }, selection: { anchor: from + name.length + 2 }, userEvent: "input.complete" };
}

/** Replace [from, pos) and the rest of the tag word after the caret with `tag `; no extra space before whitespace. */
export function tagInsert(state: EditorState, from: number, pos: number, tag: string): TransactionSpec {
  const to = pos + (BODY.exec(state.sliceDoc(pos, state.doc.lineAt(pos).to))?.[0].length ?? 0);
  const insert = /^\s/.test(state.sliceDoc(to, to + 1)) ? tag : tag + " ";
  return { changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: "input.complete" };
}

const byModifiedDesc = (a: LinkTarget, b: LinkTarget) => b.modified - a.modified;

export const linkSource =
  (src: CompleteSource) =>
  (ctx: CompletionContext): CompletionResult | null => {
    const c = linkContext(ctx.state, ctx.pos);
    if (!c) return null;
    const insert = (name: string): Completion["apply"] => (view, _c, from, to) => view.dispatch(linkInsert(view.state, from, to, name));
    const options: Completion[] = rank(fold(c.query), src.links(), byModifiedDesc).map((t) => ({
      label: t.name,
      detail: t.name === t.title ? undefined : "→ " + t.title,
      apply: insert(t.name),
    }));
    const title = c.query.trim();
    if (title && !src.links().some((r) => r.f === fold(title)))
      options.push({
        label: `Create "${title}"`,
        apply: (view, _c, from, to) => {
          view.dispatch(linkInsert(view.state, from, to, title));
          src.onCreate(title);
        },
      });
    return options.length ? { from: c.from, options, filter: false } : null; // an empty result keeps an invisible popup that eats Esc
  };

const byCountDesc = (a: TagCount, b: TagCount) => b.count - a.count;

export const tagSource =
  (src: CompleteSource) =>
  (ctx: CompletionContext): CompletionResult | null => {
    const c = tagContext(ctx.state, ctx.pos);
    if (!c) return null;
    const options: Completion[] = rank(fold(c.query), src.tags(), byCountDesc).map((t) => ({
      label: t.tag,
      detail: String(t.count),
      apply: (view, _c, from, to) => view.dispatch(tagInsert(view.state, from, to, t.tag)),
    }));
    return options.length ? { from: c.from, options, filter: false } : null;
  };

/** `[[` link and `#` tag autocompletion for the note editor. */
export const writingCompletions = (src: CompleteSource): Extension =>
  autocompletion({ override: [linkSource(src), tagSource(src)], icons: false, maxRenderedOptions: 20 });
