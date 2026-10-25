# Wails spike: results

Throwaway. Machine: Apple M4 Pro, 48 GB, macOS 27.0 (Darwin 27.0.0), 2026-10-25.

## Wails v2 or v3?

**v2.17.0.** On 2026-10-25 it is the latest *stable* Wails release (GitHub "latest", 2026-10-18).
v3 is still `v3.0.0-beta.34`, marked prerelease, with near-daily beta tags. A beta that changes every day
is a moving target, even for a comparison. Cost of choosing v2: there is no built-in global hotkey or
tray API, so the hotkey comes from `golang.design/x/hotkey`.

## Versions

| Thing | Version |
|---|---|
| Go | 1.27.3 darwin/arm64 |
| Wails CLI + lib | v2.17.0 (`go install github.com/wailsapp/wails/v2/cmd/wails@v2.17.0`) |
| SQLite driver | `modernc.org/sqlite` v1.61.0 (pure Go, no cgo), embedded SQLite 3.54.1 |
| Watcher | `github.com/fsnotify/fsnotify` v1.10.1 (kqueue backend on macOS) |
| Hotkey | `golang.design/x/hotkey` **v0.6.3** (pinned on purpose, see friction) |
| Frontend | Vite 7.3.7, TypeScript 5.9.3, markdown-it 15.0.3, pnpm 12.3.4, node 24.7.0 |
| Xcode | 27.0 (27A266a) |

## Setup steps

```sh
go install github.com/wailsapp/wails/v2/cmd/wails@v2.17.0   # -> ~/go/bin/wails
~/go/bin/wails doctor                                        # all green
cd spikes && ~/go/bin/wails init -n wails -t vanilla-ts      # Vite + plain TS template
cd wails && go get modernc.org/sqlite fsnotify golang.design/x/hotkey@v0.6.3
cd frontend && pnpm add markdown-it && pnpm add -D @types/markdown-it
# wails.json: npm -> pnpm, name/outputfilename -> velo-wails
```

## Friction / errors hit (and fixes)

1. **pnpm 12 blocked esbuild's postinstall** (`ERR_PNPM_IGNORED_BUILDS`). Fix: `frontend/pnpm-workspace.yaml` with
   `allowBuilds: { esbuild: true }`. This comes from pnpm, not Wails. The Tauri spike will likely hit it too.
2. **Hotkey permission trap.** `golang.design/x/hotkey` v0.6.4 (latest) now sends *every* hotkey through a
   CGEventTap. A CGEventTap needs **Accessibility / Input Monitoring permission**, and without it `Register()` fails.
   v0.6.3 still uses Carbon `RegisterEventHotKey` for normal keys, which needs no permission (the Tauri plugin uses
   the same API). Pinned v0.6.3. Risk: we depend on an old version of a library whose author is moving away from
   that API.
3. **Startup race (my bug, but a Wails trap too).** In v2 the page loads *while* `OnStartup` is still running.
   The first `Search("")` arrived before the index existed, and the Go nil-pointer panic showed up only as a log
   line (`ERR | process message error ... nil pointer dereference`). The UI stayed silently empty. Fix: a `ready`
   channel that `Search` waits on.
4. **`wails dev` is about 8x slower on SQLite work.** Cold index took **14.2 s in `wails dev`**, against 1.87 s in a
   release build. Dev/debug builds pass `-gcflags "all=-N -l"` (no optimization, no inlining; see
   `pkg/commands/build/base.go:200`), and modernc's machine-translated C suffers badly from that. Search in dev mode
   is slower by a similar factor (not measured). Judge performance only on `wails build` output. Probably fixable
   by building dev with normal flags; not tried.
5. **kqueue opens one fd per file.** fsnotify on macOS still uses kqueue, so watching the folder kept **10,062 open
   fds** (`lsof`). It works because Go raises the soft fd limit to the hard limit at startup. It is still ugly, and
   on a 100k-note folder it could hit `kern.maxfilesperproc`. A FSEvents-based watcher (e.g.
   `github.com/fsnotify/fsevents`, cgo) would fix this. The Rust `notify` crate uses FSEvents by default.
6. Linker warnings on every build (`ignoring duplicate libraries: '-lobjc'`, `built for newer macOS (13.0) than being
   linked (11.0)`). They are harmless.
7. Template leftovers: the scaffold's `wails.json` uses npm, and the app bundle takes its name from `"name"`, so it
   was `wails.app` until renamed.
8. `wails init` puts the TS bindings in `frontend/wailsjs/` and regenerates them on every dev/build run.
   The generated `models.ts` turns Go structs into TS classes (`main.Hit`). This worked without problems.

modernc + FTS5 + trigram: **works out of the box.** `tokenize='trigram remove_diacritics 1'` is accepted, and
`resume` matches `résumé`. No fallback to mattn/cgo was needed.

## LOC (non-blank, non-comment-only lines)

| File | LOC | What |
|---|---|---|
| `index.go` | 174 | SQLite schema, scan, upsert/sync, search, snippet |
| `app.go` | 78 | Wails-bound methods, startup, watcher wiring, hotkey loop |
| `main.go` | 34 | `wails.Run` options (template boilerplate) + `bench` switch |
| `watcher.go` | 28 | fsnotify loop |
| **Go app total** | **314** | (excludes generated `frontend/wailsjs/**`) |
| `bench.go` | 86 | headless benchmark, not part of the app |
| `frontend/src/main.ts` | 77 | UI + self-test timing (~20 lines of that) |
| `frontend/src/style.css` | 15 | |

Of the 314 Go lines: about 40 are Wails boilerplate (options struct, embed, bind), and 19 are `if err != nil` checks
(~45 lines with their bodies). The rest, about 230, is real logic, mostly SQL strings and the search merge.

## Performance (release build unless noted)

Run `go run . bench` (headless, same `Index`/`Watch` code as the app; raw output in this file below).

### Cold index, 10k notes (scan + read + insert notes + FTS5 trigram, one transaction)
- Headless bench: **1.84 s** (3 runs: 1.836 / 1.836 / 1.836 s)
- Inside the app at startup: **1.86 to 1.89 s** (5 launches)
- In `wails dev` (debug build): 14.2 s

### Backend search latency (23 queries x 20 runs each, limit 100, time measured in Go)
**All queries: p50 3.2 ms, p95 20.2 ms, max 39.9 ms.** Under the 50 ms target, and for most queries far under it.

| Query class | Examples | p50 range |
|---|---|---|
| 1 char (LIKE fallback) | `a`, `z`, `é` | 0.27 to 6.0 ms |
| 2 chars (LIKE fallback) | `de`, `ru`, **`xy` (no match)** | 0.5 to 3.1 ms, **38.8 ms** for `xy` |
| 3 chars (trigram) | `del`, `xra`, `caf`, `bug` | 0.86 to 1.2 ms |
| words (trigram) | `golang`, `kubernetes`, `résumé`, `resume`, `meeting` | 3.2 to 4.7 ms |
| multi-word phrase | `delta xray`, `rust golang`, `naïve november` | 2.8 to 20.1 ms |
| full title | `book delta xray golang 46` | 8.6 ms |
| no match, ≥3 chars | `qqqzzz` | 0.08 ms |

How search works (`index.go` `Search`):
- The query is one case-insensitive substring. Multi-word means a phrase, not AND of words; nvALT does AND,
  which v1 should decide on. Title matches come first, then body matches, each ordered by mtime desc, limit 100.
  It runs two queries and dedups in Go.
- **≥3 chars:** FTS5 `MATCH '{title} : "q"'` and then `'{body} : "q"'` on the trigram table. This is
  diacritic-insensitive.
- **<3 chars:** trigram can't match, so it falls back to `LIKE '%q%'` on the FTS table's columns (a full scan).
  The cost depends on early exit. Common letters fill 100 hits quickly while walking in mtime order (`a`: 0.27 ms).
  A rare or absent 2-char string must scan all 10k bodies (~13 MB): **`xy` = 39 ms, the worst case of the whole
  set.** The LIKE path is ASCII-only case folding and not diacritic-insensitive.
- Multi-word phrases are the slowest trigram case (`naïve november` 20 ms). Their trigrams are common, so FTS
  must verify many candidate rows.
- Snippets for body hits are cut in Go around the first match. That `strings.ToLower` match misses
  diacritic-folded hits, so those fall back to the body start.

### End-to-end keystroke to render (inside the real WKWebView, release build)
Run with `VELO_SELFTEST=1`. The frontend types 7 words character by character (63 keystrokes, including 1- and
2-char prefixes and `xy`). Per keystroke it times: input, Go `Search`, results list rendered, `Body()` fetched,
markdown-it preview rendered. Results go to the Go log.
- **input to DOM updated: p50 6 ms, p95 20 ms, max 42 ms**
- input to after next paint (rAF + setTimeout): p50 17 ms, p95 34 ms, max 49 ms. This includes up to one frame
  of waiting, so it overstates real latency by ~0 to 16 ms.
- WebKit's `performance.now()` is coarse (whole ms here).

### Watcher latency (external change to index updated)
- Headless bench, 10 rounds each, from the write until a search returns the new state: **create p50 26.6 ms
  (max 30), edit p50 1.7 ms (max 8), delete p50 0.8 ms (max 2).**
- In the running app, from a shell (`echo >`, `>>`, `touch`, `rm`; 3 rounds), shell timestamp to log line
  "synced": **create ~27 ms, edit ~2 ms, touch ~3 ms, delete ~3 ms.** The `Sync` itself takes 0.2 to 0.6 ms.
  The app then emits `notes-changed`, and the frontend re-runs the current query, keeping the selection by path.
- Creates are slower because kqueue only reports "directory changed", so fsnotify rescans the 10k-entry
  directory to find the new file. Everything is well under the ~1 s goal.
- No debounce. Every fsnotify event triggers an idempotent stat + upsert/delete.

### Bundle size
- `build/bin/velo-wails.app`: **12 MB** (one 13 MB arm64 Go binary; frontend embedded; not universal, not UPX'd)
- `velo-wails.dmg` (`hdiutil create -format UDZO`): **6.3 MB**
- Release build time: ~11 s first time, ~3 s incremental.

### Idle RAM (release app, idle 30 to 60 s after launch, 10k notes indexed, preview showing)
Helper PIDs were found by diffing WebKit processes before and after launch.

| Process | `footprint` | RSS |
|---|---|---|
| velo-wails (Go + SQLite + WebView host) | 55 MB | 146 MB |
| com.apple.WebKit.WebContent | 39 to 51 MB | 37 MB |
| com.apple.WebKit.GPU | **19 to 134 MB** (fluctuated between samples) | 25 MB |
| com.apple.WebKit.Networking | 6 MB | 11 MB |
| **Sum** | **~120 MB (low GPU sample) to ~245 MB (high GPU sample)** | **~219 MB** |

RSS counts shared system-framework pages, so `footprint` is the fairer number. Compare the Tauri spike using
the same method.

## Global hotkey
- **Registration succeeded:** log line `hotkey registered: Cmd+Shift+Space` on every launch, with v0.6.3 and no
  permission prompt.
- Toggle code: if visible, `runtime.Hide` (app-level hide, like Cmd+H, which returns focus to the previous app);
  otherwise `runtime.Show` + `runtime.WindowShow`.
- **Needs manual verification by the owner. I cannot press keys:**
  1. Does Cmd+Shift+Space fire from another app?
  2. Does the window come to front *and* take keyboard focus?
  3. Does the search field get focus after show? It does not: there is no focus call after show, only
     `autofocus` at first load.
  4. Does Cmd+Shift+Space conflict with anything on your machine (e.g. input-source switching)?
- The `visible` flag is tracked by hand. v2 has no "is window visible" query, so hiding with Cmd+H or the red
  button desyncs it, and one extra press fixes it.
- macOS main-thread note: the library needs a macOS main run loop. Wails already runs one, so no
  `mainthread.Init` is needed and registration works from a goroutine.

## Subjective notes (for a TS developer)

- **The Go parts were easy.** It was the least friction of the stack: `database/sql` + SQL strings + `os`/`filepath`
  read like Node's `fs` plus a query builder. No lifetimes, no borrow checker, no async coloring. Bound methods
  just block, and Wails runs each call on its own goroutine, so `<-a.ready` and slow queries "just work".
- **What a TS dev would trip on:**
  - `if err != nil` everywhere. It is verbose but obvious, and forgetting one is silent: Go doesn't force you to
    handle errors. Several `tx.Exec` results are ignored here.
  - Channels and `select`. Read them as a typed async queue plus `Promise.race`.
  - `defer`.
  - The blank import `_ "modernc.org/sqlite"` registering a driver by side effect.
  - Capitalization = export. This also decides what Wails binds and what JSON includes.
  - Struct tags (`json:"title"`) controlling the TS field names.
  - `[]byte` vs `string`.
  - Implicit interfaces (`execer`).
  - A nil-pointer panic inside a bound method doesn't crash the app. It becomes a log line, and the JS promise
    rejects, which is easy to miss.
- **Wails v2 itself:** small API surface (`runtime.EventsEmit`/`EventsOn`, bind a struct, done). Generated TS types
  are a real plus. Weak spots:
  - No built-in hotkey or tray: you need third-party libraries, and the hotkey one just changed to require a
    permission.
  - kqueue fd-per-file comes from fsnotify, not Wails.
  - Dev builds unoptimized, which badly affects modernc.
  - v3 is in perpetual beta, so you choose between "old stable" and "new beta".

## How to run

```sh
cd /Volumes/Dev/matteo/velo/spikes/wails
~/go/bin/wails dev                   # hot reload; NOTE: debug build, index takes ~14 s
~/go/bin/wails build && open build/bin/velo-wails.app      # release; index ~1.9 s
VELO_SELFTEST=1 build/bin/velo-wails.app/Contents/MacOS/velo-wails   # logs keystroke timings
VELO_LOG_SEARCH=1 ...                # log every backend search time
VELO_NOTES=/some/folder ...          # other notes folder (default: spikes/fixtures/notes)
go run . bench                       # headless: cold index, 23-query latency, watcher latency
```

The index DB is at `~/Library/Application Support/velo-wails-spike/index.db`. It is deleted and rebuilt on every
launch (shortcut: no mtime reconcile, not keyed by folder). The bench uses `$TMPDIR/velo-wails-bench.db`.
`go run . bench` briefly creates and deletes `spikes/fixtures/notes/zz bench watcher.md`.

Not built: note creation (Enter with no exact title match only logs `would create "<query>"`), editing, debounce,
links/tags tables.

## Raw bench output (`go run . bench`, final run)

```
sqlite 3.54.1
cold index: 10000 notes in 1.835835792s
"a"                          hits=100 p50=273.958µs  p95=504.25µs
"z"                          hits=100 p50=6.01275ms  p95=6.19325ms
"é"                          hits=100 p50=1.591167ms p95=1.668667ms
"de"                         hits=100 p50=520.125µs  p95=556.5µs
"ru"                         hits=100 p50=3.073042ms p95=3.225917ms
"xy"                         hits=  0 p50=38.807459ms p95=39.8125ms
"del"                        hits=100 p50=1.2095ms   p95=1.281917ms
"xra"                        hits=100 p50=863.167µs  p95=888.375µs
"caf"                        hits=100 p50=865.5µs    p95=994.75µs
"bug"                        hits=100 p50=1.185917ms p95=1.231125ms
"golang"                     hits=100 p50=3.187ms    p95=3.231583ms
"kubernetes"                 hits=100 p50=4.706291ms p95=4.836417ms
"résumé"                     hits=100 p50=3.348708ms p95=3.607417ms
"resume"                     hits=100 p50=3.325625ms p95=3.427458ms
"meeting"                    hits=100 p50=3.803417ms p95=4.00175ms
"invoice"                    hits=100 p50=4.073625ms p95=4.167ms
"delta xray"                 hits=100 p50=2.8105ms   p95=2.856666ms
"book delta"                 hits=100 p50=2.805042ms p95=2.974125ms
"rust golang"                hits=100 p50=14.015208ms p95=14.308ms
"project uniform"            hits=100 p50=10.819208ms p95=10.994958ms
"naïve november"             hits=100 p50=20.079208ms p95=20.316167ms
"book delta xray golang 46"  hits= 13 p50=8.591583ms p95=8.711583ms
"qqqzzz"                     hits=  0 p50=83.667µs   p95=87.25µs
ALL queries x20: p50=3.193875ms p95=20.248208ms max=39.859625ms
watcher create p50=26.60075ms max=29.89575ms
watcher edit   p50=1.666875ms max=7.984666ms
watcher delete p50=805.833µs max=2.017125ms
```
