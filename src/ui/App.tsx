import { useEffect, useRef } from "react";
import { css } from "styled-system/css";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { useStore } from "./useStore";
import { Header } from "./Header";
import { EditorHost } from "./EditorHost";
import { PreviewHost } from "./PreviewHost";
import { NoteList } from "./NoteList";
import { TaskList } from "./TaskList";
import { ConnectionsView } from "./ConnectionsView";
import { TimelineView } from "./TimelineView";
import { TitleBar } from "./TitleBar";
import { ConflictBanner } from "./ConflictBanner";
import { UpdateBanner } from "./UpdateBanner";
import { PreviewStrip } from "./PreviewStrip";
import { TagBar } from "./TagBar";
import { Divider } from "./Divider";
import { TagPanel } from "./TagPanel";
import { FilterLine } from "./FilterLine";
import { FirstRun } from "./FirstRun";
import { SettingsDialog } from "./SettingsDialog";
import { InfoPanel } from "./InfoPanel";
import { ExtractDialog } from "./ExtractDialog";
import { MergeDialog } from "./MergeDialog";
import { SaveSearchDialog } from "./SaveSearchDialog";
import { ExportDialog } from "./ExportDialog";
import { PassphraseDialog } from "./PassphraseDialog";
import { PrintHost } from "./PrintHost";

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
const pane = css({ flex: "1", minH: "0", minW: "0", display: "flex" });
const note = css({ flex: "1", minH: "0", minW: "0", display: "flex", flexDirection: "column", position: "relative" });
// Header, tag panel and filter line stack as one block; in the horizontal grid it spans both columns.
const top = css({ flex: "none", minW: "0", "[data-layout=horizontal] &": { gridColumn: "1 / -1" } });

export function App({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const previewOn = useStore(store, (s) => s.previewOn);
  const paneMode = useStore(store, (s) => s.paneMode);
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
      {paneMode === "tasks" ? (
        <TaskList controller={controller} store={store} />
      ) : paneMode === "connections" ? (
        <ConnectionsView controller={controller} store={store} />
      ) : paneMode === "timeline" ? (
        <TimelineView controller={controller} store={store} />
      ) : (
        <NoteList controller={controller} store={store} />
      )}
      <Divider store={store} app={root} />
      <div className={pane}>
      <section className={note}>
        <TitleBar controller={controller} store={store} />
        <UpdateBanner controller={controller} store={store} />
        <ConflictBanner controller={controller} store={store} />
        <PreviewStrip store={store} />
        <TagBar controller={controller} store={store} />
        <EditorHost controller={controller} />
        <PreviewHost controller={controller} />
        {/* the editor stays mounted under the first-run screen */}
        <FirstRun controller={controller} store={store} />
      </section>
      <InfoPanel controller={controller} store={store} />
      </div>
      <SettingsDialog controller={controller} store={store} />
      <ExtractDialog controller={controller} store={store} />
      <MergeDialog controller={controller} store={store} />
      <SaveSearchDialog controller={controller} store={store} />
      <ExportDialog controller={controller} store={store} />
      <PassphraseDialog />
      <PrintHost store={store} />
    </div>
  );
}
