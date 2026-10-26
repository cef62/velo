import { CircleAlert, KeyRound, Lock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { css } from "styled-system/css";
import type { UiPort } from "../app/ports";
import { Button, Dialog, Field, Input } from "@/components/ui";
import { errText } from "../errtext";
import { WRONG_PASSPHRASE, passphraseDialogMode, passphraseError, passphraseSubtitle } from "../passphrase";
import { registerPassphrase } from "./platform";

type Req = Parameters<UiPort["passphrase"]>[0];

const content = css({ maxW: "420px", p: "0", gap: "0", overflow: "hidden" });
const tile = css({ w: "36px", h: "36px", borderRadius: "8px", bg: "velo.accentSubtle", color: "velo.accentText", display: "flex", alignItems: "center", justifyContent: "center", flex: "none", "& svg": { w: "18px", h: "18px" } });
const err = css({ display: "flex", alignItems: "center", gap: "1.5", fontSize: "uiSm", lineHeight: "1.4", color: "red.11", m: "0", "& svg": { w: "14px", h: "14px", flex: "none" } });

/** Implements UiPort.passphrase: mounted once; platform routes the controller's requests here. */
export function PassphraseDialog() {
  const [req, setReq] = useState<Req | null>(null);
  const done = useRef<((ok: boolean) => void) | null>(null);
  useEffect(() => {
    registerPassphrase(
      (r) =>
        new Promise<boolean>((resolve) => {
          done.current?.(false); // a newer request supersedes a pending one
          done.current = resolve;
          setReq(r);
        }),
    );
  }, []);
  const finish = (ok: boolean) => {
    done.current?.(ok);
    done.current = null;
    setReq(null);
  };
  return (
    <Dialog.Root open={req !== null} onOpenChange={(d) => !d.open && finish(false)} role="dialog" closeOnInteractOutside={false}>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content className={content}>{req && <Body req={req} finish={finish} />}</Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}

function Body({ req, finish }: { req: Req; finish: (ok: boolean) => void }) {
  const create = req.mode === "create";
  const mode = passphraseDialogMode(!create);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pw = useRef<HTMLInputElement>(null);
  const again = useRef<HTMLInputElement>(null);
  const sub = create ? passphraseSubtitle(req.context) : "This computer doesn't have your velo key yet.";

  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    if (busy) return;
    const value = pw.current!.value;
    const bad = passphraseError(create, value, again.current?.value ?? "");
    if (bad) return void setMsg(bad);
    pw.current!.value = "";
    if (again.current) again.current.value = ""; // cleared as soon as the value is read
    setBusy(true);
    try {
      await req.submit(value);
      finish(true);
    } catch (e) {
      setMsg(e === "wrong-passphrase" ? WRONG_PASSPHRASE : errText(e));
      setBusy(false);
      pw.current?.focus();
    }
  };
  const mismatch = msg === passphraseError(true, "a", "b");
  const field = (label: string, ref: React.RefObject<HTMLInputElement | null>, bad: boolean, auto?: boolean) => (
    <Field.Root invalid={bad}>
      <Field.Label>{label}</Field.Label>
      <Input ref={ref} type="password" autoComplete="off" autoFocus={auto} onChange={() => setMsg(null)} />
      {bad && (
        <p className={err} role="alert">
          <CircleAlert aria-hidden /> {msg}
        </p>
      )}
    </Field.Root>
  );
  return (
    <form onSubmit={submit}>
      <div className={css({ p: "20px 20px 4px", display: "flex", gap: "14px" })}>
        <span className={tile} aria-hidden>{create ? <Lock /> : <KeyRound />}</span>
        <div className={css({ display: "flex", flexDirection: "column", gap: "1" })}>
          <Dialog.Title className={css({ fontSize: "17px", fontWeight: "650", lineHeight: "1.3", letterSpacing: "-0.01em" })}>{mode.title}</Dialog.Title>
          {sub && <Dialog.Description className={css({ fontSize: "ui", lineHeight: "1.5" })}>{sub}</Dialog.Description>}
          {create && <p className={css({ fontSize: "ui", lineHeight: "1.5", color: "fg.muted" })}>It can't be recovered if you forget it.</p>}
        </div>
      </div>
      <div className={css({ p: "14px 20px 18px", display: "flex", flexDirection: "column", gap: "3.5" })}>
        {field("Passphrase", pw, msg !== null && !mismatch, true)}
        {create && field("Confirm passphrase", again, mismatch)}
      </div>
      <div className={css({ display: "flex", justifyContent: "flex-end", gap: "2", px: "5", py: "3.5", borderTop: "1px solid", borderColor: "velo.divider" })}>
        <Button type="button" variant="outline" onClick={() => finish(false)}>Cancel</Button>
        <Button type="submit" disabled={busy}>{create ? "Create & lock" : "Unlock"}</Button>
      </div>
    </form>
  );
}
