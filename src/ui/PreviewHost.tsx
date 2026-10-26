import { useLayoutEffect, useRef } from "react";
import { css } from "styled-system/css";
import { mountPreview, type Preview } from "../preview";
import type { Controller } from "../app/controller";

const pane = css({ flex: "1", minH: "0", minW: "0", overflowY: "auto", px: "5", py: "3" });

/** mountPreview owns the aside's `hidden` attribute, so React never renders one; mounted once like the editor (it has no destroy). */
export function PreviewHost({ controller }: { controller: Controller }) {
  const el = useRef<HTMLElement>(null);
  const p = useRef<Preview | null>(null);
  useLayoutEffect(() => {
    if (!p.current) {
      el.current!.hidden = true; // starts off; set before paint
      p.current = mountPreview(el.current!, controller.previewOpts());
    }
    controller.attachPreview(p.current);
  }, [controller]);
  return <aside ref={el} className={pane} data-preview-host="" />;
}
