import { useEffect, useRef } from "react";
import { css } from "styled-system/css";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { useStore } from "./useStore";
import { Header } from "./Header";
import { EditorHost } from "./EditorHost";
import { PreviewHost } from "./PreviewHost";
import { NoteList } from "./NoteList";
import { PaneBar } from "./PaneBar";
import { TaskList } from "./TaskList";
import { TimelineView } from "./TimelineView";
import { TitleBar } from "./TitleBar";
import { ConflictBanner } from "./ConflictBanner";
import { TagBar } from "./TagBar";
import { Divider } from "./Divider";
import { FiltersPanel } from "./FiltersPanel";
import { FirstRun } from "./FirstRun";
import { SettingsDialog } from "./SettingsDialog";
import { SidePanel } from "./SidePanel";
import { ExtractDialog } from "./ExtractDialog";
import { MergeDialog } from "./MergeDialog";
import { SaveSearchDialog } from "./SaveSearchDialog";
import { ExportDialog } from "./ExportDialog";
import { PassphraseDialog } from "./PassphraseDialog";
import { PrintHost } from "./PrintHost";
import { CommandPalette } from "./CommandPalette";

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
const pane = css({ flex: "1", minH: "0", minW: "0", display: "flex", position: "relative" }); // the side panel overlays inside it when the note would get too narrow
// The left pane: one bar over one list, the same box in every mode; the divider sizes it through --list-h / --list-w.
const leftPane = css({ h: "var(--list-h, 30%)", flex: "none", display: "flex", flexDirection: "column", minH: "0", minW: "0", "[data-layout=horizontal] &": { h: "auto" } });
const note = css({ flex: "1", minH: "0", minW: "0", display: "flex", flexDirection: "column", position: "relative" });
// Header and Filters panel stack as one block; in the horizontal grid it spans both columns.
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
        <FiltersPanel controller={controller} store={store} />
      </div>
      <div className={leftPane}>
        <PaneBar controller={controller} store={store} />
        {paneMode === "tasks" ? <TaskList controller={controller} store={store} /> : paneMode === "timeline" ? <TimelineView controller={controller} store={store} /> : <NoteList controller={controller} store={store} />}
      </div>
      <Divider store={store} app={root} />
      <div className={pane}>
      <section className={note}>
        <TitleBar controller={controller} store={store} />
        <ConflictBanner controller={controller} store={store} />
        <TagBar controller={controller} store={store} />
        <EditorHost controller={controller} />
        <PreviewHost controller={controller} />
        {/* the editor stays mounted under the first-run screen; the inline unlock covers the note area the same way */}
        <PassphraseDialog />
        <FirstRun controller={controller} store={store} />
      </section>
      <SidePanel controller={controller} store={store} />
      </div>
      <SettingsDialog controller={controller} store={store} />
      <ExtractDialog controller={controller} store={store} />
      <MergeDialog controller={controller} store={store} />
      <SaveSearchDialog controller={controller} store={store} />
      <ExportDialog controller={controller} store={store} />
      <CommandPalette controller={controller} store={store} />
      <PrintHost store={store} />
    </div>
  );
}
