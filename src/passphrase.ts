import { errText } from "./errtext";

export const WRONG_PASSPHRASE = "Wrong passphrase — try again";
export const passphraseSubtitle = (context: string | null) => (context ? `Needed once to lock “${context}”` : null);

export const isLockedPath = (p: string) => p.endsWith(".age");

export const passphraseDialogMode = (identityFileExists: boolean) =>
  identityFileExists
    ? { title: "Enter your velo passphrase", confirm: false }
    : { title: "Create your velo passphrase", confirm: true };

export function passphraseError(confirm: boolean, pw: string, again: string): string | null {
  if (!pw) return "Passphrase required";
  return confirm && pw !== again ? "Passphrases don't match" : null;
}

/**
 * Modal passphrase dialog. `attempt` runs on submit; if it throws, the error shows inline and the
 * dialog stays open. Resolves true after a successful attempt, false on cancel.
 * The password inputs are emptied as soon as the value is read.
 */
export function askPassphrase(identityFileExists: boolean, attempt: (pw: string) => Promise<void>): Promise<boolean> {
  const mode = passphraseDialogMode(identityFileExists);
  const dlg = document.getElementById("pp") as HTMLDialogElement;
  const form = dlg.querySelector("form") as HTMLFormElement;
  const [pw, again] = Array.from(form.querySelectorAll("input")) as HTMLInputElement[];
  const msg = form.querySelector(".msg") as HTMLElement;
  form.querySelector("h3")!.textContent = mode.title;
  again.hidden = !mode.confirm;
  msg.textContent = "";
  return new Promise((resolve) => {
    const clear = () => (pw.value = again.value = "");
    let busy = false;
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (busy) return;
      const bad = passphraseError(mode.confirm, pw.value, again.value);
      if (bad) return void (msg.textContent = bad);
      const value = pw.value;
      clear();
      busy = true;
      try {
        await attempt(value);
        dlg.close("ok");
      } catch (err) {
        msg.textContent = err === "wrong-passphrase" ? WRONG_PASSPHRASE : errText(err);
        pw.focus();
      }
      busy = false;
    };
    (form.querySelector("[value=cancel]") as HTMLButtonElement).onclick = () => dlg.close("cancel");
    dlg.onclose = () => {
      clear();
      resolve(dlg.returnValue === "ok");
    };
    dlg.returnValue = "";
    dlg.showModal();
    pw.focus();
  });
}
