import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { useStore } from "./useStore";

/** The PDF export for the print dialog: a direct child of <body>, so print CSS can hide everything else (global-css.ts). */
export function PrintHost({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const html = useStore(store, (s) => s.printHtml);
  // WebKit may never fire afterprint for a native print sheet; the next export clears the container then
  useEffect(() => {
    if (html === null) return;
    const done = () => controller.printDone();
    window.addEventListener("afterprint", done, { once: true });
    return () => window.removeEventListener("afterprint", done);
  }, [html, controller]);
  // html is markdown-it output with raw HTML off, as in the preview
  return html === null ? null : createPortal(<div data-print="" dangerouslySetInnerHTML={{ __html: html }} />, document.body);
}
