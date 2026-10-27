import type { Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { TASK_ITEM } from "./preview";

const isoDate = (s: string) => {
  const d = s.slice(0, 10);
  const t = new Date(`${d}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(+t) && t.toISOString().slice(0, 10) === d;
};

/** Literal port of Rust `strip`: removes every `<marker><date>` plus the whitespace before it. */
function strip(s: string, marker: string): string {
  let out = "";
  let rest = s;
  for (let i = rest.indexOf(marker); i >= 0; i = rest.indexOf(marker)) {
    const after = rest.slice(i + marker.length);
    if (isoDate(after)) {
      out += rest.slice(0, i).trimEnd();
      rest = after.slice(10);
    } else {
      out += rest.slice(0, i + marker.length);
      rest = after;
    }
  }
  return out + rest;
}

/** TS twin of `toggle_line` in src-tauri/src/tasks.rs: flips the box, stamps/removes ` ✅ today`. null = not a task line. */
export function toggleTaskLine(line: string, today: string): string | null {
  const cr = line.endsWith("\r") ? "\r" : "";
  const body = cr ? line.slice(0, -1) : line;
  const m = TASK_ITEM.exec(body);
  if (!m) return null;
  const done = m[2] !== " ";
  const rest = strip(body.slice(m[0].length), "✅ ");
  return `${m[1]}${done ? " " : "x"}]${rest}${done ? "" : ` ✅ ${today}`}${cr}`;
}

/** The whole-line change that toggles the task on the line holding `pos`, or null. One path for every editor checkbox. */
export function toggleTaskAt(doc: Text, pos: number, today: string): { from: number; to: number; insert: string } | null {
  const l = doc.lineAt(pos);
  const t = toggleTaskLine(l.text, today);
  return t === null ? null : { from: l.from, to: l.to, insert: t };
}

export function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Typing a space right after `due:` -> `📅 `. Returns the replacement span, or null. */
export function dueRule(before: string, text: string): { from: number; insert: string } | null {
  return text === " " && /(^|\s)due:$/.test(before) ? { from: before.length - 4, insert: "📅 " } : null;
}

export const dueInputRule = EditorView.inputHandler.of((view, from, to, text) => {
  const l = view.state.doc.lineAt(from);
  const r = dueRule(l.text.slice(0, from - l.from), text);
  if (!r) return false;
  view.dispatch({ changes: { from: from - 4, to, insert: r.insert }, selection: { anchor: from - 4 + r.insert.length }, userEvent: "input.type" });
  return true;
});
