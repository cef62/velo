import { CircleAlert, FolderOpen, RotateCcw, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createListCollection } from "@ark-ui/react/select";
import { Portal } from "@ark-ui/react/portal";
import { css } from "styled-system/css";
import type { Settings } from "../api";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Button, Checkbox, Dialog, IconButton, Input, Kbd, SegmentGroup, Select, Tabs } from "@/components/ui";
import { clampFont, recorderStep, toSettings } from "../settingsform";
import { DEFAULTS, LABELS, formatBinding, resolve, type Action } from "../shortcuts";
import { conflictsOf } from "./settingsModel";
import { platform } from "./platform";
import { useStore } from "./useStore";

const sorts = createListCollection({ items: [{ value: "modified", label: "Most recent first" }, { value: "title", label: "Title A→Z" }] });
const actions = Object.keys(DEFAULTS) as Action[];

const frow = css({ display: "grid", gridTemplateColumns: "140px minmax(0, 1fr)", alignItems: "center", gap: "4", minH: "36px" });
const flab = css({ fontSize: "ui", fontWeight: "500", lineHeight: "1.2" });
const help = css({ fontSize: "uiSm", lineHeight: "1.4", color: "fg.muted", m: "0" });
const ferr = css({ display: "flex", alignItems: "center", gap: "1.5", fontSize: "uiSm", lineHeight: "1.4", color: "red.11", m: "0", "& svg": { w: "14px", h: "14px", flex: "none" } });
const th = css({ textAlign: "left", fontWeight: "500", color: "fg.muted", fontSize: "uiSm", px: "3", h: "32px", borderBottom: "1px solid", borderColor: "velo.divider", bg: "velo.chrome" });
const td = css({ px: "3", h: "40px", borderBottom: "1px solid", borderColor: "velo.subtle" });
const cap = css({
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "1.5", h: "28px", minW: "72px", px: "2.5", borderRadius: "6px",
  border: "1px solid", borderBottomWidth: "2px", borderColor: "velo.inputBorder", bg: "velo.canvas", color: "velo.fg", fontSize: "ui", fontWeight: "500", letterSpacing: "0.04em", cursor: "pointer", whiteSpace: "nowrap",
  _hover: { bg: "velo.subtle" },
  _focusVisible: { outline: "2px solid", outlineColor: "velo.accent", outlineOffset: "2px" },
  "&[data-rec]": { borderColor: "velo.accent", bg: "velo.accentSubtle", color: "velo.accentText", letterSpacing: "0", boxShadow: "0 0 0 3px var(--colors-velo-accent-halo)" },
  "&[data-bad]": { borderColor: "red.9", bg: "red.3", color: "red.11" },
});
const dot = css({ w: "6px", h: "6px", borderRadius: "50%", bg: "velo.accent" });

export function SettingsDialog({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const settings = useStore(store, (s) => s.settings);
  const last = useRef(settings);
  if (settings) last.current = settings; // keeps the body mounted through the exit animation
  return (
    <Dialog.Root open={settings !== null} onOpenChange={(d) => !d.open && controller.closeSettings()} closeOnInteractOutside={false}>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content className={css({ maxW: "640px", p: "0", gap: "0", overflow: "hidden", maxH: "calc(100dvh - 32px)" })}>
          {last.current && <Body cur={last.current} controller={controller} store={store} />}
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}

function Body({ cur, controller, store }: { cur: Settings; controller: Controller; store: Store<AppState> }) {
  const isMac = useStore(store, (s) => s.isMac);
  const [d, setD] = useState(() => ({
    notes_dir: cur.notes_dir,
    layout: cur.layout as string,
    theme: cur.theme as string,
    sort: cur.sort as string,
    fontSize: String(cur.font_size),
    headerLabels: cur.header_labels === true,
    shortcuts: resolve(cur.shortcuts, isMac),
  }));
  const set = (p: Partial<typeof d>) => setD((x) => ({ ...x, ...p }));
  const [tab, setTab] = useState("general");
  const [recording, setRecording] = useState<Action | null>(null);
  const [recMsg, setRecMsg] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const conflicts = conflictsOf(d.shortcuts);
  const nConflicts = new Set(Object.keys(conflicts).map((a) => d.shortcuts[a as Action])).size;
  const setKey = (a: Action, v: string) => set({ shortcuts: { ...d.shortcuts, [a]: v } });

  // While recording the dialog owns the keys: capture phase, before Ark's Esc handling and the app's shortcuts.
  const latest = useRef({ recording, d });
  latest.current = { recording, d };
  useEffect(() => {
    if (!recording) return;
    const on = (e: KeyboardEvent) => {
      const { recording: rec, d } = latest.current;
      e.preventDefault();
      e.stopPropagation();
      const step = recorderStep(rec, e, isMac, d.shortcuts);
      if (step.msg !== undefined) setRecMsg(step.msg);
      if (step.assign !== undefined) setD((x) => ({ ...x, shortcuts: { ...x.shortcuts, [rec!]: step.assign! } }));
      setRecording(step.recording);
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [recording, isMac]);

  const save = async () => {
    if (nConflicts || saving) return;
    setSaving(true);
    setMsg(await controller.saveSettings(toSettings({ ...cur, notes_dir: d.notes_dir }, d)));
    setSaving(false);
  };
  const change = async () => {
    const dir = await platform.chooseDirectory();
    if (dir) set({ notes_dir: dir });
  };
  const seg = (label: string, value: string, items: [string, string][], on: (v: string) => void) => (
    <SegmentGroup.Root size="sm" value={value} onValueChange={(x) => x.value && on(x.value)} aria-label={label}>
      <SegmentGroup.Indicator />
      <SegmentGroup.Items items={items.map(([v, l]) => ({ value: v, label: l }))} />
    </SegmentGroup.Root>
  );
  const kbdOn = { background: "transparent", color: "inherit", borderColor: "whiteAlpha.600", boxShadow: "none" } as const;

  return (
    <div onKeyDown={(e) => (isMac ? e.metaKey : e.ctrlKey) && e.key === "Enter" && (e.preventDefault(), void save())}>
      <div className={css({ display: "flex", alignItems: "center", px: "5", pt: "4", pb: "2" })}>
        <Dialog.Title className={css({ fontSize: "17px", fontWeight: "650", letterSpacing: "-0.01em" })}>Settings</Dialog.Title>
        <Dialog.CloseTrigger asChild>
          <IconButton variant="plain" size="sm" aria-label="Close (Esc)" className={css({ ml: "auto", position: "static" })}><X /></IconButton>
        </Dialog.CloseTrigger>
      </div>
      <Tabs.Root value={tab} onValueChange={(x) => setTab(x.value)} className={css({ gap: "0" })}>
        <Tabs.List aria-label="Settings sections" className={css({ w: "100%", px: "3.5", borderBottom: "1px solid", borderColor: "velo.subtle", gap: "1" })}>
          <Tabs.Trigger value="general" className={css({ h: "38px", px: "2", fontSize: "ui" })}>General</Tabs.Trigger>
          <Tabs.Trigger value="shortcuts" className={css({ h: "38px", px: "2", fontSize: "ui", gap: "1.5" })}>
            Keyboard shortcuts
            {nConflicts > 0 && (
              <span aria-label={`${nConflicts} conflict${nConflicts > 1 ? "s" : ""}`} className={css({ display: "inline-flex", alignItems: "center", justifyContent: "center", minW: "18px", h: "18px", px: "1.5", borderRadius: "999px", bg: "red.3", color: "red.11", fontSize: "uiXs", fontWeight: "600" })}>{nConflicts}</span>
            )}
          </Tabs.Trigger>
          <Tabs.Indicator />
        </Tabs.List>
        <Tabs.Content value="general" className={css({ p: "5", display: "flex", flexDirection: "column", gap: "2.5" })}>
          <div className={frow}>
            <span className={flab}>Notes folder</span>
            <div className={css({ display: "flex", gap: "2" })}>
              <div className={css({ flex: "1", position: "relative" })}>
                <FolderOpen aria-hidden className={css({ position: "absolute", left: "2.5", top: "50%", transform: "translateY(-50%)", w: "14px", h: "14px", color: "fg.muted" })} />
                <Input readOnly aria-label="Notes folder" value={d.notes_dir ?? ""} className={css({ pl: "8" })} />
              </div>
              <Button variant="outline" onClick={() => void change()}>Change…</Button>
            </div>
          </div>
          <div className={frow}>
            <span className={flab}>Layout</span>
            <div className={css({ display: "flex", alignItems: "center", gap: "2.5" })}>
              {seg("Layout", d.layout, [["vertical", "Vertical"], ["horizontal", "Horizontal"]], (v) => set({ layout: v }))}
              <Kbd>{formatBinding(DEFAULTS.toggle_layout, isMac)}</Kbd>
            </div>
          </div>
          <div className={frow}>
            <span className={flab}>Theme</span>
            <div>{seg("Theme", d.theme, [["system", "System"], ["light", "Light"], ["dark", "Dark"]], (v) => set({ theme: v }))}</div>
          </div>
          <div className={frow}>
            <label className={flab} htmlFor="set-font">Font size</label>
            <div className={css({ display: "flex", alignItems: "center", gap: "2.5" })}>
              <Input id="set-font" type="number" min={10} max={32} value={d.fontSize} onChange={(e) => set({ fontSize: e.target.value })} onBlur={() => set({ fontSize: String(clampFont(d.fontSize, cur.font_size)) })} className={css({ w: "72px", textAlign: "right" })} />
              <span className={help}>px · 10–32 · scales editor and list rows</span>
            </div>
          </div>
          <div className={frow}>
            <span className={flab}>Header</span>
            <Checkbox.Root checked={d.headerLabels} onCheckedChange={(x) => set({ headerLabels: x.checked === true })} size="sm">
              <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
              <Checkbox.Label>Show labels on header buttons</Checkbox.Label>
              <Checkbox.HiddenInput />
            </Checkbox.Root>
          </div>
          <div className={frow}>
            <span className={flab} id="set-sort">Sort</span>
            <Select.Root collection={sorts} value={[d.sort]} onValueChange={(x) => x.value[0] && set({ sort: x.value[0] })} positioning={{ sameWidth: false }} size="sm" className={css({ w: "fit-content" })}>
              <Select.Control>
                <Select.Trigger aria-labelledby="set-sort" className={css({ minW: "200px" })}>
                  <Select.ValueText />
                  <Select.IndicatorGroup><Select.Indicator /></Select.IndicatorGroup>
                </Select.Trigger>
              </Select.Control>
              <Portal>
                <Select.Positioner>
                  <Select.Content>
                    {sorts.items.map((it) => (
                      <Select.Item key={it.value} item={it}>
                        <Select.ItemText>{it.label}</Select.ItemText>
                        <Select.ItemIndicator />
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Positioner>
              </Portal>
              <Select.HiddenSelect />
            </Select.Root>
          </div>
        </Tabs.Content>
        <Tabs.Content value="shortcuts" className={css({ p: "4 5 5", display: "flex", flexDirection: "column", gap: "3", overflowY: "auto", maxH: "calc(100dvh - 240px)" })}>
          <div className={css({ display: "flex", alignItems: "center", gap: "3" })}>
            <p className={help}>{recMsg || "Click a key-cap, then press the new combination. Esc cancels, ⌫ clears."}</p>
            <Button variant="plain" size="xs" className={css({ ml: "auto" })} onClick={() => set({ shortcuts: { ...DEFAULTS } })}><RotateCcw /> Reset all</Button>
          </div>
          <div className={css({ border: "1px solid", borderColor: "velo.divider", borderRadius: "8px", overflow: "hidden" })}>
            <table className={css({ w: "100%", borderCollapse: "collapse", fontSize: "ui" })}>
              <thead>
                <tr><th className={th}>Action</th><th className={th} style={{ width: 150 }}>Shortcut</th><th className={th} style={{ width: 76 }}><span className={css({ srOnly: true })}>Reset</span></th></tr>
              </thead>
              <tbody>
                {actions.map((a) => {
                  const rec = recording === a;
                  const other = conflicts[a];
                  const changed = d.shortcuts[a] !== DEFAULTS[a];
                  const text = rec ? "Press keys…" : formatBinding(d.shortcuts[a], isMac);
                  return (
                    <tr key={a} className={css({ bg: other ? "red.3" : rec ? "velo.accentSubtle" : "transparent" })}>
                      <td className={td}>
                        <div className={css({ display: "flex", flexDirection: "column", gap: "0.5", py: "1" })}>
                          <span>{LABELS[a]}</span>
                          {other && <span className={ferr} role="alert"><TriangleAlert aria-hidden />Already used by {LABELS[other]}</span>}
                        </div>
                      </td>
                      <td className={td}>
                        <button type="button" className={cap} data-rec={rec || undefined} data-bad={other ? "" : undefined} aria-label={`${LABELS[a]} shortcut: ${text}. Press to change`} onClick={() => (setRecMsg(""), setRecording(rec ? null : a))}>
                          {text}
                          {changed && !rec && <span className={dot} aria-hidden />}
                        </button>
                      </td>
                      <td className={td}>
                        <Button variant="plain" size="xs" disabled={!changed} aria-label={`Reset ${LABELS[a]}`} onClick={() => setKey(a, DEFAULTS[a])}>Reset</Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Tabs.Content>
      </Tabs.Root>
      <div className={css({ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "2", px: "5", py: "3.5", borderTop: "1px solid", borderColor: "velo.divider" })}>
        {nConflicts > 0 ? (
          <span className={ferr} style={{ marginRight: "auto" }}>{nConflicts} conflict{nConflicts > 1 ? "s" : ""} — fix it to save</span>
        ) : (
          msg && <span className={ferr} role="alert" style={{ marginRight: "auto" }}><CircleAlert aria-hidden />{msg}</span>
        )}
        <Button variant="outline" onClick={() => controller.closeSettings()}>Cancel</Button>
        <Button disabled={nConflicts > 0 || saving} onClick={() => void save()}>Save <Kbd {...kbdOn}>{isMac ? "⌘↩" : "Ctrl+↩"}</Kbd></Button>
      </div>
    </div>
  );
}
