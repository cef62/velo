import { useEffect, useRef } from "react";
import { paneDivider } from "styled-system/recipes";
import { rowHeight } from "../app/fontscale";
import type { AppState, Store } from "../app/store";
import { mountDivider } from "../divider";
import { useStore } from "./useStore";

/** Wraps mountDivider's drag / double-click / keys / per-layout memory; it sets --list-h / --list-w on `app`. */
export function Divider({ store, app }: { store: Store<AppState>; app: React.RefObject<HTMLElement | null> }) {
  const el = useRef<HTMLDivElement>(null);
  const restore = useRef<(() => void) | null>(null);
  const layout = useStore(store, (s) => s.layout);
  useEffect(() => {
    const a = app.current!, d = el.current!;
    const ctl = new AbortController();
    // grip colour while dragging; mountDivider owns the pointer capture
    const on = () => d.setAttribute("data-dragging", "");
    const off = () => d.removeAttribute("data-dragging");
    for (const [t, f] of [["pointerdown", on], ["pointerup", off], ["pointercancel", off]] as const) d.addEventListener(t, f, { signal: ctl.signal });
    restore.current = mountDivider(
      d,
      a,
      a.querySelector<HTMLElement>("[data-titlebar]") ?? undefined,
      () => rowHeight(store.get().fontSize, store.get().layout),
      ctl.signal,
    );
    restore.current();
    return () => ctl.abort();
  }, [app, store]);
  useEffect(() => {
    restore.current?.(); // layout change: that layout's remembered size
    const l = el.current!.previousElementSibling as HTMLElement;
    el.current!.setAttribute("aria-valuenow", String(layout === "horizontal" ? l.offsetWidth : l.offsetHeight)); // default size when nothing is remembered
  }, [layout]);
  return (
    <div
      ref={el}
      data-divider=""
      className={paneDivider({ orientation: layout === "horizontal" ? "vertical" : "horizontal" })}
      role="separator"
      tabIndex={0}
      aria-label="Resize note list"
      aria-orientation={layout === "horizontal" ? "vertical" : "horizontal"}
    />
  );
}
