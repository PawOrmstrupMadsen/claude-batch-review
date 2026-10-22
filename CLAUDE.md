# claude-batch-review

Public JavaScript action (node24): PR review through the Anthropic Message Batches API with key rotation, or
through an LLM router (`backend: router`: a tier per PR, the local model by read-only Claude Code or Sonnet/Opus by batch).
`README.md` is the manual.

- Callers pin a release (`@<sha> # vX.Y.Z`), so a merge changes nothing until `scripts/release.sh`
  tags it and pins every caller (direct `[skip ci]` commits). Release after merging a change to
  `action.yml` or `src/` (dist/); the script skips releases where neither changed. This repo reviews its own PRs with `uses: ./`, which is the test for a change.
- `dist/index.js` is committed: run `npm run check && npm run build` and commit `dist/` with the source.
- Public repo: no keys, hostnames, LAN details or private repo names in it. Keys live only in the
  `ANTHROPIC_REVIEW_KEYS` secrets and `~/.config/claude-review/keys` on the desktop.
- Keep the one-shot model tool-less, the local engine read-only over a scrubbed checkout that only same-repo
  `pull_request` and `workflow_dispatch` runs make, and the guidance read from the base commit (README, "How it works", "Backend router").
- PRs into `main`, squash-merged, `Closes #N`.
