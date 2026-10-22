import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { main, parseState } from "../src/action.js";
import type { Checkout, RunClaude } from "../src/local.js";
import { actionEnv, ROUTER, succeeded, VERDICT_CHANGES, VERDICT_PASS, World } from "./fake.js";

const logs: string[] = [];
console.log = (...a: unknown[]) => void logs.push(a.join(" "));
beforeEach(() => void (logs.length = 0));

/** A mocked clock: sleeping moves it, nothing waits for real. */
const realNow = Date.now;
let now = 0;
beforeEach(() => {
  now = Date.parse("2026-10-22T10:00:00Z");
  Date.now = () => now;
});
afterEach(() => void (Date.now = realNow));
const sleep = async (ms: number) => void (now += ms);

interface ClaudeCall {
  args: string[];
  env: Record<string, string>;
  /** What the reviewer's checkout held when Claude Code started. */
  seen: { claudeMd: boolean; agentsMd: boolean; dotClaude: boolean; code: boolean };
  /** Batches submitted before the local engine started. */
  batches: number;
  /** The appended system prompt. */
  system: string;
}

/** A World plus a fake Claude Code and checkout for the local engine. */
function setup(text = VERDICT_PASS) {
  const w = new World();
  const calls: ClaudeCall[] = [];
  let answer = (): { stdout: string; timedOut?: boolean } => ({
    stdout: `{"type":"system"}\n${JSON.stringify({ type: "result", is_error: false, result: text, num_turns: 7, duration_ms: 125_000 })}\n`,
  });
  const runClaude: RunClaude = async (args, opts) => {
    calls.push({
      args,
      env: opts.env,
      seen: {
        claudeMd: existsSync(join(opts.cwd, "CLAUDE.md")),
        agentsMd: existsSync(join(opts.cwd, "src/AGENTS.md")),
        dotClaude: existsSync(join(opts.cwd, ".claude")),
        code: existsSync(join(opts.cwd, "src/a.ts")),
      },
      batches: w.batches.length,
      system: readFileSync(args[args.indexOf("--append-system-prompt-file") + 1], "utf8"),
    });
    const a = answer();
    return { code: 0, stdout: a.stdout, stderr: "", timedOut: !!a.timedOut };
  };
  const checkouts: string[] = [];
  const checkout: Checkout = async (dir, pr) => {
    checkouts.push(pr.head.sha);
    writeFileSync(join(dir, "CLAUDE.md"), "PR's own rules");
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", "settings.json"), '{"hooks":{}}');
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "AGENTS.md"), "more PR rules");
    writeFileSync(join(dir, "src", "a.ts"), "y\n");
    return pr.head.sha;
  };
  const run = () => main({ fetch: w.fetch, sleep, post: w.post, runClaude, checkout });
  return { w, calls, checkouts, run, answer: (f: typeof answer) => void (answer = f) };
}

const inputs = (extra: Record<string, string> = {}) => ({
  backend: "router",
  "router-url": ROUTER,
  "router-token": "rt",
  mode: "pass",
  "max-wait-minutes": "45",
  ...extra,
});
const big = (w: World) => {
  w.files = [{ filename: "src/a.ts", status: "modified", additions: 200, deletions: 10, patch: "@@ -1 +1 @@\n-x\n+y" }];
};
const state = (w: World) => parseState(w.comment);
const check = (w: World) => w.createdChecks.at(-1) as { name: string; head_sha: string; conclusion: string; output: { title: string } } | undefined;

describe("backend router: the sonnet and opus engines", () => {
  it("sends a larger change to sonnet by batch through the router with the review token", async () => {
    const { w, calls, run } = setup();
    big(w);
    const out = actionEnv(inputs());
    assert.equal(await run(), 0);
    assert.equal(calls.length, 0, "no local engine");
    assert.equal(w.batches.length, 1);
    assert.equal(w.batches[0].key, "rt");
    assert.equal(w.batches[0].model, "claude-sonnet-5-5");
    assert.ok(w.apiHosts.length > 0 && w.apiHosts.every((h) => h === "router.test:8000"), "every call goes through the router");
    assert.deepEqual(state(w), { status: "done", verdict: "pass", sha: "head1", model: "claude-opus-5-5", tier: "sonnet" });
    assert.match(w.comment, /<sub>Tier `sonnet`: 210 changed lines\. Through the LLM router\.<\/sub>/);
    assert.deepEqual(out(), { status: "done", verdict: "pass" });
    assert.deepEqual(
      { name: check(w)?.name, sha: check(w)?.head_sha, conclusion: check(w)?.conclusion, title: check(w)?.output.title },
      { name: "Review", sha: "head1", conclusion: "success", title: "Review: ✅ Looks good" },
    );
    assert.ok(logs.some((l) => l.includes("Asked the router for claude-sonnet-5-5 (tier sonnet); claude-opus-5-5 answered.")), "logs the tier asked for");
  });

  it("names the check after check-name and marks ❌ as failure", async () => {
    const { w, run } = setup();
    big(w);
    w.result = () => succeeded(VERDICT_CHANGES);
    actionEnv(inputs({ "check-name": "Gate" }));
    assert.equal(await run(), 1);
    assert.equal(check(w)?.name, "Gate");
    assert.equal(check(w)?.conclusion, "failure");
    assert.equal(check(w)?.output.title, "Review: ❌ Changes needed");
  });

  it("goes to opus for a security label", async () => {
    const { w, run } = setup();
    w.pr.labels = [{ name: "security" }];
    actionEnv(inputs());
    assert.equal(await run(), 0);
    assert.equal(w.batches[0].model, "claude-opus-5-5");
    assert.equal(state(w)?.tier, "opus");
  });

  it("keeps a floor owner's small change on sonnet", async () => {
    const { w, calls, run } = setup();
    actionEnv(inputs({ "sonnet-floor-owners": "o" }));
    assert.equal(await run(), 0);
    assert.equal(calls.length, 0);
    assert.equal(w.batches[0].model, "claude-sonnet-5-5");
  });

  it("goes direct through the router when the batch is slow", async () => {
    const { w, run } = setup();
    big(w);
    w.pollsToEnd = Number.POSITIVE_INFINITY;
    actionEnv(inputs());
    const t0 = now;
    assert.equal(await run(), 0);
    assert.ok(now - t0 >= 5 * 60_000 && now - t0 < 6 * 60_000, `went direct after ${now - t0} ms`);
    assert.deepEqual(w.cancels, ["msgbatch_1"]);
    assert.equal(w.syncs.length, 1);
    assert.equal(w.syncs[0].key, "rt");
    assert.equal(w.syncs[0].params.model, "claude-sonnet-5-5");
    assert.ok(w.apiHosts.every((h) => h === "router.test:8000"));
    assert.match(w.comment, /Messages API, synchronous: batch still queued after 5 min/);
    assert.equal(state(w)?.tier, "sonnet");
  });

  it("resumes the pending batch of the same commit", async () => {
    const { w, run } = setup();
    big(w);
    w.pollsToEnd = 3;
    actionEnv(inputs({ "max-wait-minutes": "0.01", "sync-after-minutes": "0" }));
    assert.equal(await run(), 1);
    assert.equal(state(w)?.status, "pending");
    assert.equal(state(w)?.tier, "sonnet");
    actionEnv(inputs({ "sync-after-minutes": "0" }));
    assert.equal(await run(), 0);
    assert.equal(w.batches.length, 1, "no second batch");
    assert.equal(state(w)?.status, "done");
  });
});

describe("backend router: the local engine", () => {
  it("reviews a small change with Claude Code over a scrubbed checkout", async () => {
    const { w, calls, checkouts, run } = setup();
    const out = actionEnv(inputs());
    assert.equal(await run(), 0);
    assert.equal(w.batches.length, 0, "nothing goes to Claude");
    assert.deepEqual(checkouts, ["head1"]);
    assert.equal(calls.length, 1);
    const c = calls[0];
    assert.deepEqual(c.seen, { claudeMd: false, agentsMd: false, dotClaude: false, code: true });
    assert.equal(c.args[c.args.indexOf("--allowedTools") + 1], "Read,Glob,Grep");
    assert.ok(c.args.includes("--strict-mcp-config"));
    assert.match(c.args[c.args.indexOf("--settings") + 1], /"deny":\[/);
    assert.equal(c.env.ANTHROPIC_MODEL, "local");
    assert.match(c.env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(!Object.values(c.env).includes("rt"), "the review token never reaches the reviewer");
    assert.ok(!Object.keys(c.env).some((k) => k.startsWith("GITHUB") || k.startsWith("INPUT_")), "an allowlisted environment");
    assert.deepEqual(state(w), { status: "done", verdict: "pass", sha: "head1", model: "local", tier: "local" });
    assert.match(w.comment, /\n## Review · `local` · head1\n\n\*\*Verdict:\*\* ✅ Looks good/);
    assert.match(w.comment, /Claude Code over the checkout, read-only · `local` through the LLM router · 7 turns · took 2m5s/);
    assert.match(w.comment, /Tier `local`: 2 changed lines/);
    assert.deepEqual(out(), { status: "done", verdict: "pass" });
    assert.equal(check(w)?.conclusion, "success");
  });

  it("puts the base guidance in the system prompt file, not in the checkout", async () => {
    const { calls, run } = setup();
    actionEnv(inputs());
    assert.equal(await run(), 0);
    const system = calls[0].system;
    assert.match(system, /<repository_guidance path="CLAUDE.md">\nHouse rules\./);
    assert.match(system, /\*\*Verdict:\*\* one of ✅ Looks good/);
  });

  it("fails without a review when the local model gives none", async () => {
    const { w, run, answer } = setup();
    answer(() => ({ stdout: JSON.stringify({ type: "result", is_error: true, result: "API Error: 503" }) }));
    actionEnv(inputs());
    assert.equal(await run(), 1);
    assert.equal(state(w)?.status, "failed");
    assert.match(w.comment, /### ⚠️ No review: the local review failed/);
    assert.equal(check(w)?.output.title, "No review: the local review failed");
  });

  it("says so when the local review times out", async () => {
    const { w, run, answer } = setup();
    answer(() => ({ stdout: "", timedOut: true }));
    actionEnv(inputs({ "local-timeout-minutes": "30" }));
    assert.equal(await run(), 1);
    assert.match(w.comment, /No review: the local review timed out/);
    assert.match(w.comment, /longer than 30 min/);
  });

  it("never checks out a fork: sonnet reviews it by batch", async () => {
    const { w, calls, checkouts, run } = setup();
    w.pr.head = { ...w.pr.head, repo: { full_name: "mallory/r" } } as typeof w.pr.head;
    w.pr.base = { ...w.pr.base, repo: { full_name: "o/r" } } as typeof w.pr.base;
    actionEnv(inputs());
    assert.equal(await run(), 0);
    assert.equal(calls.length + checkouts.length, 0);
    assert.equal(w.batches[0].model, "claude-sonnet-5-5");
    assert.equal(state(w)?.tier, "sonnet");
    assert.match(w.comment, /a fork pull request is never checked out, so sonnet reviews it instead of the local model/);
  });

  it("never checks out on pull_request_target: sonnet reviews it by batch", async () => {
    const { w, calls, checkouts, run } = setup();
    actionEnv(inputs(), { action: "synchronize", pull_request: { number: 1 } });
    process.env.GITHUB_EVENT_NAME = "pull_request_target";
    assert.equal(await run(), 0);
    assert.equal(calls.length + checkouts.length, 0);
    assert.equal(w.batches[0].model, "claude-sonnet-5-5");
  });

  it("refuses a checkout that is not the pull request's head", async () => {
    const { w, calls, run } = setup();
    const moved: Checkout = async () => "other1";
    actionEnv(inputs());
    assert.equal(await main({ fetch: w.fetch, sleep, post: w.post, runClaude: async () => assert.fail("must not run"), checkout: moved }), 1);
    assert.equal(calls.length, 0);
    assert.match(w.comment, /No review: the pull request moved on/);
  });
});

describe("backend router: rounds", () => {
  const prior = (w: World, s: Record<string, unknown>) =>
    w.comments.push({ id: 7, body: `<!-- claude-batch-review ${JSON.stringify(s)} -->\nold`, user: { login: "github-actions[bot]" } });

  it("keeps the tier an earlier round recorded", async () => {
    const { w, calls, run } = setup();
    prior(w, { status: "done", verdict: "minor", sha: "old1", model: "claude-sonnet-5-5", tier: "sonnet" });
    actionEnv(inputs());
    assert.equal(await run(), 0);
    assert.equal(calls.length, 0);
    assert.equal(w.batches[0].model, "claude-sonnet-5-5");
    assert.match(w.comment, /Tier `sonnet`: the tier of the earlier round/);
  });

  it("chooses again after a round without a review", async () => {
    const { w, calls, run } = setup();
    prior(w, { status: "failed", sha: "old1", tier: "sonnet" });
    actionEnv(inputs());
    assert.equal(await run(), 0);
    assert.equal(calls.length, 1, "the rules send it local");
    assert.equal(state(w)?.tier, "local");
  });

  it("chooses again after a round whose answer had no verdict", async () => {
    const { w, calls, run } = setup();
    prior(w, { status: "done", verdict: "unknown", sha: "old1", tier: "opus" });
    actionEnv(inputs());
    assert.equal(await run(), 0);
    assert.equal(calls.length, 1);
  });

  it("still gives a stored review of the head commit without a new one", async () => {
    const { w, calls, run } = setup();
    prior(w, { status: "done", verdict: "pass", sha: "head1", tier: "local" });
    actionEnv(inputs());
    assert.equal(await run(), 0);
    assert.equal(calls.length + w.batches.length, 0);
  });
});

describe("backend router: second opinion", () => {
  it("runs a local pass beside the opus batch, posts both, and the stricter verdict counts", async () => {
    const { w, calls, run } = setup(VERDICT_CHANGES);
    w.pr.labels = [{ name: "needs 2nd opinion" }];
    const out = actionEnv(inputs());
    assert.equal(await run(), 1);
    assert.equal(w.batches.length, 1);
    assert.equal(w.batches[0].model, "claude-opus-5-5");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].batches, 1, "the batch is queued before the local pass starts");
    assert.match(w.comment, /## Claude review · `claude-opus-5-5` · head1\n\n\*\*Verdict:\*\* ✅ Looks good/);
    assert.match(w.comment, /---\n\n## Second opinion · `local` · head1\n\n\*\*Verdict:\*\* ❌ Changes needed/);
    assert.match(w.comment, /Tier `opus` and a local pass: the `needs 2nd opinion` label/);
    assert.deepEqual(state(w), { status: "done", verdict: "changes", sha: "head1", model: "claude-opus-5-5", tier: "opus" });
    assert.deepEqual(out(), { status: "done", verdict: "changes" });
    assert.equal(check(w)?.conclusion, "failure");
    assert.equal(check(w)?.output.title, "Review: ❌ Changes needed");
  });

  it("passes when both passes pass", async () => {
    const { w, run } = setup(VERDICT_PASS);
    w.pr.labels = [{ name: "needs 2nd opinion" }];
    actionEnv(inputs());
    assert.equal(await run(), 0);
    assert.equal(state(w)?.verdict, "pass");
  });

  it("counts a local pass without a review as no verdict", async () => {
    const { w, run, answer } = setup();
    answer(() => ({ stdout: "" }));
    w.pr.labels = [{ name: "needs 2nd opinion" }];
    const out = actionEnv(inputs());
    assert.equal(await run(), 1);
    assert.match(w.comment, /## Second opinion · `local` · head1\n\n### ⚠️ No review: the local pass gave no review \(the local model gave no answer\)/);
    assert.equal(state(w)?.verdict, "unknown");
    assert.deepEqual(out(), { status: "done", verdict: "unknown" });
    assert.equal(check(w)?.output.title, "No review: the local pass gave no review (the local model gave no answer)");
  });

  it("runs only the Claude pass where no checkout is allowed", async () => {
    const { w, calls, run } = setup();
    w.pr.labels = [{ name: "needs 2nd opinion" }];
    actionEnv(inputs());
    process.env.GITHUB_EVENT_NAME = "pull_request_target";
    assert.equal(await run(), 0);
    assert.equal(calls.length, 0);
    assert.equal(w.batches[0].model, "claude-opus-5-5");
    assert.doesNotMatch(w.comment, /Second opinion/);
  });

  it("a label run leaves the pending batch to the review run", async () => {
    const { w, calls, run } = setup();
    w.pr.labels = [{ name: "needs 2nd opinion" }];
    w.comments.push({
      id: 7,
      body: '<!-- claude-batch-review {"status":"pending","sha":"head1","batch":"msgbatch_9","key":"x","model":"claude-opus-5-5","tier":"opus"} -->\nq',
      user: { login: "github-actions[bot]" },
    });
    actionEnv(inputs(), { action: "labeled", pull_request: { number: 1 } });
    assert.equal(await run(), 1);
    assert.equal(calls.length + w.batches.length, 0);
    assert.equal(w.createdChecks.length, 0, "it leaves the check to the review run");
  });
});

describe("backend router: the gateway's refusals", () => {
  it("401: the review token is not set up", async () => {
    const { w, run } = setup();
    big(w);
    const out = actionEnv(inputs({ "router-token": "wrong" }));
    assert.equal(await run(), 1);
    assert.equal(w.batches.length, 0);
    assert.match(w.comment, /### ⚠️ No review: the review token is not set up/);
    assert.match(w.comment, /Set the `router-token` input/);
    assert.equal(out().status, "failed");
    assert.equal(check(w)?.output.title, "No review: the review token is not set up");
    assert.ok(!w.comment.includes("wrong"), "the token is never quoted");
  });

  it("an empty token: the review token is not set up", async () => {
    const { w, run } = setup();
    actionEnv(inputs({ "router-token": "" }));
    assert.equal(await run(), 1);
    assert.equal(w.apiHosts.length, 0);
    assert.equal(check(w)?.output.title, "No review: the review token is not set up");
  });

  it("403 over budget: the local model reviews instead, and the comment says so", async () => {
    const { w, calls, run } = setup();
    big(w);
    w.keys.rt = "over-budget";
    actionEnv(inputs());
    assert.equal(await run(), 0);
    assert.equal(w.creates.rt, 1, "a 403 is not retried");
    assert.equal(calls.length, 1);
    assert.match(w.comment, /## Review · `local` · head1\n\n> ↪️ The review budget is used up for now, so the local model reviewed this instead of Claude\./);
    assert.deepEqual(state(w), { status: "done", verdict: "pass", sha: "head1", model: "local", tier: "sonnet" });
  });

  it("403 over budget where no checkout is allowed: no review", async () => {
    const { w, calls, run } = setup();
    big(w);
    w.keys.rt = "over-budget";
    actionEnv(inputs());
    process.env.GITHUB_EVENT_NAME = "pull_request_target";
    assert.equal(await run(), 1);
    assert.equal(calls.length, 0);
    assert.match(w.comment, /No review: over the review budget/);
  });

  it("403 over budget with a second opinion: the local model reviews alone", async () => {
    const { w, calls, run } = setup();
    w.pr.labels = [{ name: "needs 2nd opinion" }];
    w.keys.rt = "over-budget";
    actionEnv(inputs());
    assert.equal(await run(), 0);
    assert.equal(calls.length, 1, "the local pass runs once");
    assert.match(w.comment, /## Review · `local` · head1\n\n> ↪️ The review budget is used up for now, so the local model reviewed this instead of Claude\./);
    assert.equal(state(w)?.verdict, "pass");
  });
});

describe("backend router: authors", () => {
  it("passes a bot's pull request without a review, with a neutral check", async () => {
    const { w, calls, run } = setup();
    w.pr.user = { login: "renovate[bot]", type: "Bot" };
    w.pr.title = "Update dependency esbuild to v0.29.1";
    const out = actionEnv(inputs());
    assert.equal(await run(), 0);
    assert.equal(calls.length + w.batches.length + w.comments.length, 0);
    assert.equal(out().status, "skipped");
    assert.deepEqual({ conclusion: check(w)?.conclusion, title: check(w)?.output.title }, { conclusion: "neutral", title: "Not reviewed: a pull request by renovate[bot]" });
  });

  it("reviews Renovate's major updates on opus", async () => {
    const { w, run } = setup();
    w.pr.user = { login: "renovate[bot]", type: "Bot" };
    w.pr.title = "Update dependency esbuild to v1";
    actionEnv(inputs());
    assert.equal(await run(), 0);
    assert.equal(w.batches[0].model, "claude-opus-5-5");
    assert.match(w.comment, /Tier `opus`: a Renovate major update/);
  });

  it("reviews a listed agent's pull requests on opus", async () => {
    const { w, calls, run } = setup();
    w.pr.user = { login: "coding-agent", type: "User" };
    actionEnv(inputs({ "opus-authors": "someone, coding-agent" }));
    assert.equal(await run(), 0);
    assert.equal(calls.length, 0);
    assert.equal(w.batches[0].model, "claude-opus-5-5");
  });

  it("says when the gateway's own key is out of credit", async () => {
    const { w, run } = setup();
    big(w);
    w.keys.rt = "credit";
    actionEnv(inputs());
    assert.equal(await run(), 1);
    assert.match(w.comment, /No review: out of API credit/);
    assert.match(w.comment, /Add credit to the gateway's key/);
  });
});

describe("backend router: the gate's edges", () => {
  it("403 over budget for a floor owner: no review, never the local model", async () => {
    const { w, calls, run } = setup();
    big(w);
    w.keys.rt = "over-budget";
    actionEnv(inputs({ "sonnet-floor-owners": "o" }));
    assert.equal(await run(), 1);
    assert.equal(calls.length, 0);
    assert.match(w.comment, /No review: over the review budget/);
    assert.equal(check(w)?.conclusion, "failure");
  });

  it("the override label passes the check, and removing it turns the check red again", async () => {
    const { w, calls, run } = setup();
    w.pr.labels = [{ name: "review-override" }];
    actionEnv(inputs(), { action: "labeled", pull_request: { number: 1 } });
    assert.equal(await run(), 0);
    assert.equal(calls.length, 0);
    assert.equal(check(w)?.conclusion, "success");
    w.pr.labels = [];
    actionEnv(inputs(), { action: "unlabeled", pull_request: { number: 1 } });
    assert.equal(await run(), 1);
    assert.equal(w.createdChecks.length, 2);
    assert.equal(check(w)?.conclusion, "failure");
  });

  it("a label run that crashes writes no check", async () => {
    const { w, run } = setup();
    actionEnv(inputs(), { action: "labeled", pull_request: { number: 1, head: { sha: "head1" } } });
    w.comments = null as unknown as typeof w.comments;
    assert.equal(await run(), 1);
    assert.ok(logs.some((l) => l.startsWith("::error title=No review: the job hit an error")), "it crashed");
    assert.equal(w.createdChecks.length, 0);
  });

  it("a dispatched run that crashes reports on the head commit it read", async () => {
    const { w, run } = setup();
    actionEnv(inputs(), {});
    process.env.GITHUB_EVENT_NAME = "workflow_dispatch";
    w.comments = null as unknown as typeof w.comments;
    assert.equal(await run(), 1);
    assert.equal(check(w)?.output.title, "No review: the job hit an error");
    assert.equal(check(w)?.head_sha, "head1");
    assert.equal(check(w)?.conclusion, "failure");
  });
});

describe("backend router: inputs", () => {
  it("needs router-url", async () => {
    const { run } = setup();
    actionEnv(inputs({ "router-url": "" }));
    assert.equal(await run(), 1);
    assert.ok(logs.some((l) => l.includes("backend router needs the `router-url` input")));
  });
  it("rejects an unknown tier", async () => {
    const { run } = setup();
    actionEnv(inputs({ tier: "haiku" }));
    assert.equal(await run(), 1);
    assert.ok(logs.some((l) => l.includes("Input tier must be auto, local, sonnet or opus")));
  });
  it("forces a tier", async () => {
    const { w, calls, run } = setup();
    actionEnv(inputs({ tier: "opus" }));
    assert.equal(await run(), 0);
    assert.equal(calls.length, 0);
    assert.equal(w.batches[0].model, "claude-opus-5-5");
  });
});
