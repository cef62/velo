import { createPortal } from "react-dom";
import type { AppState, Store } from "../app/store";
import { useStore } from "./useStore";

/** The PDF export for the print dialog: a direct child of <body>, so print CSS can hide everything else (global-css.ts). */
export function PrintHost({ store }: { store: Store<AppState> }) {
  const html = useStore(store, (s) => s.printHtml);
  // html is markdown-it output with raw HTML off, as in the preview
  return html === null ? null : createPortal(<div data-print="" dangerouslySetInnerHTML={{ __html: html }} />, document.body);
}
