import { useEffect, useRef } from "react";
import { css } from "styled-system/css";
import { paneDivider } from "styled-system/recipes";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { useStore } from "./useStore";
import { Header } from "./Header";
import { EditorHost } from "./EditorHost";
import { PreviewHost } from "./PreviewHost";
import { NoteList } from "./NoteList";

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
      <Header controller={controller} store={store} />
      <NoteList controller={controller} store={store} />
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
