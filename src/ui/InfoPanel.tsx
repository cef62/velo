import { css } from "styled-system/css";
import type { Controller } from "../app/controller";
import type { RevisionInfo } from "../api";
import type { AppState, Store } from "../app/store";
import { Badge, Button, Tooltip } from "@/components/ui";
import { useStore } from "./useStore";

// The fragment keeps Panda from reading the Tooltip content prop as the CSS `content` property.
const FROM_FILE = "Not stored in the note yet; it may change when the file is synced or checked out.";
// The Info tab of the side panel (v2 §3 #13): dates, words, aliases, revisions. Tags live in the tag bar, links in Related.
const root = css({ display: "flex", flexDirection: "column", gap: "4", p: "2", fontSize: "uiSm", color: "velo.fg" });
const head = css({ fontWeight: "600", mb: "1.5" });
const row = css({ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "2", py: "0.5" });
const muted = css({ color: "velo.fgMuted" });
const list = css({ display: "flex", flexDirection: "column", gap: "0.5", listStyle: "none", m: "0", p: "0" });
const rev = css({ w: "full", textAlign: "left", px: "2", py: "1", borderRadius: "l2", cursor: "pointer", display: "flex", justifyContent: "space-between", _hover: { bg: "velo.subtle" }, "&[aria-pressed=true]": { bg: "velo.accentSubtleHover", color: "velo.accentText" } });
const preview = css({ mt: "2", maxH: "180px", overflow: "auto", p: "2", borderRadius: "l2", bg: "velo.canvas", borderWidth: "1px", borderColor: "velo.border", whiteSpace: "pre-wrap", fontSize: "uiXs", m: "0" });

export const revisionLabel = (r: RevisionInfo) => ({ summary: r.summary ?? null, agent: r.agent });
const abs = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536e6], ["month", 2592e6], ["day", 864e5], ["hour", 36e5], ["minute", 6e4]];
function rel(ms: number): string {
  const d = ms - Date.now();
  const [u, n] = UNITS.find(([, n]) => Math.abs(d) >= n) ?? ["minute", 6e4];
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round(d / n), u);
}

export function InfoTab({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const openPath = useStore(store, (s) => s.openPath);
  const info = useStore(store, (s) => s.info);
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
    <div className={root} data-info-panel="">
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
            {m.aliases.length > 0 && <div className={row}><span className={muted}>Aliases</span><span>{m.aliases.join(", ")}</span></div>}
          </section>
          <section>
            <div className={head}>Revisions</div>
            {info.revisions && info.revisions.length === 0 && <div className={muted}>No revisions yet</div>}
            <ul className={list}>
              {info.revisions?.map((r) => (
                <li key={r.id}>
                  <button type="button" className={rev} aria-pressed={info.preview?.id === r.id} title={abs(r.ts)} onClick={() => void controller.selectRevision(r.id)}>
                    <span>
                      {rel(r.ts)}
                      {revisionLabel(r).summary && <span className={css({ display: "block", color: "velo.fgMuted", fontSize: "uiXs" })}>{revisionLabel(r).summary}</span>}
                    </span>
                    <span className={muted}>{revisionLabel(r).agent && <Badge size="sm" mr="1.5">agent</Badge>}{abs(r.ts)}</span>
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
        </>
      )}
      {!openPath && <div className={muted}>Open a note to see its info.</div>}
    </div>
  );
}
