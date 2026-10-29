import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, drawSelection, dropCursor, highlightSpecialChars, keymap } from "@codemirror/view";
import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";

// Colors are Panda's velo.* tokens (CSS variables, light/dark via data-theme), so the editor follows the app theme.
const v = (name: string) => `var(--colors-velo-${name})`;
const MONO = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';

export const writingHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.6em", lineHeight: "1.25", fontWeight: "700", letterSpacing: "-0.015em" },
  { tag: t.heading2, fontSize: "1.22em", fontWeight: "650", letterSpacing: "-0.01em" },
  { tag: t.heading3, fontSize: "1.08em", fontWeight: "650" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "650" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: v("accent-text") },
  { tag: t.monospace, fontFamily: MONO, fontSize: "0.86em" },
  { tag: t.quote, color: v("fg-muted") },
  // Markdown punctuation (#, **, >, -, [ ], ```), rules and link labels: present but quiet.
  { tag: [t.processingInstruction, t.contentSeparator, t.labelName, t.meta], color: v("mark"), fontWeight: "400", fontStyle: "normal" },
]);

const writingTheme = EditorView.theme({
  "&": { height: "100%", background: v("canvas"), color: v("fg"), fontSize: "var(--velo-editor-fs, 16px)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: '"Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", sans-serif', lineHeight: "1.7" },
  ".cm-content": { maxWidth: "46em", margin: "0 auto", padding: "28px 40px 40px", caretColor: v("accent") },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: v("accent") },
  ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": { background: v("selection-idle") },
  ".cm-selectionMatch": { background: v("accent-halo") },
  ".cm-panels": { background: v("chrome"), color: v("fg"), borderColor: v("divider") },
  // Autocomplete popup; `&.cm-editor` outranks the base theme's &light/&dark row colors.
  "&.cm-editor .cm-tooltip.cm-tooltip-autocomplete": { background: v("panel"), color: v("fg"), border: `1px solid ${v("border")}`, borderRadius: "6px", overflow: "hidden" },
  "&.cm-editor .cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "inherit", maxHeight: "20em" },
  "&.cm-editor .cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "3px 10px" },
  "&.cm-editor .cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": { background: v("selection"), color: v("selection-fg") },
  ".cm-completionDetail": { color: v("fg-muted"), fontStyle: "normal", marginLeft: "0.75em" },
  "&.cm-editor .cm-tooltip-autocomplete li[aria-selected] .cm-completionDetail": { color: v("selection-muted") },
});

const darkMq = window.matchMedia?.("(prefers-color-scheme: dark)");
// data-theme (Settings → Theme) overrides the OS; no attribute = follow the OS
const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : !!darkMq?.matches;
};

/** Editor setup for prose: no gutters or code-editor chrome, readable in light and dark. */
export function writingSetup(): Extension[] {
  const dark = new Compartment(); // tells CodeMirror's base theme (search panel, cursor) which scheme is on
  const followScheme = ViewPlugin.define((view) => {
    const onChange = () => view.dispatch({ effects: dark.reconfigure(EditorView.darkTheme.of(isDark())) });
    darkMq?.addEventListener("change", onChange);
    const themeAttr = new MutationObserver(onChange);
    themeAttr.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return { destroy: () => (darkMq?.removeEventListener("change", onChange), themeAttr.disconnect()) };
  });
  return [
    highlightSpecialChars(), // undo history: the editor's own undoHistory() slot
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    highlightSelectionMatches(),
    keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap]),
    markdown({ base: markdownLanguage }), // GFM: tables, ~~strike~~, task lists, like the preview
    syntaxHighlighting(writingHighlight),
    writingTheme,
    EditorView.lineWrapping,
    dark.of(EditorView.darkTheme.of(isDark())),
    followScheme,
  ];
}
