# velo

A fast, keyboard-first notes app for macOS, Windows and Linux, built with Tauri 2. One box searches and creates: type to filter your notes, press Enter to open the match or create a new note with that title.

Inspired by nvALT and Notational Velocity; not affiliated with or endorsed by their authors.

## Features

- Search-or-create box; results update on every keystroke (backend under 50 ms p95 at 10k notes, release build).
- Plain files you own: a flat folder of `.md` / `.txt` notes, edited in a CodeMirror editor with autosave.
- `[[wikilinks]]`: following a link to a missing note creates it; renaming a note rewrites links to it.
- Markdown preview with clickable wikilinks and external links.
- Per-note encryption with [age](https://age-encryption.org); locked notes are never written to disk or to the index as plaintext.
- Live reload of external edits; a concurrent edit produces a `(conflict ...)` copy instead of overwriting anything.
- Global hotkey (default `CommandOrControl+Shift+Space`) to bring velo up; configurable in settings.

## Keyboard shortcuts

`Mod` is ⌘ on macOS and Ctrl on Windows/Linux.

| Keys | Action |
| --- | --- |
| Enter (in search) | Open the top/selected match, or create a note titled with the query |
| ↑ / ↓ | Move selection in the results list |
| Mod+J / Mod+K | Move selection down / up (also works from the editor) |
| Mod+L | Focus the search box |
| Esc (in editor) | Back to the search box |
| Mod+R | Rename current note (also: double-click the title) |
| Mod+Shift+P | Toggle Markdown preview |
| Mod+Shift+E | Lock / unlock current note |
| Mod+Shift+L | Lock all notes |
| Mod+, | Settings |
| Cmd/Ctrl+Shift+Space | Global hotkey (system-wide, configurable) |

## Storage

- Your notes folder is flat: only `*.md`, `*.txt` and `*.md.age` files directly inside it are notes. Subfolders and dotfiles are ignored. New notes are `Title.md`.
- Files are the source of truth. Locked notes are `Title.md.age`.
- `.velo/identity.age` (inside the notes folder) holds your encryption identity, wrapped with your passphrase.
- The search index is a SQLite file (`index-<hash>.sqlite`) in the app's data directory (Tauri app data dir for `dev.velo.app`, e.g. `~/Library/Application Support/dev.velo.app` on macOS), never in the notes folder. It is rebuildable: delete it and velo reindexes on next launch without losing anything. Settings live in the app config dir.

## Encryption

velo generates one age X25519 identity. It is kept in the OS keychain (so locked notes open without a prompt on this machine) and a passphrase-wrapped copy is stored in `.velo/identity.age` (so you can unlock on another machine, or recover). Each locked note is age-encrypted to that identity as `Title.md.age`.

Decrypt outside velo with the [`age` CLI](https://github.com/FiloSottile/age):

```sh
age -d .velo/identity.age > key.txt          # asks for your passphrase
age -d -i key.txt "Note.md.age" > "Note.md"
rm key.txt                                    # key.txt is your plaintext private key: delete it
```

On Linux the keychain needs a Secret Service provider such as gnome-keyring (or KeePassXC) running for automatic unlock; without one, velo asks for the passphrase.

## Unsigned builds

Release builds are not signed or notarized.

- macOS: right-click the app, choose Open, then confirm. Or run `xattr -dr com.apple.quarantine /Applications/velo.app`.
- Windows: on the SmartScreen dialog click "More info", then "Run anyway".

## Development

Requires Node 24, pnpm, and a Rust toolchain (plus [Tauri's platform prerequisites](https://v2.tauri.app/start/prerequisites/)).

```sh
pnpm install
pnpm tauri dev          # run the app
pnpm test               # frontend tests
cd src-tauri && cargo test
pnpm tauri build        # release bundles
```

Performance test (10k notes, release build only):

```sh
node scripts/seed.mjs 10000 fixtures/notes
cd src-tauri && cargo test --release --test perf -- --ignored --nocapture
```

Pushing a `v*` tag runs `.github/workflows/release.yml`, which tests and builds all platforms into a draft GitHub release.

## License

MIT, see [LICENSE](LICENSE).
