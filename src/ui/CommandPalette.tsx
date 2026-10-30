import { Search } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { css } from "styled-system/css";
import { commandPalette, sectionHeader } from "styled-system/recipes";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Dialog, Kbd } from "@/components/ui";
import { paletteGroups, paletteSearch, type PaletteItem } from "../palette";
import { formatBinding } from "../shortcuts";
import { HighlightedText } from "./HighlightedText";
import { useStore } from "./useStore";

// ⌘P (v2 §3 #7–#8): every action by name with its live binding. Actions only; notes stay in the search field.
const c = commandPalette();
const disabledReason = css({ ml: "auto", fontSize: "uiXs", color: "velo.fgMuted", whiteSpace: "nowrap" });
const empty = css({ p: "6", textAlign: "center", color: "velo.fgMuted", fontSize: "ui" });

export function CommandPalette({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const open = useStore(store, (s) => s.palette);
  return (
    <Dialog.Root open={open} onOpenChange={(d) => !d.open && controller.closePalette()}>
      <Dialog.Backdrop />
      <Dialog.Positioner className={css({ alignItems: "flex-start" })}>
        <Dialog.Content className={`${c.content} ${css({ p: "0", gap: "0", w: "palette", maxW: "calc(100vw - 32px)", mt: "10vh", mb: "auto", bg: "velo.panel", boxShadow: "veloPopover", borderRadius: "l3" })}`} aria-label="Command palette">
          {open && <Body controller={controller} store={store} />}
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}

function Body({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const keys = useStore(store, (s) => s.keys);
  const isMac = useStore(store, (s) => s.isMac);
  const openPath = useStore(store, (s) => s.openPath);
  const title = useStore(store, (s) => s.title);
  const encrypted = useStore(store, (s) => s.encrypted);
  const recent = useStore(store, (s) => s.recentActions);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const hasSelection = useMemo(() => controller.hasSelection(), [controller]); // read once per open
  const state = { keys, isMac, noteOpen: openPath !== null, title, encrypted, hasSelection, recent };
  const groups = useMemo(() => (query.trim() ? [{ title: "", items: paletteSearch(query, state) }] : paletteGroups(state)), [query, keys, isMac, openPath, title, encrypted, hasSelection, recent]); // eslint-disable-line react-hooks/exhaustive-deps
  const flat = groups.flatMap((g) => g.items);
  const cur = Math.min(sel, Math.max(0, flat.length - 1));
  const run = (it: PaletteItem) => {
    if (it.disabled) return;
    controller.runPaletteAction(it.action);
  };
  const move = (d: number) => {
    const to = Math.max(0, Math.min(flat.length - 1, cur + d));
    setSel(to);
    list.current?.querySelector<HTMLElement>(`[data-i="${to}"]`)?.scrollIntoView({ block: "nearest" });
  };
  let i = -1;
  return (
    <>
      <div className={c.inputRow}>
        <Search size={16} aria-hidden />
        <input
          className={c.input}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={flat.length ? `palette-opt-${cur}` : undefined}
          aria-label="Command"
          placeholder="Type a command…"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") move(1);
            else if (e.key === "ArrowUp") move(-1);
            else if (e.key === "Enter" && flat[cur] && !e.nativeEvent.isComposing) run(flat[cur]);
            else return;
            e.preventDefault();
          }}
        />
      </div>
      {flat.length === 0 && <div className={empty} role="status">No command matches “{query}”</div>}
      <div ref={list} id="palette-list" role="listbox" aria-label="Commands" className={c.list}>
        {groups.map((g, gi) => (
          <div key={`${gi}:${g.title}`} role="group" aria-label={g.title || "Matches"}>
            {g.title && <div className={sectionHeader()} aria-hidden="true">{g.title}</div>}
            {g.items.map((it) => {
              i++;
              const n = i;
              return (
                <div
                  key={it.action}
                  id={`palette-opt-${n}`}
                  role="option"
                  aria-selected={n === cur}
                  aria-disabled={it.disabled ? true : undefined}
                  data-i={n}
                  data-highlighted={n === cur ? "" : undefined}
                  data-disabled={it.disabled ? "" : undefined}
                  className={c.item}
                  onMouseMove={() => setSel(n)}
                  onClick={() => run(it)}
                >
                  <span><HighlightedText text={it.label} query={query.trim()} /></span>
                  {it.context && !it.disabled && <span className={c.context}>{it.context}</span>}
                  {it.disabled ? <span className={disabledReason}>{it.disabled}</span> : it.binding && <Kbd data-part="kbd" marginLeft="auto">{it.binding}</Kbd>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className={c.footer}>
        <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> move</span>
        <span><Kbd>↩</Kbd> run</span>
        <span><Kbd>Esc</Kbd> close</span>
        <span className={css({ ml: "auto" })}>{query.trim() ? `Looking for a note? Esc, then ${keys.focus_search === "none" ? "the search box" : formatBinding(keys.focus_search, isMac)}` : `${flat.length} commands`}</span>
      </div>
    </>
  );
}
