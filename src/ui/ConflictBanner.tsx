import { TriangleAlert, X } from "lucide-react";
import { banner } from "styled-system/recipes";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { IconButton } from "@/components/ui";
import { useStore } from "./useStore";

/** Conflict note title from its path: no folder, no extension. */
export const noteTitle = (path: string) => (path.split(/[\\/]/).pop() ?? path).replace(/\.[^.]*$/, "");

export function ConflictBanner({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const conflict = useStore(store, (s) => s.conflict);
  if (!conflict) return null;
  return (
    <div className={banner({ tone: "conflict" })} role="status">
      <TriangleAlert size={16} aria-hidden />
      <span>
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
      </span>
      <IconButton variant="plain" size="2xs" marginLeft="auto" aria-label="Dismiss" onClick={() => controller.dismissConflict()}>
        <X />
      </IconButton>
    </div>
  );
}
