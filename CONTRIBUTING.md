# Contributing to velo

## Making a change

1. Branch from `main` (`git checkout -b feat/short-name`, or `fix/…`, `docs/…`, `ci/…`). Never commit to `main` directly.
2. Write the failing test first when the change is logic, then the code.
3. Run the quality gate below.
4. **Add a changeset** for anything a user can notice (behaviour, settings, docs that change what the user is told to do): `pnpm changeset`, pick `patch` or `minor`, write one sentence in the past tense from the user's point of view. Commit the generated `.changeset/*.md` with your change.
5. Open a pull request against `main` and get an adversarial review (below). CI must be green.

## Quality gate

Run before every commit that finishes a task and before opening a PR. Report the results as a table (check, status, details).

| # | Check | How |
|---|---|---|
| 1 | Verify | `pnpm exec tsc --noEmit`, `pnpm test`, `cd src-tauri && cargo test` all green; new logic has a test (Vitest next to the module, inline `#[cfg(test)]` in Rust) |
| 2 | App build | when `src-tauri/` or `tauri.conf.json` changed: `pnpm build:app` (or at least `cargo build --release`) |
| 3 | Docs | README reflects new behaviour, settings and shortcuts; comments explain why, not what |
| 4 | Staleness | no orphaned files, no unused dependencies in `package.json` or `Cargo.toml`, no docs pointing at removed code |
| 5 | Capabilities | `src-tauri/capabilities/default.json` grants exactly what the code uses; `opener:allow-open-url` keeps its URL scope |

## Pull requests

- PRs are squash-merged, so the title is in conventional-commit form (`feat: …`, `fix: …`, `docs: …`, `ci: …`); it becomes the commit on `main`.
- Body: `## Summary` (what changed and why, as bullets) and `## Test plan` (checkboxes: what was run, ticked; manual checks still to do after merge or release, unticked).
- Name what was not tested and any risk the reviewer must know.

## Adversarial review

Every PR gets an adversarial review before merge, on top of CI. The reviewer's job is to break the change, not to approve it.

- **Reviewer:** a fresh agent on the most capable model (or a human), read-only, given the diff, the PR body and an **attack list** written for this change: the inputs, races, failure paths, platforms and upgrade paths most likely to break it. It reads the code the diff touches, not only the diff.
- **Findings** need a concrete reproduction (input or sequence → wrong result), proven by a test, a script or exact steps. No reproduction, no finding. Severity: **Critical** (data loss, security, broken release), **Major** (wrong behaviour a user will hit), **Minor** (edge case or polish).
- **Verdict:** FAIL if any Critical or Major finding is open, else PASS. The report goes on the PR as a comment.
- **FAIL:** fix each finding with a regression test, then a scoped re-review of the fixes plus another adversarial round. Add an extra round whenever a fix goes beyond its finding.
- **Strike rule:** two failed rounds is the preferred stop (continue only when the open findings are concrete, reproduced and the fix is small and local); four is the hard maximum, then stop and ask the maintainer.
- Minors may be deferred: list them in the PR with the reason.

## Releases

Versions are managed with [Changesets](https://github.com/changesets/changesets): merging a PR with a changeset makes the bot open (or update) a **Version Packages** PR; merging that PR bumps the version, writes `CHANGELOG.md`, tags `vX.Y.Z` and dispatches `build-release.yml`. Never edit versions or create tags by hand.

Release builds sign the updater artifacts with the key in the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; the public key is in `src-tauri/tauri.conf.json`. Never lose or commit the private key: installed apps only accept updates signed with it.
