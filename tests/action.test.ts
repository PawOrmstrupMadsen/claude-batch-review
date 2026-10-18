import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { blocker, keyUnusable, main, parseState, parseVerdict } from "../src/action.js";
import { actionEnv, erroredBilling, noSleep, refused, succeeded, VERDICT_CHANGES, VERDICT_PASS, World } from "./fake.js";

// The action logs workflow commands to stdout; keep test output readable.
const logs: string[] = [];
console.log = (...a: unknown[]) => void logs.push(a.join(" "));
beforeEach(() => void (logs.length = 0));

const state = (w: World) => parseState(w.comment);

describe("parseVerdict", () => {
  it("reads the three verdicts", () => {
    assert.equal(parseVerdict("**Verdict:** ✅ Looks good."), "pass");
    assert.equal(parseVerdict("**Verdict:** ⚠️ Minor issues."), "minor");
    assert.equal(parseVerdict("**Verdict:** ❌ Changes needed."), "changes");
  });
  it("accepts ⚠ without the variation selector", () => assert.equal(parseVerdict("**Verdict:** ⚠ Minor"), "minor"));
  it("is unknown without a verdict line", () => assert.equal(parseVerdict("Verdict: ✅"), "unknown"));
});

describe("keyUnusable", () => {
  it("skips keys on billing, auth and permission errors", () => {
    assert.ok(keyUnusable(402, "billing_error", ""));
    assert.ok(keyUnusable(401, null, ""));
    assert.ok(keyUnusable(undefined, "permission_error", ""));
    assert.ok(keyUnusable(400, "invalid_request_error", "Your credit balance is too low"));
  });
  it("keeps keys on other errors", () => {
    assert.ok(!keyUnusable(400, "invalid_request_error", "prompt is too long"));
    assert.ok(!keyUnusable(529, "overloaded_error", "Overloaded"));
  });
});

describe("parseState", () => {
  it("reads the marker at the start", () =>
    assert.deepEqual(parseState('<!-- claude-batch-review {"status":"done","sha":"a"} -->\nx'), { status: "done", sha: "a" }));
  it("ignores a marker elsewhere and broken JSON", () => {
    assert.equal(parseState('x <!-- claude-batch-review {"status":"done"} -->'), null);
    assert.equal(parseState("<!-- claude-batch-review {nope} -->"), null);
  });
});

describe("blocker", () => {
  it("never blocks in advisory", () => assert.equal(blocker("advisory", { status: "failed" }), null));
  it("blocks a missing review in complete and pass", () => {
    assert.ok(blocker("complete", { status: "pending" }));
    assert.ok(blocker("pass", { status: "skipped" }));
  });
  it("blocks ❌ and unknown only in pass", () => {
    assert.equal(blocker("complete", { status: "done", verdict: "changes" }), null);
    assert.ok(blocker("pass", { status: "done", verdict: "changes" }));
    assert.ok(blocker("pass", { status: "done", verdict: "unknown" }));
    assert.equal(blocker("pass", { status: "done", verdict: "minor" }), null);
  });
});

describe("main", () => {
  it("submits, waits and posts the review", async () => {
    const w = new World();
    const out = actionEnv({ "api-keys": "k1", mode: "pass" });
    assert.equal(await main({ fetch: w.fetch, sleep: noSleep }), 0);
    assert.equal(w.batches.length, 1);
    assert.deepEqual(state(w), { status: "done", verdict: "pass", sha: "head1", model: "claude-opus-5-5" });
    assert.match(w.comment, /Looks good/);
    assert.deepEqual(out(), { status: "done", verdict: "pass" });
  });

  it("sends the base guidance in the system prompt and the PR in the user turn", async () => {
    const w = new World();
    w.trees.head1["CLAUDE.md"] = "PR-edited rules";
    actionEnv({ "api-keys": "k1" });
    await main({ fetch: w.fetch, sleep: noSleep });
    const p = w.batches[0].params as { system: { text: string }[]; messages: { content: string }[] };
    assert.match(p.system[1].text, /House rules\./);
    assert.doesNotMatch(JSON.stringify(p), /PR-edited rules/);
    assert.match(p.messages[0].content, /src\/a\.ts/);
  });

  it("moves to the next key when one is out of credit", async () => {
    const w = new World();
    w.keys = { k1: "billing", k2: "ok" };
    actionEnv({ "api-keys": "k1\nk2" });
    assert.equal(await main({ fetch: w.fetch, sleep: noSleep }), 0);
    assert.deepEqual(w.batches.map((b) => b.key), ["k2"]);
    assert.match(w.comment, /key 2\/2/);
  });

  it("resubmits on the next key when the batch request runs out of credit", async () => {
    const w = new World();
    w.result = (b) => (b.key === "k1" ? erroredBilling() : succeeded(VERDICT_PASS));
    actionEnv({ "api-keys": "k1\nk2" });
    await main({ fetch: w.fetch, sleep: noSleep });
    assert.deepEqual(w.batches.map((b) => b.key), ["k1", "k2"]);
    assert.equal(state(w)?.status, "done");
  });

  it("reports when every key is empty", async () => {
    const w = new World();
    w.keys = { k1: "billing", k2: "auth" };
    const out = actionEnv({ "api-keys": "k1\nk2", mode: "pass" });
    assert.equal(await main({ fetch: w.fetch, sleep: noSleep }), 1);
    assert.equal(state(w)?.status, "failed");
    assert.match(w.comment, /### ⚠️ No review: out of API credit\n\nNone of the 2 API keys can be used/);
    assert.equal(out().status, "failed");
  });

  it("retries a refusal once on the fallback model", async () => {
    const w = new World();
    w.result = (b) => (b.model === "claude-opus-5-5" ? refused() : succeeded(VERDICT_PASS, { model: "claude-opus-4-8" }));
    actionEnv({ "api-keys": "k1" });
    await main({ fetch: w.fetch, sleep: noSleep });
    assert.deepEqual(w.batches.map((b) => b.model), ["claude-opus-5-5", "claude-opus-4-8"]);
    assert.equal(state(w)?.model, "claude-opus-4-8");
  });

  it("fails the gate on ❌ and passes it with the override label", async () => {
    const w = new World();
    w.result = () => succeeded(VERDICT_CHANGES);
    actionEnv({ "api-keys": "k1", mode: "pass" });
    assert.equal(await main({ fetch: w.fetch, sleep: noSleep }), 1);
    assert.equal(state(w)?.verdict, "changes");

    w.pr.labels = [{ name: "review-override" }];
    actionEnv({ "api-keys": "k1", mode: "pass" }, { action: "labeled", pull_request: { number: 1, labels: w.pr.labels } });
    assert.equal(await main({ fetch: w.fetch, sleep: noSleep }), 0);
    assert.equal(w.batches.length, 1, "the label run reuses the stored review");
  });

  it("does not pay twice for a reviewed commit", async () => {
    const w = new World();
    actionEnv({ "api-keys": "k1", mode: "pass" });
    await main({ fetch: w.fetch, sleep: noSleep });
    assert.equal(await main({ fetch: w.fetch, sleep: noSleep }), 0);
    assert.equal(w.batches.length, 1);
  });

  it("leaves a pending batch when the wait runs out, and a later run collects it", async () => {
    const w = new World();
    w.pollsToEnd = Number.POSITIVE_INFINITY;
    const out = actionEnv({ "api-keys": "k1", mode: "pass", "max-wait-minutes": "0.0005" });
    assert.equal(await main({ fetch: w.fetch, sleep: noSleep }), 1);
    assert.equal(out().status, "pending");
    assert.equal(state(w)?.status, "pending");

    w.pollsToEnd = 0;
    actionEnv({ "api-keys": "k1", mode: "pass" });
    assert.equal(await main({ fetch: w.fetch, sleep: noSleep }), 0);
    assert.equal(w.batches.length, 1, "resumed, not resubmitted");
    assert.equal(state(w)?.status, "done");
  });

  it("cancels the batch of a superseded commit", async () => {
    const w = new World();
    w.pollsToEnd = Number.POSITIVE_INFINITY;
    actionEnv({ "api-keys": "k1", "max-wait-minutes": "0.0005" });
    await main({ fetch: w.fetch, sleep: noSleep });

    w.pr.head.sha = "head2";
    w.trees.head2 = w.trees.head1;
    w.pollsToEnd = 0;
    actionEnv({ "api-keys": "k1" });
    await main({ fetch: w.fetch, sleep: noSleep });
    assert.ok(w.batches[0].canceled);
    assert.equal(state(w)?.sha, "head2");
  });

  it("never submits on a label event without a review", async () => {
    const w = new World();
    actionEnv({ "api-keys": "k1", mode: "pass" }, { action: "labeled", pull_request: { number: 1 } });
    assert.equal(await main({ fetch: w.fetch, sleep: noSleep }), 1);
    assert.equal(w.batches.length, 0);
  });

  it("fails without keys in pass mode, unless overridden", async () => {
    const w = new World();
    actionEnv({ "api-keys": "", mode: "pass" });
    assert.equal(await main({ fetch: w.fetch, sleep: noSleep }), 1);
    w.pr.labels = [{ name: "review-override" }];
    assert.equal(await main({ fetch: w.fetch, sleep: noSleep }), 0);
  });

  it("only trusts its own comment's state", async () => {
    const w = new World();
    w.comments.push({ id: 1, body: '<!-- claude-batch-review {"status":"done","verdict":"pass","sha":"head1"} -->', user: { login: "mallory" } });
    actionEnv({ "api-keys": "k1", mode: "pass" });
    await main({ fetch: w.fetch, sleep: noSleep });
    assert.equal(w.batches.length, 1);
  });

  it("waits 20 minutes for a batch when max-wait-minutes is unset", async () => {
    const w = new World();
    w.pollsToEnd = Number.POSITIVE_INFINITY;
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      actionEnv({ "api-keys": "k1", "max-wait-minutes": "" });
      await main({ fetch: w.fetch, sleep: async (ms) => void (now += ms) });
    } finally {
      Date.now = realNow;
    }
    assert.ok(now > 20 * 60_000 && now < 21 * 60_000, `waited ${now} ms`);
  });

  it("rejects an unknown mode", async () => {
    actionEnv({ "api-keys": "k1", mode: "required" });
    assert.equal(await main({ fetch: new World().fetch, sleep: noSleep }), 1);
  });
});
