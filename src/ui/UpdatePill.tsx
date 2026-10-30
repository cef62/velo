import { CircleAlert, CircleCheck, Download } from "lucide-react";
import { css } from "styled-system/css";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Button, Popover, Spinner } from "@/components/ui";
import { platform } from "./platform";
import { useStore } from "./useStore";

// "velo 0.11 is ready": a pill in the header (v2 §3 #12), green = positive; the install, its failure or "up to date" use the same pill
const pill = css({
  display: "inline-flex",
  alignItems: "center",
  gap: "1.5",
  h: "6",
  px: "2.5",
  borderRadius: "full",
  borderWidth: "1px",
  borderColor: "velo.positiveBorder",
  bg: "velo.positiveSubtle",
  color: "velo.positiveText",
  fontSize: "uiSm",
  fontWeight: "500",
  whiteSpace: "nowrap",
  flex: "none",
  cursor: "pointer",
  "&[data-tone=failed]": { borderColor: "velo.dangerBorder", bg: "velo.dangerSubtle", color: "velo.danger" },
  "&[data-tone=current]": { borderColor: "velo.border", bg: "velo.muted", color: "velo.fgMuted" },
  "& svg": { w: "3.5", h: "3.5" },
  _focusVisible: { outline: "2px solid", outlineColor: "velo.accent", outlineOffset: "1px" },
});
const body = css({ display: "flex", flexDirection: "column", gap: "3", fontSize: "ui", color: "velo.fg", minW: "240px" });
const actions = css({ display: "flex", gap: "2", justifyContent: "flex-end" });
const srOnly = css({ srOnly: true });

/** A new version (Install and restart), the install in progress, its failure, or a manual check's "up to date". */
export function UpdatePill({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const update = useStore(store, (s) => s.update);
  const { version, status, message } = update ?? { version: "", status: "current" as const, message: undefined };
  const label = !update ? "" : status === "available" ? `velo ${version} is ready` : status === "installing" ? "Installing…" : status === "failed" ? "Update failed" : "Up to date";
  // the live region is always mounted, so an update's arrival is announced (text appearing in an existing region)
  if (!update) return <span className={srOnly} role="status" />;
  const icon = status === "installing" ? <Spinner size="xs" /> : status === "current" ? <CircleCheck aria-hidden /> : status === "failed" ? <CircleAlert aria-hidden /> : <Download aria-hidden />;
  const dismiss = () => {
    controller.dismissUpdate(); // the pill unmounts: focus must not fall to <body>
    platform.focusSearch();
  };
  return (
    <Popover.Root positioning={{ placement: "bottom-end" }}>
      <span className={srOnly} role="status">{label}</span>
      <Popover.Trigger asChild>
        <button type="button" className={pill} data-tone={status} aria-label={`${label}: details`}>
          {icon}
          {label}
        </button>
      </Popover.Trigger>
      <Popover.Positioner>
        <Popover.Content>
          <div className={body}>
            {status === "available" && <span>velo {version} is available.</span>}
            {(status === "installing" || status === "failed") && <span>{message}</span>}
            {status === "current" && <span>velo is up to date ({version}).</span>}
            <div className={actions}>
              {status === "available" && (
                <Button size="xs" variant="outline" onClick={() => controller.openReleaseNotes(version)}>
                  What's new
                </Button>
              )}
              {status === "available" && (
                <Button size="xs" colorPalette="green" onClick={() => void controller.installUpdate()}>
                  Install and restart
                </Button>
              )}
              {status !== "installing" && (
                <Button size="xs" variant="plain" onClick={dismiss}>
                  Dismiss
                </Button>
              )}
            </div>
          </div>
        </Popover.Content>
      </Popover.Positioner>
    </Popover.Root>
  );
}
