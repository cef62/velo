import { type KeyboardEvent, memo, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { css, cx } from "styled-system/css";
import { countBadge, searchMatch, sectionHeader } from "styled-system/recipes";
import type { TaskItem } from "../api";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Badge, Button, Checkbox } from "@/components/ui";
import { renderInline } from "../preview";
import { highlightRanges, markHtml } from "../highlight";
import { byNote } from "../tasks";
import { HighlightedText } from "./HighlightedText";
import { useStore } from "./useStore";

const pane = css({ flex: "1", display: "flex", flexDirection: "column", minH: "0" }); // fills the left pane under its bar
const scroller = css({ flex: "1", minH: "0", overflowY: "auto", p: "1" });
const row = css({
  display: "flex",
  alignItems: "center",
  gap: "2.5",
  px: "2.5",
  minH: "var(--velo-row-h)",
  py: "1", // breathing room for wrapped tasks; padding on the clamped text would show a sliver of line 3
  borderRadius: "l2",
  color: "velo.fg",
  fontSize: "var(--velo-list-fs)",
  lineHeight: "1.2",
  cursor: "default",
  userSelect: "none",
  minW: "0",
  _hover: { bg: "velo.subtle" },
  _focusVisible: { outline: "2px solid", outlineColor: "velo.accent", outlineOffset: "-2px" },
});
const text = css({
  lineClamp: 2, // long tasks wrap once, then "…"
  overflowWrap: "anywhere",
  "[data-done] &": { color: "velo.fgMuted", textDecoration: "line-through" },
  "& a": { color: "velo.accentText", textDecoration: "none" },
  "& code": { fontFamily: "mono", fontSize: "0.9em", bg: "velo.subtle", px: "1", borderRadius: "l1" },
});
// task text, and in the flat list its note title on a line below: a wrapped task leaves no room beside it
const body = css({ flex: "1 1 0", minW: "0", display: "flex", flexDirection: "column" });
const note = css({ color: "velo.fgMuted", truncate: true, minW: "0", fontSize: "var(--velo-snippet-fs)" });
// "Ticked · Undo": one status line under the list (v2 §3 #16), only while there is something to undo
const status = css({ display: "flex", alignItems: "center", gap: "1", h: "8", px: "2.5", borderTop: "1px solid", borderColor: "velo.muted", fontSize: "uiSm", color: "velo.fgMuted", flex: "none" });
const noteHead = css({ textTransform: "none", letterSpacing: "0", fontSize: "uiSm", color: "velo.fg", cursor: "default", userSelect: "none", minW: "0", _hover: { bg: "velo.subtle" }, "& [data-title]": { truncate: true, minW: "0" }, "& [data-count]": { ml: "auto", flex: "none" } });
const indent = css({ pl: "3" });
const empty = css({ p: "4", textAlign: "center", color: "velo.fgMuted", fontSize: "uiSm" });

const GROUPS = [
  ["overdue", "Overdue"],
  ["today", "Today"],
  ["upcoming", "Upcoming"],
  ["no_date", "No date"],
  ["done", "Done"],
] as const;

// Folded note headings, by note path, shared by every date section. Per-machine convenience like the divider size: losing it only unfolds.
const FOLDED = "velo.tasks.folded";
const loadFolded = (): Set<string> => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(FOLDED) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
};

type RowProps = { t: TaskItem; overdue: boolean; query: string; controller: Controller; stop: boolean; onStop: (key: string) => void; showNote: boolean };

const marks = (t: TaskItem, q: string) => JSON.stringify([highlightRanges(t.text, q), highlightRanges(t.title, q)]);
// Every reload brings new objects and every keystroke a new query: compare what the row shows, so only rows that change re-render.
// shortcut: marks are compared on the raw markdown, so a match only in rendered text (an entity like &copy;) can show late; compare rendered HTML if that matters.
const sameRow = (a: RowProps, b: RowProps) =>
  a.overdue === b.overdue && a.showNote === b.showNote && a.controller === b.controller && a.stop === b.stop && a.onStop === b.onStop &&
  (["path", "line", "line_text", "text", "title", "due", "done"] as const).every((k) => a.t[k] === b.t[k]) &&
  (a.query === b.query || marks(a.t, a.query) === marks(b.t, b.query));

const TaskRow = memo(function TaskRow({ t, overdue, query, controller, stop, onStop, showNote }: RowProps) {
  // renderInline escapes HTML (markdown-it, html: false), as the preview does; markHtml re-escapes what it touches
  const html = useMemo(() => markHtml(renderInline(t.text), query, searchMatch()), [t.text, query]);
  return (
    <div
      role="listitem"
      tabIndex={stop ? 0 : -1} // roving: one tab stop for the whole list, ↑/↓ move
      data-task=""
      onFocus={() => onStop(`${t.path}:${t.line}`)}
      className={row}
      data-done={t.done || undefined}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a")) e.preventDefault(); // links, wikilinks and tags in a row don't navigate: the row opens the task
        void controller.openTask(t);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter") void controller.openTask(t);
        else if (e.key === " ") {
          e.preventDefault();
          void controller.tickTask(t);
        }
      }}
    >
      <Checkbox.Root size="sm" colorPalette="green" checked={t.done} onCheckedChange={() => void controller.tickTask(t)} onClick={(e) => e.stopPropagation()}>
        <Checkbox.Control>
          <Checkbox.Indicator />
        </Checkbox.Control>
        <Checkbox.HiddenInput aria-label={t.text} tabIndex={-1} />
      </Checkbox.Root>
      <div className={body}>
        <span className={text} aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />
        {showNote && <span className={note}><HighlightedText text={t.title} query={query} /></span>}
      </div>
      {t.due && (
        <Badge size="sm" variant="subtle" colorPalette={overdue ? "red" : "gray"} flex="none" marginLeft="auto">
          {t.due}
        </Badge>
      )}
    </div>
  );
}, sameRow);

export function TaskList({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const view = useStore(store, (s) => s.taskView);
  const query = useStore(store, (s) => s.query);
  const undo = useStore(store, (s) => s.tickUndo);
  const grouped = useStore(store, (s) => s.tasksByNote);
  const [folded, setFolded] = useState(loadFolded);
  const fold = (path: string, on: boolean) => {
    if (folded.has(path) === on) return;
    const next = new Set(folded);
    if (on) next.add(path);
    else next.delete(path);
    setFolded(next);
    try { localStorage.setItem(FOLDED, JSON.stringify([...next])); } catch { /* storage blocked: the fold just isn't remembered */ }
  };

  const groups = view ? GROUPS.filter(([k]) => view[k].length) : [];
  const sections = groups.map(([k, label]) => ({ k, label, notes: grouped ? byNote(view![k]) : null }));
  const list = useRef<HTMLDivElement>(null);
  const [cur, setCur] = useState(""); // key of the tab stop; the first row when it is gone
  const keyOf = (t: TaskItem) => `${t.path}:${t.line}`;
  const headKey = (k: string, path: string) => `note:${k}:${path}`;
  // every focusable key in screen order: headings, and the rows of unfolded notes
  const keys = sections.flatMap(({ k, notes }) =>
    notes ? notes.flatMap((n) => [headKey(k, n.path), ...(folded.has(n.path) ? [] : n.items.map(keyOf))]) : view![k].map(keyOf),
  );
  const stopKey = keys.includes(cur) ? cur : (keys[0] ?? "");
  const move = (e: KeyboardEvent) => {
    const d = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    const rows = [...list.current!.querySelectorAll<HTMLElement>("[data-task], [data-note-head]")];
    const i = rows.indexOf(e.target as HTMLElement);
    if (!d || i < 0) return;
    e.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, i + d))].focus(); // focus sets the tab stop
  };
  const row = (t: TaskItem, k: string, showNote: boolean) => (
    <TaskRow key={keyOf(t)} t={t} overdue={k === "overdue"} query={query} controller={controller} stop={keyOf(t) === stopKey} onStop={setCur} showNote={showNote} />
  );
  return (
    <div className={pane}>
      <div ref={list} className={scroller} role="list" aria-label="Tasks" onKeyDown={move}>
        {view && groups.length === 0 && <div className={empty}>{query ? `No tasks match “${query}”` : "No open tasks"}</div>}
        {sections.map(({ k, label, notes }) => (
          <div key={k} role="group" aria-label={label}>
            <div className={sectionHeader()}>{label}</div>
            {notes
              ? notes.map((n) => {
                  const open = !folded.has(n.path);
                  const hk = headKey(k, n.path);
                  return (
                    <div key={n.path} role="group" aria-label={n.title}>
                      <div
                        role="button"
                        data-note-head=""
                        aria-expanded={open}
                        aria-label={`${n.title}, ${n.items.length} task${n.items.length === 1 ? "" : "s"}`}
                        tabIndex={hk === stopKey ? 0 : -1}
                        className={cx(sectionHeader(), noteHead)}
                        onFocus={() => setCur(hk)}
                        onClick={() => fold(n.path, open)} // like Related's sections; Enter opens the note at its first task
                        onKeyDown={(e) => {
                          if (e.target !== e.currentTarget) return;
                          if (e.key === "Enter") void controller.openTask(n.items[0]);
                          else if (e.key === " ") fold(n.path, open);
                          else if (e.key === "ArrowLeft") fold(n.path, true);
                          else if (e.key === "ArrowRight") fold(n.path, false);
                          else return;
                          e.preventDefault();
                        }}
                      >
                        <ChevronDown aria-hidden />
                        <span data-title=""><HighlightedText text={n.title} query={query} /></span>
                        <span data-count="" className={countBadge()}>{n.items.length}</span>
                      </div>
                      {open && <div className={indent}>{n.items.map((t) => row(t, k, false))}</div>}
                    </div>
                  );
                })
              : view![k].map((t) => row(t, k, true))}
          </div>
        ))}
      </div>
      {undo && (
        <span role="status" className={status}>
          {undo.unticked ? "Unticked" : "Ticked"} ·
          <Button variant="plain" size="2xs" onClick={() => void controller.undoTick()}>
            Undo
          </Button>
        </span>
      )}
    </div>
  );
}
