import { useLayoutEffect, useRef, useState } from "react";
import { Search, SquareCheck } from "lucide-react";
import { css } from "styled-system/css";
import type { Controller } from "../app/controller";
import type { AppState, Store } from "../app/store";
import { Input, Kbd } from "@/components/ui";
import { searchHint } from "./breakpoints";
import { registerSearchInput } from "./platform";
import { useStore } from "./useStore";

const wrap = css({ position: "relative", flex: "1 1 200px", minW: "180px" });
const icon = css({ position: "absolute", left: "2.5", top: "50%", transform: "translateY(-50%)", w: "4", h: "4", color: "fg.muted", pointerEvents: "none" });
const capErr = css({ position: "absolute", left: "0", top: "100%", mt: "1", zIndex: "1", fontSize: "uiSm", color: "red.11", bg: "velo.canvas", px: "1", borderRadius: "4px" });
const hints = css({ position: "absolute", right: "1.5", top: "50%", transform: "translateY(-50%)", display: "inline-flex", gap: "1.5", pointerEvents: "none" });

export function SearchField({ controller, store }: { controller: Controller; store: Store<AppState> }) {
  const query = useStore(store, (s) => s.query);
  const indexing = useStore(store, (s) => s.indexing !== null);
  const sel = useStore(store, (s) => s.sel);
  const exactTitleMatch = useStore(store, (s) => s.exactTitleMatch);
  const keys = useStore(store, (s) => s.keys);
  const isMac = useStore(store, (s) => s.isMac);
  const capture = useStore(store, (s) => s.capture);
  const hintsEl = useRef<HTMLSpanElement>(null);
  const [hintW, setHintW] = useState(0); // typed text must never run under the hints
  useLayoutEffect(() => {
    const el = hintsEl.current;
    if (!el) return setHintW(0);
    const ro = new ResizeObserver(() => setHintW(el.offsetWidth));
    ro.observe(el);
    setHintW(el.offsetWidth);
    return () => ro.disconnect();
  });
  const hint = capture ? [] : searchHint({ query, sel, exactTitleMatch, keys, isMac });
  const Icon = capture ? SquareCheck : Search;
  return (
    <div className={wrap}>
      <Icon className={icon} aria-hidden="true" />
      <Input
        ref={registerSearchInput}
        size="sm"
        aria-label={capture ? `Add a task to ${capture.target}` : "Search or create"}
        placeholder={capture ? `→ ${capture.target}` : "Search or create…"}
        value={query}
        style={hint.length ? { paddingRight: hintW + 14 } : undefined}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        disabled={indexing && !capture} // capture keeps the field: an "indexing" refusal shows under it, text kept
        className={css({ pl: "8", pr: "2", fontSize: "ui" })}
        onChange={(e) => controller.setQuery(e.target.value)}
        onFocus={() => controller.setListActive(true)}
        onBlur={() => {
          controller.setListActive(false);
          controller.blurCapture();
        }}
        onKeyDown={(e) => {
          if (capture && (e.key === "Escape" || e.key === "Enter")) {
            e.preventDefault();
            if (e.key === "Escape") controller.cancelCapture();
            else void controller.submitCapture(query);
          } else if (e.key === "Escape" && query !== "") {
            e.preventDefault();
            controller.setQuery("");
          } else if (e.key === "Enter") {
            e.preventDefault();
            void controller.enter(e.shiftKey || e.altKey, e.altKey);
          }
        }}
      />
      <span ref={hintsEl} className={hints} aria-hidden="true">
        {hint.map((h) => (
          <Kbd key={h} fontFamily="inherit" gap="1.5">
            {h.split(" ").map((part) => (
              <span key={part}>{part}</span>
            ))}
          </Kbd>
        ))}
      </span>
      {capture?.err && <div role="alert" className={capErr}>{capture.err}</div>}
    </div>
  );
}
