// Draggable divider between the note list and the note: list height (vertical layout) or width (horizontal).
// Remembered per layout in localStorage: a per-machine convenience, so losing it only resets the default size.

export const MIN_LIST = 116; // px: list never collapses (36px pane bar + a couple of rows)
export const MIN_NOTE = 160; // px: note pane never collapses

/** Size clamped so both the list and the note keep a usable minimum within `total` px. */
export const clampSize = (size: number, total: number): number => Math.round(Math.max(MIN_LIST, Math.min(size, total - MIN_NOTE)));

/** Arrow keys move one row (Shift: ten); null for any other key. */
export const nudge = (size: number, key: string, shift: boolean, rowH: number): number | null => {
  const d = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[key];
  return d === undefined ? null : size + d * rowH * (shift ? 10 : 1);
};

const key = (horizontal: boolean) => (horizontal ? "velo.list-w" : "velo.list-h");
const cssVar = (horizontal: boolean) => (horizontal ? "--list-w" : "--list-h");

/** `titlebar` also drags in the vertical layout: it is the band that reads as the divider there. `rowH`: keyboard step (the list row height). `signal` removes the listeners. */
export function mountDivider(divider: HTMLElement, app: HTMLElement, titlebar?: HTMLElement, rowH: () => number = () => 16, signal?: AbortSignal) {
  const horizontal = () => !!app.closest("[data-layout=horizontal]");
  // looked up each time: switching to Tasks or Connections swaps the element before the divider
  const list = () => divider.previousElementSibling as HTMLElement;
  const total = () => (horizontal() ? app.clientWidth : app.clientHeight - list().getBoundingClientRect().top + app.getBoundingClientRect().top);
  const set = (size: number, save: boolean) => {
    const h = horizontal(), v = clampSize(size, total());
    app.style.setProperty(cssVar(h), `${v}px`);
    divider.setAttribute("aria-valuenow", String(v));
    if (save) try { localStorage.setItem(key(h), String(v)); } catch { /* storage blocked: size just isn't remembered */ }
  };
  const current = () => (horizontal() ? list().offsetWidth : list().offsetHeight);

  const drag = (handle: HTMLElement, e: PointerEvent) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const start = horizontal() ? e.clientX : e.clientY, from = current();
    const move = (m: PointerEvent) => set(from + (horizontal() ? m.clientX : m.clientY) - start, false);
    const up = () => {
      handle.removeEventListener("pointermove", move);
      set(current(), true);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
    handle.addEventListener("pointercancel", up, { once: true });
  };
  divider.addEventListener("pointerdown", (e) => drag(divider, e), { signal });
  titlebar?.addEventListener("pointerdown", (e) => {
    // the title itself keeps double-click rename and the rename field its text selection
    if (horizontal() || e.button !== 0 || (e.target as HTMLElement).closest("#title, [data-note-title], input, button, a")) return;
    drag(titlebar, e);
  }, { signal });
  divider.addEventListener("keydown", (e) => {
    const v = nudge(current(), e.key, e.shiftKey, rowH());
    if (v === null) return;
    e.preventDefault();
    set(v, true);
  }, { signal });
  divider.addEventListener("dblclick", () => {
    app.style.removeProperty(cssVar(horizontal())); // back to the default size
    try { localStorage.removeItem(key(horizontal())); } catch { /* ignore */ }
  }, { signal });

  /** Apply the remembered size for the current layout (startup and layout changes). */
  return function restore() {
    const h = horizontal();
    divider.setAttribute("aria-orientation", h ? "vertical" : "horizontal");
    app.style.removeProperty("--list-w");
    app.style.removeProperty("--list-h");
    let saved: number | null = null;
    try { saved = Number(localStorage.getItem(key(h))) || null; } catch { /* ignore */ }
    if (saved) set(saved, false);
  };
}
