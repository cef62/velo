import { Search } from "lucide-react";
import { css } from "styled-system/css";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Input, Kbd } from "@/components/ui";
import { searchHint } from "./breakpoints";
import { registerSearchInput } from "./platform";
import { useStore } from "./useStore";

const wrap = css({ position: "relative", flex: "1 1 200px", minW: "180px" });
const icon = css({ position: "absolute", left: "2.5", top: "50%", transform: "translateY(-50%)", w: "4", h: "4", color: "fg.muted", pointerEvents: "none" });
const hints = css({ position: "absolute", right: "1.5", top: "50%", transform: "translateY(-50%)", display: "inline-flex", gap: "1.5", pointerEvents: "none" });

export function SearchField({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const query = useStore(store, (s) => s.query);
  const indexing = useStore(store, (s) => s.indexing !== null);
  const sel = useStore(store, (s) => s.sel);
  const exactTitleMatch = useStore(store, (s) => s.exactTitleMatch);
  const keys = useStore(store, (s) => s.keys);
  const isMac = useStore(store, (s) => s.isMac);
  const hint = searchHint({ query, sel, exactTitleMatch, keys, isMac });
  return (
    <div className={wrap}>
      <Search className={icon} aria-hidden="true" />
      <Input
        ref={registerSearchInput}
        size="sm"
        aria-label="Search or create"
        placeholder="Search or create…"
        value={query}
        disabled={indexing}
        className={css({ pl: "8", pr: hint.length ? "24" : "2", fontSize: "ui" })}
        onChange={(e) => controller.setQuery(e.target.value)}
        onFocus={() => controller.setListActive(true)}
        onBlur={() => controller.setListActive(false)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          void controller.enter(e.shiftKey);
        }}
      />
      <span className={hints} aria-hidden="true">
        {hint.map((h) => (
          <Kbd key={h} fontFamily="inherit">{h}</Kbd>
        ))}
      </span>
    </div>
  );
}
