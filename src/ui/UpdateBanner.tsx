import { CircleCheck, Download, X } from "lucide-react";
import { banner } from "styled-system/recipes";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Button, IconButton, Spinner } from "@/components/ui";
import { useStore } from "./useStore";

/** A new version (Install and restart), the install in progress, or a manual check's "up to date". */
export function UpdateBanner({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const update = useStore(store, (s) => s.update);
  if (!update) return null;
  const { version, status } = update;
  const notes = (
    <a
      href="#"
      onClick={(e) => {
        e.preventDefault();
        controller.openReleaseNotes(version);
      }}
    >
      What's new
    </a>
  );
  return (
    <div className={banner({ tone: "update" })} role="status">
      {status === "installing" ? <Spinner size="sm" /> : status === "current" ? <CircleCheck size={16} aria-hidden /> : <Download size={16} aria-hidden />}
      {status === "available" && <span>velo {version} is available. {notes}</span>}
      {status === "installing" && <span>Installing velo {version}… velo restarts when it's done.</span>}
      {status === "current" && <span>velo is up to date ({version}).</span>}
      {status === "available" && (
        <Button size="xs" marginLeft="auto" onClick={() => void controller.installUpdate()}>
          Install and restart
        </Button>
      )}
      {status !== "installing" && (
        <IconButton variant="plain" size="2xs" marginLeft={status === "available" ? undefined : "auto"} aria-label="Dismiss" onClick={() => controller.dismissUpdate()}>
          <X />
        </IconButton>
      )}
    </div>
  );
}
