import { syntaxTree } from "@codemirror/language";
import { StateEffect, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { readTag } from "./tags";
import { docFrontMatter } from "./fmhide";
import { externalUrl } from "./preview";
import { localToday, toggleTaskAt } from "./tasks";

// Rich edit: the text stays plain markdown; marks (#, **, >, [ ](url), [[ ]]) are hidden except on the lines the
// selection touches, so what is on disk is exactly what was typed.

export interface RichOpts {
  exists: (title: string) => boolean;
  onWikilink: (title: string) => void;
  onTag: (tag: string) => void;
  openExternal: (url: string) => void;
}

/** Rebuild decorations without a doc change (e.g. note titles changed, so wikilink "missing" styling may differ). */
export const refreshRich = StateEffect.define<null>();

class Bullet extends WidgetType {
  eq() { return true; }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-rich-bullet";
    s.textContent = "•";
    return s;
  }
}

class Check extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) { super(); }
  eq(o: Check) { return o.checked === this.checked && o.pos === this.pos; }
  toDOM() {
    const c = document.createElement("input");
    c.type = "checkbox";
    c.checked = this.checked;
    c.className = "cm-rich-check";
    c.dataset.pos = String(this.pos); // the char between [ ] in the doc
    return c;
  }
  ignoreEvent() { return false; } // let mousedown reach the handler below
}

const openHint = `${typeof navigator !== "undefined" && navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl"}-click to open`;
const WIKILINK = /\[\[(.+?)\]\]/g; // same as the preview: up to the first ]], trimmed, one line

/** Decorations for `ranges` (default: whole doc). Exported for tests. */
export function buildDecorations(state: EditorState, opts: Pick<RichOpts, "exists">, ranges: readonly { from: number; to: number }[] = [{ from: 0, to: state.doc.length }]): DecorationSet {
  const doc = state.doc;
  const fm = docFrontMatter(doc); // front matter stays raw (hidden or shown)
  if (fm) ranges = ranges.filter((r) => r.to > fm.to).map((r) => ({ from: Math.max(r.from, fm.to), to: r.to }));
  const active = new Set<number>();
  for (const r of state.selection.ranges) for (let l = doc.lineAt(r.from).number; l <= doc.lineAt(r.to).number; l++) active.add(l);
  const onActive = (pos: number) => active.has(doc.lineAt(pos).number);
  const out: Range<Decoration>[] = [];
  const skip: [number, number][] = []; // code and URLs: no wikilinks or tags inside
  const hide = (from: number, to: number) => { if (to > from) out.push(Decoration.replace({}).range(from, to)); };
  const withSpace = (to: number) => (doc.sliceString(to, to + 1) === " " ? to + 1 : to);
  const lineClass = (from: number, to: number, cls: string) => {
    for (let l = doc.lineAt(from).number; l <= doc.lineAt(to).number; l++) out.push(Decoration.line({ class: cls }).range(doc.line(l).from));
  };

  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (n) => {
        switch (n.name) {
          case "FencedCode":
          case "CodeBlock":
            skip.push([n.from, n.to]);
            lineClass(n.from, n.to, "cm-rich-code");
            return false; // fences stay visible
          case "InlineCode":
          case "URL":
            skip.push([n.from, n.to]);
            break;
          case "Image":
            return false;
          case "CodeMark": // inline code only: fenced code returned above
          case "EmphasisMark":
          case "StrikethroughMark":
            if (!onActive(n.from)) hide(n.from, n.to);
            break;
          case "HeaderMark":
            if (n.node.parent?.name.startsWith("ATXHeading") && !onActive(n.from)) hide(n.from, withSpace(n.to));
            break;
          case "Blockquote":
            lineClass(n.from, n.to, "cm-rich-quote");
            break;
          case "QuoteMark":
            if (!onActive(n.from)) hide(n.from, withSpace(n.to));
            break;
          case "HorizontalRule":
            if (!onActive(n.from)) {
              out.push(Decoration.line({ class: "cm-rich-hr" }).range(doc.lineAt(n.from).from));
              hide(n.from, n.to);
            }
            break;
          case "ListMark": {
            if (onActive(n.from) || !/^[-*+]$/.test(doc.sliceString(n.from, n.to))) break;
            const marker = n.node.nextSibling?.name === "Task" ? n.node.nextSibling.getChild("TaskMarker") : null;
            if (marker) {
              const checked = /x/i.test(doc.sliceString(marker.from, marker.to));
              out.push(Decoration.replace({ widget: new Check(checked, marker.from + 1) }).range(n.from, marker.to));
            } else out.push(Decoration.replace({ widget: new Bullet() }).range(n.from, n.to));
            break;
          }
          case "Link": {
            const url = n.node.getChild("URL");
            if (!url) break; // reference-style links, and the inside of [[wikilinks]]
            const close = n.node.getChildren("LinkMark").find((m) => doc.sliceString(m.from, m.to) === "]");
            if (!close || close.from <= n.from + 1) break;
            out.push(Decoration.mark({ class: "cm-rich-link", attributes: { "data-url": doc.sliceString(url.from, url.to), title: openHint } }).range(n.from + 1, close.from));
            if (!onActive(n.from)) {
              hide(n.from, n.from + 1);
              hide(close.from, n.to);
            }
            break;
          }
        }
      },
    });
  }

  const inSkip = (a: number, b: number) => skip.some(([f, t]) => a < t && b > f);
  for (const { from, to } of ranges) {
    for (let l = doc.lineAt(from).number; l <= doc.lineAt(to).number; l++) {
      const line = doc.line(l);
      for (const m of line.text.matchAll(WIKILINK)) {
        const a = line.from + m.index, b = a + m[0].length, title = m[1].trim();
        if (!title || inSkip(a, b)) continue;
        const cls = "cm-rich-wikilink" + (opts.exists(title) ? "" : " cm-rich-missing");
        out.push(Decoration.mark({ class: cls, attributes: { "data-title": title, title: openHint } }).range(a + 2, b - 2));
        if (!active.has(l)) {
          hide(a, a + 2);
          hide(b - 2, b);
        }
      }
      for (let i = line.text.indexOf("#"); i >= 0; i = line.text.indexOf("#", i + 1)) {
        const tag = readTag(line.text, i);
        if (!tag || inSkip(line.from + i, line.from + i + 1)) continue;
        out.push(Decoration.mark({ class: "cm-rich-tag", attributes: { "data-tag": tag, title: openHint } }).range(line.from + i, line.from + i + 1 + tag.length));
        i += tag.length;
      }
    }
  }
  return Decoration.set(out, true);
}

const richTheme = EditorView.theme({
  ".cm-rich-link, .cm-rich-wikilink": { color: "var(--colors-velo-accent-text)", textDecoration: "underline", textDecorationColor: "var(--colors-velo-accent-line)", textUnderlineOffset: "3px" },
  ".cm-rich-wikilink": { textDecoration: "none", borderBottom: "1px solid var(--colors-velo-accent-line)" },
  ".cm-rich-missing, .cm-rich-missing *": { color: "var(--colors-velo-danger)", borderBottomStyle: "dashed", borderBottomColor: "var(--colors-velo-danger)" }, // * beats the inner link highlight
  ".cm-rich-tag": { color: "var(--colors-velo-accent-text)", background: "var(--colors-velo-accent-subtle)", borderRadius: "4px", padding: "0.1em 0.45em", fontSize: "0.8em", fontWeight: "500" },
  ".cm-rich-bullet": { color: "var(--colors-velo-fg-muted)" },
  ".cm-rich-check": { width: "1em", height: "1em", margin: "0 0.4em 0 0", verticalAlign: "-0.15em", accentColor: "var(--colors-velo-accent)", cursor: "pointer" },
  ".cm-rich-quote": { borderLeft: "3px solid var(--colors-velo-accent-halo)", paddingLeft: "1em", color: "var(--colors-velo-fg-muted)" },
  ".cm-rich-code": { background: "var(--colors-velo-subtle)", padding: "0 1em", fontFamily: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace', fontSize: "0.84em" },
  ".cm-rich-hr": { backgroundImage: "linear-gradient(var(--colors-velo-border), var(--colors-velo-border))", backgroundSize: "100% 1px", backgroundRepeat: "no-repeat", backgroundPosition: "center" },
});

export function richMarkdown(opts: RichOpts): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view.state, opts, view.visibleRanges);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.state) !== syntaxTree(u.startState) || u.transactions.some((t) => t.effects.some((e) => e.is(refreshRich))))
          this.decorations = buildDecorations(u.state, opts, u.view.visibleRanges);
      }
    },
    { decorations: (v) => v.decorations },
  );
  const clicks = EditorView.domEventHandlers({
    mousedown(e, view) {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement && t.classList.contains("cm-rich-check")) {
        e.preventDefault();
        if (!view.state.facet(EditorView.editable)) return true; // no note open, indexing, lock hand-off
        const change = toggleTaskAt(view.state.doc, Number(t.dataset.pos), localToday()); // same @done stamp as Editor.toggleTask
        if (change) view.dispatch({ changes: change });
        return true;
      }
      if (!(e.metaKey || e.ctrlKey)) return false; // a plain click edits
      const el = t.closest<HTMLElement>(".cm-rich-link, .cm-rich-wikilink, .cm-rich-tag");
      if (!el) return false;
      e.preventDefault();
      if (el.dataset.title !== undefined) opts.onWikilink(el.dataset.title);
      else if (el.dataset.tag !== undefined) opts.onTag(el.dataset.tag);
      else {
        const url = externalUrl(el.dataset.url ?? "");
        if (url) opts.openExternal(url);
      }
      return true;
    },
  });
  return [plugin, clicks, richTheme];
}
