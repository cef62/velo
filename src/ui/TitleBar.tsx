import { ChevronDown, Code, Ellipsis, Eye, Lock, LockOpen, PanelRight, TriangleAlert, Type } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { css } from "styled-system/css";
import { menuButton, titleBar } from "styled-system/recipes";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Button, IconButton, Kbd, Menu, SegmentGroup, Spinner, Tooltip } from "@/components/ui";
import { formatBinding, NONE, type Action } from "../shortcuts";
import { titleBarMode } from "./layout";
import { useStore } from "./useStore";

// v2 title bar (design/park-ui/v2/README.md §2, §3 #5–#7): the note's own controls live here —
// the view switch (Rich · Plain · Preview), Lock, the side panel toggle and a ⋯ menu for the rest.
const c = titleBar();
const num = (n: number) => n.toLocaleString("en-US");
const rename = css({
  flex: "1",
  minW: "0",
  h: "control",
  ml: "-2",
  px: "2",
  borderWidth: "1px",
  borderColor: "velo.accentBorder",
  boxShadow: "0 0 0 1px var(--colors-velo-accent-border)",
  borderRadius: "l2",
  bg: "velo.canvas",
  color: "velo.fg",
  fontSize: "var(--velo-title-fs)",
  fontWeight: "650",
  letterSpacing: "-0.01em",
  outline: "0",
});
const hint = css({ display: "inline-flex", alignItems: "center", gap: "1.5", fontSize: "uiSm", color: "velo.fgMuted", whiteSpace: "nowrap", flex: "none" });
const track = css({ w: "64px", h: "1", borderRadius: "2px", bg: "velo.muted", overflow: "hidden", display: "inline-block" });
const root = css({ "[data-layout=vertical] &": { cursor: "row-resize" }, "& [data-note-title]": { cursor: "default" } });
const pressed = css({ "&[aria-pressed=true], &[aria-expanded=true]": { bg: "velo.accentSubtleHover", color: "velo.accentText", boxShadow: "inset 0 0 0 1px {colors.velo.hairline}, inset 0 1px 0 {colors.velo.highlight}" } });
const segHover = css({ "&:not([data-state=checked]):hover": { bg: "velo.subtle", color: "velo.fg" } });
const label = css({ px: "2", py: "1", fontSize: "uiSm", fontWeight: "600", color: "velo.fgMuted" });
const row = css({ display: "flex", alignItems: "center", gap: "2", w: "100%", "& svg, & [data-part=item-indicator]": { w: "4", h: "4", flex: "none" } });

type View = "rich" | "plain" | "preview";
const VIEWS: { value: View; text: string; glyph: ReactNode; action: Action }[] = [
  { value: "rich", text: "Rich", glyph: <Type size={14} />, action: "toggle_rich" },
  { value: "plain", text: "Plain", glyph: <Code size={14} />, action: "toggle_rich" },
  { value: "preview", text: "Preview", glyph: <Eye size={14} />, action: "toggle_preview" },
];

/** Error text with `code` spans (the locked-note message names .velo/identity.age). */
const withCode = (t: string): ReactNode[] => t.split("`").map((p, i) => (i % 2 ? <code key={i}>{p}</code> : p));

export function TitleBar({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const s = useStore(store);
  const input = useRef<HTMLInputElement>(null);
  const el = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(1000);
  useEffect(() => {
    if (s.renaming) input.current?.select();
  }, [s.renaming]);
  useLayoutEffect(() => {
    const e = el.current!;
    const ro = new ResizeObserver(() => setW(e.offsetWidth)); // the note area's own width decides the layout
    ro.observe(e);
    setW(e.offsetWidth);
    return () => ro.disconnect();
  }, []);
  const mode = titleBarMode(w);
  const [canExtract, setCanExtract] = useState(false); // read when the ⋯ menu opens
  const bar = { ...c, root: `${c.root} ${root}` };
  const view: View = s.previewOn ? "preview" : s.editorStyle;
  const setView = (v: View) => {
    if (v === "preview") return controller.setPreview(true);
    controller.setPreview(false);
    if (v !== s.editorStyle) void controller.setStyle(v);
  };
  const binding = (a: Action) => (s.keys[a] === NONE ? "" : ` (${formatBinding(s.keys[a], s.isMac)})`);
  const kbd = (a: Action) => (s.keys[a] === NONE ? null : <Kbd marginLeft="auto">{formatBinding(s.keys[a], s.isMac)}</Kbd>);
  const noNote = !s.openPath;
  const lockItem = (
    <Menu.Item value="lock" disabled={noNote} onSelect={() => void controller.toggleLock()}>
      <span className={row}>{s.encrypted ? <LockOpen /> : <Lock />}{s.encrypted ? "Remove encryption" : "Lock note"}{kbd("toggle_lock")}</span>
    </Menu.Item>
  );

  return (
    <div ref={el} className={bar.root} data-titlebar="">
      {s.renaming ? (
        <>
          <input
            ref={input}
            className={rename}
            data-rename=""
            aria-label="Note title"
            defaultValue={s.title}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") void controller.commitRename(e.currentTarget.value);
              else if (e.key === "Escape") void controller.commitRename(null);
              else return;
              e.preventDefault();
            }}
            onBlur={() => void controller.commitRename(null)}
          />
          <span className={hint}>
            <Kbd>↩</Kbd> Rename <Kbd>Esc</Kbd> Cancel
          </span>
        </>
      ) : (
        <h2 className={bar.title} data-note-title="" title={s.title} onDoubleClick={() => controller.startRename()}>
          {s.title}
        </h2>
      )}
      {s.err ? (
        <>
          <span className={bar.status} data-tone="error" role="alert">
            <TriangleAlert size={14} aria-hidden />
            {withCode(s.err)}
          </span>
          {s.errFromSave && (
            <Button variant="outline" size="sm" onClick={() => controller.retrySave()}>
              Retry
            </Button>
          )}
        </>
      ) : null}
      {s.indexing ? (
        <span className={bar.status} role="status">
          <Spinner size="sm" />
          Indexing… {num(s.indexing.done)} / {num(s.indexing.total)}
          <span className={track} aria-hidden>
            <i className={css({ display: "block", h: "full", bg: "velo.accent" })} style={{ width: `${s.indexing.total ? Math.min(100, (100 * s.indexing.done) / s.indexing.total) : 0}%` }} />
          </span>
        </span>
      ) : !s.err && s.saving ? (
        <span className={bar.status} role="status">
          <Spinner size="sm" />
          Saving…
        </span>
      ) : null}
      {s.openPath && (
        <div className={bar.actions}>
          {mode.viewSwitch === "segments" ? (
            <SegmentGroup.Root size="2xs" value={view} onValueChange={(d) => d.value && d.value !== view && setView(d.value as View)} aria-label="View">
              <SegmentGroup.Indicator />
              {VIEWS.map((it) => (
                <SegmentGroup.Item key={it.value} value={it.value} className={segHover} data-preview={it.value === "preview" ? "" : undefined}>
                  {it.glyph}
                  <SegmentGroup.ItemText>{it.text}</SegmentGroup.ItemText>
                  <SegmentGroup.ItemHiddenInput aria-label={`${it.text}${binding(it.action)}`} />
                </SegmentGroup.Item>
              ))}
            </SegmentGroup.Root>
          ) : (
            <Menu.Root positioning={{ placement: "bottom-end" }}>
              <Menu.Trigger asChild>
                <button type="button" className={menuButton()} aria-label={`View: ${VIEWS.find((v) => v.value === view)!.text}`}>
                  {VIEWS.find((v) => v.value === view)!.glyph}
                  <span data-label>{VIEWS.find((v) => v.value === view)!.text}</span>
                  <ChevronDown data-chevron aria-hidden />
                </button>
              </Menu.Trigger>
              <Menu.Positioner>
                <Menu.Content minW="180px">
                  <Menu.RadioItemGroup value={view} onValueChange={(d) => d.value !== view && setView(d.value as View)}>
                    <Menu.ItemGroupLabel className={label}>View</Menu.ItemGroupLabel>
                    {VIEWS.map((it) => (
                      <Menu.RadioItem key={it.value} value={it.value}><span className={row}><Menu.ItemIndicator /><Menu.ItemText>{it.text}</Menu.ItemText>{kbd(it.action)}</span></Menu.RadioItem>
                    ))}
                  </Menu.RadioItemGroup>
                </Menu.Content>
              </Menu.Positioner>
            </Menu.Root>
          )}
          {!mode.lockInMenu && (
            <Tooltip content={`${s.encrypted ? "Encrypted — press to remove encryption" : "Lock note"}${binding("toggle_lock")}`} openDelay={500}>
              <IconButton className={pressed} variant="plain" size="sm" aria-label="Encrypt note" aria-pressed={s.encrypted} onClick={() => void controller.toggleLock()}>
                {s.encrypted ? <Lock size={16} aria-hidden /> : <LockOpen size={16} aria-hidden />}
              </IconButton>
            </Tooltip>
          )}
          <Tooltip content={`Side panel${binding("toggle_info")}`} openDelay={500}>
            <IconButton className={pressed} variant="plain" size="sm" aria-label="Side panel" aria-pressed={s.infoOpen} onClick={() => void controller.toggleInfo()}>
              <PanelRight size={16} aria-hidden />
            </IconButton>
          </Tooltip>
          <Menu.Root positioning={{ placement: "bottom-end" }} onOpenChange={(d) => d.open && setCanExtract(controller.hasSelection())}>
            <Menu.Trigger asChild>
              <IconButton className={pressed} variant="plain" size="sm" aria-label="Note menu">
                <Ellipsis size={16} aria-hidden />
              </IconButton>
            </Menu.Trigger>
            <Menu.Positioner>
              <Menu.Content minW="240px">
                <Menu.Item value="rename" onSelect={() => controller.startRename()}>
                  <span className={row}>Rename{kbd("rename")}</span>
                </Menu.Item>
                <Menu.Item value="extract" disabled={!canExtract || s.encrypted} onSelect={() => controller.startExtract()}>
                  <span className={row}>Move selection to new note{!canExtract && <span className={css({ ml: "auto", fontSize: "uiXs", color: "velo.fgMuted" })}>select text first</span>}{canExtract && kbd("extract_note")}</span>
                </Menu.Item>
                <Menu.Item value="merge" disabled={s.encrypted} onSelect={() => void controller.startMerge()}>
                  <span className={row}>Merge into…{kbd("merge_note")}</span>
                </Menu.Item>
                <Menu.CheckboxItem value="front-matter" checked={s.showFrontMatter} onCheckedChange={() => void controller.toggleFrontMatter()}>
                  <span className={row}><Menu.ItemIndicator /><Menu.ItemText>Show front matter</Menu.ItemText>{kbd("toggle_front_matter")}</span>
                </Menu.CheckboxItem>
                {mode.lockInMenu && lockItem}
                <Menu.Separator />
                <Menu.Item value="trash" onSelect={() => void controller.deleteNote()}>
                  <span className={row}>Move to Trash{kbd("delete_note")}</span>
                </Menu.Item>
              </Menu.Content>
            </Menu.Positioner>
          </Menu.Root>
        </div>
      )}
    </div>
  );
}
