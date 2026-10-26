import { useLayoutEffect, useRef } from "react";
import { css } from "styled-system/css";
import { mountEditor, type Editor } from "../editor";
import type { Controller } from "../app/controller";

const host = css({
  flex: "1",
  display: "flex",
  flexDirection: "column",
  minH: "0",
  minW: "0",
  "& .cm-host": { flex: "1", minH: "0" },
  "[data-preview-on] &": { display: "none" }, // the preview takes the editor's place
});

/** CodeMirror lives for the app's lifetime: mounted once (the ref survives StrictMode's effect replay), attached on every run. */
export function EditorHost({ controller }: { controller: Controller }) {
  const el = useRef<HTMLDivElement>(null);
  const ed = useRef<Editor | null>(null);
  useLayoutEffect(() => {
    ed.current ??= mountEditor(el.current!, controller.editorOpts());
    controller.attachEditor(ed.current);
  }, [controller]);
  return <div ref={el} className={host} data-editor-host="" />;
}
