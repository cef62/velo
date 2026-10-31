import { ArrowDownAZ, CalendarDays, Check, ChevronDown, Clock, Download, FileText, ListChecks } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { css } from "styled-system/css";
import { countBadge, menuButton, paneBar } from "styled-system/recipes";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Kbd, Menu, Tooltip } from "@/components/ui";
import { formatBinding, NONE, type Action } from "../shortcuts";
import { paneBarMode } from "./layout";
import { PANE_TABS, stepPaneTab, type PaneTab } from "./paneTabs";
import { useStore } from "./useStore";

// The bar on top of the left pane (v2 §2): mode tabs on the left, that mode's controls on the right.
// The tablist is one Tab stop (roving tabindex), ←/→ move, Enter/Space select. Labels follow the pane's own width.
const label = css({ px: "2", py: "1", fontSize: "uiSm", fontWeight: "600", color: "velo.fgMuted" });
const row = css({ display: "flex", alignItems: "center", gap: "2", w: "100%", "& svg, & [data-part=item-indicator]": { w: "4", h: "4", flex: "none" } });
const TAB: Record<PaneTab, { text: string; glyph: ReactNode; action: Action | null }> = {
  notes: { text: "Notes", glyph: <FileText />, action: null },
  tasks: { text: "Tasks", glyph: <ListChecks />, action: "toggle_tasks" },
  timeline: { text: "Timeline", glyph: <CalendarDays />, action: "toggle_timeline" },
};
const RANGES = [["7", "7 days"], ["30", "30 days"], ["all", "All"]] as const;

export function PaneBar({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const paneMode = useStore(store, (s) => s.paneMode);
  const keys = useStore(store, (s) => s.keys);
  const isMac = useStore(store, (s) => s.isMac);
  const dueCount = useStore(store, (s) => s.dueCount);
  const total = useStore(store, (s) => s.total);
  const sort = useStore(store, (s) => s.sort);
  const showDone = useStore(store, (s) => s.showDone);
  const tl = useStore(store, (s) => s.timeline);
  const root = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(1000);
  useLayoutEffect(() => {
    const e = root.current!;
    const ro = new ResizeObserver(() => setW(e.offsetWidth)); // divider drag, window resize, layout change
    ro.observe(e);
    setW(e.offsetWidth);
    return () => ro.disconnect();
  }, []);
  const mode = paneBarMode(w);
  const c = paneBar({ labels: mode.labels });
  const cur: PaneTab = paneMode;
  const kbd = (a: Action) => (keys[a] === NONE ? null : <Kbd marginLeft="auto">{formatBinding(keys[a], isMac)}</Kbd>);
  const tip = (a: Action | null, text: string) => (!a || keys[a] === NONE ? text : `${text} (${formatBinding(keys[a], isMac)})`);
  const menuBtn = (text: string, aria: string, glyph: ReactNode, extra: Record<string, unknown> = {}) => (
    <button type="button" className={menuButton({ iconOnly: mode.menusIconOnly })} aria-label={aria} {...extra}>
      {glyph}
      <span data-label>{text}</span>
      <ChevronDown data-chevron aria-hidden />
    </button>
  );

  return (
    <div ref={root} className={c.root}>
      <div
        className={c.tabs}
        role="tablist"
        aria-label="Left pane"
        onKeyDown={(e) => {
          const to = stepPaneTab(cur, e.key);
          if (!to) return;
          e.preventDefault();
          controller.setPaneMode(to);
          root.current?.querySelector<HTMLElement>(`[role=tab][data-tab="${to}"]`)?.focus();
        }}
      >
        {PANE_TABS.map((t) => (
          <Tooltip key={t} content={tip(TAB[t].action, TAB[t].text)} openDelay={500}>
            <button type="button" role="tab" data-tab={t} aria-selected={t === cur} tabIndex={t === cur ? 0 : -1} className={c.tab} aria-label={t === "tasks" && dueCount > 0 ? `Tasks, ${dueCount} due` : TAB[t].text} onClick={() => t !== cur && controller.setPaneMode(t)}>
              {TAB[t].glyph}
              <span data-label>{TAB[t].text}</span>
              {t === "tasks" && dueCount > 0 && <span className={countBadge({ tone: "danger" })} aria-hidden="true">{dueCount}</span>}
            </button>
          </Tooltip>
        ))}
      </div>
      <span className={c.spacer} />
      {cur === "notes" && (
        <>
          {total > 0 && <span className={c.meta} title={`${total.toLocaleString("en-US")} notes`}>{total.toLocaleString("en-US")}</span>}
          <Menu.Root positioning={{ placement: "bottom-end" }}>
            <Menu.Trigger asChild>{menuBtn(sort === "title" ? "Title A→Z" : "Recent", `Sort: ${sort === "title" ? "title" : "recent"}`, sort === "title" ? <ArrowDownAZ /> : <Clock />)}</Menu.Trigger>
            <Menu.Positioner>
              <Menu.Content minW="200px">
                <Menu.RadioItemGroup value={sort} onValueChange={(d) => d.value !== sort && void controller.setSort(d.value as typeof sort)}>
                  <Menu.ItemGroupLabel className={label}>Sort</Menu.ItemGroupLabel>
                  <Menu.RadioItem value="modified"><span className={row}><Menu.ItemIndicator /><Menu.ItemText>Recent</Menu.ItemText></span></Menu.RadioItem>
                  <Menu.RadioItem value="title"><span className={row}><Menu.ItemIndicator /><Menu.ItemText>Title A→Z</Menu.ItemText>{kbd("toggle_sort")}</span></Menu.RadioItem>
                </Menu.RadioItemGroup>
              </Menu.Content>
            </Menu.Positioner>
          </Menu.Root>
        </>
      )}
      {cur === "tasks" && (
        <button type="button" className={menuButton({ iconOnly: mode.menusIconOnly })} aria-pressed={showDone} aria-label="Show done" onClick={() => void controller.toggleShowDone()}>
          <Check aria-hidden />
          <span data-label>Show done</span>
        </button>
      )}
      {cur === "timeline" && (
        <>
          <Menu.Root positioning={{ placement: "bottom-end" }}>
            <Menu.Trigger asChild>
              {menuBtn(`${tl.by === "created" ? "Created" : "Updated"} · ${tl.range === "all" ? "All" : `${tl.range}d`}`, `Timeline: by ${tl.by}, ${tl.range === "all" ? "all time" : `last ${tl.range} days`}`, null)}
            </Menu.Trigger>
            <Menu.Positioner>
              <Menu.Content minW="200px">
                <Menu.RadioItemGroup value={tl.by} onValueChange={(d) => d.value !== tl.by && void controller.setTimelineBy(d.value as typeof tl.by)}>
                  <Menu.ItemGroupLabel className={label}>By</Menu.ItemGroupLabel>
                  <Menu.RadioItem value="created"><span className={row}><Menu.ItemIndicator /><Menu.ItemText>Created</Menu.ItemText></span></Menu.RadioItem>
                  <Menu.RadioItem value="updated"><span className={row}><Menu.ItemIndicator /><Menu.ItemText>Updated</Menu.ItemText></span></Menu.RadioItem>
                </Menu.RadioItemGroup>
                <Menu.Separator />
                <Menu.RadioItemGroup value={tl.range} onValueChange={(d) => d.value !== tl.range && void controller.setTimelineRange(d.value as typeof tl.range)}>
                  <Menu.ItemGroupLabel className={label}>Range</Menu.ItemGroupLabel>
                  {RANGES.map(([v, text]) => (
                    <Menu.RadioItem key={v} value={v}><span className={row}><Menu.ItemIndicator /><Menu.ItemText>{text}</Menu.ItemText></span></Menu.RadioItem>
                  ))}
                </Menu.RadioItemGroup>
              </Menu.Content>
            </Menu.Positioner>
          </Menu.Root>
          <Tooltip content={tip("export", "Export…")} openDelay={500}>
            <button type="button" className={menuButton({ iconOnly: true })} aria-label="Export…" onClick={() => void controller.startExport()}>
              <Download />
            </button>
          </Tooltip>
        </>
      )}
    </div>
  );
}
