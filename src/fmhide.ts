import { EditorSelection, EditorState, StateField, Transaction, type Extension, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { frontMatterRange } from "./frontmatter";

/** frontMatterRange of a CodeMirror doc, reading only the first lines (a block closes within 200). */
export function docFrontMatter(doc: Text) {
  return frontMatterRange(doc.sliceString(0, doc.line(Math.min(doc.lines, 201)).to));
}

const shownTheme = EditorView.theme({
  // Shown raw: undo markdown styling (the closing --- would otherwise make a setext heading).
  ".cm-fm, .cm-fm span": { fontSize: "0.86em", fontWeight: "400", color: "var(--colors-velo-fg-muted)", fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace' },
  ".cm-fm span": { fontSize: "1em" },
});

/**
 * Hidden: the front-matter block is one atomic block-replace decoration. The caret can't land in or before it,
 * and user edits can't touch it (show it to edit). Non-user changes (load, stamp) pass.
 * Shown: the block is plain, editable monospace text.
 */
export function frontMatterHide(hidden: boolean): Extension {
  const build = (doc: Text): DecorationSet => {
    const r = docFrontMatter(doc);
    if (!r) return Decoration.none;
    const last = doc.lineAt(r.to - 1); // the closing --- line
    if (hidden) return Decoration.set(Decoration.replace({ block: true }).range(0, last.to));
    return Decoration.set(Array.from({ length: last.number }, (_, i) => Decoration.line({ class: "cm-fm" }).range(doc.line(i + 1).from)));
  };
  const field = StateField.define<DecorationSet>({
    create: (s) => build(s.doc),
    update: (v, tr) => (tr.docChanged ? build(tr.state.doc) : v),
    provide: (f) => EditorView.decorations.from(f),
  });
  if (!hidden) return [field, shownTheme];

  const guard = EditorState.transactionFilter.of((tr) => {
    const before = docFrontMatter(tr.startState.doc);
    if (before && tr.docChanged && tr.annotation(Transaction.userEvent) !== undefined && tr.changes.touchesRange(0, before.to - 1)) return {};
    if (!tr.selection) return tr;
    const r = docFrontMatter(tr.newDoc);
    if (!r || tr.newSelection.ranges.every((s) => s.from >= r.to)) return tr;
    const clamp = (p: number) => Math.max(p, r.to);
    const sel = EditorSelection.create(tr.newSelection.ranges.map((s) => EditorSelection.range(clamp(s.anchor), clamp(s.head))), tr.newSelection.mainIndex);
    return [tr, { selection: sel, sequential: true }];
  });
  return [field, EditorView.atomicRanges.of((v) => v.state.field(field)), guard];
}
