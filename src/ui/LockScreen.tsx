import { CircleAlert, Lock } from "lucide-react";
import { useRef, useState } from "react";
import { css } from "styled-system/css";
import { lockScreen } from "styled-system/recipes";
import type { UiPort } from "../app/ports";
import { Button, Input } from "@/components/ui";
import { errText } from "../errtext";
import { WRONG_PASSPHRASE, passphraseError } from "../passphrase";
import { platform } from "./platform";

type Req = Parameters<UiPort["passphrase"]>[0];

const c = lockScreen();
const err = css({ display: "flex", alignItems: "center", gap: "1.5", fontSize: "uiSm", lineHeight: "1.4", color: "velo.danger", m: "0", "& svg": { w: "14px", h: "14px", flex: "none" } });
const sub = css({ fontSize: "uiSm", color: "velo.fgMuted", m: "0" });

/** Inline unlock (v2 §3 #14): a locked note was opened and the key is not loaded. One passphrase unlocks every locked note, as before. */
export function LockScreen({ req, finish }: { req: Req; finish: (ok: boolean) => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pw = useRef<HTMLInputElement>(null);
  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    if (busy) return;
    const value = pw.current!.value;
    const bad = passphraseError(false, value, "");
    if (bad) return void setMsg(bad);
    pw.current!.value = ""; // cleared as soon as the value is read
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
  const cancel = () => {
    finish(false);
    // back to where you came from: the list's tab stop, else the search field
    const row = document.querySelector<HTMLElement>('[role=listbox] [tabindex="0"], [role=list] [tabindex="0"], [role=tree] [tabindex="0"]');
    if (row) row.focus();
    else platform.focusSearch();
  };
  return (
    <div className={c.root} role="dialog" aria-modal="false" aria-labelledby="lock-title" data-lock-screen="">
      <form className={c.card} onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), cancel())}>
        <span className={c.icon} aria-hidden><Lock size={20} /></span>
        <h3 id="lock-title" className={c.title}>This note is locked</h3>
        <p className={sub}>Enter your velo passphrase to unlock your notes on this computer.</p>
        <div className={c.row}>
          <Input ref={pw} type="password" size="sm" autoComplete="off" autoFocus aria-label="Passphrase" aria-invalid={msg !== null || undefined} onChange={() => setMsg(null)} />
          <Button type="submit" size="sm" colorPalette="green" disabled={busy}>Unlock</Button>
        </div>
        {msg && (
          <p className={err} role="alert">
            <CircleAlert aria-hidden /> {msg}
          </p>
        )}
      </form>
    </div>
  );
}
