// Demo-only overlay: the "nothing is saved" pill, a toast, and the in-page stand-in for native popup menus.
// Inline styles on purpose: Panda would extract css() calls from here into the real app's stylesheet too.
import { useEffect, useState, type CSSProperties } from "react";
import { Menu } from "../components/ui";
import type { MenuSpec } from "../app/ports";

type MenuState = { items: MenuSpec[]; x: number; y: number; key: number };

let showMenu: (m: MenuState) => void = () => {};
let showToast: (t: string) => void = () => {};
let pointer = { x: 0, y: 0 };
let menuKey = 0;
window.addEventListener("pointerdown", (e) => void (pointer = { x: e.clientX, y: e.clientY }), true);
window.addEventListener("contextmenu", (e) => void (pointer = { x: e.clientX, y: e.clientY }), true);

export const demoChrome = {
  /** A native menu without an anchor opens at the pointer, so this one does too. */
  menu(items: MenuSpec[], anchor: { x: number; y: number } | null) {
    showMenu({ items, ...(anchor ?? pointer), key: ++menuKey });
  },
  toast: (t: string) => showToast(t),
};

// top-left corner of the header (empty: room for the macOS window buttons), so it never covers note text
const pill: CSSProperties = {
  position: "fixed", left: 8, top: 14, zIndex: 9999, pointerEvents: "none", padding: "1px 7px", borderRadius: 999,
  font: "500 11px/18px var(--fonts-ui, system-ui)", color: "var(--colors-velo-fg-muted, #666)",
  background: "var(--colors-velo-chrome, #f4f4f4)", border: "1px solid var(--colors-velo-border, #ddd)", opacity: 0.9,
};
const toastStyle: CSSProperties = { ...pill, top: "auto", left: "50%", bottom: 24, padding: "3px 10px", transform: "translateX(-50%)", color: "var(--colors-velo-fg, #222)", maxWidth: "80vw" };
const showPill = new URLSearchParams(location.search).get("pill") !== "0"; // ?pill=0: screenshots without it

export function DemoChrome() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    showMenu = setMenu;
    let timer: ReturnType<typeof setTimeout>;
    showToast = (t) => {
      setToast(t);
      clearTimeout(timer);
      timer = setTimeout(() => setToast(null), 3000);
    };
    const onNotice = (e: Event) => showToast((e as CustomEvent<string>).detail);
    window.addEventListener("velo-demo-notice", onNotice);
    return () => window.removeEventListener("velo-demo-notice", onNotice);
  }, []);
  return (
    <>
      {showPill && <div style={pill} title="Demo: nothing you change is saved" aria-label="Demo: nothing you change is saved" data-demo-pill>Demo</div>}
      {toast && <div style={toastStyle} role="status">{toast}</div>}
      {menu && (
        <Menu.Root
          key={menu.key}
          open
          anchorPoint={{ x: menu.x, y: menu.y }}
          onOpenChange={(d) => !d.open && setMenu(null)}
          onSelect={(d) => menu.items.find((m) => m !== "separator" && m.id === d.value && (m.action(), true))}
        >
          <Menu.Positioner>
            <Menu.Content minW="180px" aria-label="Note actions">
              {menu.items.map((m, i) =>
                m === "separator" ? <Menu.Separator key={i} /> : <Menu.Item key={m.id} value={m.id}><Menu.ItemText>{m.text}</Menu.ItemText></Menu.Item>,
              )}
            </Menu.Content>
          </Menu.Positioner>
        </Menu.Root>
      )}
    </>
  );
}
