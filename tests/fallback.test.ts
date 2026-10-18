import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { apiDown, keyUnusable, main, parseState } from "../src/action.js";
import { actionEnv, completion, erroredBilling, jobCheck, noSleep, World } from "./fake.js";
import Anthropic from "@anthropic-ai/sdk";

const logs: string[] = [];
console.log = (...a: unknown[]) => void logs.push(a.join(" "));
beforeEach(() => void (logs.length = 0));

const withFallback = (extra: Record<string, string> = {}) => ({
  "api-keys": "k1",
  "fallback-backend": "openai",
  "openai-base-url": "http://llm.test:8000/v1",
  "openai-model": "local",
  mode: "pass",
  ...extra,
});
const run = (w: World) => main({ fetch: w.fetch, sleep: noSleep, post: w.post });
const state = (w: World) => parseState(w.comment);
const errorTitle = () => logs.find((l) => l.startsWith("::error title="));
const check = (w: World) => w.checkRuns.find((c) => c.id === 900)?.output as { title: string; summary: string } | undefined;

describe("keyUnusable and apiDown", () => {
  it("treat spend limits and the spend cap as an unusable key", () => {
    assert.ok(keyUnusable(400, "invalid_request_error", "You have reached your specified API usage limits. You will regain access on 2026-11-01."));
    assert.ok(keyUnusable(400, "invalid_request_error", "You have reached your specified workspace API usage limits."));
    assert.ok(keyUnusable(429, "rate_limit_error", "You have reached your API usage limits: your organization has crossed its monthly API usage threshold"));
    assert.ok(!keyUnusable(429, "rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit"));
  });
  it("calls 429, 5xx and connection errors down, and other 4xx not", () => {
    const err = (status: number) => Anthropic.APIError.generate(status, { type: "error", error: { type: "x", message: "m" } }, "m", new Headers());
    assert.equal(apiDown(err(429)), "the Anthropic API is rate-limited");
    assert.equal(apiDown(err(529)), "the Anthropic API is overloaded");
    assert.equal(apiDown(err(500)), "the Anthropic API failed (HTTP 500)");
    assert.equal(apiDown(new Anthropic.APIConnectionError({ message: "down" })), "the Anthropic API is unreachable");
    assert.equal(apiDown(err(400)), null);
    assert.equal(apiDown(err(413)), null);
    assert.equal(apiDown(new Error("x")), null);
  });
});

describe("fallback-backend", () => {
  it("reviews through the fallback when every key is out of credit, and says so", async () => {
    const w = new World();
    w.keys = { k1: "credit" };
    const out = actionEnv(withFallback());
    assert.equal(await run(w), 0);
    assert.equal(w.batches.length, 0);
    assert.equal(w.chats.length, 1);
    assert.equal(w.chats[0].body.model, "local");
    assert.match(w.comment, /^<!-- claude-batch-review .*-->\n## Review · `local-model-q4` · head1\n\n> ↪️ Fallback review: no Anthropic API key can be used \(out of credit/);
    assert.match(w.comment, /OpenAI-compatible API .* · fallback from the Anthropic API/);
    assert.deepEqual(state(w), { status: "done", verdict: "pass", sha: "head1", model: "local-model-q4" });
    assert.match(out.summary(), /### Review: ✅ Looks good \(fallback: local-model-q4\)\n\nReviewed by `local-model-q4` through the OpenAI-compatible API, the fallback backend: no Anthropic API key/);
  });

  it("falls back on the monthly spend cap's 429 without SDK retries piling up", async () => {
    const w = new World();
    w.keys = { k1: "spend-cap" };
    actionEnv(withFallback());
    assert.equal(await run(w), 0);
    assert.equal(w.creates.k1, 1);
    assert.equal(w.chats.length, 1);
  });

  it("moves to the next key at a spend limit before it falls back", async () => {
    const w = new World();
    w.keys = { k1: "spend-limit", k2: "ok" };
    actionEnv(withFallback({ "api-keys": "k1\nk2" }));
    assert.equal(await run(w), 0);
    assert.deepEqual(w.batches.map((b) => b.key), ["k2"]);
    assert.equal(w.chats.length, 0);
  });

  it("falls back when a rate limit outlasts the SDK's retries", async () => {
    const w = new World();
    w.keys = { k1: "rate-limit" };
    actionEnv(withFallback());
    assert.equal(await run(w), 0);
    assert.equal(w.creates.k1, 5, "the SDK's 4 retries come first");
    assert.equal(w.chats.length, 1);
    assert.match(w.comment, /Fallback review: the Anthropic API is rate-limited/);
  });

  it("tries the next key on a rate limit before it falls back", async () => {
    const w = new World();
    w.keys = { k1: "rate-limit", k2: "ok" };
    actionEnv(withFallback({ "api-keys": "k1\nk2" }));
    assert.equal(await run(w), 0);
    assert.deepEqual(w.batches.map((b) => b.key), ["k2"]);
    assert.equal(w.chats.length, 0);
  });

  it("titles the check of a fallback review with the fallback model", async () => {
    const w = new World();
    jobCheck(w);
    w.keys = { k1: "credit" };
    actionEnv(withFallback());
    assert.equal(await run(w), 0);
    assert.equal(check(w)?.title, "Review: ✅ Looks good (fallback: local-model-q4)");
    assert.match(check(w)?.summary ?? "", /the fallback backend: no Anthropic API key can be used/);
  });

  it("heads a crash in the fallback with the fallback model", async () => {
    const w = new World();
    w.keys = { k1: "credit" };
    w.chat = () => ({ status: 503, text: "busy" });
    actionEnv(withFallback());
    const code = await main({ fetch: w.fetch, post: w.post, sleep: async () => { throw new Error("runner went away"); } });
    assert.equal(code, 1);
    assert.match(w.comment, /\n## Review · `local` · head1\n\n### ⚠️ No review: the job hit an error/);
  });

  it("falls back when the API stays overloaded", async () => {
    const w = new World();
    w.keys = { k1: "overloaded" };
    actionEnv(withFallback());
    assert.equal(await run(w), 0);
    assert.match(w.comment, /Fallback review: the Anthropic API is overloaded/);
  });

  it("falls back when the batch request runs out of credit on every key", async () => {
    const w = new World();
    w.result = () => erroredBilling();
    actionEnv(withFallback());
    assert.equal(await run(w), 0);
    assert.equal(w.batches.length, 1);
    assert.equal(w.chats.length, 1);
  });

  it("does not fall back on a bad request", async () => {
    const w = new World();
    w.keys = { k1: "bad-request" };
    actionEnv(withFallback());
    assert.equal(await run(w), 1);
    assert.equal(w.chats.length, 0);
    assert.match(w.comment, /No review: the job hit an error/);
  });

  it("ends as no review when the fallback fails too", async () => {
    const w = new World();
    jobCheck(w);
    w.keys = { k1: "credit" };
    w.chat = () => ({ status: 200, text: JSON.stringify(completion("")) });
    actionEnv(withFallback({ "max-wait-minutes": "0.5" }));
    assert.equal(await run(w), 1);
    assert.equal(check(w)?.title, "No review: the model gave an empty answer (fallback: local-model-q4)");
    assert.match(w.comment, /Fallback review: .*\n\n### ⚠️ No review: the model gave an empty answer/);
  });

  it("is not used for a fork pull request", async () => {
    const w = new World();
    w.keys = { k1: "credit" };
    Object.assign(w.pr.base, { repo: { full_name: "o/r" } });
    Object.assign(w.pr.head, { repo: { full_name: "mallory/r" } });
    actionEnv(withFallback());
    assert.equal(await run(w), 1);
    assert.equal(w.chats.length, 0);
  });

  it("changes nothing when unset", async () => {
    const w = new World();
    w.keys = { k1: "rate-limit" };
    actionEnv({ "api-keys": "k1", mode: "pass", "openai-base-url": "http://llm.test:8000/v1", "openai-model": "local" });
    assert.equal(await run(w), 1);
    assert.equal(w.chats.length, 0);
    assert.match(errorTitle() ?? "", /^::error title=No review%3A the Anthropic API is rate-limited::/);
  });

  it("needs backend anthropic, the openai inputs and a known name", async () => {
    actionEnv(withFallback({ backend: "openai" }));
    assert.equal(await run(new World()), 1);
    actionEnv(withFallback({ "openai-model": "" }));
    assert.equal(await run(new World()), 1);
    actionEnv(withFallback({ "fallback-backend": "gemini" }));
    assert.equal(await run(new World()), 1);
  });
});

describe("No review", () => {
  it("titles the check, the annotation and the summary: out of API credit", async () => {
    const w = new World();
    jobCheck(w);
    w.keys = { k1: "credit" };
    const out = actionEnv({ "api-keys": "k1", mode: "pass" });
    assert.equal(await run(w), 1);
    assert.equal(check(w)?.title, "No review: out of API credit");
    assert.match(check(w)?.summary ?? "", /Add credit or a key .* To merge anyway, add the `review-override` label\./);
    assert.equal(w.checkRuns.find((c) => c.id === 901)?.output, undefined, "another run's check is left alone");
    assert.match(errorTitle() ?? "", /^::error title=No review%3A out of API credit::No review: out of API credit\. Add credit/);
    assert.match(out.summary(), /^### No review: out of API credit\n\nAdd credit/);
    assert.match(w.comment, /## Claude review · `claude-opus-5-5` · head1\n\n### ⚠️ No review: out of API credit\n\n/);
  });

  it("names the configured override label for an empty answer", async () => {
    const w = new World();
    jobCheck(w);
    w.chat = () => ({ status: 200, text: JSON.stringify(completion("")) });
    actionEnv({
      backend: "openai",
      "openai-base-url": "http://llm.test:8000/v1",
      "openai-model": "local",
      mode: "pass",
      "override-label": "merge-anyway",
      "max-wait-minutes": "0.5",
    });
    assert.equal(await run(w), 1);
    assert.equal(check(w)?.title, "No review: the model gave an empty answer");
    assert.equal(check(w)?.summary, "Re-run with force to redo it. To merge anyway, add the `merge-anyway` label.");
    assert.match(w.comment, /### ⚠️ No review: the model gave an empty answer\n\nRe-run with force to redo it\. To merge anyway, add the `merge-anyway` label\./);
  });

  it("says the answer has no verdict line", async () => {
    const w = new World();
    jobCheck(w);
    w.chat = () => ({ status: 200, text: JSON.stringify(completion("Looks fine to me.")) });
    actionEnv({ backend: "openai", "openai-base-url": "http://llm.test:8000/v1", "openai-model": "local", mode: "pass" });
    assert.equal(await run(w), 1);
    assert.equal(check(w)?.title, "No review: the answer has no verdict line");
  });

  it("still passes with the override label", async () => {
    const w = new World();
    jobCheck(w);
    w.pr.labels = [{ name: "review-override" }];
    w.chat = () => ({ status: 200, text: JSON.stringify(completion("")) });
    actionEnv({ backend: "openai", "openai-base-url": "http://llm.test:8000/v1", "openai-model": "local", mode: "pass", "max-wait-minutes": "0.5" });
    assert.equal(await run(w), 0);
    assert.equal(check(w)?.title, "No review: the model gave an empty answer (overridden by the label)");
    assert.equal(errorTitle(), undefined);
  });

  it("says in the summary that the label overrode it", async () => {
    const w = new World();
    w.pr.labels = [{ name: "review-override" }];
    w.keys = { k1: "credit" };
    const out = actionEnv({ "api-keys": "k1", mode: "pass" });
    assert.equal(await run(w), 0);
    assert.match(out.summary(), /^### No review: out of API credit \(overridden by the label\)\n\nThe `review-override` label lets the pull request through\./);
    assert.doesNotMatch(out.summary(), /To merge anyway/);
  });

  it("does not call a review without a verdict no review in mode complete", async () => {
    const w = new World();
    jobCheck(w);
    w.chat = () => ({ status: 200, text: JSON.stringify(completion("Looks fine to me.")) });
    const out = actionEnv({ backend: "openai", "openai-base-url": "http://llm.test:8000/v1", "openai-model": "local", mode: "complete" });
    assert.equal(await run(w), 0);
    assert.match(out.summary(), /^### Review: no verdict\n/);
    assert.equal(check(w), undefined);
  });

  it("says the batch is still running", async () => {
    const w = new World();
    jobCheck(w);
    w.pollsToEnd = Number.POSITIVE_INFINITY;
    actionEnv({ "api-keys": "k1", mode: "pass", "max-wait-minutes": "0.0005" });
    assert.equal(await run(w), 1);
    assert.match(check(w)?.title ?? "", /^No review: batch still running after 0\.0005 min$/);
    assert.match(check(w)?.summary ?? "", /^Re-run this job to collect it\./);
  });

  it("keeps the gate's answer when the check cannot be titled", async () => {
    const w = new World();
    w.keys = { k1: "credit" };
    actionEnv({ "api-keys": "k1", mode: "pass" });
    assert.equal(await run(w), 1);
    assert.ok(logs.some((l) => l.startsWith("Found no single check run")));
  });
});
