import { FolderOpen } from "lucide-react";
import { useEffect, useRef } from "react";
import { css } from "styled-system/css";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Button, Kbd } from "@/components/ui";
import { formatBinding } from "../shortcuts";
import { useStore } from "./useStore";

const screen = css({ position: "absolute", inset: "0", zIndex: "3", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "5.5", p: "10", textAlign: "center", bg: "velo.chrome" });
const mark = css({ w: "52px", h: "52px", borderRadius: "12px", bg: "velo.accent", color: "white", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "28px", fontWeight: "700", letterSpacing: "-0.04em", lineHeight: "1" });

export function FirstRun({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const s = useStore(store);
  const btn = useRef<HTMLButtonElement>(null);
  const setup = s.phase === "setup";
  useEffect(() => {
    if (setup) btn.current?.focus();
  }, [setup]);
  if (!setup) return null;
  return (
    <main className={screen}>
      <div className={mark} aria-hidden>
        v
      </div>
      <div className={css({ display: "flex", flexDirection: "column", gap: "2.5", alignItems: "center" })}>
        <h1 className={css({ fontSize: "26px", fontWeight: "700", lineHeight: "1.2", letterSpacing: "-0.02em", color: "velo.fg" })}>Choose a notes folder</h1>
        <p className={css({ maxW: "420px", fontSize: "15px", lineHeight: "1.55", color: "velo.fgMuted" })}>
          velo keeps every note as a plain Markdown file in a folder you pick. Existing files appear as notes — nothing is moved or renamed.
        </p>
      </div>
      <Button ref={btn} size="lg" onClick={() => void controller.chooseFolder()}>
        <FolderOpen /> Choose folder… <Kbd bg="transparent" color="inherit" borderColor="whiteAlpha.600" boxShadow="none">↩</Kbd>
      </Button>
      <p className={css({ fontSize: "uiSm", color: "velo.fgMuted" })}>You can change it later in Settings ({formatBinding(s.keys.settings, s.isMac)}).</p>
    </main>
  );
}
