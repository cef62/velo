import { useRef } from "react";

// What counts as an open dialog in the main window. OVERLAY (any open dialog, the update pill's non-modal popover
// included) keeps app shortcuts and tray actions away, as before. MODAL (Ark dialogs, which set aria-modal=true, a
// native <dialog>, an alertdialog) is what can hold unsaved input: only a modal refuses the What's new window's install.
export const MODAL = "dialog[open], [role=dialog][aria-modal=true][data-state=open], [role=alertdialog][data-state=open]";
export const OVERLAY = "dialog[open], [role=dialog][data-state=open], [role=alertdialog][data-state=open]";

export const modalOpen = (root: ParentNode = document) => !!root.querySelector(MODAL);
export const overlayOpen = (root: ParentNode = document) => !!root.querySelector(OVERLAY);

/** The command palette is the only open dialog (and focus is not in a menu or the lock screen): its own shortcut may close it. */
export const paletteOnly = (t: Element, root: ParentNode = document) => {
  const open = [...root.querySelectorAll(OVERLAY)];
  return open.length > 0 && open.every((d) => d.matches("[aria-label='Command palette']")) && !t.closest("[role=menu], [data-lock-screen]");
};

// The origin of the last dialog opened from outside a dialog. A dialog opened from the command palette opens while the palette's
// input is going away (focus in the palette or, in Chromium, already on <body>): it returns to where the palette was opened from.
// A key or a click outside any dialog starts afresh: a dialog opened with focus on <body> (WebKit leaves a clicked button unfocused)
// returns focus to <body>, never to an older origin (#111). Not to the clicked button either: focus there opens its tooltip, which
// shows unasked and takes the next Escape.
let lastOrigin: Element | null = null;
const fresh = (e: Event) => {
  if (!(e.target instanceof Element && e.target.closest("[role=dialog]"))) lastOrigin = null;
};
// registered when this module loads, before main.tsx's shortcut handler: a dialog a key opens finds that key's reset done
if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", fresh, true);
  window.addEventListener("keydown", fresh, true);
  // the window's own blur (the tray), not an element's; an open palette still hands its origin to the dialog it runs
  window.addEventListener("blur", (e) => e.target === window && !overlayOpen() && (lastOrigin = null));
}

function focusOrigin(): Element | null {
  const a = document.activeElement;
  if (!a || a === document.body || a.closest("[role=dialog]")) return lastOrigin;
  // a menu item (Move selection to new note) is about to vanish with its menu: the menu's trigger is where focus belongs
  const menu = a.closest("[role=menu]");
  lastOrigin = menu ? (menu.id && document.querySelector(`[aria-controls="${menu.id}"]`)) || null : a;
  return lastOrigin;
}

/**
 * `finalFocusEl` for a dialog whose input has `autoFocus`: that runs at commit, before the dialog's focus trap records what had
 * focus, so the trap would "return" focus to the removed input, i.e. <body> (#111). Record the origin in the render that opens
 * the dialog, still before that commit.
 */
export function useReturnFocus(open: boolean) {
  const origin = useRef<Element | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) origin.current = focusOrigin();
  wasOpen.current = open;
  return () => (origin.current instanceof HTMLElement && origin.current.isConnected ? origin.current : null);
}
