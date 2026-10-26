import { TriangleAlert } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { css } from "styled-system/css";
import { titleBar } from "styled-system/recipes";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Button, Kbd, Spinner } from "@/components/ui";
import { useStore } from "./useStore";

const c = titleBar();
const num = (n: number) => n.toLocaleString("en-US");
const rename = css({
  flex: "1",
  minW: "0",
  h: "control",
  ml: "-2",
  px: "2",
  borderWidth: "1px",
  borderColor: "velo.accentBorder",
  boxShadow: "0 0 0 1px var(--colors-velo-accent-border)",
  borderRadius: "l2",
  bg: "velo.canvas",
  color: "velo.fg",
  fontSize: "var(--velo-title-fs)",
  fontWeight: "650",
  letterSpacing: "-0.01em",
  outline: "0",
});
const hint = css({ display: "inline-flex", alignItems: "center", gap: "1.5", fontSize: "uiSm", color: "velo.fgMuted", whiteSpace: "nowrap", flex: "none" });
const track = css({ w: "64px", h: "1", borderRadius: "2px", bg: "velo.muted", overflow: "hidden", display: "inline-block" });
const root = css({ "[data-layout=vertical] &": { cursor: "row-resize" }, "& [data-note-title]": { cursor: "default" } });

/** Error text with `code` spans (the locked-note message names .velo/identity.age). */
const withCode = (t: string): ReactNode[] => t.split("`").map((p, i) => (i % 2 ? <code key={i}>{p}</code> : p));

export function TitleBar({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const s = useStore(store);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (s.renaming) input.current?.select();
  }, [s.renaming]);
  const bar = { ...c, root: `${c.root} ${root}` };

  return (
    <div className={bar.root} data-titlebar="">
      {s.renaming ? (
        <>
          <input
            ref={input}
            className={rename}
            data-rename=""
            aria-label="Note title"
            defaultValue={s.title}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") void controller.commitRename(e.currentTarget.value);
              else if (e.key === "Escape") void controller.commitRename(null);
              else return;
              e.preventDefault();
            }}
            onBlur={() => void controller.commitRename(null)}
          />
          <span className={hint}>
            <Kbd>↩</Kbd> Rename <Kbd>Esc</Kbd> Cancel
          </span>
        </>
      ) : (
        <h2 className={bar.title} data-note-title="" title={s.title} onDoubleClick={() => controller.startRename()}>
          {s.title}
        </h2>
      )}
      {s.err ? (
        <>
          <span className={bar.status} data-tone="error" role="alert">
            <TriangleAlert size={14} aria-hidden />
            {withCode(s.err)}
          </span>
          {s.errFromSave && (
            <Button variant="outline" size="sm" onClick={() => controller.retrySave()}>
              Retry
            </Button>
          )}
        </>
      ) : s.indexing ? (
        <span className={bar.status} role="status">
          <Spinner size="sm" />
          Indexing… {num(s.indexing.done)} / {num(s.indexing.total)}
          <span className={track} aria-hidden>
            <i className={css({ display: "block", h: "full", bg: "velo.accent" })} style={{ width: `${s.indexing.total ? Math.min(100, (100 * s.indexing.done) / s.indexing.total) : 0}%` }} />
          </span>
        </span>
      ) : s.saving ? (
        <span className={bar.status} role="status">
          <Spinner size="sm" />
          Saving…
        </span>
      ) : null}
    </div>
  );
}
