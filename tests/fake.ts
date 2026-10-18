// In-memory GitHub + Anthropic Batches API, served through an injected fetch.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Json = Record<string, unknown>;

export interface FakeBatch {
  id: string;
  key: string;
  model: string;
  polls: number;
  ended: boolean;
  canceled: boolean;
  params: Json;
}

export const VERDICT_PASS = "**Verdict:** ✅ Looks good. Adds a thing.\n\n### Findings\nNo issues found.";
export const VERDICT_CHANGES = "**Verdict:** ❌ Changes needed. Breaks a thing.\n\n### Findings\n1. **[high]** `a.ts:1` — bug";

export class World {
  pr = {
    number: 1,
    title: "Add a thing",
    body: "Adds a thing.",
    draft: false,
    html_url: "https://github.com/o/r/pull/1",
    user: { login: "paw" },
    labels: [] as { name: string }[],
    base: { sha: "base1", ref: "main" },
    head: { sha: "head1", ref: "feat" },
  };
  files: Json[] = [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-x\n+y" }];
  /** Files per commit SHA. */
  trees: Record<string, Record<string, string>> = {
    base1: { "CLAUDE.md": "House rules.", "src/a.ts": "x\n" },
    head1: { "CLAUDE.md": "House rules.", "src/a.ts": "y\n" },
  };
  comments: { id: number; body: string; user: { login: string } }[] = [];
  /** Paths whose contents request answers 500. */
  failingPaths = new Set<string>();
  batches: FakeBatch[] = [];
  /** Per API key: how batch creation answers. */
  keys: Record<string, "ok" | "billing" | "auth" | "credit" | "spend-limit" | "spend-cap" | "rate-limit" | "overloaded" | "bad-request"> = {};
  /** Batch creation requests per key, retries included. */
  creates: Record<string, number> = {};
  /** This commit's check runs, as the Checks API lists them. */
  checkRuns: { id: number; head_sha: string; status: string; details_url: string; output?: Json }[] = [];
  /** Polls before a batch ends. */
  pollsToEnd = 1;
  /** The batch result for a request; defaults to a passing review. */
  result: (b: FakeBatch) => Json = () => succeeded(VERDICT_PASS);
  /** Chat completion requests the `openai` backend sent. */
  chats: { url: string; headers: Record<string, string>; body: Json; timeoutMs: number }[] = [];
  /** How the chat endpoint answers, per request (0-based); defaults to a passing review. */
  chat: (n: number) => { status: number; text: string } | Error = () => ({ status: 200, text: JSON.stringify(completion(VERDICT_PASS)) });

  post = async (url: string, headers: Record<string, string>, body: string, timeoutMs: number) => {
    this.chats.push({ url, headers, body: JSON.parse(body) as Json, timeoutMs });
    const r = this.chat(this.chats.length - 1);
    if (r instanceof Error) throw r;
    return r;
  };

  get comment() {
    return this.comments[0]?.body ?? "";
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = init?.body ? (JSON.parse(String(init.body)) as Json) : undefined;
    if (url.host === "api.anthropic.com") return this.anthropic(url, method, headers.get("x-api-key") ?? "", body);
    return this.github(url, method, body);
  };

  private anthropic(url: URL, method: string, key: string, body?: Json): Response {
    const p = url.pathname;
    if (method === "POST" && p === "/v1/messages/batches") {
      const mode = this.keys[key] ?? "ok";
      this.creates[key] = (this.creates[key] ?? 0) + 1;
      if (mode === "billing") return error(402, "billing_error", "Your credit balance is too low to access the Anthropic API.");
      if (mode === "auth") return error(401, "authentication_error", "invalid x-api-key");
      if (mode === "credit") return error(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.");
      if (mode === "spend-limit")
        return error(400, "invalid_request_error", "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.");
      // No retry-after: the SDK backs off for seconds; x-should-retry keeps the test fast.
      if (mode === "spend-cap")
        return error(429, "rate_limit_error", "You have reached your API usage limits: your organization has crossed its monthly API usage threshold.", { "x-should-retry": "false" });
      if (mode === "rate-limit") return error(429, "rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit", { "retry-after-ms": "1" });
      if (mode === "overloaded") return error(529, "overloaded_error", "Overloaded", { "retry-after-ms": "1" });
      if (mode === "bad-request") return error(400, "invalid_request_error", "prompt is too long: 250000 tokens > 200000 maximum");
      const req = (body!.requests as Json[])[0];
      const params = req.params as Json;
      const b: FakeBatch = { id: `msgbatch_${this.batches.length + 1}`, key, model: String(params.model), polls: 0, ended: false, canceled: false, params };
      this.batches.push(b);
      return json(batchObject(b));
    }
    let m = /^\/v1\/messages\/batches\/([^/]+)$/.exec(p);
    if (method === "GET" && m) {
      const b = this.batch(m[1]);
      if (++b.polls >= this.pollsToEnd) b.ended = true;
      return json(batchObject(b));
    }
    m = /^\/v1\/messages\/batches\/([^/]+)\/results$/.exec(p);
    if (method === "GET" && m) {
      const b = this.batch(m[1]);
      return new Response(JSON.stringify({ custom_id: "x", result: this.result(b) }) + "\n", { status: 200 });
    }
    m = /^\/v1\/messages\/batches\/([^/]+)\/cancel$/.exec(p);
    if (method === "POST" && m) {
      const b = this.batch(m[1]);
      b.canceled = true;
      return json(batchObject(b));
    }
    return error(404, "not_found_error", `${method} ${p}`);
  }

  private batch(id: string): FakeBatch {
    const b = this.batches.find((x) => x.id === id);
    if (!b) throw new Error(`unknown batch ${id}`);
    return b;
  }

  private github(url: URL, method: string, body?: Json): Response {
    const p = url.pathname.replace(/^\/repos\/o\/r/, "");
    if (method === "GET" && p === "/pulls/1") return json(this.pr);
    if (method === "GET" && p === "/pulls/1/files") return json(this.files);
    let m = /^\/git\/trees\/([^/]+)$/.exec(p);
    if (method === "GET" && m) {
      const files = this.trees[m[1]] ?? {};
      return json({ truncated: false, tree: Object.entries(files).map(([path, c]) => ({ path, type: "blob", size: c.length })) });
    }
    m = /^\/contents\/(.+)$/.exec(p);
    if (method === "GET" && m && this.failingPaths.has(decodeURIComponent(m[1]))) return new Response("boom", { status: 500 });
    if (method === "GET" && m) {
      const content = this.trees[url.searchParams.get("ref") ?? ""]?.[decodeURIComponent(m[1])];
      return content === undefined ? new Response("Not Found", { status: 404 }) : new Response(content, { status: 200 });
    }
    if (method === "GET" && p === "/issues/1/comments") return json(this.comments);
    m = /^\/commits\/([^/]+)\/check-runs$/.exec(p);
    if (method === "GET" && m) {
      const status = url.searchParams.get("status");
      return json({ check_runs: this.checkRuns.filter((c) => c.head_sha === m![1] && (!status || c.status === status)) });
    }
    m = /^\/check-runs\/(\d+)$/.exec(p);
    if (method === "PATCH" && m) {
      const c = this.checkRuns.find((x) => x.id === Number(m![1]));
      if (!c) return new Response("Not Found", { status: 404 });
      c.output = body!.output as Json;
      return json(c);
    }
    if (method === "POST" && p === "/issues/1/comments") {
      const c = { id: this.comments.length + 100, body: String(body!.body), user: { login: "github-actions[bot]" } };
      this.comments.push(c);
      return json(c, 201);
    }
    m = /^\/issues\/comments\/(\d+)$/.exec(p);
    if (method === "PATCH" && m) {
      const c = this.comments.find((x) => x.id === Number(m![1]))!;
      c.body = String(body!.body);
      return json(c);
    }
    return new Response(`no route ${method} ${p}`, { status: 404 });
  }
}

export function succeeded(text: string, extra: Json = {}): Json {
  return {
    type: "succeeded",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_details: null,
      stop_sequence: null,
      usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      ...extra,
    },
  };
}

export function completion(text: string, extra: Json = {}): Json {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "local-model-q4",
    choices: [{ index: 0, message: { role: "assistant", content: text, reasoning_content: "thinking" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1500, completion_tokens: 300, total_tokens: 1800 },
    ...extra,
  };
}

export function refused(): Json {
  return succeeded("", { content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } });
}

export function erroredBilling(): Json {
  return { type: "errored", error: { type: "error", error: { type: "billing_error", message: "Your credit balance is too low" } } };
}

function batchObject(b: FakeBatch): Json {
  return {
    id: b.id,
    type: "message_batch",
    processing_status: b.canceled ? "canceling" : b.ended ? "ended" : "in_progress",
    request_counts: { processing: b.ended ? 0 : 1, succeeded: b.ended ? 1 : 0, errored: 0, canceled: 0, expired: 0 },
    created_at: "2026-10-14T10:00:00Z",
    ended_at: b.ended ? "2026-10-14T10:03:00Z" : null,
    expires_at: "2026-10-15T10:00:00Z",
    cancel_initiated_at: null,
    archived_at: null,
    results_url: b.ended ? `https://api.anthropic.com/v1/messages/batches/${b.id}/results` : null,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function error(status: number, type: string, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Sets the action's inputs and runtime files; returns a reader for the step outputs. */
export function actionEnv(inputs: Record<string, string>, event: Json = { action: "synchronize", pull_request: { number: 1 } }) {
  const dir = mkdtempSync(join(tmpdir(), "cbr-test-"));
  for (const k of Object.keys(process.env)) if (k.startsWith("INPUT_")) delete process.env[k];
  const all: Record<string, string> = { "github-token": "gh", repository: "o/r", pr: "1", "max-wait-minutes": "1", ...inputs };
  for (const [k, v] of Object.entries(all)) process.env[`INPUT_${k.toUpperCase()}`] = v;
  writeFileSync(join(dir, "event.json"), JSON.stringify(event));
  writeFileSync(join(dir, "output"), "");
  writeFileSync(join(dir, "summary"), "");
  process.env.GITHUB_EVENT_PATH = join(dir, "event.json");
  process.env.GITHUB_STEP_SUMMARY = join(dir, "summary");
  process.env.GITHUB_RUN_ID = "77";
  process.env.GITHUB_EVENT_NAME = "pull_request";
  process.env.GITHUB_OUTPUT = join(dir, "output");
  process.env.GITHUB_API_URL = "https://api.github.test";
  const outputs = () =>
    Object.fromEntries(
      readFileSync(join(dir, "output"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split(/=(.*)/s).slice(0, 2) as [string, string]),
    );
  return Object.assign(outputs, { summary: () => readFileSync(join(dir, "summary"), "utf8") });
}

/** The job's own in-progress check run, as GitHub Actions creates it. */
export function jobCheck(w: World, id = 900): void {
  w.checkRuns.push({ id, head_sha: w.pr.head.sha, status: "in_progress", details_url: `https://github.com/o/r/actions/runs/77/job/${id}` });
  w.checkRuns.push({ id: id + 1, head_sha: w.pr.head.sha, status: "in_progress", details_url: `https://github.com/o/r/actions/runs/78/job/${id + 1}` });
}

export const noSleep = async () => {};
