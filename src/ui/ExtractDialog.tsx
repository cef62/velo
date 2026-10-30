import { CircleAlert } from "lucide-react";
import { useRef } from "react";
import { css } from "styled-system/css";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Button, Dialog, Field, Input } from "@/components/ui";
import { useStore } from "./useStore";

const err = css({ display: "flex", alignItems: "center", gap: "1.5", fontSize: "uiSm", lineHeight: "1.4", color: "red.11", m: "0", "& svg": { w: "14px", h: "14px", flex: "none" } });

export function ExtractDialog({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const extract = useStore(store, (s) => s.extract);
  const last = useRef(extract);
  if (extract) last.current = extract; // keeps the body mounted through the exit animation
  return (
    <Dialog.Root open={extract !== null} onOpenChange={(d) => !d.open && void controller.commitExtract(null)} closeOnInteractOutside={false}>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content className={css({ maxW: "420px", p: "0", gap: "0", overflow: "hidden" })}>
          {last.current && <Body init={last.current.title} err={extract?.err ?? ""} controller={controller} />}
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}

function Body({ init, err: msg, controller }: { init: string; err: string; controller: Controller }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void controller.commitExtract(input.current!.value);
      }}
    >
      <div className={css({ p: "20px 20px 4px" })}>
        <Dialog.Title className={css({ fontSize: "17px", fontWeight: "650", lineHeight: "1.3", letterSpacing: "-0.01em" })}>Move to new note</Dialog.Title>
      </div>
      <div className={css({ p: "14px 20px 18px" })}>
        <Field.Root invalid={msg !== ""}>
          <Field.Label>Title</Field.Label>
          <Input ref={input} defaultValue={init} autoComplete="off" autoFocus onFocus={(e) => e.currentTarget.select()} />
          {msg && (
            <p className={err} role="alert">
              <CircleAlert aria-hidden /> {msg}
            </p>
          )}
        </Field.Root>
      </div>
      <div className={css({ display: "flex", justifyContent: "flex-end", gap: "2", px: "5", py: "3.5", borderTop: "1px solid", borderColor: "velo.divider" })}>
        <Button type="button" variant="outline" onClick={() => void controller.commitExtract(null)}>Cancel</Button>
        <Button type="submit" colorPalette="green">Move</Button>
      </div>
    </form>
  );
}
