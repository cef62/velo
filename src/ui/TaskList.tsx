import { type KeyboardEvent, memo, useMemo, useRef, useState } from "react";
import { css } from "styled-system/css";
import { searchMatch, sectionHeader } from "styled-system/recipes";
import type { TaskItem } from "../api";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Badge, Button, Checkbox } from "@/components/ui";
import { renderInline } from "../preview";
import { highlightRanges, markHtml } from "../highlight";
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
  truncate: true,
  flex: "0 1 auto",
  minW: "0",
  "[data-done] &": { color: "velo.fgMuted", textDecoration: "line-through" },
  "& a": { color: "velo.accentText", textDecoration: "none" },
  "& code": { fontFamily: "mono", fontSize: "0.9em", bg: "velo.subtle", px: "1", borderRadius: "l1" },
});
const note = css({ color: "velo.fgMuted", truncate: true, flex: "1 1 0", minW: "0", fontSize: "var(--velo-snippet-fs)" });
// "Ticked · Undo": one status line under the list (v2 §3 #16), only while there is something to undo
const status = css({ display: "flex", alignItems: "center", gap: "1", h: "8", px: "2.5", borderTop: "1px solid", borderColor: "velo.muted", fontSize: "uiSm", color: "velo.fgMuted", flex: "none" });
const empty = css({ p: "4", textAlign: "center", color: "velo.fgMuted", fontSize: "uiSm" });

const GROUPS = [
  ["overdue", "Overdue"],
  ["today", "Today"],
  ["upcoming", "Upcoming"],
  ["no_date", "No date"],
  ["done", "Done"],
] as const;

type RowProps = { t: TaskItem; overdue: boolean; query: string; controller: Controller; stop: boolean; onStop: (key: string) => void };

const marks = (t: TaskItem, q: string) => JSON.stringify([highlightRanges(t.text, q), highlightRanges(t.title, q)]);
// Every reload brings new objects and every keystroke a new query: compare what the row shows, so only rows that change re-render.
// shortcut: marks are compared on the raw markdown, so a match only in rendered text (an entity like &copy;) can show late; compare rendered HTML if that matters.
const sameRow = (a: RowProps, b: RowProps) =>
  a.overdue === b.overdue && a.controller === b.controller && a.stop === b.stop && a.onStop === b.onStop &&
  (["path", "line", "line_text", "text", "title", "due", "done"] as const).every((k) => a.t[k] === b.t[k]) &&
  (a.query === b.query || marks(a.t, a.query) === marks(b.t, b.query));

const TaskRow = memo(function TaskRow({ t, overdue, query, controller, stop, onStop }: RowProps) {
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
      <span className={text} aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />
      <span className={note}><HighlightedText text={t.title} query={query} /></span>
      {t.due && (
        <Badge size="sm" variant="subtle" colorPalette={overdue ? "red" : "gray"} flex="none">
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

  const groups = view ? GROUPS.filter(([k]) => view[k].length) : [];
  const list = useRef<HTMLDivElement>(null);
  const [cur, setCur] = useState(""); // key of the tab stop; the first row when it is gone
  const keyOf = (t: TaskItem) => `${t.path}:${t.line}`;
  const stopKey = groups.some(([k]) => view![k].some((t) => keyOf(t) === cur)) ? cur : groups.length ? keyOf(view![groups[0][0]][0]) : "";
  const move = (e: KeyboardEvent) => {
    const d = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    const rows = [...list.current!.querySelectorAll<HTMLElement>("[data-task]")];
    const i = rows.indexOf(e.target as HTMLElement);
    if (!d || i < 0) return;
    e.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, i + d))].focus(); // focus sets the tab stop
  };
  return (
    <div className={pane}>
      <div ref={list} className={scroller} role="list" aria-label="Tasks" onKeyDown={move}>
        {view && groups.length === 0 && <div className={empty}>{query ? `No tasks match “${query}”` : "No open tasks"}</div>}
        {groups.map(([k, label]) => (
          <div key={k} role="group" aria-label={label}>
            <div className={sectionHeader()}>{label}</div>
            {view![k].map((t) => <TaskRow key={keyOf(t)} t={t} overdue={k === "overdue"} query={query} controller={controller} stop={keyOf(t) === stopKey} onStop={setCur} />)}
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
