// What counts as an open dialog in the main window. OVERLAY (any open dialog, the update pill's non-modal popover
// included) keeps app shortcuts and tray actions away, as before. MODAL (Ark dialogs, which set aria-modal=true, a
// native <dialog>, an alertdialog) is what can hold unsaved input: only a modal refuses the What's new window's install.
export const MODAL = "dialog[open], [role=dialog][aria-modal=true][data-state=open], [role=alertdialog][data-state=open]";
export const OVERLAY = "dialog[open], [role=dialog][data-state=open], [role=alertdialog][data-state=open]";

export const modalOpen = (root: ParentNode = document) => !!root.querySelector(MODAL);
export const overlayOpen = (root: ParentNode = document) => !!root.querySelector(OVERLAY);
