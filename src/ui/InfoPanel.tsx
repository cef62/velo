import { css } from "styled-system/css";
import { tagChip } from "styled-system/recipes";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Button, Checkbox, Tooltip } from "@/components/ui";
import { fold } from "../search";
import { useStore } from "./useStore";

// The fragment keeps Panda from reading the Tooltip content prop as the CSS `content` property.
const FROM_FILE = "Not stored in the note yet; it may change when the file is synced or checked out.";
const root = css({ w: "280px", flex: "none", minH: "0", display: "flex", flexDirection: "column", gap: "4", p: "3.5", overflowY: "auto", bg: "velo.chrome", borderLeftWidth: "1px", borderLeftStyle: "solid", borderLeftColor: "velo.divider", fontSize: "uiSm", color: "velo.fg" });
const head = css({ fontWeight: "600", mb: "1.5" });
const row = css({ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "2", py: "0.5" });
const muted = css({ color: "velo.fgMuted" });
const chips = css({ display: "flex", flexWrap: "wrap", gap: "1.5" });
const list = css({ display: "flex", flexDirection: "column", gap: "0.5", listStyle: "none", m: "0", p: "0" });
const rev = css({ w: "full", textAlign: "left", px: "2", py: "1", borderRadius: "l2", cursor: "pointer", display: "flex", justifyContent: "space-between", _hover: { bg: "velo.subtle" }, "&[aria-pressed=true]": { bg: "velo.accentSubtleHover", color: "velo.accentText" } });
const preview = css({ mt: "2", maxH: "180px", overflow: "auto", p: "2", borderRadius: "l2", bg: "velo.canvas", borderWidth: "1px", borderColor: "velo.border", whiteSpace: "pre-wrap", fontSize: "uiXs", m: "0" });

const abs = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536e6], ["month", 2592e6], ["day", 864e5], ["hour", 36e5], ["minute", 6e4]];
function rel(ms: number): string {
  const d = ms - Date.now();
  const [u, n] = UNITS.find(([, n]) => Math.abs(d) >= n) ?? ["minute", 6e4];
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round(d / n), u);
}

export function InfoPanel({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const open = useStore(store, (s) => s.infoOpen);
  const openPath = useStore(store, (s) => s.openPath);
  const info = useStore(store, (s) => s.info);
  const showFm = useStore(store, (s) => s.showFrontMatter);
  const selected = useStore(store, (s) => s.selectedTags);
  if (!open) return null;
  const m = info.meta;
  const date = (label: string, ms: number, src: string) => (
    <div className={row}>
      <span className={muted}>{label}</span>
      <span title={abs(ms)}>
        {ms ? rel(ms) : "—"}{" "}
        {src === "file" && (
          <Tooltip content={<>{FROM_FILE}</>} openDelay={300}>
            <span className={muted} tabIndex={0} data-from-file="">(from file)</span>
          </Tooltip>
        )}
      </span>
    </div>
  );
  return (
    <aside className={root} aria-label="Note info" data-info-panel="">
      {openPath && m && (
        <>
          <section>
            <div className={head}>Dates</div>
            {date("Created", m.created, m.created_src)}
            {date("Modified", m.modified, m.modified_src)}
            <div className={muted}>{abs(m.created)} · {abs(m.modified)}</div>
          </section>
          <section>
            <div className={head}>Info</div>
            <div className={row}><span className={muted}>Words</span><span>{info.words}</span></div>
            <div className={row}>
              <span className={muted}>Linked from</span>
              <span>{info.backlinks === null ? "…" : `${info.backlinks} ${info.backlinks === 1 ? "note" : "notes"}`}</span>
            </div>
            {info.tags.length > 0 && (
              <div className={chips} role="group" aria-label="Tags">
                {info.tags.map((t) => {
                  const c = tagChip({ selected: selected.some((x) => fold(x) === fold(t)) });
                  return <button key={t} type="button" className={c.root} aria-pressed={selected.some((x) => fold(x) === fold(t))} onClick={() => controller.toggleTagFilter(t)}>#{t}</button>;
                })}
              </div>
            )}
            {m.aliases.length > 0 && <div className={row}><span className={muted}>Aliases</span><span>{m.aliases.join(", ")}</span></div>}
          </section>
          <section>
            <div className={head}>Revisions</div>
            {info.revisions && info.revisions.length === 0 && <div className={muted}>No revisions yet</div>}
            <ul className={list}>
              {info.revisions?.map((r) => (
                <li key={r.id}>
                  <button type="button" className={rev} aria-pressed={info.preview?.id === r.id} title={abs(r.ts)} onClick={() => void controller.selectRevision(r.id)}>
                    <span>{rel(r.ts)}</span>
                    <span className={muted}>{abs(r.ts)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {info.preview && (
              <>
                <pre className={preview} data-rev-preview="">{info.preview.text}</pre>
                <Button size="sm" variant="outline" mt="2" onClick={() => void controller.restoreRevision(info.preview!.id)}>Restore</Button>
              </>
            )}
          </section>
          <Checkbox.Root checked={showFm} onCheckedChange={() => void controller.toggleFrontMatter()} size="sm">
            <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
            <Checkbox.Label>Show front matter in the editor</Checkbox.Label>
            <Checkbox.HiddenInput />
          </Checkbox.Root>
        </>
      )}
    </aside>
  );
}
