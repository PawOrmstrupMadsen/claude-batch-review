# claude-batch-review

A GitHub Action that reviews a pull request with Claude through the
[Message Batches API](https://platform.claude.com/docs/en/build-with-claude/batch-processing), which bills
half the normal token price. It takes a list of API keys and moves on to the next one when a key runs out
of credit, so several prepaid balances can be used up one after the other.

The review is one sticky PR comment (marked `<!-- claude-batch-review … -->`), rewritten on every push.
The `mode` input decides whether it can block a merge:

| `mode` | The job fails when |
|---|---|
| `advisory` (default) | never (only on a crash) |
| `complete` | no review is posted for the head commit: no keys, keys out of credit, an error, or the batch outlived `max-wait-minutes` |
| `pass` | as `complete`, or the verdict is ❌ Changes needed, or the review has no recognisable verdict line |

In `complete` and `pass`, the PR label named by `override-label` (`review-override`) lets any of these through.

The example workflow uses `pass` and names the job **Claude review**; add that name as a required status
check in the repo's ruleset to make it a merge gate. The verdict is stored with the review, so re-running
the job, or adding or removing the override label (the workflow triggers on `labeled`/`unlabeled`), gives the
answer again without a new batch. A new push gets a new review.

## Add it to a repo

1. Copy [`examples/claude-review.yml`](examples/claude-review.yml) to `.github/workflows/claude-review.yml`.
   Replace `<repo-label>` in `runs-on` with the repo's own runner label (never a deploy runner). The job only
   waits on the network, holding the runner for the few minutes a batch takes.
2. Make sure the repo can read the `ANTHROPIC_REVIEW_KEYS` secret (see below).

To retry or collect a batch that outlived the job, re-run the failed **Claude review** job from the PR's checks.
To redo a commit that already has a review: Actions → Claude review → Run workflow → PR number, tick
*force*, then re-run the PR's job (a dispatched run is not attached to the PR's checks).

Inputs (`with:`): `api-keys` (required), `model` (default `claude-opus-5-5`), `effort` (`high`),
`fallback-model` (`claude-opus-4-8`), `max-input-tokens` (`300000`), `max-output-tokens` (`32000`),
`max-wait-minutes` (`20`), `mode` (`advisory`), `override-label` (`review-override`), `prompt-file`, `force`,
`pr`, `github-token`, `comment-author`. Outputs: `status` = `done`, `pending`, `failed` or `skipped`;
`verdict` = `pass`, `minor`, `changes` or `unknown`. Full descriptions are in [`action.yml`](action.yml).

Repo-specific review rules go in `.github/claude-review.md` (or the file named by `prompt-file`).

## Keys

`ANTHROPIC_REVIEW_KEYS` holds one Anthropic API key per line; `#` lines are ignored. The action tries them
in order: a key that answers with `billing_error` (no credit), `authentication_error` or
`permission_error` is skipped, and a batch whose request fails for lack of credit is resubmitted on the
next key. Put the key you want drained first at the top. When every key is empty, the comment says so.

The list lives in `~/.config/claude-review/keys` on the desktop (mode 600). After adding or removing a
key there, push it everywhere with:

```bash
scripts/sync-keys.sh
```

That sets the WhistleSafe organisation secret (visible to all its repos) and a repository secret on every
non-archived personal repo, because personal accounts have no account-wide Actions secrets. Run it again
after creating a new personal repo.

## How it works

1. Reads the PR, its file list and patches through the GitHub API, plus `CLAUDE.md` / `AGENTS.md` (root
   and every directory above a changed file) and `.github/claude-review.md` **from the base commit**. The
   guidance goes into the system prompt and the PR into the user turn, so a PR can neither rewrite nor
   imitate its review rules.
2. Builds one request: guidance, PR text, the diff (largest patches cut first if it would take more than
   60 % of the budget), then the full post-change files with line numbers, smallest first, while they fit
   in `max-input-tokens` (blob sizes come from the head tree; at most 8 fetches at a time). Lock files and
   minified files only show their added/removed line counts. Anything left out, or whose fetch failed, is listed in the
   comment.
3. Submits a one-request batch (adaptive thinking, `effort: high`) and writes a "queued" comment holding
   the batch id, the head SHA and a fingerprint of the key (first 8 hex of its SHA-256, never the key).
4. Polls until the batch ends or `max-wait-minutes` passes. A run that finds a pending batch for the same
   head commit resumes it instead of paying twice; a run for a newer commit cancels the older batch.
5. Posts the review with token counts and the batch cost. If the model declines (`stop_reason:
   refusal`), the request is resubmitted once on `fallback-model`: the server-side `fallbacks` parameter
   is not accepted by the Batches API.

The model sees the PR as untrusted data and has no tools: it cannot run code, open other files or reach
the network. Prompt injection in a diff can still skew the review, and in `pass` mode that includes the
verdict, so the gate is no defence against a hostile contributor: their PRs need a human review.

Two cases pass the gate without a review: PRs opened by bots (the example workflow skips them, and a skipped
required check counts as passed) and, with the override label, fork PRs, which get no secrets. A label
change never submits a new batch: it reuses the head commit's review, waits for a pending one, or, with the
override label, passes at once.

## Cost and timing

A typical PR (30K tokens in, 4K out, thinking included) costs about $0.10 on Opus 5.5 at batch prices
($2 / $10 per million tokens). Batches usually end within minutes (the first one here took 3½), at most 24
hours; re-run the workflow later to collect a batch that outlived the job. On GitHub-hosted runners a
private repo pays Actions minutes for the wait, so callers use self-hosted runners; this public repo's own
jobs run on `ubuntu-latest` for free.

## Development

```bash
npm ci
npm run check   # tsc
npm run build   # bundles src/ into dist/index.js, which is committed
```

CI fails when `dist/` does not match the source. This repo reviews its own PRs with the checked-out
action (`uses: ./`), so a PR exercises its own changes.
