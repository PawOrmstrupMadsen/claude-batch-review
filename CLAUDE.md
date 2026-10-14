# claude-batch-review

Public JavaScript action (node24): PR review through the Anthropic Message Batches API with key rotation.
`README.md` is the manual.

- Callers pin a release (`@<sha> # vX.Y.Z`), so a merge changes nothing until `scripts/release.sh`
  tags it and pins every caller (direct `[skip ci]` commits). Release after merging a change to
  `action.yml` or `src/` (dist/); the script skips releases where neither changed. This repo reviews its own PRs with `uses: ./`, which is the test for a change.
- `dist/index.js` is committed: run `npm run check && npm run build` and commit `dist/` with the source.
- Public repo: no keys, hostnames, LAN details or private repo names in it. Keys live only in the
  `ANTHROPIC_REVIEW_KEYS` secrets and `~/.config/claude-review/keys` on the desktop.
- Keep the model tool-less and the guidance read from the base commit (README, "How it works").
- PRs into `main`, squash-merged, `Closes #N`.
