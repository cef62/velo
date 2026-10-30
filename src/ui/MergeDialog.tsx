import { CircleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { css } from "styled-system/css";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Button, Dialog, Field, Input } from "@/components/ui";
import { useStore } from "./useStore";

type Merge = NonNullable<AppState["merge"]>;

const err = css({ display: "flex", alignItems: "center", gap: "1.5", fontSize: "uiSm", lineHeight: "1.4", color: "red.11", m: "0", "& svg": { w: "14px", h: "14px", flex: "none" } });
const list = css({ listStyle: "none", m: "0", mt: "2", p: "1", maxH: "240px", overflowY: "auto", border: "1px solid", borderColor: "velo.divider", borderRadius: "l2" });
const option = css({ px: "2.5", py: "1.5", borderRadius: "l1", fontSize: "uiSm", cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", "&[aria-selected=true]": { bg: "gray.a3" } });
const footer = css({ display: "flex", justifyContent: "flex-end", gap: "2", px: "5", py: "3.5", borderTop: "1px solid", borderColor: "velo.divider" });

export function MergeDialog({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const merge = useStore(store, (s) => s.merge);
  const last = useRef(merge);
  if (merge) last.current = merge; // keeps the body mounted through the exit animation
  const m = last.current;
  return (
    <Dialog.Root open={merge !== null} onOpenChange={(d) => !d.open && controller.cancelMerge()} closeOnInteractOutside={false}>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content className={css({ maxW: "440px", p: "0", gap: "0", overflow: "hidden" })}>
          <div className={css({ p: "20px 20px 4px" })}>
            <Dialog.Title className={css({ fontSize: "17px", fontWeight: "650", lineHeight: "1.3", letterSpacing: "-0.01em" })}>Merge note</Dialog.Title>
          </div>
          {m && (m.target ? <Confirm m={m} controller={controller} /> : <Pick m={m} controller={controller} />)}
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}

const Err = ({ msg }: { msg: string }) =>
  msg ? (
    <p className={err} role="alert">
      <CircleAlert aria-hidden /> {msg}
    </p>
  ) : null;

function Pick({ m, controller }: { m: Merge; controller: Controller }) {
  const rows = useMemo(() => controller.mergeCandidates(m.query), [controller, m.query]);
  const [active, setActive] = useState(0);
  const at = Math.min(active, rows.length - 1);
  useEffect(() => document.getElementById(`merge-target-${at}`)?.scrollIntoView({ block: "nearest" }), [at]);
  return (
    <>
      <div className={css({ p: "14px 20px 18px" })}>
        <Field.Root invalid={m.err !== ""}>
          <Field.Label>Merge into</Field.Label>
          <Input
            value={m.query}
            autoComplete="off"
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls="merge-targets"
            aria-activedescendant={at >= 0 ? `merge-target-${at}` : undefined}
            onChange={(e) => {
              setActive(0);
              controller.setMergeQuery(e.currentTarget.value);
            }}
            onKeyDown={(e) => {
              const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
              if (step) {
                e.preventDefault();
                setActive(Math.max(0, Math.min(rows.length - 1, at + step)));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (at >= 0) void controller.chooseMergeTarget(rows[at]);
              }
            }}
          />
          <ul id="merge-targets" role="listbox" aria-label="Notes" className={list}>
            {rows.map((t, i) => (
              <li
                key={t.path}
                id={`merge-target-${i}`}
                role="option"
                aria-selected={i === at}
                className={option}
                onMouseDown={(e) => e.preventDefault()} // keep focus in the input
                onClick={() => void controller.chooseMergeTarget(t)}
              >
                {t.title}
              </li>
            ))}
            {rows.length === 0 && <li className={css({ px: "2.5", py: "1.5", fontSize: "uiSm", color: "fg.muted" })}>No matching notes</li>}
          </ul>
          <Err msg={m.err} />
        </Field.Root>
      </div>
      <div className={footer}>
        <Button type="button" variant="outline" onClick={() => controller.cancelMerge()}>Cancel</Button>
      </div>
    </>
  );
}

function Confirm({ m, controller }: { m: Merge; controller: Controller }) {
  const t = m.target!;
  return (
    <>
      <div className={css({ p: "14px 20px 18px", display: "flex", flexDirection: "column", gap: "2", fontSize: "uiSm", lineHeight: "1.5" })}>
        <p className={css({ m: "0" })}>
          Merge <strong>{m.sourceTitle}</strong> into <strong>{t.title}</strong>? <em>{t.count}</em> {t.count === 1 ? "link will be" : "links will be"} updated. {m.sourceTitle} goes to the Trash.
        </p>
        <Err msg={m.err} />
      </div>
      <div className={footer}>
        <Button type="button" variant="outline" disabled={m.pending} onClick={() => controller.cancelMerge()}>Cancel</Button>
        <Button type="button" variant="outline" disabled={m.pending} onClick={() => controller.backMerge()}>Back</Button>
        <Button type="button" autoFocus disabled={m.pending} onClick={() => void controller.commitMerge()}>Merge</Button>
      </div>
    </>
  );
}
