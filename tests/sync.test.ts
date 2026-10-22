import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { main, parseState } from "../src/action.js";
import { actionEnv, refused, succeeded, VERDICT_PASS, World } from "./fake.js";

const logs: string[] = [];
console.log = (...a: unknown[]) => void logs.push(a.join(" "));
beforeEach(() => void (logs.length = 0));

/** A mocked clock: sleeping moves it, nothing waits for real. */
const realNow = Date.now;
let now = 0;
let onSleep: (() => void) | null = null;
beforeEach(() => {
  now = Date.parse("2026-10-22T10:00:00Z");
  onSleep = null;
  Date.now = () => now;
});
afterEach(() => void (Date.now = realNow));
const sleep = async (ms: number) => {
  now += ms;
  onSleep?.();
};
const MIN = 60_000;

const run = (w: World) => main({ fetch: w.fetch, sleep });
const state = (w: World) => parseState(w.comment);
/** How long a run took on the mocked clock. */
async function timed(w: World): Promise<{ code: number; ms: number }> {
  const t0 = now;
  const code = await run(w);
  return { code, ms: now - t0 };
}
const slow = () => {
  const w = new World();
  w.pollsToEnd = Number.POSITIVE_INFINITY;
  return w;
};

describe("sync-after-minutes", () => {
  it("cancels a batch still queued after 5 minutes and sends the same request directly", async () => {
    const w = slow();
    const out = actionEnv({ "api-keys": "k1", mode: "pass", "max-wait-minutes": "45" });
    const { code, ms } = await timed(w);
    assert.equal(code, 0);
    assert.ok(ms >= 5 * MIN && ms < 5.5 * MIN, `went direct after ${ms} ms`);
    assert.deepEqual(w.cancels, ["msgbatch_1"]);
    assert.equal(w.syncs.length, 1);
    assert.equal(w.syncs[0].key, "k1");
    const { stream, ...params } = w.syncs[0].params;
    assert.equal(stream, true, "the direct request is streamed");
    assert.deepEqual(params, w.batches[0].params);
    assert.deepEqual(state(w), { status: "done", verdict: "pass", sha: "head1", model: "claude-opus-5-5" });
    assert.match(w.comment, /\n## Claude review · `claude-opus-5-5` · head1\n\n\*\*Verdict:\*\* ✅ Looks good/);
    assert.match(w.comment, /<sub>Messages API, synchronous: batch still queued after 5 min · .* \(full price\) · took 0m0s · key 1\/1 · /);
    assert.deepEqual(out(), { status: "done", verdict: "pass" });
    assert.match(out.summary(), /### Review: ✅ Looks good\n\nReviewed by `claude-opus-5-5` through the Messages API directly \(batch still queued after 5 min\)\./);
  });

  it("counts from the submission and takes its minutes from the input", async () => {
    const w = slow();
    actionEnv({ "api-keys": "k1", "max-wait-minutes": "45", "sync-after-minutes": "2" });
    const { ms } = await timed(w);
    assert.ok(ms >= 2 * MIN && ms < 2.5 * MIN, `went direct after ${ms} ms`);
    assert.match(w.comment, /synchronous: batch still queued after 2 min/);
  });

  it("uses the batch's result when the batch ends as the cancel lands", async () => {
    const w = slow();
    w.cancel = "ends";
    actionEnv({ "api-keys": "k1", mode: "pass", "max-wait-minutes": "45" });
    assert.equal(await run(w), 0);
    assert.deepEqual(w.cancels, ["msgbatch_1"]);
    assert.equal(w.syncs.length, 0, "never pays twice");
    assert.match(w.comment, /<sub>Message Batches API · /);
    assert.equal(state(w)?.status, "done");
  });

  it("still goes direct when the batch ended canceled", async () => {
    const w = slow();
    w.cancel = "ends";
    w.result = (b) => (b.canceled ? { type: "canceled" } : succeeded(VERDICT_PASS));
    actionEnv({ "api-keys": "k1", mode: "pass", "max-wait-minutes": "45" });
    assert.equal(await run(w), 0);
    assert.equal(w.syncs.length, 1);
    assert.match(w.comment, /Messages API, synchronous/);
  });

  it("still goes direct when the cancel fails, and logs it", async () => {
    const w = slow();
    w.cancel = "fails";
    actionEnv({ "api-keys": "k1", mode: "pass", "max-wait-minutes": "45" });
    assert.equal(await run(w), 0);
    assert.equal(w.syncs.length, 1);
    assert.ok(logs.some((l) => l.includes("Could not cancel msgbatch_1")));
    assert.equal(state(w)?.status, "done");
  });

  it("never goes direct with 0", async () => {
    const w = slow();
    const out = actionEnv({ "api-keys": "k1", mode: "pass", "max-wait-minutes": "20", "sync-after-minutes": "0" });
    const { code, ms } = await timed(w);
    assert.equal(code, 1);
    assert.ok(ms >= 20 * MIN && ms < 21 * MIN, `waited ${ms} ms`);
    assert.equal(out().status, "pending");
    assert.deepEqual(w.cancels, []);
    assert.equal(w.syncs.length, 0);
    assert.equal(state(w)?.batch, "msgbatch_1");
  });

  it("rejects a negative value", async () => {
    actionEnv({ "api-keys": "k1", mode: "pass", "sync-after-minutes": "-1" });
    assert.equal(await run(new World()), 1);
  });

  it("goes direct at once when a re-run finds a pending batch older than that", async () => {
    const w = slow();
    actionEnv({ "api-keys": "k1", mode: "pass", "max-wait-minutes": "1" });
    assert.equal(await run(w), 1);
    assert.equal(state(w)?.status, "pending");
    assert.equal(w.syncs.length, 0, "the wait ran out before sync-after-minutes");

    now += 10 * MIN;
    actionEnv({ "api-keys": "k1", mode: "pass", "max-wait-minutes": "45" });
    const { code, ms } = await timed(w);
    assert.equal(code, 0);
    assert.equal(ms, 0, "no waiting");
    assert.equal(w.batches.length, 1, "no new batch");
    assert.deepEqual(w.cancels, ["msgbatch_1"]);
    assert.equal(w.syncs.length, 1);
    assert.equal(state(w)?.status, "done");
  });

  it("collects an old pending batch that ended meanwhile instead", async () => {
    const w = slow();
    actionEnv({ "api-keys": "k1", mode: "pass", "max-wait-minutes": "1" });
    await run(w);

    now += 10 * MIN;
    w.pollsToEnd = 0;
    actionEnv({ "api-keys": "k1", mode: "pass", "max-wait-minutes": "45" });
    assert.equal(await run(w), 0);
    assert.deepEqual(w.cancels, []);
    assert.equal(w.syncs.length, 0);
    assert.match(w.comment, /<sub>Message Batches API · /);
  });

  it("moves the direct request to the next key when the batch's key is out of credit", async () => {
    const w = slow();
    w.syncKeys = { k1: "billing" };
    actionEnv({ "api-keys": "k1\nk2", mode: "pass", "max-wait-minutes": "45" });
    assert.equal(await run(w), 0);
    assert.deepEqual(w.batches.map((b) => b.key), ["k1"]);
    assert.deepEqual(w.syncs.map((s) => s.key), ["k1", "k2"]);
    assert.match(w.comment, /· key 2\/2 · /);
  });

  it("moves the direct request to the next key on a rate limit", async () => {
    const w = slow();
    w.syncKeys = { k1: "rate-limit" };
    actionEnv({ "api-keys": "k1\nk2", mode: "pass", "max-wait-minutes": "45" });
    assert.equal(await run(w), 0);
    assert.equal(w.syncs.at(-1)?.key, "k2");
    assert.equal(state(w)?.status, "done");
  });

  it("says so when no key can take the direct request", async () => {
    const w = slow();
    w.syncKeys = { k1: "billing", k2: "auth" };
    actionEnv({ "api-keys": "k1\nk2", mode: "pass", "max-wait-minutes": "45" });
    assert.equal(await run(w), 1);
    assert.equal(state(w)?.status, "failed");
    assert.match(w.comment, /### ⚠️ No review: out of API credit/);
  });

  it("retries a refusal directly on the fallback model", async () => {
    const w = slow();
    w.syncResult = (p) => (p.model === "claude-opus-5-5" ? refused() : succeeded(VERDICT_PASS, { model: "claude-opus-4-8" })).message as Record<string, unknown>;
    actionEnv({ "api-keys": "k1", mode: "pass", "max-wait-minutes": "45" });
    assert.equal(await run(w), 0);
    assert.deepEqual(w.syncs.map((s) => s.params.model), ["claude-opus-5-5", "claude-opus-4-8"]);
    assert.equal(w.batches.length, 1, "no new batch for the retry");
    assert.equal(state(w)?.model, "claude-opus-4-8");
  });

  it("a label run never goes direct, and takes the review run's answer when that run canceled the batch", async () => {
    const w = slow();
    actionEnv({ "api-keys": "k1", mode: "pass", "max-wait-minutes": "1" });
    await run(w);
    now += 10 * MIN;

    // While the label run waits, the review run cancels the batch and posts its direct review.
    const posted = '<!-- claude-batch-review {"status":"done","verdict":"pass","sha":"head1","model":"claude-opus-5-5"} -->\n## Claude review';
    onSleep = () => {
      Object.assign(w.batches[0], { canceled: true, ended: true });
      w.comments[0].body = posted;
    };
    w.result = (b) => (b.canceled ? { type: "canceled" } : succeeded(VERDICT_PASS));
    const out = actionEnv({ "api-keys": "k1", mode: "pass", "max-wait-minutes": "45" }, { action: "labeled", pull_request: { number: 1 } });
    assert.equal(await run(w), 0);
    assert.deepEqual(w.cancels, []);
    assert.equal(w.syncs.length, 0);
    assert.equal(w.comment, posted, "the review run's comment stays");
    assert.ok(logs.some((l) => l.includes("msgbatch_1 was canceled by another run, which reviewed head1")));
    assert.deepEqual(out(), { status: "done", verdict: "pass" });
  });
});
