# velo

@AGENTS.md
@CONTRIBUTING.md

## Workflow rules for Claude

- Never commit to `main`: work on a feature branch and open a PR.
- Before a commit that finishes a task, and before a PR: run the quality gate from `CONTRIBUTING.md` and report it as a table.
- PRs: conventional-commit title, body with `## Summary` and `## Test plan`, changeset for user-visible changes, CI green.
- Every PR gets an adversarial review (rules in `CONTRIBUTING.md`) by a fresh agent on the most capable model, with an attack list written for the change. Post each round's report on the PR as a comment. Fix Critical/Major findings with regression tests, then run another round; follow the strike rule.
- When a review guarantees an invariant (for example "the editor stays frozen"), make the attack list enumerate every code path that can break it, not only the ones the diff touches.
- Answer bot reviews (Copilot) on the PR: reply to each comment with the fixing commit or the reason it is deferred.
