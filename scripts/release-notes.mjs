// Release notes for one version: its CHANGELOG.md section, then the install hints below a `---` line.
// `node scripts/release-notes.mjs 0.19.0 CHANGELOG.md` prints them (build-release.yml, create-release job).
// The section keeps its `### Minor Changes` / `### Patch Changes` headings and each bullet's continuation lines
// (a changeset's later lines); the commit hash changesets puts before each bullet is dropped. The app's What's new
// window (src/whatsnew/notes.ts) groups by those headings and cuts everything from the last `---` line on.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const SEPARATOR = "---";
export const FALLBACK = "- See CHANGELOG.md for details.";
export const HINTS =
  "macOS: the app is ad-hoc signed, not notarized: on first launch open System Settings → Privacy & Security and click Open Anyway, or run `xattr -cr /Applications/velo.app` once. Windows: the installer is unsigned. When SmartScreen appears, click More info → Run anyway.";

/** The release body for `version` (no leading "v") from the text of CHANGELOG.md. */
export function releaseNotes(changelog, version) {
  const out = [];
  let on = false;
  for (const raw of changelog.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === `## ${version}`) on = true;
    else if (on && line.startsWith("## ")) break;
    else if (on) out.push(line.replace(/^- [0-9a-f]{7}: /, "- "));
  }
  const section = out.join("\n").trim();
  // a section without a single bullet (missing version, or headings only) says where to look instead
  const body = out.some((l) => l.startsWith("- ")) ? section : FALLBACK;
  // the blank line before `---` matters: right under a text line it would turn that line into a heading
  return `${body}\n\n${SEPARATOR}\n\n${HINTS}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [version, file = "CHANGELOG.md"] = process.argv.slice(2);
  if (!version) {
    console.error("usage: node scripts/release-notes.mjs <version> [CHANGELOG.md]");
    process.exit(2);
  }
  process.stdout.write(releaseNotes(readFileSync(file, "utf8"), version));
}
