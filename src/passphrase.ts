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
