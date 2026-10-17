// The `openai` backend: one synchronous request to an OpenAI-compatible chat completions endpoint.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export type Post = (
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
) => Promise<{ status: number; text: string }>;

export class TimeoutError extends Error {}

/**
 * POST through node:http rather than fetch: fetch (undici) gives up after 5 minutes without response
 * headers, and a server that does not stream sends none until the whole answer is ready.
 */
export const httpPost: Post = (url, headers, body, timeoutMs) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const send = u.protocol === "https:" ? httpsRequest : httpRequest;
    let timer: NodeJS.Timeout | undefined;
    const fail = (e: Error) => {
      clearTimeout(timer);
      reject(e);
    };
    const req = send(u, { method: "POST", headers: { ...headers, "content-length": String(Buffer.byteLength(body)) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", fail);
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
      });
    });
    timer = setTimeout(() => req.destroy(new TimeoutError(`no answer within ${Math.round(timeoutMs / 60_000)} min`)), timeoutMs);
    req.on("error", fail);
    req.end(body);
  });

export interface ChatRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  /** Sent as top-level `reasoning_effort` when set; the server's default otherwise. */
  reasoningEffort?: string;
  timeoutMs: number;
  system: string;
  user: string;
}

export interface ChatAnswer {
  /** The model the server says answered, else the requested one. */
  model: string;
  text: string;
  truncated: boolean;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

export type ChatResult = { ok: true; answer: ChatAnswer } | { ok: false; why: string };

interface Completion {
  model?: string;
  choices?: { message?: { content?: string | { type: string; text?: string }[] | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const RETRIES = 2;
const RETRY_MS = 30_000;

/** Sends the review prompt and returns the answer, or why there is none. Never throws for HTTP or network errors. */
export async function chatReview(post: Post, sleep: (ms: number) => Promise<void>, r: ChatRequest): Promise<ChatResult> {
  // What the server says goes into the PR comment, which no log mask covers: never let it carry the key.
  const scrub = (s: string) => (r.apiKey ? s.split(r.apiKey).join("***") : s);
  const result = await ask(post, sleep, r);
  return result.ok ? result : { ok: false, why: scrub(result.why) };
}

async function ask(post: Post, sleep: (ms: number) => Promise<void>, r: ChatRequest): Promise<ChatResult> {
  const url = `${r.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "claude-batch-review" };
  if (r.apiKey) headers.authorization = `Bearer ${r.apiKey}`;
  // One system message: some chat templates accept a system message only as the first and only one.
  const body = JSON.stringify({
    model: r.model,
    max_tokens: r.maxTokens,
    ...(r.reasoningEffort ? { reasoning_effort: r.reasoningEffort } : {}),
    stream: false,
    messages: [
      { role: "system", content: r.system },
      { role: "user", content: r.user },
    ],
  });
  const start = Date.now();
  const deadline = start + r.timeoutMs;
  for (let attempt = 0; ; attempt++) {
    let res: { status: number; text: string };
    try {
      res = await post(url, headers, body, Math.max(1, deadline - Date.now()));
    } catch (e) {
      if (e instanceof TimeoutError) return { ok: false, why: `the model gave ${e.message}.` };
      const why = `could not reach the endpoint: \`${errorText(e)}\`.`;
      if (attempt < RETRIES && deadline - Date.now() > RETRY_MS) {
        await sleep(RETRY_MS);
        continue;
      }
      return { ok: false, why };
    }
    if (res.status >= 200 && res.status < 300) return parseCompletion(res.text, r.model, Date.now() - start);
    const msg = errorMessage(res.text);
    if ([502, 503, 504].includes(res.status) && attempt < RETRIES && deadline - Date.now() > RETRY_MS) {
      await sleep(RETRY_MS);
      continue;
    }
    if ([400, 413, 422].includes(res.status) && /context|too long|too large/i.test(msg))
      return { ok: false, why: `the prompt does not fit the model's context (HTTP ${res.status}: ${msg}). Lower \`max-input-tokens\`.` };
    return { ok: false, why: `the request failed: HTTP ${res.status} ${msg}` };
  }
}

function parseCompletion(text: string, requested: string, ms: number): ChatResult {
  let c: Completion;
  try {
    c = JSON.parse(text) as Completion;
  } catch {
    return { ok: false, why: `the endpoint answered with something other than JSON: \`${text.slice(0, 200)}\`` };
  }
  const choice = c.choices?.[0];
  if (!choice) return { ok: false, why: "the endpoint answered without a choice." };
  const content = choice.message?.content;
  const raw = typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => p?.text ?? "").join("") : "";
  return {
    ok: true,
    answer: {
      model: c.model || requested,
      text: stripThinking(raw),
      truncated: choice.finish_reason === "length",
      inputTokens: c.usage?.prompt_tokens ?? 0,
      outputTokens: c.usage?.completion_tokens ?? 0,
      ms,
    },
  };
}

/**
 * Reasoning models on some servers put their thinking in the content, ahead of the first `</think>`
 * (with or without the opening tag). A `</think>` after the verdict line is part of the review itself.
 */
export function stripThinking(text: string): string {
  const t = text.trim();
  const end = t.indexOf("</think>");
  if (end < 0) return t;
  const before = t.slice(0, end);
  if (t.startsWith("<think>") || !before.includes("**Verdict:**")) return t.slice(end + "</think>".length).trim();
  return t;
}

function errorMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: string | { message?: string }; message?: string };
    const m = typeof j.error === "string" ? j.error : (j.error?.message ?? j.message);
    if (m) return m.slice(0, 500);
  } catch {
    // not JSON: fall through to the raw text
  }
  return body.slice(0, 500) || "(empty body)";
}

function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const code = (e as { code?: string }).code;
  return code ? `${code} ${e.message}` : e.message;
}
