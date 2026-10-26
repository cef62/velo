import { useEffect, useRef } from "react";
import { css } from "styled-system/css";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { useStore } from "./useStore";
import { Header } from "./Header";
import { EditorHost } from "./EditorHost";
import { PreviewHost } from "./PreviewHost";
import { NoteList } from "./NoteList";
import { TitleBar } from "./TitleBar";
import { ConflictBanner } from "./ConflictBanner";
import { PreviewStrip } from "./PreviewStrip";
import { Divider } from "./Divider";
import { TagPanel } from "./TagPanel";
import { FilterLine } from "./FilterLine";
import { FirstRun } from "./FirstRun";
import { SettingsDialog } from "./SettingsDialog";
import { PassphraseDialog } from "./PassphraseDialog";

// Layout per design README: vertical = header / list / divider / note; horizontal = header over [list | divider | note].
// platform.applyLook writes data-layout on <html>; the divider sizes come from --list-h / --list-w .
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
// Header, tag panel and filter line stack as one block; in the horizontal grid it spans both columns.
const top = css({ flex: "none", minW: "0", "[data-layout=horizontal] &": { gridColumn: "1 / -1" } });

export function App({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const previewOn = useStore(store, (s) => s.previewOn);
  // The hosts' layout effects (attachEditor/attachPreview) run before this effect, so start() sees them; once only under StrictMode.
  const started = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    controller.start().catch((e) => console.error("start failed", e));
  }, [controller]);

  return (
    <div ref={root} className={app} data-preview-on={previewOn || undefined}>
      <div className={top}>
        <Header controller={controller} store={store} />
        <TagPanel controller={controller} store={store} />
        <FilterLine controller={controller} store={store} />
      </div>
      <NoteList controller={controller} store={store} />
      <Divider store={store} app={root} />
      <section className={note}>
        <TitleBar controller={controller} store={store} />
        <ConflictBanner controller={controller} store={store} />
        <PreviewStrip store={store} />
        <EditorHost controller={controller} />
        <PreviewHost controller={controller} />
        {/* the editor stays mounted under the first-run screen */}
        <FirstRun controller={controller} store={store} />
      </section>
      <SettingsDialog controller={controller} store={store} />
      <PassphraseDialog />
    </div>
  );
}
