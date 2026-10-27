import { EditorView } from "@codemirror/view";
import { TASK_ITEM } from "./preview";

const validDate = (d: string) => new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

/** TS twin of `toggle_line` in src-tauri/src/tasks.rs: flips the box, stamps/removes ` ✅ today`. null = not a task line. */
export function toggleTaskLine(line: string, today: string): string | null {
  const cr = line.endsWith("\r") ? "\r" : "";
  const body = cr ? line.slice(0, -1) : line;
  const m = TASK_ITEM.exec(body);
  if (!m) return null;
  const done = m[2] !== " ";
  const rest = body.slice(m[0].length).replace(/\s*✅ (\d{4}-\d{2}-\d{2})/g, (s, d) => (validDate(d) ? "" : s));
  return `${m[1]}${done ? " " : "x"}]${rest}${done ? "" : ` ✅ ${today}`}${cr}`;
}

export function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Typing a space right after `due:` -> `📅 `. Returns the replacement span, or null. */
export function dueRule(before: string, text: string): { from: number; insert: string } | null {
  return text === " " && before.endsWith("due:") ? { from: before.length - 4, insert: "📅 " } : null;
}

export const dueInputRule = EditorView.inputHandler.of((view, from, to, text) => {
  const r = dueRule(view.state.doc.sliceString(Math.max(0, from - 4), from), text);
  if (!r) return false;
  view.dispatch({ changes: { from: from - 4, to, insert: r.insert }, selection: { anchor: from - 4 + r.insert.length }, userEvent: "input.type" });
  return true;
});
