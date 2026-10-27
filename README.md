# velo

A fast, keyboard-first notes app for macOS, Windows and Linux, built with Tauri 2 and a React 19 UI (Park UI on Ark UI, styled with Panda CSS 1.12). One box searches and creates: type to filter your notes, press Enter to open the match or create a new note with that title.

Inspired by nvALT and Notational Velocity; not affiliated with or endorsed by their authors.

## Features

- Search-or-create box; results update on every keystroke (backend under 50 ms p95 at 10k notes, release build), with matches highlighted in the list.
- Plain files you own: a flat folder of `.md` / `.txt` notes, edited in a CodeMirror editor with autosave.
- `[[wikilinks]]`: following a link to a missing note creates it; renaming a note rewrites links to it.
- Markdown preview with clickable wikilinks and external links.
- Note counts next to every tag and in the filter line; a Retry button when a save fails.
- Theme: System (follows the OS), Light or Dark, in Settings. Settings can also show text labels next to the header buttons.
- Rich editing (default): markdown marks are hidden except on the line you are editing; ⌘/Ctrl-click opens links, wikilinks and tags; task checkboxes are clickable. Toggle Rich / Plain with the toolbar button or ⌘⇧R. The file text is never changed by the display.
- Per-note encryption with [age](https://age-encryption.org); locked notes are never written to disk or to the index as plaintext.
- Live reload of external edits; a concurrent edit produces a `(conflict ...)` copy instead of overwriting anything.
- Global hotkey (default ⌘⇧Space / Ctrl+Shift+Space) to bring velo up; remappable in Settings. Any shortcut can be cleared with ⌫ in Settings, and conflicting shortcuts are shown instead of refused.

## Keyboard shortcuts

All shortcuts below are remappable in Settings (click a shortcut, press the new keys; Esc cancels). Enter in search, Esc in the editor, ↑/↓ in search and the list, the Edit menu and ⌘Q are fixed. `Mod` is ⌘ on macOS and Ctrl on Windows/Linux.

| macOS | Windows/Linux | Action |
| --- | --- | --- |
| ⌘L | Ctrl+L | Focus the search box |
| ⌘R | Ctrl+R | Rename current note (also: double-click the title) |
| ⌘⇧P | Ctrl+Shift+P | Toggle Markdown preview |
| ⌘⇧E | Ctrl+Shift+E | Lock / unlock current note |
| ⌥⌘E | Ctrl+Alt+E | Lock all notes |
| ⌘⌫ | Ctrl+Backspace | Move the current note to the Trash, after confirming (from the list or an empty search box; in the editor and in a non-empty search box ⌘⌫ keeps its editing meaning) |
| ⌘⇧S | Ctrl+Shift+S | Toggle sort (last modified / title) |
| ⌘J / ⌘K | Ctrl+J / Ctrl+K | Back / forward through visited notes (also from the editor; ↑/↓ in search move in the list) |
| ⌘, | Ctrl+, | Settings |
| ⌘⇧T | Ctrl+Shift+T | Show / hide the tag panel |
| ⌘⇧R | Ctrl+Shift+R | Rich / plain editing |
| ⌘⇧J | Ctrl+Shift+J | Vertical / horizontal layout |
| ⌘I | Ctrl+I | Show / hide the note info panel |
| ⌘⇧Space | Ctrl+Shift+Space | Show / hide velo (system-wide) |

Right-click a note in the list (or press the Menu key / Shift+F10 on the highlighted row) for a menu: open, rename, lock/unlock, copy `[[link]]`, show in Finder/Explorer, move to Trash. It opens the note first, so no menu appears if the switch is refused.

Fixed: Enter (in search) opens the highlighted note, or creates a note titled with the query when nothing matches; Shift+Enter creates a note titled exactly as typed (or opens that exact title if it exists); ↑ / ↓ move the selection; Esc (in editor) returns to search.

## Tags

Write `#tag` anywhere in a note (at the start of a line, after a space, or after `(`; letters, digits, `_`, `-`, `/`; at least one letter; not in fenced code blocks; `# Heading` is not a tag). The `#` button next to search (or ⌘⇧T) shows every tag with its note count; click chips to filter the list to notes having all selected tags, combined with the search text. A "Filtered by" line stays visible while tags are selected. In the preview, click a `#tag` to filter by it. Locked notes are not listed in the tag panel.

## Dates and front matter

Notes sync through Drive, Dropbox, iCloud or git, which reset or rewrite file dates. So velo stores each note's dates inside the note, in a YAML front-matter block at the top:

```
---
created: 2026-10-27T09:14:05+01:00
modified: 2026-10-27T10:02:41+01:00
---
```

- New notes start with both dates. Saving a note without a block prepends one (`created` from the file's date, `modified` now); saving a note with a block updates `modified` and adds `created` if missing. Locked notes are stamped before encryption.
- Everything else in the block (other keys, comments, order) is left byte for byte. velo never overwrites an existing `created:` line, and edits only the first `modified:` line. Other date formats (`2026-10-27`, `2026-10-27 09:14`, quoted) are read; an unreadable value falls back to the file date, shown with a "from file" hint.
- Turn writing off in Settings, General ("Add created/modified dates to notes"). Existing blocks are still read.
- The block is hidden in the editor and preview. Show it with the "Show front matter in the editor" checkbox in the info panel, or bind a key to "Show / hide front matter" in Settings (unbound by default).
- `tags:` and `aliases:` (flow list `[a, b]`, block list or single value) are read, never written. Tags merge with `#tags`. Aliases work as titles for `[[wikilinks]]`, opening by name, and search.
- The list's date and the Recent sort use the modified date from the note.

## Revisions

velo keeps local snapshots of each note: on save when the last one is over 10 minutes old (the version the save replaces), before an external change replaces the editor text, and before a restore. They are kept for 30 days, stored in the app data directory (never in the notes folder, never synced), and encrypted for locked notes.

Press ⌘I (Ctrl+I) for the info panel: created and modified dates, word count, "linked from N notes", tags, aliases and the revision list. Select a revision to preview it, then Restore; the current text is kept as a revision first.

## How it's built

Rust backend in `src-tauri` (Tauri 2); UI in `src` with React 19, Park UI v1 (Ark UI) and Panda CSS 1.12. Panda generates `styled-system/` (git-ignored) from `panda.config.ts`: `pnpm test` and `pnpm build` run `panda codegen` first; `pnpm install` runs it too (`pnpm codegen` to rerun).

## Storage

- Your notes folder is flat: only `*.md`, `*.txt` and `*.md.age` files directly inside it are notes. Subfolders and dotfiles are ignored. New notes are `Title.md`.
- Files are the source of truth. Locked notes are `Title.md.age`.
- `.velo/identity.age` (inside the notes folder) holds your encryption identity, wrapped with your passphrase.
- The search index is a SQLite file (`index-<hash>.sqlite`) in the app's data directory (Tauri app data dir for `dev.velo.app`, e.g. `~/Library/Application Support/dev.velo.app` on macOS), never in the notes folder. It is rebuildable: delete it and velo reindexes on next launch without losing anything. Settings live in the app config dir.

## Encryption

velo generates one age X25519 identity. It is kept in the OS keychain (so locked notes open without a prompt on this machine) and a passphrase-wrapped copy is stored in `.velo/identity.age` (so you can unlock on another machine, or recover). Each locked note is age-encrypted to that identity as `Title.md.age`.

Lock all (⌥⌘E) forgets the decrypted notes and the key until you enter your passphrase again; quitting and relaunching unlocks from the keychain as usual.

Decrypt outside velo with the [`age` CLI](https://github.com/FiloSottile/age):

```sh
age -d .velo/identity.age > key.txt          # asks for your passphrase
age -d -i key.txt "Note.md.age" > "Note.md"
rm key.txt                                    # key.txt is your plaintext private key: delete it
```

On Linux the keychain needs a Secret Service provider such as gnome-keyring (or KeePassXC) running for automatic unlock. If no OS keychain/Secret Service is available, velo asks for your passphrase each time it starts and keeps the key in memory only for that session.

## Unsigned builds

Release builds are not notarized: on macOS they carry only an ad-hoc signature, on Windows none.

- macOS: open the app once, then in System Settings › Privacy & Security click "Open Anyway". Or run `xattr -dr com.apple.quarantine /Applications/velo.app`.
- Windows: on the SmartScreen dialog click "More info", then "Run anyway".

## Updates

velo checks GitHub for a new release 30 seconds after launch and then once a day. When one is out, a banner offers **Install and restart**: velo saves your note, installs the update and relaunches. Check by hand from **velo → Check for Updates…** (macOS) or **Settings → Updates → Check now**; turn the daily check off in Settings. Updates are verified against velo's signing key before they install. On Linux in-app updates work for the AppImage only. Versions before 0.6.0 have no updater: install 0.6.0 by hand once.

## Known limitations

- Quitting from the Dock or at logout bypasses the unsaved-edits prompt; edits are autosaved within about 0.5 s. Cmd+Q (and closing the window) asks first.

## Development

Requires Node 24, pnpm, and a Rust toolchain (plus [Tauri's platform prerequisites](https://v2.tauri.app/start/prerequisites/)).

```sh
pnpm install
pnpm tauri dev          # run the app
pnpm test               # frontend tests
cd src-tauri && cargo test
pnpm build:app          # release bundles, signed for the updater with ~/.tauri/velo.key
```

Performance test (10k notes, release build only):

```sh
node scripts/seed.mjs 10000 fixtures/notes
cd src-tauri && cargo test --release --test perf -- --ignored --nocapture
```

Pushing a `v*` tag runs `.github/workflows/build-release.yml`, which tests and builds all platforms into a GitHub release.

Release builds also produce updater artifacts (`.sig` files and `latest.json`) signed with a minisign key stored in the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; the matching public key lives in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`. `pnpm tauri build` refuses to run without the private key; `pnpm build:app` reads it and its password from `~/.tauri/velo.key` and `~/.tauri/velo.password`. Forks need their own keypair (`pnpm tauri signer generate`). Never lose or commit the private key: installed apps only accept updates signed with it.

## License

MIT, see [LICENSE](LICENSE).

## Versioning

Versions are managed with [Changesets](https://github.com/changesets/changesets). `package.json` is the version source.

- Every user-visible change ships with a changeset in the same commit or PR: `pnpm changeset`, pick `patch` or `minor`, and write one past-tense sentence from the user's point of view.
- `pnpm version-packages` applies pending changesets (bumps `package.json`, writes `CHANGELOG.md`) and mirrors the version into `src-tauri/tauri.conf.json`.
- `pnpm release:tag` creates the `vX.Y.Z` git tag.
- On GitHub: `ci.yml` builds and tests every PR and `main`. `release.yml` (Changesets action) opens a "Version Packages" PR while changesets are pending; merging it tags `vX.Y.Z` and dispatches `build-release.yml`, which builds macOS (arm64 + x64), Linux and Windows one after the other into a draft GitHub Release and publishes it once `latest.json` lists all four platforms.
