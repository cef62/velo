import { css } from "styled-system/css";
import type { TaskItem } from "../api";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Badge, Button, Checkbox } from "@/components/ui";
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
const text = css({ truncate: true, flex: "0 1 auto", minW: "0", "[data-done] &": { color: "velo.fgMuted", textDecoration: "line-through" } });
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

export function TaskList({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const view = useStore(store, (s) => s.taskView);
  const query = useStore(store, (s) => s.query);
  const showDone = useStore(store, (s) => s.showDone);
  const undo = useStore(store, (s) => s.tickUndo);

  const item = (t: TaskItem, overdue: boolean) => (
    <div
      key={`${t.path}:${t.line}`}
      role="listitem"
      tabIndex={0}
      className={row}
      data-done={t.done || undefined}
      onClick={() => void controller.openTask(t)}
      onKeyDown={(e) => e.key === "Enter" && void controller.openTask(t)}
    >
      <Checkbox.Root size="sm" checked={t.done} onCheckedChange={() => void controller.tickTask(t)} onClick={(e) => e.stopPropagation()}>
        <Checkbox.Control>
          <Checkbox.Indicator />
        </Checkbox.Control>
        <Checkbox.HiddenInput aria-label={t.text} />
      </Checkbox.Root>
      <span className={text}><HighlightedText text={t.text} query={query} /></span>
      <span className={note}><HighlightedText text={t.title} query={query} /></span>
      {t.due && (
        <Badge size="sm" variant="subtle" colorPalette={overdue ? "red" : "gray"} flex="none">
          {t.due}
        </Badge>
      )}
    </div>
  );

  const groups = view ? GROUPS.filter(([k]) => view[k].length) : [];
  return (
    <div className={pane}>
      <div className={scroller} role="list" aria-label="Tasks">
        {view && groups.length === 0 && <div className={empty}>{query ? `No tasks match “${query}”` : "No open tasks"}</div>}
        {groups.map(([k, label]) => (
          <div key={k} role="group" aria-label={label}>
            <div className={header}>{label}</div>
            {view![k].map((t) => item(t, k === "overdue"))}
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
            Ticked ·
            <Button variant="plain" size="xs" onClick={() => void controller.undoTick()}>
              Undo
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}
