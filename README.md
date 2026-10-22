# claude-batch-review

A GitHub Action that reviews a pull request with Claude through the
[Message Batches API](https://platform.claude.com/docs/en/build-with-claude/batch-processing), which bills
half the normal token price. It takes a list of API keys and moves on to the next one when a key runs out
of credit, so several prepaid balances can be used up one after the other. With `backend: router` it goes
through an LLM router and its gateway instead, and picks the reviewer per pull request: a local model, Sonnet
or Opus ([Backend router](#backend-router)).

The review is one sticky PR comment (marked `<!-- claude-batch-review … -->`), rewritten on every push.
The `mode` input decides whether it can block a merge:

| `mode` | The job fails when |
|---|---|
| `advisory` (default) | never (only on a crash) |
| `complete` | no review is posted for the head commit: no keys, keys out of credit, an error, or the batch outlived `max-wait-minutes` |
| `pass` | as `complete`, or the verdict is ❌ Changes needed, or the review has no recognisable verdict line |

In `complete` and `pass`, the PR label named by `override-label` (`review-override`) lets any of these through.
A run that finds the label already set submits and waits for nothing (unless *force*): it reuses a stored
review of the head commit, or passes at once with the comment and the check saying it was not reviewed
(`No review: skipped for the label (overridden by the label)`). A batch already queued for the commit stays
in the comment's state, so a run after the label is removed collects it.

Without a usable review (no answer, an empty answer, no verdict line, no credit, a batch still running), the
failure reads as one line, for example `No review: out of API credit`, `No review: the model gave an empty
answer` or `No review: batch still running after 45 min`, followed by the way out: re-run the job (with
*force* for a commit that already has an answer), or add the override label, named as configured. The line
heads the error annotation, the job summary and the sticky comment, and becomes the title of the job's own
check run when the workflow grants `checks: write` (the example does), so the PR's checks list shows it.

The example workflow uses `pass` and names the job **Claude review**; add that name as a required status
check in the repo's ruleset to make it a merge gate. The verdict is stored with the review, so re-running
the job, or adding or removing the override label (the workflow triggers on `labeled`/`unlabeled`), gives the
answer again without a new batch. A new push gets a new review.

## Add it to a repo

1. Copy [`examples/claude-review.yml`](examples/claude-review.yml) to `.github/workflows/claude-review.yml`.
   Replace `<repo-label>` in `runs-on` with the repo's own runner label (never a deploy runner). The job only
   waits on the network, holding the runner for the few minutes a batch takes. A public repo uses
   `runs-on: ubuntu-latest` instead: free there, and fork PRs never reach a self-hosted runner.
2. Make sure the repo can read the `ANTHROPIC_REVIEW_KEYS` secret (see below).

To retry or collect a batch that outlived the job, re-run the failed **Claude review** job from the PR's checks.
To redo a commit that already has a review: Actions → Claude review → Run workflow → PR number, tick
*force*, then re-run the PR's job (a dispatched run is not attached to the PR's checks).

A PR opened before the workflow existed has no **Claude review** check, so a required check blocks it. Close and
reopen it (`gh pr close N && gh pr reopen N`) or push to it: either runs the workflow on the PR.

Inputs (`with:`): `backend` (`anthropic`; `openai`, `router`), `api-keys` (backend `anthropic`), `fallback-backend` (empty),
`openai-base-url`, `openai-model`, `openai-reasoning-effort`, `openai-api-key` (backend or fallback `openai`), `model` (default `claude-opus-5-5`), `effort` (`high`),
`fallback-model` (`claude-opus-4-8`), `max-input-tokens` (`300000`), `max-output-tokens` (`32000`),
`max-wait-minutes` (`20`; `30` for `openai`), `sync-after-minutes` (`5`; `0` turns it off), `mode` (`advisory`), `override-label` (`review-override`), `prompt-file`, `force`,
`pr`, `github-token`, `comment-author`, `check-name` (empty; `Review` with backend `router`), and the router's own
inputs ([Backend router](#backend-router)). Outputs: `status` = `done`, `pending`, `failed` or `skipped`;
`verdict` = `pass`, `minor`, `changes` or `unknown`. Full descriptions are in [`action.yml`](action.yml).

Repo-specific review rules go in `.github/claude-review.md` (or the file named by `prompt-file`).

## Slow batches

Batches here usually end in 2 to 4 minutes, but the queue can stall a batch for hours. A batch still
queued `sync-after-minutes` (default 5) after its submission is canceled, and the same request goes to the
Messages API directly, streamed: one review at full price instead of a gate that blocks for hours.

- It uses the key that submitted the batch and moves on to the next key exactly as a submission does (no
  credit, a spend limit, a refused key, a rate limit), falling back as `fallback-backend` says when none can.
- A request the model is already working on still finishes, and is billed, after a cancel. So a batch that
  answers the cancel with `canceling` gets up to 30 s to end: a succeeded result is used and nothing is paid
  twice. A canceled result, or a batch still canceling after that, goes direct. A failed cancel is logged,
  the batch is looked at once more (it may have ended), and the request goes direct.
- The answer is used as a batch result is (verdict, sticky comment, check title, refusal retry on
  `fallback-model`, sent directly too), and the footer reads `Messages API, synchronous: batch still queued
  after 5 min` with the full-price cost.
- A re-run that finds a pending batch older than `sync-after-minutes` collects it when it has ended, and
  otherwise cancels it and goes direct at once. With `max-wait-minutes` below `sync-after-minutes`, the wait
  runs out first and the next run goes direct.
- A label-event run never goes direct: it waits for the batch, and when the review run canceled it, takes
  that run's review from the comment instead of writing over it. A run that reaches `sync-after-minutes`
  after another run of the same commit went direct does the same, so one review is paid once.

`sync-after-minutes: 0` waits for the batch for the whole of `max-wait-minutes`, as before. The direct
request has no time limit of its own beyond the SDK's: allow for one long answer after `sync-after-minutes`
in `timeout-minutes`.

## OpenAI-compatible backend

`backend: openai` sends the same prompt to any OpenAI-compatible chat completions endpoint instead, for
example a self-hosted model server, when the Anthropic keys are out of credit or a repo should not use them:

```yaml
      - uses: PawOrmstrupMadsen/claude-batch-review@<sha> # vX.Y.Z
        with:
          backend: openai
          openai-base-url: http://<model-server>:8000/v1
          openai-model: <model>
          mode: pass
```

- It is one synchronous `POST <base>/chat/completions` (not streamed), waiting up to `max-wait-minutes`
  (default 30) for a server that may be busy with other requests; a 502/503/504 or a refused connection is
  retried twice, 30 s apart. There is no batch, so nothing to resume: a run that died while waiting asks again.
- The guidance and the system prompt go in one system message, the PR in the user turn. Thinking that the
  server returns inside the content (up to `</think>`) is dropped.
- `openai-reasoning-effort` (empty by default: the server decides) is sent as top-level `reasoning_effort`.
  A reasoning model can spend all of `max-output-tokens` thinking: an answer that is empty, or cut off before
  its verdict line, is asked for once more at `low` (at `low` again when that was the setting), within what is
  left of `max-wait-minutes`, and the footer says it was retried.
- The comment reads `## Review · <model>`, naming the model the server reports, never "Claude review"; the
  footer gives the token counts the server reports and how long the answer took.
- Verdict, sticky comment, `mode` and the override label work as with Claude. A prompt larger than the model's
  context fails the job with that error: lower `max-input-tokens` to the model's context minus
  `max-output-tokens`.
- No key is sent unless `openai-api-key` is set (a warning when it goes over plain HTTP), and the key is
  scrubbed from any server error quoted in the comment. Fork PRs are skipped, as with the Anthropic backend
  (where they get no secrets): their token cannot write the comment.

## Fallback backend

`fallback-backend: openai` keeps a required check from blocking every merge while the Anthropic account
cannot serve: the same run reviews through the `openai-*` inputs instead.

```yaml
          api-keys: ${{ secrets.ANTHROPIC_REVIEW_KEYS }}
          fallback-backend: openai
          openai-base-url: http://<model-server>:8000/v1
          openai-model: <model>
```

What falls back, after the key rotation and the SDK's own 4 retries:

| Anthropic API answer | Falls back | Why |
|---|---|---|
| 400 `invalid_request_error` "Your credit balance is too low", 402 `billing_error` | when every key answers so | no credit; re-running does not help |
| 400 `invalid_request_error` "You have reached your specified (workspace) API usage limits" | when every key answers so | a spend limit set in the Console, until it resets |
| 429 `rate_limit_error` "You have reached your API usage limits" (no `retry-after`) | when every key answers so | the tier's monthly spend cap, until the month ends |
| 401 `authentication_error`, 403 `permission_error` | when every key answers so | a revoked or restricted key |
| 429 `rate_limit_error` (a rate limit) | after the remaining keys | rate limits are per organisation, and another key may belong to another one |
| 529 `overloaded_error`, other 5xx, no connection | yes | still failing after the retries; the review would otherwise wait for a manual re-run |
| other 4xx (a request the API rejects) | no | the request itself is wrong: a fallback would hide the bug, and the job fails as before |
| batch request `errored` for lack of credit on every key | yes | as for credit above |
| a refusal whose retry on `fallback-model` finds no key with credit | yes | as for credit above |

The comment then reads `## Review · <model>` with a line saying it is a fallback review and why, the
footer says `fallback from the Anthropic API`, the job summary names the backend, and the check run's title
(with `checks: write`) reads `Review: ✅ Looks good (fallback: <model>)`, so a gate that reads the check
sees it too. A fallback that fails
too ends as no review (`No review: the model gave no answer`, …). Fork PRs never fall back, as the
`openai` backend skips them. Without `fallback-backend` nothing changes. The fallback waits up to
`max-wait-minutes` of its own (default 30) after whatever the batch took, so one job can wait up to
2 × `max-wait-minutes`: with a fallback, set `timeout-minutes` above that (the example's 45 minutes need
`timeout-minutes: 100`).

## Backend router

`backend: router` sends every request through an LLM router (`router-url`) with the gateway's client token for
reviews (`router-token`). The gateway books each review in its ledger against the review client's budget, and
bills the key the token belongs to. The action picks a **tier** per pull request, then runs the engine for it:

| Tier | Engine |
|---|---|
| `local` | Claude Code, read-only (Read, Glob and Grep), over a checkout of the pull request's head, with the router's local model (`local-model`, default `local`) |
| `sonnet`, `opus` | The one-shot review this action always sent (diff plus changed files, no tools), as a batch through the router's `/v1/messages/batches`, model `sonnet-model` or `opus-model` (`claude-sonnet-5-5`, `claude-opus-5-5`). [Slow batches](#slow-batches) go to the router's `/v1/messages` |

### Tier rules

With `tier: auto` (the default), the first rule that matches decides:

1. The `second-opinion-label` (`needs 2nd opinion`): `opus`, plus a local pass ([Second opinion](#second-opinion)).
2. A label in `opus-labels` (`security`): `opus`.
3. An author in `opus-authors` (a coding agent's machine user, say), or Renovate on a major update (its
   `major` label or branch, `(major)` in the title, or a title ending "to v5"): `opus`.
4. A later round on the same pull request keeps the tier its sticky comment recorded, unless that round
   produced no review (failed, or an answer without a verdict line).
5. Docs only (every changed path under `docs/` or `changelog.d/`, or `*.md`), or at most `local-max-lines`
   (150) changed lines: `local`.
6. Anything else: `sonnet`.

A repository whose owner is in `sonnet-floor-owners` (`WhistleSafe`) never gets less than `sonnet`, whatever
the rule or the `tier` input. `tier: local`, `sonnet` or `opus` skips the rules and runs that one tier. Labels
match without case. The gateway's own `auto` is not asked yet: the rules come first, a sorter later.

Only a `pull_request` or `workflow_dispatch` run of a branch in the same repository checks code out. A fork's
pull request, or any `pull_request_target` run, gets `sonnet` instead of `local`, which reads the pull request
through the API only.

### The local engine

- The action fetches `refs/pull/<n>/head` shallowly into a temporary folder (the GitHub token travels in the
  environment, never on a command line) and refuses a checkout that is not the head commit it reviews.
- The pull request may not configure its reviewer: `.claude/`, `.mcp.json`, every `CLAUDE.md`,
  `CLAUDE.local.md` and `AGENTS.md`, and every symbolic link are deleted. The base commit's guidance (as for
  Claude, [How it works](#how-it-works)) goes into the system prompt, with the same answer shape and verdict line.
- Claude Code (`claude-code-version`, installed into the runner's home when missing) runs with an allowlisted
  environment (no GitHub or Actions tokens, and never the review token), a scratch `HOME`, no MCP servers,
  Read, Glob and Grep only, and Read denied for the runner's credentials, temp and the system folders. A small
  relay on 127.0.0.1 reshapes its requests for strict chat templates.
- It may take `local-timeout-minutes` (60), queue waits at the router included. The runner needs `git`,
  `curl` and `bash`, and must reach the router.

### Second opinion

The `needs 2nd opinion` label gets both engines: the Opus batch is queued first, the local pass runs while
it waits, and the sticky comment holds the Claude review with the local pass below it. The stricter verdict
counts (❌ over no verdict over ⚠️ over ✅), so a local pass without a review blocks in `pass` mode too. A
label-event run never collects such a batch; the review run does. A label added after a commit's review takes
effect at the next push, or a re-run with *force*.

### The check and the gateway's answers

- The verdict becomes a completed check run named `check-name` (`Review`) on the pull request's head:
  `success` on ✅, ⚠️ or the override label, `failure` on ❌ or no review. Rulesets require that check, so the
  job itself can have any other name, and a `pull_request_target` run still reports on the head commit.
- A bot's pull request (author type `Bot`) is not reviewed, except Renovate's major updates and `opus-authors`:
  the check is `neutral`, which passes a required check as a skipped job does. Drafts stay with the workflow's
  `if:`.
- `401` from the gateway: `No review: the review token is not set up`, as is an empty `router-token`.
- `403` on a batch (the review client is over its budget): the local model reviews instead, and the comment
  says so; where no checkout is allowed, `No review: over the review budget`. The next round tries Claude again.
- On `/v1/messages` the gateway steps a client that is ahead of its pace down a tier without saying so: the
  log names the tier asked for and the model that answered, and the comment's heading names that model.
- A refusal is retried once on the other Claude tier (the gateway allows only its tiers' models).
  `fallback-backend` does not apply.

The comment ends with the tier and the rule that chose it, and its state keeps the tier for the next round.

### Moving a repository to the router

The workflow (on a self-hosted runner that reaches the router; `vars.LLM_ROUTER_URL` and
`secrets.LLM_REVIEW_TOKEN` are the repository's own variable and secret):

```yaml
name: Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, labeled, unlabeled]
  workflow_dispatch:
    inputs:
      pr: { description: Pull request number, required: true, type: number }
      force: { description: Re-review a commit that already has a review, type: boolean, default: false }

concurrency:
  group: review-${{ github.event.pull_request.number || inputs.pr }}-${{ contains(github.event.action, 'labeled') && 'label' || 'review' }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write
  checks: write

jobs:
  review:
    # Not "Review": the action writes the check of that name itself.
    name: llm-review
    # Bots are left to the action, which reviews Renovate's major updates.
    if: github.event_name == 'workflow_dispatch' || github.event.pull_request.draft == false
    runs-on: [self-hosted, linux, x64, <repo-label>]
    # A second opinion: up to local-timeout-minutes of local pass, then the rest of the batch.
    timeout-minutes: 120
    steps:
      - uses: PawOrmstrupMadsen/claude-batch-review@<sha> # vX.Y.Z
        with:
          backend: router
          router-url: ${{ vars.LLM_ROUTER_URL }}
          router-token: ${{ secrets.LLM_REVIEW_TOKEN }}
          pr: ${{ github.event.pull_request.number || inputs.pr }}
          force: ${{ inputs.force || false }}
          mode: pass
          max-wait-minutes: 45
          # opus-authors: <agent-login>
```

Then switch the ruleset's required check from `Claude review` to `Review`, and drop
`ANTHROPIC_REVIEW_KEYS` from the repository once nothing else reads it.

## Releases and pinning

Callers pin a release by commit SHA: `uses: PawOrmstrupMadsen/claude-batch-review@<sha> # vX.Y.Z`. A merge to
`main` reaches nobody until it is released:

```bash
scripts/release.sh            # patch; or minor / major
```

It releases only when `action.yml` or `dist/` changed since the last tag (what callers actually run; CI keeps
`dist/` in step with `src/`), so docs, scripts and tests alone release nothing; `FORCE=1` overrides that. It
tags the next version on `origin/main`, creates the GitHub release and runs
`scripts/pin-callers.sh <tag>`, which rewrites the pin in every non-archived repo of the personal account and
the WhistleSafe org that has `.github/workflows/claude-review.yml`, and in `examples/claude-review.yml`. Each
bump is one commit on the repo's default branch with `[skip ci]`: no review, no deploy. The rulesets'
admin bypass lets it through; a repo whose ruleset has no bypass (hearth) gets the bump as a PR instead. A new repo picks up the pin from the example; `pin-callers.sh <tag>` alone
re-pins everything to an existing release.

## Keys

`ANTHROPIC_REVIEW_KEYS` holds one Anthropic API key per line; `#` lines are ignored. The action tries them
in order: a key that answers with `billing_error` (no credit), an empty balance, a spend limit or spend cap,
`authentication_error` or `permission_error` is skipped, and a batch whose request fails for lack of credit is resubmitted on the
next key. A key still rate-limited after the SDK's retries hands the request to the next key. Put the key you want drained first at the top. When every key is empty, the comment says so.

The list lives in `~/.config/claude-review/keys` on the desktop (mode 600). After adding or removing a
key there, push it everywhere with:

```bash
scripts/sync-keys.sh
```

That sets a repository secret on every non-archived repo of the personal account and the WhistleSafe
org: personal accounts have no account-wide Actions secrets, and on GitHub Free an organisation secret does
not reach private repos. Run it again after creating a repo.

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
   head commit resumes it instead of paying twice; a run for a newer commit cancels the older batch. A
   batch still queued after `sync-after-minutes` is canceled and sent directly ([Slow batches](#slow-batches)).
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
npm test        # node:test against an in-memory GitHub + Batches API (tests/fake.ts)
npm run build   # bundles src/ into dist/index.js, which is committed
```

CI fails when `dist/` does not match the source. This repo reviews its own PRs with the checked-out
action (`uses: ./`), so a PR exercises its own changes.
