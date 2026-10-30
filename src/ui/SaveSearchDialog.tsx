import { CircleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { css } from "styled-system/css";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Button, Dialog, Field, Input } from "@/components/ui";
import { fold } from "../search";
import { useStore } from "./useStore";

const err = css({ display: "flex", alignItems: "center", gap: "1.5", fontSize: "uiSm", lineHeight: "1.4", color: "red.11", m: "0", "& svg": { w: "14px", h: "14px", flex: "none" } });

/** Save search… and a saved search's Rename…: one name field. */
export function SaveSearchDialog({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const saveSearch = useStore(store, (s) => s.saveSearch);
  const last = useRef(saveSearch);
  if (saveSearch) last.current = saveSearch; // keeps the body mounted through the exit animation
  return (
    <Dialog.Root open={saveSearch !== null} onOpenChange={(d) => !d.open && void controller.commitSaveSearch(null)} closeOnInteractOutside={false}>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content className={css({ maxW: "420px", p: "0", gap: "0", overflow: "hidden" })}>
          {last.current && <Body state={saveSearch ?? last.current} controller={controller} />}
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}

function Body({ state, controller }: { state: NonNullable<AppState["saveSearch"]>; controller: Controller }) {
  const [value, setValue] = useState(state.name);
  const replacing = state.confirmReplace && fold(value.trim()) === fold(state.name); // the ask is for the name still typed
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void controller.commitSaveSearch(value);
      }}
    >
      <div className={css({ p: "20px 20px 4px" })}>
        <Dialog.Title className={css({ fontSize: "17px", fontWeight: "650", lineHeight: "1.3", letterSpacing: "-0.01em" })}>{state.renaming !== undefined ? "Rename saved search" : "Save search"}</Dialog.Title>
      </div>
      <div className={css({ p: "14px 20px 18px" })}>
        <Field.Root invalid={state.err !== ""}>
          <Field.Label>Name</Field.Label>
          <Input value={value} onChange={(e) => setValue(e.currentTarget.value)} autoComplete="off" autoFocus onFocus={(e) => e.currentTarget.select()} />
          {state.err && (
            <p className={err} role="alert">
              <CircleAlert aria-hidden /> {state.err}
            </p>
          )}
          {replacing && (
            <p className={css({ fontSize: "uiSm", color: "velo.fgMuted", m: "0" })} role="alert">
              Replace “{state.name}”?
            </p>
          )}
        </Field.Root>
      </div>
      <div className={css({ display: "flex", justifyContent: "flex-end", gap: "2", px: "5", py: "3.5", borderTop: "1px solid", borderColor: "velo.divider" })}>
        <Button type="button" variant="outline" onClick={() => void controller.commitSaveSearch(null)}>Cancel</Button>
        <Button type="submit">{replacing ? "Replace" : state.renaming !== undefined ? "Rename" : "Save"}</Button>
      </div>
    </form>
  );
}
