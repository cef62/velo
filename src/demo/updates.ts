// Demo update fixtures in the release-notes format (scripts/release-notes.mjs). `?update=big` (3 highlights with detail,
// 20 fixes) or `?update=patch` (4 fixes) makes the pill appear and fills the What's new page (whatsnew.html, same query).
import { version as current } from "../../package.json";
import type { UpdateInfo } from "../whatsnew/api";
import changelog from "../../CHANGELOG.md?raw";
// @ts-expect-error plain .mjs (it runs in CI without a build step); no type declarations
import { releaseNotes } from "../../scripts/release-notes.mjs";

const HINTS = `\n\n---\n\nmacOS: the app is ad-hoc signed, not notarized: on first launch open System Settings → Privacy & Security and click Open Anyway, or run \`xattr -cr /Applications/velo.app\` once. Windows: the installer is unsigned. When SmartScreen appears, click More info → Run anyway.\n`;

const FIXES = [
  "Fixed an agent edit to the open note reporting success when the note changed on disk meanwhile: the agent now gets an error that names the conflict copy.",
  "Fixed Enter sometimes doing nothing on the exact title of a hidden archived note.",
  "Fixed which of two same-titled notes opens: it is now always the first by path.",
  "Fixed a second save of the same edits overwriting a change made outside velo.",
  "Fixed keyboard focus being lost when the list pane is resized across the icon-only width.",
  "Fixed the note count above the list reading “100K” instead of “99K” on some Linux systems.",
  "Fixed a locked note's text staying searchable when the index could not erase it.",
  "Fixed a held shortcut repeating its action: only Back and Forward keep repeating.",
  "Fixed the title bar staying reachable by keyboard behind the lock screen.",
  "Fixed a reload of the open note moving the caret onto lines added above it.",
  "Fixed the caret jumping when a note reloads after an outside edit above and below it.",
  "Fixed renaming a note to a title that differs only in accents or case.",
  "Fixed tag chips: a filter on a tag that only archived notes carry now shows its chip.",
  "Fixed shortcuts acting on the note hidden behind a locked note's unlock screen.",
  "Fixed locking a note changing whether another note with the same name shows as archived.",
  "Fixed the “archived” badge squeezing note titles in a narrow list.",
  "Fixed Enter opening the first row instead of an archived note whose exact title you typed.",
  "Fixed a failure to update the archived-notes list being hidden by a save's status.",
  "Fixed the search index staying stuck after a disk-full error.",
  "Fixed notes saved after a disk-full error being lost when the app quit.",
];

const bullets = (lines: string[]) => lines.map((l) => `- ${l}`).join("\n");

const BIG = `### Minor Changes

- Added a What's new window that shows what an update brings before you install it.
  Open it from the update pill. New things come first as cards, fixes follow in a short list, and Install and restart is one click away.
- Added \`Ctrl+Tab\` to jump between the notes you opened last.
  Hold Ctrl and press Tab again to go further back; release to open the note.
- Added a Reading width setting under Settings › Appearance.
  Pick Narrow, Comfortable or Wide; long lines in the editor and the preview wrap at that width.

### Patch Changes

${bullets(FIXES)}${HINTS}`;

const PATCH = `### Patch Changes

${bullets(FIXES.slice(0, 4))}${HINTS}`;

const kind = new URLSearchParams(globalThis.location?.search ?? "").get("update");

/** The update the demo announces, or null without `?update=`. `?update=0.17.0` (any CHANGELOG version): that release's
 *  real notes, as the release script writes them. */
export const demoUpdate: UpdateInfo | null =
  kind === "big"
    ? { version: "0.19.0", current_version: current, notes: BIG }
    : kind === "patch"
      ? { version: "0.18.3", current_version: current, notes: PATCH }
      : kind && changelog.includes(`\n## ${kind}\n`)
        ? { version: kind, current_version: current, notes: releaseNotes(changelog, kind) }
        : null;

/**
 * The demo's stand-in for Rust between the two tabs (same origin): What's new posts `{ install }`, the main tab's
 * `whatsnew-install` listener (src/ui/main.tsx) runs it, then posts `{ failed }` (whatsnewFailed) or `{ play }` (the
 * install started: the tab plays a fake download). So the browser runs the real listener and the real refusal rule.
 */
export const relay = () => new BroadcastChannel("velo-demo-whatsnew");
export const post = (m: { install?: string; failed?: string; play?: true }) => {
  const ch = relay();
  ch.postMessage(m); // delivered even though the channel closes right after
  ch.close();
};
