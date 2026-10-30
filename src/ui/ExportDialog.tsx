import { CircleAlert } from "lucide-react";
import { useRef } from "react";
import { css } from "styled-system/css";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Button, Dialog, SegmentGroup, Spinner } from "@/components/ui";
import { countsLine } from "../export";
import { filtersLine } from "../timeline";
import { useStore } from "./useStore";

const err = css({ display: "flex", alignItems: "center", gap: "1.5", fontSize: "uiSm", lineHeight: "1.4", color: "red.11", m: "0", "& svg": { w: "14px", h: "14px", flex: "none" } });
const label = css({ fontSize: "uiSm", fontWeight: "550", color: "velo.fg" });
const row = css({ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "3" });

/** Export…: what the timeline shows, to one Markdown file or to PDF through the print dialog. */
export function ExportDialog({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const exporting = useStore(store, (s) => s.exporting);
  // the scope is what the Timeline shows (v2 §4): by, range and the active filters
  const scope = useStore(store, (s) =>
    [`From the Timeline · ${s.timeline.by === "created" ? "Created" : "Updated"} ${s.timeline.range === "all" ? "any time" : `in the last ${s.timeline.range} days`}`, filtersLine({ query: s.query, tags: s.selectedTags, noLinks: s.noLinks, range: "all" })].filter(Boolean).join(" · "),
  );
  const last = useRef(exporting);
  if (exporting) last.current = exporting; // keeps the body mounted through the exit animation
  return (
    <Dialog.Root open={exporting !== null} onOpenChange={(d) => !d.open && void controller.commitExport(false)} closeOnInteractOutside={false}>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content className={css({ maxW: "460px", p: "0", gap: "0", overflow: "hidden" })}>
          {last.current && <Body state={exporting ?? last.current} scope={scope} controller={controller} />}
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}

function Segments<T extends string>({ label: name, value, items, on }: { label: string; value: T; items: readonly (readonly [T, string])[]; on: (v: T) => void }) {
  return (
    <SegmentGroup.Root size="sm" value={value} onValueChange={(d) => d.value && d.value !== value && on(d.value as T)} aria-label={name}>
      <SegmentGroup.Indicator />
      {items.map(([v, text]) => (
        <SegmentGroup.Item key={v} value={v}>
          <SegmentGroup.ItemText>{text}</SegmentGroup.ItemText>
          <SegmentGroup.ItemHiddenInput aria-label={text} />
        </SegmentGroup.Item>
      ))}
    </SegmentGroup.Root>
  );
}

function Body({ state, scope, controller }: { state: NonNullable<AppState["exporting"]>; scope: string; controller: Controller }) {
  const { counts } = state;
  const empty = counts !== null && counts.notes === 0;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void controller.commitExport(true);
      }}
    >
      <div className={css({ p: "20px 20px 4px" })}>
        <Dialog.Title className={css({ fontSize: "17px", fontWeight: "650", lineHeight: "1.3", letterSpacing: "-0.01em" })}>Export</Dialog.Title>
        <Dialog.Description className={css({ mt: "1", fontSize: "uiSm", color: "velo.fgMuted" })}>{scope}</Dialog.Description>
      </div>
      <div className={css({ p: "14px 20px 18px", display: "flex", flexDirection: "column", gap: "3" })}>
        <div className={row}>
          <span className={label} aria-hidden>Format</span>
          <Segments label="Format" value={state.format} items={[["md", "Markdown"], ["pdf", "PDF"]] as const} on={(format) => void controller.setExportOptions({ format })} />
        </div>
        <div className={row}>
          <span className={label} aria-hidden>Content</span>
          <Segments label="Content" value={state.tasksOnly ? "tasks" : "full"} items={[["full", "Full notes"], ["tasks", "Tasks only"]] as const} on={(v) => void controller.setExportOptions({ tasksOnly: v === "tasks" })} />
        </div>
        <p className={css({ fontSize: "uiSm", color: "velo.fgMuted", m: "0" })} role="status">
          {counts ? (empty ? `Nothing to export · ${countsLine(counts)}` : countsLine(counts)) : <><Spinner size="sm" /> Counting…</>}
        </p>
        {state.err && (
          <p className={err} role="alert">
            <CircleAlert aria-hidden /> {state.err}
          </p>
        )}
      </div>
      <div className={css({ display: "flex", justifyContent: "flex-end", gap: "2", px: "5", py: "3.5", borderTop: "1px solid", borderColor: "velo.divider" })}>
        <Button type="button" variant="outline" onClick={() => void controller.commitExport(false)}>Cancel</Button>
        <Button type="submit" colorPalette="green" disabled={!counts || empty || state.pending}>Export…</Button>
      </div>
    </form>
  );
}
