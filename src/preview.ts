import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import { readTag } from "./tags";
import { frontMatterRange } from "./frontmatter";

// GitHub flavor: tables, ~~strike~~ and autolinks are built in; task lists and alerts are the rules below.
const md = new MarkdownIt({ html: false, linkify: true }).use(footnote);
const esc = md.utils.escapeHtml;

// Set per renderMarkdown call; the renderer is synchronous so this is safe.
let exists: (title: string) => boolean = () => true;

md.inline.ruler.before("link", "wikilink", (state, silent) => {
  const { src, pos } = state;
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
  const end = src.indexOf("]]", pos + 2);
  const title = end < 0 ? "" : src.slice(pos + 2, end).trim();
  if (!title || title.includes("\n")) return false;
  if (!silent) state.push("wikilink", "", 0).content = title;
  state.pos = end + 2;
  return true;
});
md.renderer.rules.wikilink = (tokens, i) => {
  const t = tokens[i].content;
  return `<a href="#" class="wikilink${exists(t) ? "" : " missing"}" data-title="${esc(t)}">${esc(t)}</a>`;
};

// Code spans/fences are separate tokens, so tags inside them never reach this rule (Rust, which indexes, skips fences only).
md.inline.ruler.before("link", "tag", (state, silent) => {
  const tag = readTag(state.src, state.pos);
  if (!tag) return false;
  if (!silent) state.push("tag", "", 0).content = tag;
  state.pos += 1 + tag.length;
  return true;
});
md.renderer.rules.tag = (tokens, i) => `<a href="#" class="tag" data-tag="${esc(tokens[i].content)}">#${esc(tokens[i].content)}</a>`;

// "- [ ] x" / "- [x] x": a checkbox carrying the item's source line, so a click can toggle it in the note.
const TASK = /^\[([ xX])\][ \t]/;
/** Source line of a task item (optionally inside blockquotes): group 1 ends just before the box's state char. */
export const TASK_ITEM = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/;
// "> [!NOTE]" (TIP, IMPORTANT, WARNING, CAUTION) as the first line of a blockquote, like GitHub alerts.
const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i;
md.core.ruler.after("inline", "gfm_tasks_alerts", (state) => {
  const t = state.tokens;
  for (let i = 2; i < t.length; i++) {
    if (t[i].type !== "inline" || t[i - 1].type !== "paragraph_open") continue;
    const open = t[i - 2];
    const first = t[i].children?.[0];
    const task = open.type === "list_item_open" && first?.type === "text" ? TASK.exec(first.content) : null;
    if (task && first) {
      first.content = first.content.slice(task[0].length);
      const box = new state.Token("task_checkbox", "", 0);
      box.meta = { checked: task[1] !== " ", line: open.map?.[0] ?? -1 };
      t[i].children!.unshift(box);
      open.attrJoin("class", "task-list-item");
    }
    const alert = open.type === "blockquote_open" ? ALERT.exec(t[i].content) : null;
    if (alert) {
      const kind = alert[1].toLowerCase();
      open.attrJoin("class", `markdown-alert markdown-alert-${kind}`);
      t[i].content = t[i].content.slice(alert[0].length);
      const children: typeof t = [];
      state.md.inline.parse(t[i].content, state.md, state.env, children);
      t[i].children = children;
      const title = new state.Token("alert_title", "", 0);
      title.content = kind[0].toUpperCase() + kind.slice(1);
      t.splice(i - 1, 0, title);
      i++;
    }
  }
});
md.renderer.rules.task_checkbox = (tokens, i) => {
  const { line, checked } = tokens[i].meta as { line: number; checked: boolean };
  return `<input type="checkbox" class="task" data-line="${line}"${checked ? " checked" : ""}> `;
};
md.renderer.rules.alert_title = (tokens, i) => `<p class="markdown-alert-title">${esc(tokens[i].content)}</p>\n`;

export function renderMarkdown(text: string, existsFn: (title: string) => boolean): string {
  exists = existsFn;
  const fm = frontMatterRange(text);
  // Blank lines in place of the front matter keep source line numbers (task checkboxes toggle by line).
  return md.render(fm ? "\n".repeat(text.slice(0, fm.to).split("\n").length - 1) + text.slice(fm.to) : text);
}

/** One line of markdown as inline HTML (task rows): same renderer and escaping as the preview, no block wrapper. */
export function renderInline(text: string): string {
  exists = () => true; // rows don't mark missing wikilinks
  return md.renderInline(text);
}

/** The URL if it may be opened in the system browser (http/https only), else null. */
export function externalUrl(href: string): string | null {
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:" ? href : null;
  } catch {
    return null;
  }
}

export const emptyWatermark = (toggleLabel: string) => "Empty note — press " + toggleLabel + " to edit";

/** Preview must never hide a note the user needs to type in: new notes and empty notes open in edit mode. */
export const shouldAutoEdit = (o: { created: boolean; body: string; previewOn: boolean }) => o.created || (o.previewOn && o.body.trim() === "");

/** What to do once a note is open. Enter always wants the caret in the editor; a wikilink click only when it lands on a new/empty note. */
export function afterOpen(o: { created: boolean; body: string; layout: "vertical" | "horizontal"; previewOn: boolean; source: "enter" | "wikilink" }) {
  const auto = shouldAutoEdit(o);
  if (o.source === "wikilink") return { leavePreview: auto, focusEditor: auto };
  // vertical layout: preview replaces the editor (display:none), where focus() silently does nothing
  return { leavePreview: auto || (o.previewOn && o.layout === "vertical"), focusEditor: true };
}

export interface Preview {
  toggle(): void;
  setMode(on: boolean): void;
  isOn(): boolean;
  /** Re-render, debounced 150 ms (editor change or title cache change). */
  refresh(): void;
}

/** Mounts the preview pane. Only renderMarkdown output is ever assigned to innerHTML. */
export function mountPreview(
  el: HTMLElement,
  opts: {
    getText: () => string;
    /** Current shortcut label for the empty-note watermark. */
    toggleLabel: () => string;
    exists: (title: string) => boolean;
    onWikilink: (title: string) => void;
    onTag: (tag: string) => void;
    openExternal: (url: string) => void;
    onToggle?: (visible: boolean) => void;
    /** A task checkbox was clicked: toggle the item on this 0-based source line. */
    onToggleTask?: (line: number) => void;
  },
): Preview {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const draw = () => {
    if (el.hidden) return;
    const text = opts.getText();
    el.classList.toggle("empty", text.trim() === "");
    if (text.trim() === "") el.textContent = emptyWatermark(opts.toggleLabel());
    else el.innerHTML = renderMarkdown(text, opts.exists);
  };
  el.addEventListener("click", (e) => {
    const box = e.target as HTMLElement;
    if (box instanceof HTMLInputElement && box.classList.contains("task")) {
      e.preventDefault(); // the note is the source of truth: the re-render after the edit shows the new state
      opts.onToggleTask?.(Number(box.dataset.line));
      return;
    }
    const a = (e.target as HTMLElement).closest?.("a");
    if (!a) return;
    e.preventDefault(); // never navigate the app window
    if (a.classList.contains("wikilink")) opts.onWikilink(a.dataset.title ?? "");
    else if (a.classList.contains("tag")) opts.onTag(a.dataset.tag ?? "");
    else {
      const href = a.getAttribute("href") ?? "";
      // in-note anchors (footnote [1] and its ↩ back-link) scroll the preview; never navigate the window
      if (href.startsWith("#")) el.querySelector(`[id="${CSS.escape(safeDecode(href.slice(1)))}"]`)?.scrollIntoView({ block: "center" });
      else {
        const url = externalUrl(href);
        if (url) opts.openExternal(url);
      }
    }
  });
  const toggle = () => {
    el.hidden = !el.hidden;
    opts.onToggle?.(!el.hidden);
    draw();
  };
  return {
    toggle,
    setMode: (on) => on === el.hidden && toggle(),
    isOn: () => !el.hidden,
    refresh() {
      clearTimeout(timer);
      timer = setTimeout(draw, 150);
    },
  };
}

/** decodeURIComponent, or the raw text when it isn't valid percent-encoding ("#50%"). */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
