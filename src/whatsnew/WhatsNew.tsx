import { ArrowRight, Check, ChevronDown, ExternalLink, Sparkles } from "lucide-react";
import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import { css, cx } from "styled-system/css";
import { token } from "styled-system/tokens";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { externalUrl, renderInline } from "../preview";
import * as api from "./api";
import { fixesLabel, headline, parseReleaseNotes, type Item } from "./notes";

/** Fixes shown before "Show all" when the list is long. */
const FOLD = 6;

export type Phase = { kind: "idle" } | { kind: "starting" } | { kind: "downloading"; downloaded: number; total: number | null } | { kind: "installing" } | { kind: "failed"; message: string };

const releaseUrl = (version: string) => `https://github.com/cef62/velo/releases/tag/v${encodeURIComponent(version)}`;

const rise = css({
  animation: "fade-in 420ms ease-out both, slide-from-bottom 420ms cubic-bezier(0.2, 0.7, 0.2, 1) both",
  _motionReduce: { animation: "none" },
});
const page = css({ display: "grid", gridTemplateRows: "1fr auto", h: "100vh", bg: "velo.canvas", color: "velo.fg", fontSize: "var(--wn-fs)", "--wn-fs": "clamp(13px, var(--velo-list-fs, 14px), 20px)", "--wn-top": "28px", "[data-mac=true] &": { "--wn-top": "48px" } });
const scroller = css({ overflowY: "auto", overscrollBehavior: "contain" });
const dragStrip = css({ position: "fixed", top: "0", insetX: "0", h: "32px", zIndex: "1" });
const hero = css({
  px: "7",
  pt: "var(--wn-top)",
  pb: "6",
  borderBottomWidth: "1px",
  borderColor: "velo.hairline",
  backgroundImage: `radial-gradient(120% 90% at 0% 0%, ${token.var("colors.velo.accentSubtle")} 0%, transparent 62%)`,
});
const versionRow = css({ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "2.5", mb: "4" });
const mark = css({ w: "36px", h: "36px", flex: "none", borderRadius: "10px", bg: "velo.accent", color: "velo.accentFg", display: "grid", placeItems: "center", fontSize: "20px", fontWeight: "700", letterSpacing: "-0.04em", lineHeight: "1" });
const versionChip = css({ display: "inline-flex", alignItems: "center", gap: "1.5", h: "6", px: "2.5", borderRadius: "full", borderWidth: "1px", borderColor: "velo.border", bg: "velo.panel", fontSize: "uiSm", color: "velo.fgMuted", fontVariantNumeric: "tabular-nums", "& svg": { w: "3", h: "3" }, "& strong": { color: "velo.fg", fontWeight: "600" } });
const h1 = css({ fontSize: "clamp(22px, calc(var(--wn-fs) * 1.85), 36px)", lineHeight: "1.2", fontWeight: "700", letterSpacing: "-0.022em", textWrap: "balance", overflowWrap: "anywhere", _focusVisible: { outline: "none" } });
const lead = css({ mt: "3", color: "velo.fgMuted", lineHeight: "1.6", maxW: "60ch", overflowWrap: "anywhere", "& p + p": { mt: "2" } });
const summary = css({ mt: "4", display: "flex", flexWrap: "wrap", gap: "2", fontSize: "uiSm", color: "velo.fgMuted" });
const section = css({ px: "7", pt: "6", "&:last-child": { pb: "7" } });
const h2 = css({ display: "flex", alignItems: "center", gap: "2", mb: "3", fontSize: "uiSm", fontWeight: "600", letterSpacing: "0.06em", textTransform: "uppercase", color: "velo.fgMuted", "& svg": { w: "4", h: "4", color: "velo.accentText" } });
const cards = css({ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "3" });
const card = css({
  p: "4",
  borderRadius: "lg",
  borderWidth: "1px",
  borderColor: "velo.border",
  bg: "velo.panel",
  boxShadow: "xs",
  transition: "border-color 150ms",
  _hover: { borderColor: "velo.accentBorder" },
  "& h3": { fontWeight: "600", lineHeight: "1.35", overflowWrap: "anywhere" },
  "& p": { mt: "1.5", color: "velo.fgMuted", lineHeight: "1.55", fontSize: "0.93em", overflowWrap: "anywhere" },
});
const fixList = css({
  display: "flex",
  flexDirection: "column",
  borderRadius: "lg",
  borderWidth: "1px",
  borderColor: "velo.border",
  bg: "velo.panel",
  "& li": { display: "flex", gap: "2.5", px: "3.5", py: "2.5", lineHeight: "1.5", overflowWrap: "anywhere" },
  "& li + li": { borderTopWidth: "1px", borderColor: "velo.hairline" },
  "& li > svg": { flex: "none", w: "4", h: "4", mt: "0.2em", color: "velo.positive" },
  "& li p": { color: "velo.fgMuted", fontSize: "0.93em", mt: "0.5" },
});
const more = css({ mt: "2", fontSize: "uiSm", color: "velo.fgMuted" });
const plainText = css({ color: "velo.fg", lineHeight: "1.6", overflowWrap: "anywhere", "& p + p": { mt: "2" } });
const inline = css({ "& code": { fontFamily: "mono", fontSize: "0.9em", px: "1", borderRadius: "sm", bg: "velo.muted" }, "& a": { color: "velo.accentText", textDecoration: "underline", textUnderlineOffset: "2px" } });
const bar = css({ display: "flex", alignItems: "center", gap: "3", px: "5", py: "3", borderTopWidth: "1px", borderColor: "velo.border", bg: "velo.chrome", flexWrap: "wrap" });
const githubLink = css({ display: "inline-flex", alignItems: "center", gap: "1.5", fontSize: "uiSm", color: "velo.fgMuted", textDecoration: "none", borderRadius: "sm", "& svg": { w: "3.5", h: "3.5" }, _hover: { color: "velo.fg", textDecoration: "underline" }, _focusVisible: { outline: "2px solid", outlineColor: "velo.accent", outlineOffset: "2px" } });
const status = css({ flex: "1", minW: "160px", display: "flex", flexDirection: "column", gap: "1.5", fontSize: "uiSm", color: "velo.fgMuted" });
const track = css({ h: "1.5", borderRadius: "full", bg: "velo.muted", overflow: "hidden", "& > div": { h: "full", bg: "velo.positive", borderRadius: "full", transition: "width 200ms ease-out" } });
const failed = css({ flex: "1", minW: "160px", fontSize: "uiSm", color: "velo.danger", overflowWrap: "anywhere" });
const actions = css({ display: "flex", gap: "2", ml: "auto" });
const toggle = css({ mt: "2", display: "inline-flex", alignItems: "center", gap: "1", fontSize: "uiSm", fontWeight: "500", color: "velo.accentText", cursor: "pointer", borderRadius: "sm", "& svg": { w: "4", h: "4", transition: "rotate 150ms" }, "&[aria-expanded=true] svg": { rotate: "180deg" }, _focusVisible: { outline: "2px solid", outlineColor: "velo.accent", outlineOffset: "2px" } });

/** Feed text as inline Markdown: markdown-it with `html: false`, so markup in the notes shows as text. */
function Md({ text, as: Tag = "span", className }: { text: string; as?: "span" | "p" | "h1" | "h3"; className?: string }) {
  return <Tag className={cx(inline, className)} dangerouslySetInnerHTML={{ __html: renderInline(text) }} />;
}

const Detail = ({ lines }: { lines: string[] }) => lines.map((l, i) => <Md key={i} as="p" text={l} />);

function progressText(p: Phase, version: string): string {
  if (p.kind === "starting") return "Saving your notes…";
  if (p.kind === "installing") return `Installing velo ${version}… velo restarts when it's done.`;
  if (p.kind !== "downloading") return "";
  // announced in 10% steps: a screen reader would read every percent
  return p.total ? `Downloading velo ${version}… ${Math.min(100, Math.floor((p.downloaded * 10) / p.total) * 10)}%` : `Downloading velo ${version}… ${(p.downloaded / 1e6).toFixed(1)} MB`;
}

export function WhatsNew({ info, phase, onInstall }: { info: api.WhatsNewInfo | null; phase: Phase; onInstall: () => void }) {
  const [open, setOpen] = useState(false);
  const fixesId = useId();
  const primary = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const u = info?.update ?? null;
  useEffect(() => {
    if (info) (primary.current ?? heading.current)?.focus(); // the primary action, else the heading (no update)
  }, [info]);

  // every link (feed links included) opens in the browser, http(s) only; the window itself never navigates
  const onLinkClick = (e: MouseEvent) => {
    const a = (e.target as Element).closest?.("a");
    if (!a) return;
    e.preventDefault();
    const url = externalUrl(a.getAttribute("href") ?? "");
    if (url) void api.openUrl(url);
  };

  if (!info) return <div className={page} aria-busy="true" />;
  const notes = parseReleaseNotes(u?.notes ?? "");
  const title = headline(notes);
  const [first, ...rest] = notes.highlights;
  const parsed = notes.highlights.length + notes.fixes.length + notes.other.length > 0;
  const folded = notes.fixes.length > FOLD && !open;
  const shownFixes = folded ? notes.fixes.slice(0, FOLD - 1) : notes.fixes;
  const busy = phase.kind === "starting" || phase.kind === "downloading" || phase.kind === "installing";
  const pct = phase.kind === "downloading" && phase.total ? Math.min(100, (phase.downloaded * 100) / phase.total) : phase.kind === "installing" ? 100 : null;
  let delay = 0;
  const step = () => ({ animationDelay: `${(delay += 50)}ms` });
  const counts = [notes.highlights.length && `${notes.highlights.length} new`, notes.fixes.length && fixesLabel(notes.fixes.length), notes.other.length && `${notes.other.length} other`].filter(Boolean);

  return (
    <div className={page} onClick={onLinkClick} onAuxClick={onLinkClick}>
      <div className={dragStrip} data-tauri-drag-region aria-hidden />
      <main className={scroller} aria-labelledby="wn-title">
        <header className={hero}>
          <div className={cx(versionRow, rise)}>
            <div className={mark} aria-hidden>
              v
            </div>
            {u ? (
              <span className={versionChip}>
                <span>
                  You're on <strong>{u.current_version}</strong>
                </span>
                <ArrowRight aria-hidden />
                <span>
                  velo <strong>{u.version}</strong>
                </span>
              </span>
            ) : null}
          </div>
          <h1 id="wn-title" ref={heading} tabIndex={-1} className={cx(h1, rise)} style={step()}>
            {!u ? "No update is waiting" : title ? <Md text={title} /> : `velo ${u.version} is ready`}
          </h1>
          {first && first.detail.length > 0 && (
            <div className={cx(lead, rise)} style={step()}>
              <Detail lines={first.detail} />
            </div>
          )}
          {!u && (
            <p className={cx(lead, rise)} style={step()}>
              The update was installed, or it is no longer available. Check for updates again from the velo window.
            </p>
          )}
          {counts.length > 1 && (
            <p className={cx(summary, rise)} style={step()}>
              {counts.join(" · ")}
            </p>
          )}
        </header>

        {rest.length > 0 && (
          <section className={section} aria-labelledby="wn-new">
            <h2 id="wn-new" className={h2}>
              <Sparkles aria-hidden /> Also new
            </h2>
            <div className={cards}>
              {rest.map((it, i) => (
                <article key={i} className={cx(card, rise)} style={step()}>
                  <Md as="h3" text={it.title} />
                  <Detail lines={it.detail} />
                </article>
              ))}
            </div>
          </section>
        )}

        {notes.fixes.length > 0 && (
          <section className={section} aria-labelledby="wn-fixed">
            <h2 id="wn-fixed" className={h2}>
              Fixed <Badge size="sm" variant="surface">{notes.fixes.length}</Badge>
            </h2>
            <ul id={fixesId} className={cx(fixList, rise)} style={step()}>
              {shownFixes.map((it, i) => (
                <FixRow key={i} item={it} />
              ))}
            </ul>
            {notes.fixes.length > FOLD && (
              <button type="button" className={toggle} aria-expanded={open} aria-controls={fixesId} onClick={() => setOpen(!open)}>
                {open ? "Show fewer" : `Show all ${notes.fixes.length} fixes`} <ChevronDown aria-hidden />
              </button>
            )}
          </section>
        )}

        {notes.other.length > 0 && (
          <section className={section} aria-labelledby="wn-other">
            <h2 id="wn-other" className={h2}>
              {notes.highlights.length + notes.fixes.length ? "Other changes" : "Changes"}
            </h2>
            <ul className={cx(fixList, rise)} style={step()}>
              {notes.other.map((it, i) => (
                <FixRow key={i} item={it} />
              ))}
            </ul>
          </section>
        )}

        {notes.more > 0 && (
          <section className={section}>
            <p className={more}>…and {notes.more} more in the full changelog.</p>
          </section>
        )}

        {u && !parsed && (
          <section className={section} aria-labelledby="wn-notes">
            <h2 id="wn-notes" className={h2}>
              Release notes
            </h2>
            <div className={plainText}>
              {notes.text ? <Detail lines={notes.text.split("\n").filter((l) => l.trim())} /> : <p>No release notes came with this update. They are on GitHub.</p>}
            </div>
          </section>
        )}
      </main>

      <footer className={bar}>
        {busy ? (
          <div className={status}>
            <span role="status">{progressText(phase, u?.version ?? "")}</span>
            <div className={track} role="progressbar" aria-label="Update progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct === null ? undefined : Math.round(pct)}>
              <div style={{ width: `${pct ?? 8}%` }} />
            </div>
          </div>
        ) : phase.kind === "failed" ? (
          <p className={failed} role="alert">
            {phase.message}
          </p>
        ) : (
          <a className={githubLink} href={u ? releaseUrl(u.version) : "https://github.com/cef62/velo/releases"}>
            {u ? "Full changelog on GitHub" : "Releases on GitHub"} <ExternalLink aria-hidden />
          </a>
        )}
        <div className={actions}>
          <Button size="sm" variant="outline" onClick={() => void api.close()}>
            {u ? "Later" : "Close"}
          </Button>
          {u && (
            <Button ref={primary} size="sm" colorPalette="green" loading={busy} loadingText="Installing…" onClick={onInstall}>
              {phase.kind === "failed" ? "Try again" : "Install and restart"}
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}

function FixRow({ item }: { item: Item }) {
  return (
    <li>
      <Check aria-hidden />
      <div>
        <Md text={item.title} />
        <Detail lines={item.detail} />
      </div>
    </li>
  );
}
