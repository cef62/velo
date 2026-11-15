// Entry of the What's new window (whatsnew.html). It imports no app controller, store or notes API: only the theme,
// a few Park UI components, the inline Markdown renderer and its own small API (./api).
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "../ui/index.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { applyFontScale } from "../app/fontscale";
import { installWindowHandlers, logError } from "../log";
import { applyPalette } from "../theme/palettes/apply";
import * as api from "./api";
import { WhatsNew } from "./WhatsNew";

installWindowHandlers(window);
document.documentElement.dataset.mac = String(navigator.platform.startsWith("Mac")); // the title bar overlays the content

// The main window's look: its cached copy for the first frame (same origin, src/ui/platform.ts writes it), then the settings.
const dark = window.matchMedia("(prefers-color-scheme: dark)");
let theme = "system";
const writeTheme = () => void (document.documentElement.dataset.theme = theme === "system" ? (dark.matches ? "dark" : "light") : theme);
try {
  const l = JSON.parse(localStorage.getItem("velo.look") ?? "null");
  if (l?.theme === "light" || l?.theme === "dark") theme = l.theme;
  applyPalette(l?.palette);
} catch {}
writeTheme();
dark.addEventListener("change", writeTheme);

function App() {
  const [info, setInfo] = useState<api.WhatsNewInfo | null>(null);
  const [phase, setPhase] = useState<api.Phase>({ kind: "idle" });
  useEffect(() => {
    // the reply carries the install's phase now; the channel every later one, even an install started from the pill.
    // A channel message can land before the reply: the snapshot is then older and is dropped.
    let live = false;
    api
      .info((p) => {
        live = true;
        setPhase(p);
      })
      .then((i) => {
        theme = i.theme;
        writeTheme();
        applyPalette(i.palette);
        applyFontScale(i.font_size);
        if (!live) setPhase(i.phase);
        setInfo(i);
      })
      .catch((e) => {
        logError("whatsnew: info failed", e);
        setInfo({ update: null, phase: { kind: "idle" }, theme: "system", palette: "", font_size: 14 });
      });
  }, []);
  const install = () => {
    if (!info?.update) return;
    setPhase({ kind: "starting" });
    api.install(info.update.version).catch((e) => setPhase({ kind: "failed", message: typeof e === "string" ? e : "The update could not start.", retry: false }));
  };
  return <WhatsNew info={info} phase={phase} onInstall={install} />;
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !e.defaultPrevented) void api.close();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
