import { memo, useMemo } from "react";
import { css } from "styled-system/css";
import { searchMatch } from "styled-system/recipes";
import type { TaskItem } from "../api";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Badge, Button, Checkbox } from "@/components/ui";
import { renderInline } from "../preview";
import { highlightRanges, markHtml } from "../highlight";
import { HighlightedText } from "./HighlightedText";
import { useStore } from "./useStore";

// Same box as the note list's scroller, so the divider sizes it the same way.
const pane = css({
  h: "var(--list-h, 30%)",
  flex: "none",
  display: "flex",
  flexDirection: "column",
  minH: "0",
  "[data-layout=horizontal] &": { h: "auto" },
});
const scroller = css({ flex: "1", minH: "0", overflowY: "auto", p: "1" });
const header = css({ px: "2.5", pt: "2", pb: "1", fontSize: "uiXs", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.04em", color: "velo.fgMuted" });
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
const footer = css({ display: "flex", alignItems: "center", gap: "2", px: "2.5", py: "1", borderTop: "1px solid", borderColor: "velo.divider", fontSize: "uiSm", color: "velo.fgMuted", flex: "none" });
const empty = css({ p: "4", textAlign: "center", color: "velo.fgMuted", fontSize: "uiSm" });

const GROUPS = [
  ["overdue", "Overdue"],
  ["today", "Today"],
  ["upcoming", "Upcoming"],
  ["no_date", "No date"],
  ["done", "Done"],
] as const;

type RowProps = { t: TaskItem; overdue: boolean; query: string; controller: Controller };

const marks = (t: TaskItem, q: string) => JSON.stringify([highlightRanges(t.text, q), highlightRanges(t.title, q)]);
// Every reload brings new objects and every keystroke a new query: compare what the row shows, so only rows that change re-render.
// shortcut: marks are compared on the raw markdown, so a match only in rendered text (an entity like &copy;) can show late; compare rendered HTML if that matters.
const sameRow = (a: RowProps, b: RowProps) =>
  a.overdue === b.overdue && a.controller === b.controller &&
  (["path", "line", "line_text", "text", "title", "due", "done"] as const).every((k) => a.t[k] === b.t[k]) &&
  (a.query === b.query || marks(a.t, a.query) === marks(b.t, b.query));

const TaskRow = memo(function TaskRow({ t, overdue, query, controller }: RowProps) {
  // renderInline escapes HTML (markdown-it, html: false), as the preview does; markHtml re-escapes what it touches
  const html = useMemo(() => markHtml(renderInline(t.text), query, searchMatch()), [t.text, query]);
  return (
    <div
      role="listitem"
      tabIndex={0}
      className={row}
      data-done={t.done || undefined}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a")) e.preventDefault(); // links, wikilinks and tags in a row don't navigate: the row opens the task
        void controller.openTask(t);
      }}
      onKeyDown={(e) => e.key === "Enter" && void controller.openTask(t)}
    >
      <Checkbox.Root size="sm" checked={t.done} onCheckedChange={() => void controller.tickTask(t)} onClick={(e) => e.stopPropagation()}>
        <Checkbox.Control>
          <Checkbox.Indicator />
        </Checkbox.Control>
        <Checkbox.HiddenInput aria-label={t.text} />
      </Checkbox.Root>
      <span className={text} dangerouslySetInnerHTML={{ __html: html }} />
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
  const showDone = useStore(store, (s) => s.showDone);
  const undo = useStore(store, (s) => s.tickUndo);

  const groups = view ? GROUPS.filter(([k]) => view[k].length) : [];
  return (
    <div className={pane}>
      <div className={scroller} role="list" aria-label="Tasks">
        {view && groups.length === 0 && <div className={empty}>{query ? `No tasks match “${query}”` : "No open tasks"}</div>}
        {groups.map(([k, label]) => (
          <div key={k} role="group" aria-label={label}>
            <div className={header}>{label}</div>
            {view![k].map((t) => <TaskRow key={`${t.path}:${t.line}`} t={t} overdue={k === "overdue"} query={query} controller={controller} />)}
          </div>
        ))}
      </div>
      <div className={footer}>
        <Checkbox.Root size="sm" checked={showDone} onCheckedChange={() => void controller.toggleShowDone()}>
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
          <Checkbox.Label>Show done</Checkbox.Label>
          <Checkbox.HiddenInput />
        </Checkbox.Root>
        {undo && (
          <span role="status" className={css({ ml: "auto", display: "inline-flex", alignItems: "center", gap: "1" })}>
            {undo.unticked ? "Unticked" : "Ticked"} ·
            <Button variant="plain" size="xs" onClick={() => void controller.undoTick()}>
              Undo
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}
