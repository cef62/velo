import { useEffect, useRef } from "react";
import { css } from "styled-system/css";
import { paneDivider } from "styled-system/recipes";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { useStore } from "./useStore";
import { registerSearchInput } from "./platform";
import { EditorHost } from "./EditorHost";
import { PreviewHost } from "./PreviewHost";

// Layout per design README: vertical = header / list / divider / note; horizontal = header over [list | divider | note].
// platform.applyLook writes data-layout on <html>; the divider sizes come from --list-h / --list-w (Task 11).
const app = css({
  h: "100vh",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  bg: "velo.canvas",
  color: "velo.fg",
  "[data-layout=horizontal] &": {
    display: "grid",
    gridTemplateColumns: "minmax(200px, var(--list-w, 260px)) auto minmax(320px, 1fr)",
    gridTemplateRows: "auto minmax(0, 1fr)",
  },
});
const header = css({
  display: "flex",
  alignItems: "center",
  gap: "1.5",
  h: "header",
  px: "3",
  bg: "velo.chrome",
  borderBottom: "1px solid",
  borderColor: "velo.divider",
  flex: "none",
  "[data-layout=horizontal] &": { gridColumn: "1 / -1" },
});
const list = css({
  h: "var(--list-h, 30%)",
  flex: "none",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  p: "1",
  "[data-layout=horizontal] &": { h: "auto", minH: "0" },
});
const note = css({ flex: "1", minH: "0", minW: "0", display: "flex", flexDirection: "column", position: "relative" });
const titleBar = css({
  display: "flex",
  alignItems: "center",
  gap: "3",
  h: "titleBar",
  px: "5",
  flex: "none",
  borderBottom: "1px solid",
  borderColor: "velo.divider",
  fontWeight: "650",
  fontSize: "var(--velo-title-fs)",
  "& [data-err]": { color: "red.11", fontSize: "uiSm", fontWeight: "normal" },
});

// placeholder: replaced in Task 9
function SearchPlaceholder({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const query = useStore(store, (s) => s.query);
  const indexing = useStore(store, (s) => s.indexing !== null);
  return (
    <input
      ref={registerSearchInput}
      aria-label="Search or create"
      placeholder="Search or create…"
      value={query}
      disabled={indexing}
      className={css({ flex: "1", h: "control", px: "2.5", border: "1px solid", borderColor: "velo.inputBorder", borderRadius: "l2", bg: "velo.canvas" })}
      onChange={(e) => controller.setQuery(e.target.value)}
      onFocus={() => controller.setListActive(true)}
      onBlur={() => controller.setListActive(false)}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        void controller.enter(e.shiftKey);
      }}
    />
  );
}

// placeholder: replaced in Task 10
function ListPlaceholder({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  useStore(store, (s) => s.listVersion);
  const count = useStore(store, (s) => s.count);
  const sel = useStore(store, (s) => s.sel);
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <button
          key={i}
          type="button"
          data-row={i}
          aria-current={i === sel}
          className={css({ textAlign: "left", px: "2.5", h: "var(--velo-row-h)", flex: "none", borderRadius: "l2", fontSize: "var(--velo-list-fs)", "&[aria-current=true]": { bg: "velo.accent", color: "white" } })}
          onClick={() => void controller.select(i)}
          onContextMenu={(e) => {
            e.preventDefault();
            void controller.openContextMenu(i);
          }}
        >
          {controller.row(i)?.title ?? "…"}
        </button>
      ))}
    </>
  );
}

export function App({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const s = useStore(store);
  // The hosts' layout effects (attachEditor/attachPreview) run before this effect, so start() sees them; once only under StrictMode.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    controller.start().catch((e) => console.error("start failed", e));
  }, [controller]);

  return (
    <div className={app} data-preview-on={s.previewOn || undefined}>
      <header className={header}>
        <SearchPlaceholder controller={controller} store={store} />
      </header>
      <div className={list}>
        <ListPlaceholder controller={controller} store={store} />
      </div>
      <div className={paneDivider({ orientation: s.layout === "horizontal" ? "vertical" : "horizontal" })} role="separator" aria-label="Resize note list" />
      <section className={note}>
        {/* placeholder: replaced in Task 11 */}
        <div className={titleBar}>
          <span>{s.title}</span>
          {s.err && <span data-err="">{s.err}</span>}
        </div>
        <EditorHost controller={controller} />
        <PreviewHost controller={controller} />
        {/* placeholder: first-run screen replaced in Task 12; the editor stays mounted under it */}
        {s.phase === "setup" && (
          <div className={css({ position: "absolute", inset: "0", display: "grid", placeItems: "center", bg: "velo.chrome" })}>
            <button type="button" onClick={() => void controller.chooseFolder()}>
              Choose notes folder
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
