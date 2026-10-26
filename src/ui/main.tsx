import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { css } from "styled-system/css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className={css({ bg: "velo.canvas", color: "velo.fg", fontFamily: "ui" })}>velo</div>
  </StrictMode>,
);
