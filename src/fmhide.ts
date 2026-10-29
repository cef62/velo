import { Compartment, EditorSelection, EditorState, StateField, Transaction, type Extension, type Text } from "@codemirror/state";
import { history, isolateHistory } from "@codemirror/commands";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { frontMatterRange } from "./frontmatter";

/** frontMatterRange of a CodeMirror doc, reading only the first lines (a block closes within 200). */
export function docFrontMatter(doc: Text) {
  return frontMatterRange(doc.sliceString(0, doc.line(Math.min(doc.lines, 201)).to));
}

/** Undo history in a slot a note load can empty: an undo must never bring back the previous note's text
 *  (it would be autosaved into the open note). Dispatch `reset` as separate transactions after the load. */
export function undoHistory() {
  const slot = new Compartment();
  return { extension: slot.of(history()), reset: [{ effects: slot.reconfigure([]) }, { effects: slot.reconfigure(history()) }] };
}

/** Replace the whole doc with the caret at the top; a hidden front matter's caret guard then moves it past the block. */
export function replaceAll(doc: Text, text: string) {
  return { changes: { from: 0, to: doc.length, insert: text }, selection: { anchor: 0 } };
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

  // User edits skip the block (other changes in the same transaction go through). Undo/redo pass untouched so
  // history can't wedge on a step that touches the block; load and stamp changes carry no user event.
  const protect = EditorState.changeFilter.of((tr) => {
    if (tr.annotation(Transaction.userEvent) === undefined || tr.isUserEvent("undo") || tr.isUserEvent("redo")) return true;
    const r = docFrontMatter(tr.startState.doc);
    return r ? [0, r.to] : true; // inserting at r.to (body start) is at the edge, so allowed
  });
  const guard = EditorState.transactionFilter.of((tr) => {
    if (!tr.selection) return tr;
    const r = docFrontMatter(tr.newDoc);
    if (!r || tr.newSelection.ranges.every((s) => s.from >= r.to)) return tr;
    const clamp = (p: number) => Math.max(p, r.to);
    const sel = EditorSelection.create(tr.newSelection.ranges.map((s) => EditorSelection.range(clamp(s.anchor), clamp(s.head))), tr.newSelection.mainIndex);
    return [tr, { selection: sel, sequential: true }];
  });
  return [field, EditorView.atomicRanges.of((v) => v.state.field(field)), protect, guard];
}

/** Transaction spec that keeps a change out of the history event of the typing before it, so one undo reverts only it. */
export const ISOLATED = { annotations: isolateHistory.of("full"), userEvent: "input.link" };
