import { TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { css } from "styled-system/css";
import { banner } from "styled-system/recipes";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { IconButton } from "@/components/ui";
import { useStore } from "./useStore";

/** Conflict note title from its path: no folder, no extension. */
export const noteTitle = (path: string) => (path.split(/[\\/]/).pop() ?? path).replace(/\.[^.]*$/, "");

/** A warning row under the title bar; its text wraps. `onDismiss` moves focus away (the row unmounts: focus must not fall to <body>). */
function Banner({ role, label, onDismiss, children }: { role: "status" | "alert"; label: string; onDismiss: () => void; children: ReactNode }) {
  return (
    <div className={banner({ tone: "conflict" })} role={role} data-banner="">
      <TriangleAlert size={16} aria-hidden />
      <span className={css({ overflowWrap: "anywhere" })}>{children}</span>
      <IconButton
        variant="plain"
        size="2xs"
        marginLeft="auto"
        aria-label={label}
        onClick={onDismiss}
      >
        <X />
      </IconButton>
    </div>
  );
}

export function ConflictBanner({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const conflict = useStore(store, (s) => s.conflict);
  if (!conflict) return null;
  return (
    <Banner role="status" label="Dismiss" onDismiss={() => controller.dismissConflict()}>
      This file changed on disk. Your edits were saved to{" "}
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault();
          void controller.openConflict();
        }}
      >
        {noteTitle(conflict)}
      </a>
    </Banner>
  );
}

/** The archived-notes list could not be updated: stays until dismissed (see `Controller.onArchiveError`). */
export function ArchiveBanner({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const msg = useStore(store, (s) => s.archiveErr);
  if (!msg) return null;
  return (
    // an alert: announced when it appears (a status region would have to exist before its text)
    <Banner role="alert" label="Dismiss archived-list warning" onDismiss={() => controller.dismissArchiveErr()}>
      {msg}
    </Banner>
  );
}
