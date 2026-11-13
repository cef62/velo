import { type ChangeSet, Compartment, EditorSelection, EditorState, StateField, Transaction, type Extension, type Text } from "@codemirror/state";
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

/** The smallest single change turning `a` into `b` (null if equal): common prefix and suffix kept, no surrogate cut, no overlap. */
export function middleChange(a: string, b: string): { from: number; to: number; insert: string } | null {
  if (a === b) return null;
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  if (p > 0 && (a.charCodeAt(p - 1) & 0xfc00) === 0xd800) p--; // prefix ends on a high surrogate: its pair is cut
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  if (s > 0 && (a.charCodeAt(a.length - s) & 0xfc00) === 0xdc00) s--; // suffix starts on a low surrogate
  return { from: p, to: a.length - s, insert: b.slice(p, b.length - s) };
}

type Hunk = { from: number; to: number; insert: string };

/** Max old-lines x new-lines cells of one exact LCS table (4 MB). */
const LCS_BUDGET = 1_000_000;
/** Max chars (old + new) of the differing region the line diff will look at: string compares cost per char, and a region this
 *  big is no ordinary note edit. Above it the reload is one middle change, as before the line diff. */
const MAX_REGION_CHARS = 512 * 1024;
/** Work units one reload may spend in all: an LCS cell costs 1, a patience scan costs 10 per line. About 15 ms worst case. */
const WORK_BUDGET = 3_000_000;
/** Patience recursion depth cap: a stack-overflow guard that stays whatever the budget is (the budget alone also bounds it today). */
const MAX_DEPTH = 100;

/** Push hunks [a0,a1) -> [b0,b1) (line ranges, in order, never touching) turning old lines `a` into new lines `b`.
 *  Total cost is bounded by `work`; a gap that no longer fits becomes one hunk. */
function lineDiff(a: string[], b: string[], a0: number, a1: number, b0: number, b1: number, out: number[][], work: { left: number }, depth = 0): void {
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) { a0++; b0++; }
  while (a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]) { a1--; b1--; }
  const n = a1 - a0, m = b1 - b0;
  if (!n || !m) { if (n || m) out.push([a0, a1, b0, b1]); return; }
  if (n * m <= LCS_BUDGET && n * m <= work.left) {
    work.left -= n * m;
    const w = m + 1, L = new Uint32Array((n + 1) * w); // L[i*w+j]: LCS length of a[a0+i..] and b[b0+j..]
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        L[i * w + j] = a[a0 + i] === b[b0 + j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0, j = 0, si = -1, sj = -1;
    const close = () => { if (si >= 0) { out.push([a0 + si, a0 + i, b0 + sj, b0 + j]); si = -1; } };
    while (i < n || j < m) {
      if (i < n && j < m && a[a0 + i] === b[b0 + j]) { close(); i++; j++; continue; }
      if (si < 0) { si = i; sj = j; }
      if (j >= m || (i < n && L[(i + 1) * w + j] >= L[i * w + j + 1])) i++; else j++;
    }
    close();
    return;
  }
  // shortcut: out of budget, too deep, or no unique line in a gap above the LCS budget: one hunk (its caret may jump); upgrade to Myers if that bites.
  if (depth >= MAX_DEPTH || work.left < 10 * (n + m)) { out.push([a0, a1, b0, b1]); return; }
  work.left -= 10 * (n + m);
  // Patience: lines unique on both sides, their longest increasing run as anchors, then diff each gap.
  const seen = new Map<string, { o: number; n: number; i: number; j: number }>(); // counts and positions per line
  for (let i = a0; i < a1; i++) { const e = seen.get(a[i]); if (e) e.o++; else seen.set(a[i], { o: 1, n: 0, i, j: -1 }); }
  for (let j = b0; j < b1; j++) { const e = seen.get(b[j]); if (e) { e.n++; e.j = j; } }
  const pairs: number[][] = []; // [old idx, new idx], by old idx
  for (const e of seen.values()) if (e.o === 1 && e.n === 1) pairs.push([e.i, e.j]);
  pairs.sort((x, y) => x[0] - y[0]);
  const tails: number[] = [], prev: number[] = []; // LIS on new idx: tails[k] ends the best run of length k+1
  for (let p = 0; p < pairs.length; p++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[tails[mid]][1] < pairs[p][1]) lo = mid + 1; else hi = mid; }
    prev[p] = lo ? tails[lo - 1] : -1;
    tails[lo] = p;
  }
  const anchors: number[][] = [];
  for (let p = tails.length ? tails[tails.length - 1] : -1; p >= 0; p = prev[p]) anchors.push(pairs[p]);
  anchors.reverse();
  if (!anchors.length) { out.push([a0, a1, b0, b1]); return; }
  let i = a0, j = b0;
  for (const [ai, bj] of anchors) { lineDiff(a, b, i, ai, j, bj, out, work, depth + 1); i = ai + 1; j = bj + 1; }
  lineDiff(a, b, i, a1, j, b1, out, work, depth + 1);
}

/**
 * Changes turning `a` into `b` (both LF): one per differing run of lines, so unchanged lines between edits keep their
 * positions and a caret on them stays put; inside a run the common prefix and suffix are kept too. Sorted, disjoint, in `a` coordinates.
 * Lines compare without their terminator, so a last line without "\n" matches the same line once a newline follows it.
 * Cost is bounded (WORK_BUDGET, MAX_DEPTH, LCS_BUDGET): the worst input costs a few ms more than one middle change.
 */
export function reloadChanges(a: string, b: string): Hunk[] {
  if (a === b) return [];
  const la = a.split("\n"), lb = b.split("\n");
  const starts = [0]; // char offset of each old line
  for (const l of la) starts.push(starts[starts.length - 1] + l.length + 1);
  const hunks: number[][] = [];
  let p = 0, e = 0; // common line prefix and suffix, trimmed here so the size cap sees only the differing region
  while (p < la.length && p < lb.length && la[p] === lb[p]) p++;
  while (e < la.length - p && e < lb.length - p && la[la.length - 1 - e] === lb[lb.length - 1 - e]) e++;
  let chars = starts[la.length - e] - starts[p];
  for (let i = p; i < lb.length - e && chars <= MAX_REGION_CHARS; i++) chars += lb[i].length + 1;
  // shortcut: a region above MAX_REGION_CHARS is one middle change (a caret inside it may jump); upgrade to a char-aware diff if that bites.
  if (chars > MAX_REGION_CHARS) return [middleChange(a, b)!];
  lineDiff(la, lb, p, la.length - e, p, lb.length - e, hunks, { left: WORK_BUDGET });
  const out: Hunk[] = [];
  for (const [a0, a1, b0, b1] of hunks) {
    // old lines [a0,a1) -> new lines [b0,b1), keeping the "\n" of every neighbouring line
    let from: number, to: number, ins = lb.slice(b0, b1).join("\n");
    if (a1 > a0 && b1 > b0) { from = starts[a0]; to = starts[a1] - 1; }
    else if (b1 > b0) { // pure insertion
      if (a0 < la.length) { from = to = starts[a0]; ins += "\n"; } else { from = to = a.length; ins = "\n" + ins; }
    } else if (a1 < la.length) { from = starts[a0]; to = starts[a1]; } // pure deletion
    else { from = a0 > 0 ? starts[a0] - 1 : 0; to = a.length; }
    const c = middleChange(a.slice(from, to), ins);
    if (c) out.push({ from: from + c.from, to: from + c.to, insert: c.insert });
  }
  return out;
}

/** `changes` applied to `a`, or null if they are not sorted, disjoint and inside `a`. */
function applied(a: string, changes: Hunk[]) {
  let out = "", at = 0;
  for (const c of changes) {
    if (c.from < at || c.to < c.from || c.to > a.length) return null;
    out += a.slice(at, c.from) + c.insert;
    at = c.to;
  }
  return out + a.slice(at);
}

/**
 * A reload of the same note: only the differing lines change (CRLF read as LF, as CodeMirror's own text split does) and the
 * selection is mapped explicitly, so the hidden-front-matter guard runs (it skips transactions without a selection). Null if equal.
 * The diff is checked against the new text; a throw or a wrong result falls back to the single middle change, so the editor never gets wrong text.
 */
export function reloadSpec(state: EditorState, text: string, diff: (a: string, b: string) => Hunk[] = reloadChanges) {
  const a = state.doc.toString(), b = text.replace(/\r\n?/g, "\n");
  if (a === b) return null;
  let c: Hunk[] | null = null;
  try { c = diff(a, b); if (applied(a, c) !== b) c = null; } catch { c = null; }
  if (!c) c = [middleChange(a, b)!];
  const changes = state.changes(c);
  // Hunks insert whole lines at a line start (a line "x\n" before the line there, or "\nx" after the last one), so a caret at a
  // line start sits at the insertion point and must go after it (assoc 1), any other caret stays before (-1). A selection keeps
  // covering its text: start forward, end backward.
  const { doc } = state;
  const ranges = state.selection.ranges.map((r) => {
    // goal column and bidi level survive, as with SelectionRange.map
    const [goal, bidi] = [r.goalColumn, r.bidiLevel ?? undefined];
    if (r.empty) return EditorSelection.cursor(changes.mapPos(r.head, doc.lineAt(r.head).from === r.head ? 1 : -1), r.assoc, bidi, goal);
    const [from, to] = [changes.mapPos(r.from, 1), changes.mapPos(r.to, -1)];
    return r.anchor < r.head ? EditorSelection.range(from, Math.max(from, to), goal, bidi) : EditorSelection.range(Math.max(from, to), from, goal, bidi);
  });
  return { changes, selection: EditorSelection.create(ranges, state.selection.mainIndex) };
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

/** The caret for a save's front-matter stamp: only when assoc 1 moves it (a caret at 0 before an inserted block).
 *  Any explicit selection resets an open autocomplete, so the usual stamp sets none. */
export function stampSelection(sel: EditorSelection, changes: ChangeSet): EditorSelection | undefined {
  const after = sel.map(changes, 1);
  return after.eq(sel.map(changes)) ? undefined : after;
}
