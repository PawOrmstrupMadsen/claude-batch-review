import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, beforeEach, describe, it } from "node:test";
import { main, parseState } from "../src/action.js";
import { httpPost, stripThinking, TimeoutError } from "../src/openai.js";
import { actionEnv, completion, noSleep, VERDICT_CHANGES, World } from "./fake.js";

const logs: string[] = [];
console.log = (...a: unknown[]) => void logs.push(a.join(" "));
beforeEach(() => void (logs.length = 0));

const openai = (extra: Record<string, string> = {}) => ({
  backend: "openai",
  "openai-base-url": "http://llm.test:8000/v1/",
  "openai-model": "local",
  mode: "pass",
  "max-wait-minutes": "5",
  ...extra,
});
const answer = (text: string, extra = {}) => () => ({ status: 200, text: JSON.stringify(completion(text, extra)) });
const run = (w: World) => main({ fetch: w.fetch, sleep: noSleep, post: w.post });
const state = (w: World) => parseState(w.comment);

describe("backend openai", () => {
  it("sends one chat completion and posts the review under the answering model's name", async () => {
    const w = new World();
    const out = actionEnv(openai({ "max-wait-minutes": "" }));
    assert.equal(await run(w), 0);
    assert.equal(w.batches.length, 0);
    assert.equal(w.chats.length, 1);
    const c = w.chats[0];
    assert.equal(c.url, "http://llm.test:8000/v1/chat/completions");
    assert.equal(c.headers.authorization, undefined, "no key unless one is given");
    assert.equal(c.timeoutMs > 29 * 60_000, true, "waits about 30 minutes by default");
    const msgs = c.body.messages as { role: string; content: string }[];
    assert.deepEqual(msgs.map((m) => m.role), ["system", "user"]);
    assert.match(msgs[0].content, /House rules\./);
    assert.match(msgs[1].content, /src\/a\.ts/);
    assert.equal(c.body.model, "local");
    assert.match(w.comment, /^<!-- claude-batch-review .*-->\n## Review · `local-model-q4` · head1\n/);
    assert.doesNotMatch(w.comment, /Claude review/);
    assert.match(w.comment, /OpenAI-compatible API · 1 files · 1,500 in \/ 300 out tokens/);
    assert.deepEqual(state(w), { status: "done", verdict: "pass", sha: "head1", model: "local-model-q4" });
    assert.deepEqual(out(), { status: "done", verdict: "pass" });
  });

  it("sends a bearer key only when openai-api-key is set", async () => {
    const w = new World();
    actionEnv(openai({ "openai-api-key": "sk-test" }));
    await run(w);
    assert.equal(w.chats[0].headers.authorization, "Bearer sk-test");
    assert.ok(logs.includes("::add-mask::sk-test"));
  });

  it("fails the gate on ❌ and passes on ⚠️", async () => {
    const w = new World();
    w.chat = answer(VERDICT_CHANGES);
    actionEnv(openai());
    assert.equal(await run(w), 1);
    assert.equal(state(w)?.verdict, "changes");

    const m = new World();
    m.chat = answer("**Verdict:** ⚠️ Minor issues. Fine.");
    actionEnv(openai());
    assert.equal(await run(m), 0);
  });

  it("fails on an answer without a verdict line, after dropping inline thinking", async () => {
    const w = new World();
    w.chat = answer("<think>**Verdict:** ✅</think>Looks fine to me.");
    actionEnv(openai());
    assert.equal(await run(w), 1);
    assert.equal(state(w)?.verdict, "unknown");
    assert.doesNotMatch(w.comment, /<think>/);
  });

  it("notes an answer cut off at max-output-tokens", async () => {
    const w = new World();
    w.chat = answer("**Verdict:** ✅ Looks good.", { choices: [{ message: { content: "**Verdict:** ✅ Looks good." }, finish_reason: "length" }] });
    actionEnv(openai());
    await run(w);
    assert.match(w.comment, /Cut off at `max-output-tokens`/);
  });

  it("fails clearly when the prompt does not fit the context", async () => {
    const w = new World();
    w.chat = () => ({ status: 400, text: JSON.stringify({ error: { code: 400, message: "the request exceeds the available context size", type: "exceed_context_size_error" } }) });
    const out = actionEnv(openai());
    assert.equal(await run(w), 1);
    assert.equal(state(w)?.status, "failed");
    assert.match(w.comment, /No review: the prompt does not fit the model's context .*Lower `max-input-tokens`/);
    assert.equal(out().status, "failed");
  });

  it("fails when the model gives no answer in time", async () => {
    const w = new World();
    w.chat = () => new TimeoutError("no answer within 30 min");
    actionEnv(openai());
    assert.equal(await run(w), 1);
    assert.match(w.comment, /No review: the model gave no answer within 30 min/);
    assert.equal(w.chats.length, 1, "a timeout is not retried");
  });

  it("retries a busy or unreachable endpoint twice", async () => {
    const w = new World();
    w.chat = (n) => (n === 0 ? { status: 503, text: "no server available" } : n === 1 ? Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) : answer("**Verdict:** ✅ Looks good.")());
    actionEnv(openai());
    assert.equal(await run(w), 0);
    assert.equal(w.chats.length, 3);

    const down = new World();
    down.chat = () => Object.assign(new Error("connect"), { code: "ECONNREFUSED" });
    actionEnv(openai());
    assert.equal(await run(down), 1);
    assert.equal(down.chats.length, 3);
    assert.match(down.comment, /could not reach the endpoint: `ECONNREFUSED connect`/);
  });

  it("reuses a stored review and never asks on a label event", async () => {
    const w = new World();
    actionEnv(openai());
    await run(w);
    assert.equal(await run(w), 0);
    assert.equal(w.chats.length, 1);

    const l = new World();
    actionEnv(openai(), { action: "labeled", pull_request: { number: 1 } });
    assert.equal(await run(l), 1);
    assert.equal(l.chats.length, 0);
  });

  it("asks again after a run that died while waiting", async () => {
    const w = new World();
    w.comments.push({ id: 7, body: '<!-- claude-batch-review {"status":"pending","sha":"head1","model":"local"} -->\nx', user: { login: "github-actions[bot]" } });
    actionEnv(openai());
    assert.equal(await run(w), 0);
    assert.equal(w.chats.length, 1);
    assert.equal(w.comments.length, 1, "the sticky comment is rewritten");
  });

  it("sends reasoning_effort only when it is set", async () => {
    const w = new World();
    actionEnv(openai());
    await run(w);
    assert.equal("reasoning_effort" in w.chats[0].body, false);

    const m = new World();
    actionEnv(openai({ "openai-reasoning-effort": "medium" }));
    await run(m);
    assert.equal(m.chats[0].body.reasoning_effort, "medium");
  });

  const thinkingOnly = { status: 200, text: JSON.stringify(completion("", { choices: [{ message: { content: "", reasoning_content: "…" }, finish_reason: "length" }] })) };
  const pass = answer("**Verdict:** ✅ Looks good.");

  it("retries an empty answer once at low, and says so", async () => {
    const w = new World();
    w.chat = (n) => (n === 0 ? thinkingOnly : pass());
    actionEnv(openai({ "openai-reasoning-effort": "medium" }));
    assert.equal(await run(w), 0);
    assert.deepEqual(w.chats.map((c) => c.body.reasoning_effort), ["medium", "low"]);
    assert.equal(state(w)?.verdict, "pass");
    assert.match(w.comment, /retried at reasoning effort low after an empty answer/);
    assert.doesNotMatch(w.comment, /Empty response/);
  });

  it("retries at low when no effort was set, and at low again when it was low", async () => {
    const w = new World();
    w.chat = (n) => (n === 0 ? thinkingOnly : pass());
    actionEnv(openai());
    await run(w);
    assert.deepEqual(w.chats.map((c) => c.body.reasoning_effort), [undefined, "low"]);

    const l = new World();
    l.chat = (n) => (n === 0 ? thinkingOnly : pass());
    actionEnv(openai({ "openai-reasoning-effort": "low" }));
    await run(l);
    assert.deepEqual(l.chats.map((c) => c.body.reasoning_effort), ["low", "low"]);
  });

  it("retries an answer cut off before its verdict, not one cut off after it", async () => {
    const cut = (text: string) => () => ({ status: 200, text: JSON.stringify(completion(text, { choices: [{ message: { content: text }, finish_reason: "length" }] })) });
    const w = new World();
    w.chat = (n) => (n === 0 ? cut("Let me look at the diff first and")() : pass());
    actionEnv(openai());
    assert.equal(await run(w), 0);
    assert.equal(w.chats.length, 2);
    assert.match(w.comment, /after an answer cut off before its verdict/);

    const v = new World();
    v.chat = cut("**Verdict:** ⚠️ Minor issues. Fine.\n\n### Findings\n1. a");
    actionEnv(openai());
    assert.equal(await run(v), 0);
    assert.equal(v.chats.length, 1);
    assert.match(v.comment, /Cut off at `max-output-tokens`/);
  });

  it("retries only once and fails a second empty answer", async () => {
    const w = new World();
    w.chat = () => thinkingOnly;
    actionEnv(openai());
    assert.equal(await run(w), 1);
    assert.equal(w.chats.length, 2);
    assert.equal(state(w)?.verdict, "unknown");
    assert.match(w.comment, /_Empty response\._[\s\S]*retried at reasoning effort low/);
  });

  it("gives the retry only what is left of max-wait-minutes", async () => {
    const w = new World();
    w.chat = (n) => (n === 0 ? thinkingOnly : pass());
    actionEnv(openai({ "max-wait-minutes": "10" }));
    await run(w);
    assert.ok(w.chats[1].timeoutMs <= w.chats[0].timeoutMs);

    const short = new World();
    short.chat = () => thinkingOnly;
    actionEnv(openai({ "max-wait-minutes": "0.5" }));
    await run(short);
    assert.equal(short.chats.length, 1, "no retry with under a minute left");
  });

  it("skips a fork pull request", async () => {
    const w = new World();
    Object.assign(w.pr.base, { repo: { full_name: "o/r" } });
    Object.assign(w.pr.head, { repo: { full_name: "mallory/r" } });
    const out = actionEnv(openai({ mode: "advisory" }));
    assert.equal(await run(w), 0);
    assert.equal(w.chats.length, 0);
    assert.equal(out().status, "skipped");
  });

  it("keeps the key out of the comment when the server echoes it", async () => {
    const w = new World();
    w.chat = () => ({ status: 500, text: "upstream said: Bearer sk-secret" });
    actionEnv(openai({ "openai-api-key": "sk-secret" }));
    assert.equal(await run(w), 1);
    assert.doesNotMatch(w.comment, /sk-secret/);
    assert.match(w.comment, /HTTP 500 upstream said: Bearer \*\*\*/);
  });

  it("does not take a server error that mentions context for an overflow", async () => {
    const w = new World();
    w.chat = () => ({ status: 500, text: "internal error in request context" });
    actionEnv(openai());
    await run(w);
    assert.doesNotMatch(w.comment, /does not fit/);
  });

  it("needs a base URL and a model", async () => {
    actionEnv(openai({ "openai-base-url": "" }));
    assert.equal(await run(new World()), 1);
    actionEnv(openai({ "openai-model": "" }));
    assert.equal(await run(new World()), 1);
  });

  it("rejects an unknown backend", async () => {
    actionEnv({ "api-keys": "k1", backend: "gemini" });
    assert.equal(await run(new World()), 1);
  });
});

describe("stripThinking", () => {
  it("drops thinking before the first </think>", () => {
    assert.equal(stripThinking("<think>a</think>\n\nb"), "b");
    assert.equal(stripThinking("a</think>\n\nb </think> c"), "b </think> c");
  });
  it("keeps a review that mentions </think> after its verdict", () => {
    const review = "**Verdict:** ⚠️ Minor issues. Parses `</think>`.\n\n### Findings\n1. strips text after `</think>`";
    assert.equal(stripThinking(review), review);
  });
  it("leaves plain text alone", () => assert.equal(stripThinking("  b \n"), "b"));
});

describe("httpPost", () => {
  const servers: Server[] = [];
  after(() => servers.forEach((s) => s.close()));
  const serve = async (handler: Parameters<typeof createServer>[1]) => {
    const s = createServer(handler);
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}/v1/chat/completions`;
  };

  it("posts the body and returns status and text", async () => {
    const url = await serve((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => res.writeHead(201).end(`${req.headers.authorization} ${b}`));
    });
    assert.deepEqual(await httpPost(url, { authorization: "Bearer x" }, "{}", 5_000), { status: 201, text: "Bearer x {}" });
  });

  it("gives up with a TimeoutError when no answer comes", async () => {
    const url = await serve(() => {});
    await assert.rejects(httpPost(url, {}, "{}", 50), TimeoutError);
  });
});
