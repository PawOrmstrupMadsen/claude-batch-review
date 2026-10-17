import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildContext, type Pull, type ReviewContext } from "./context.js";
import { GitHub, input, log, setOutput } from "./github.js";
import { chatReview, httpPost, type ChatAnswer, type Post } from "./openai.js";
import { SYSTEM_PROMPT } from "./prompt.js";

const MARKER = "<!-- claude-batch-review";
/** GitHub rejects comment bodies over 65,536 characters. */
const MAX_COMMENT_CHARS = 65_000;

/** List price per million tokens (input, output); the Batches API bills half of it. */
const PRICES: Record<string, [number, number]> = {
  "claude-fable-5-1": [10, 50],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};

interface Slot {
  key: string;
  fp: string;
  client: Anthropic;
}

export type Verdict = "pass" | "minor" | "changes" | "unknown";
export type Status = "done" | "pending" | "failed" | "skipped";
export type Mode = "advisory" | "complete" | "pass";
export type Backend = "anthropic" | "openai";

/** Seams for tests: the network and the clock. */
export interface Deps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** The `openai` backend's HTTP POST. */
  post?: Post;
}

interface Settings {
  mode: Mode;
  overrideLabel: string;
  backend: Backend;
  event: PrEvent;
}

export interface State {
  status: "pending" | "done" | "failed";
  verdict?: Verdict;
  sha: string;
  batch?: string;
  key?: string;
  model?: string;
  submitted?: string;
}

interface Job {
  batch: string;
  slot: number;
  model: string;
  submitted: string;
}

interface Comment {
  id: number;
  body: string;
  user: { login: string } | null;
}

export interface Outcome {
  status: Status;
  verdict?: Verdict;
  overridden?: boolean;
}

async function run({ overrideLabel, backend, event }: Settings, deps: Deps): Promise<Outcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const keys = input("api-keys")
    .split(/\r?\n/)
    .map((k) => k.trim())
    .filter((k) => k && !k.startsWith("#"));
  keys.forEach(log.mask);
  const slots: Slot[] = keys.map((key) => ({
    key,
    fp: createHash("sha256").update(key).digest("hex").slice(0, 8),
    client: new Anthropic({ apiKey: key, maxRetries: 4, fetch: deps.fetch }),
  }));

  const [owner, repo] = input("repository", process.env.GITHUB_REPOSITORY ?? "").split("/");
  const gh = new GitHub(input("github-token"), owner, repo, deps.fetch);
  const prNumber = Number(input("pr") || event.pull_request?.number || "");
  if (!prNumber) throw new Error("No pull request number: pass the `pr` input.");
  const pr = await gh.json<Pull>(`/repos/${owner}/${repo}/pulls/${prNumber}`);

  const openai = backend === "openai";
  const cfg = {
    model: openai ? input("openai-model") : input("model", "claude-opus-5-5"),
    fallbackModel: input("fallback-model", "claude-opus-4-8"),
    effort: input("effort", "high") as "low" | "medium" | "high" | "xhigh" | "max",
    maxOutputTokens: num("max-output-tokens", 32000),
    maxInputTokens: num("max-input-tokens", 300000),
    maxWaitMs: num("max-wait-minutes", openai ? 30 : 20) * 60_000,
    promptFile: input("prompt-file"),
    force: input("force") === "true",
  };
  const overridden = pr.labels.some((l) => l.name === overrideLabel);
  const openaiKey = input("openai-api-key");
  if (openaiKey) log.mask(openaiKey);
  const baseUrl = input("openai-base-url");
  if (openai && (!baseUrl || !cfg.model)) throw new Error("backend openai needs the `openai-base-url` and `openai-model` inputs.");
  if (openai && openaiKey && !baseUrl.startsWith("https:"))
    log.warning("openai-api-key goes to a plain-HTTP endpoint: keep that endpoint on a private network.");
  // A fork PR's token cannot write the comment, and its untrusted code should not reach a private endpoint unasked.
  if (openai && pr.head.repo?.full_name !== pr.base.repo?.full_name) {
    log.notice("Fork pull request: the openai backend skips it.");
    return { status: "skipped", overridden };
  }
  if (!openai && keys.length === 0) {
    log.notice("No API keys (secret unset, or a fork PR without secrets): skipping the review.");
    return { status: "skipped", overridden };
  }

  const sha7 = pr.head.sha.slice(0, 7);

  let comment = await findComment(gh, prNumber, input("comment-author", "github-actions[bot]"));
  const prior = comment ? parseState(comment.body) : null;
  let job: Job | null = null;

  if (prior?.status === "done" && prior.sha === pr.head.sha && !cfg.force) {
    log.notice(`PR #${prNumber} @ ${sha7} already has a review; dispatch with force=true to redo it.`);
    return { status: "done", verdict: prior.verdict ?? parseVerdict(comment?.body ?? ""), overridden };
  }
  // A label change only re-evaluates the gate: it may resume a pending batch, never pay for a new one.
  const labelEvent = process.env.GITHUB_EVENT_NAME === "pull_request" && /^(un)?labeled$/.test(event.action ?? "");
  // Only a batch can be resumed; the openai backend has none.
  const resumable = !openai && prior?.status === "pending" && prior.sha === pr.head.sha && !!prior.batch;
  if (labelEvent && (overridden || !resumable)) {
    log.info(`Label change: review state for ${sha7} is ${prior?.sha === pr.head.sha ? prior.status : "missing"}; nothing submitted.`);
    return { status: prior?.sha === pr.head.sha && prior.status === "failed" ? "failed" : "pending", overridden };
  }
  if (!openai && prior?.status === "pending" && prior.batch) {
    const slot = slots.findIndex((s) => s.fp === prior.key);
    if (prior.sha === pr.head.sha && slot >= 0 && !cfg.force) {
      job = { batch: prior.batch, slot, model: prior.model ?? cfg.model, submitted: prior.submitted ?? "" };
      log.info(`Resuming batch ${job.batch} for ${sha7}.`);
    } else if (slot >= 0) {
      await slots[slot].client.messages.batches.cancel(prior.batch).then(
        () => log.info(`Canceled superseded batch ${prior.batch} (${prior.sha.slice(0, 7)}).`),
        (e: unknown) => log.info(`Could not cancel ${prior.batch}: ${String(e)}`),
      );
    }
  }

  let ctx: ReviewContext | null = null;
  const context = async () => (ctx ??= await buildContext(gh, pr, cfg.maxInputTokens, cfg.promptFile));

  const submit = async (from: number, model: string): Promise<Job | null> => {
    const c = await context();
    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: cfg.maxOutputTokens,
      thinking: { type: "adaptive" },
      output_config: { effort: cfg.effort },
      // Guidance rides in the system prompt, a channel PR text cannot reach or imitate.
      system: [
        { type: "text", text: SYSTEM_PROMPT },
        { type: "text", text: c.guidance || "(The repository has no guidance files.)" },
      ],
      messages: [{ role: "user", content: c.text }],
    };
    for (let i = from; i < slots.length; i++) {
      try {
        const batch = await slots[i].client.messages.batches.create({
          requests: [{ custom_id: `${owner}-${repo}-${prNumber}-${sha7}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64), params }],
        });
        log.info(`Submitted ${batch.id} on key ${i + 1}/${slots.length} (${model}).`);
        return { batch: batch.id, slot: i, model, submitted: batch.created_at };
      } catch (e) {
        if (!(e instanceof Anthropic.APIError) || !keyUnusable(e.status, e.type, e.message)) throw e;
        log.warning(`Key ${i + 1}/${slots.length} (${slots[i].fp}) unusable: ${e.type ?? e.status} — ${e.message}`);
      }
    }
    return null;
  };

  const upsert = async (state: State, body: string) => {
    const head = `${MARKER} ${JSON.stringify(state)} -->\n`;
    const room = MAX_COMMENT_CHARS - head.length;
    const full = head + (body.length <= room ? body : `${body.slice(0, room - 80)}\n\n… [comment cut at GitHub's size limit]`);
    const base = `/repos/${owner}/${repo}/issues`;
    if (comment) {
      await gh.json(`${base}/comments/${comment.id}`, { method: "PATCH", body: JSON.stringify({ body: full }) });
      comment.body = full;
    } else {
      comment = await gh.json<Comment>(`${base}/${prNumber}/comments`, { method: "POST", body: JSON.stringify({ body: full }) });
    }
  };
  // The openai backend's heading names only the model, so its review never passes for Claude's.
  const header = (model: string) => `## ${openai ? "Review" : "Claude review"} · \`${model}\` · ${sha7}\n\n`;

  const queue = async (j: Job) =>
    upsert(
      { status: "pending", sha: pr.head.sha, batch: j.batch, key: slots[j.slot].fp, model: j.model, submitted: j.submitted },
      `${header(j.model)}⏳ Queued in batch \`${j.batch}\` (key ${j.slot + 1}/${slots.length}). ` +
        "This comment becomes the review when the batch ends. If the workflow times out first, re-run it to collect the result.",
    );
  const fail = async (model: string, why: string): Promise<Outcome> => {
    await upsert({ status: "failed", sha: pr.head.sha }, `${header(model)}⚠️ No review: ${why}`);
    log.warning(why);
    return { status: "failed", overridden };
  };

  const reviewOpenAI = async (): Promise<Outcome> => {
    const c = await context();
    await upsert(
      { status: "pending", sha: pr.head.sha, model: cfg.model },
      `${header(cfg.model)}⏳ Reviewing with \`${cfg.model}\`. This comment becomes the review when the model answers.`,
    );
    log.info(`Asking ${cfg.model} at ${baseUrl} (waits up to ${cfg.maxWaitMs / 60_000} min).`);
    const r = await chatReview(deps.post ?? httpPost, sleep, {
      baseUrl,
      apiKey: openaiKey,
      model: cfg.model,
      maxTokens: cfg.maxOutputTokens,
      timeoutMs: cfg.maxWaitMs,
      system: `${SYSTEM_PROMPT}\n\n${c.guidance || "(The repository has no guidance files.)"}`,
      user: c.text,
    });
    if (!r.ok) return fail(cfg.model, r.why);
    const a = r.answer;
    const truncated = a.truncated ? "\n\n> ⚠️ Cut off at `max-output-tokens`." : "";
    const verdict = parseVerdict(a.text);
    await upsert(
      { status: "done", verdict, sha: pr.head.sha, model: a.model },
      `${header(a.model)}${a.text || "_Empty response._"}${truncated}\n\n${openaiFooter(a, c)}`,
    );
    log.info(`Posted the review for #${prNumber} @ ${sha7} (verdict: ${verdict}).`);
    return { status: "done", verdict, overridden };
  };

  const review = async (): Promise<Outcome> => {
    if (openai) return reviewOpenAI();
    if (!job) {
      job = await submit(0, cfg.model);
      if (!job) return fail(cfg.model, `none of the ${slots.length} API keys has credit left. Add a key to \`ANTHROPIC_REVIEW_KEYS\`.`);
      await queue(job);
    }

    const deadline = Date.now() + cfg.maxWaitMs;
    for (let round = 0; round < slots.length + 3; round++) {
      const client = slots[job.slot].client;
      const batch = await waitForBatch(client, job.batch, deadline, sleep);
      if (!batch) {
        log.notice(`Batch ${job.batch} still running after ${cfg.maxWaitMs / 60_000} min; re-run the workflow to collect it.`);
        return { status: "pending", overridden };
      }
      let result: Anthropic.Messages.MessageBatchResult | null = null;
      for await (const r of await client.messages.batches.results(job.batch)) result = r.result;
      if (!result) return fail(job.model, `batch \`${job.batch}\` ended without a result.`);

      if (result.type === "succeeded") {
        const msg = result.message;
        if (msg.stop_reason === "refusal" && job.model !== cfg.fallbackModel) {
          log.warning(`${job.model} declined (${msg.stop_details?.category ?? "no category"}); retrying on ${cfg.fallbackModel}.`);
          const next = await submit(job.slot, cfg.fallbackModel);
          if (!next) return fail(job.model, "the model declined and no key had credit for the fallback model.");
          await queue((job = next));
          continue;
        }
        if (msg.stop_reason === "refusal") return fail(job.model, `the model declined to review this PR (${msg.stop_details?.category ?? "no category"}).`);
        const text = msg.content
          .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n\n")
          .trim();
        const truncated = msg.stop_reason === "max_tokens" ? "\n\n> ⚠️ Cut off at `max-output-tokens`." : "";
        const verdict = parseVerdict(text);
        await upsert(
          { status: "done", verdict, sha: pr.head.sha, model: msg.model },
          `${header(msg.model)}${text || "_Empty response._"}${truncated}\n\n${footer(msg, job, batch, slots.length, await context())}`,
        );
        log.info(`Posted the review for #${prNumber} @ ${sha7} (verdict: ${verdict}).`);
        return { status: "done", verdict, overridden };
      }

      if (result.type === "errored") {
        const err = result.error.error;
        if (keyUnusable(undefined, err.type, err.message)) {
          log.warning(`Key ${job.slot + 1}/${slots.length} ran out during the batch: ${err.message}`);
          const next = await submit(job.slot + 1, job.model);
          if (!next) return fail(job.model, `every API key is out of credit. Add a key to \`ANTHROPIC_REVIEW_KEYS\`.`);
          await queue((job = next));
          continue;
        }
        return fail(job.model, `the batch request failed: \`${err.type}\` ${err.message}`);
      }
      return fail(job.model, `batch \`${job.batch}\` ended as \`${result.type}\`. Re-run the workflow to try again.`);
    }
    return fail(job.model, "gave up after too many resubmissions.");
  };

  try {
    return await review();
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    // A submitted batch stays collectable: keep the pending state and say what went wrong.
    if (job)
      await upsert(
        { status: "pending", sha: pr.head.sha, batch: job.batch, key: slots[job.slot].fp, model: job.model, submitted: job.submitted },
        `${header(job.model)}⏳ Batch \`${job.batch}\` is queued, but the job hit an error (\`${why.slice(0, 300)}\`). Re-run the workflow to collect the result.`,
      ).catch(() => {});
    else await fail(cfg.model, `the job hit an error: \`${why.slice(0, 300)}\``).catch(() => {});
    throw e;
  }
}

export function parseVerdict(text: string): Verdict {
  // ⚠ may come with or without the U+FE0F variation selector.
  const m = /\*\*Verdict:\*\*\s*(✅|⚠\uFE0F?|❌)/u.exec(text);
  return !m ? "unknown" : m[1] === "✅" ? "pass" : m[1] === "❌" ? "changes" : "minor";
}

function num(name: string, fallback: number): number {
  const raw = input(name, String(fallback));
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Input ${name} must be a positive number, got "${raw}".`);
  return n;
}

/** Out of credit, revoked or not allowed: move on to the next key. */
export function keyUnusable(status: number | undefined, type: string | null | undefined, message: string): boolean {
  if (status === 401 || status === 402 || status === 403) return true;
  if (type === "billing_error" || type === "authentication_error" || type === "permission_error") return true;
  // Older accounts report an empty balance as a 400 invalid_request_error; only the message tells it apart.
  return /credit balance/i.test(message);
}

async function waitForBatch(client: Anthropic, id: string, deadline: number, sleep: (ms: number) => Promise<void>) {
  for (let i = 0; ; i++) {
    const batch = await client.messages.batches.retrieve(id);
    if (batch.processing_status === "ended") return batch;
    if (Date.now() > deadline) return null;
    if (i % 4 === 0) log.info(`Batch ${id}: ${batch.processing_status}…`);
    await sleep(i < 8 ? 15_000 : 30_000);
  }
}

function footer(
  msg: Anthropic.Messages.Message,
  job: Job,
  batch: Anthropic.Messages.MessageBatch,
  keyCount: number,
  ctx: ReviewContext,
): string {
  const u = msg.usage;
  const input = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const price = PRICES[msg.model];
  const cost = price ? ` · ≈ $${((input * price[0] + u.output_tokens * price[1]) / 2 / 1e6).toFixed(3)}` : "";
  const waited = batch.ended_at ? Math.round((Date.parse(batch.ended_at) - Date.parse(batch.created_at)) / 1000) : 0;
  return (
    `---\n<sub>Message Batches API · ${ctx.files} files · ${input.toLocaleString("en")} in / ${u.output_tokens.toLocaleString("en")} out tokens${cost}` +
    ` · batch took ${duration(waited)} · key ${job.slot + 1}/${keyCount} · ${LINK}</sub>${omittedList(ctx)}`
  );
}

function openaiFooter(a: ChatAnswer, ctx: ReviewContext): string {
  return (
    `---\n<sub>OpenAI-compatible API · ${ctx.files} files · ${a.inputTokens.toLocaleString("en")} in / ${a.outputTokens.toLocaleString("en")} out tokens` +
    ` · took ${duration(Math.round(a.ms / 1000))} · ${LINK}</sub>${omittedList(ctx)}`
  );
}

const LINK = "[claude-batch-review](https://github.com/PawOrmstrupMadsen/claude-batch-review)";

function duration(s: number): string {
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

function omittedList(ctx: ReviewContext): string {
  const shown = ctx.omitted.slice(0, 50).map((o) => `- ${o}`);
  if (ctx.omitted.length > 50) shown.push(`- … and ${ctx.omitted.length - 50} more`);
  return shown.length ? `\n<details><summary>Not shown to the reviewer</summary>\n\n${shown.join("\n")}\n</details>` : "";
}

/** Only the action's own comment counts, so nobody else can plant a state marker. */
async function findComment(gh: GitHub, pr: number, author: string): Promise<Comment | null> {
  const comments = await gh.paginate<Comment>(`/repos/${gh.owner}/${gh.repo}/issues/${pr}/comments`);
  return comments.find((c) => c.user?.login === author && c.body?.startsWith(MARKER)) ?? null;
}

export function parseState(body: string): State | null {
  const m = /^<!-- claude-batch-review (\{.*?\}) -->/.exec(body);
  try {
    return m ? (JSON.parse(m[1]) as State) : null;
  } catch {
    return null;
  }
}

interface PrEvent {
  action?: string;
  pull_request?: { number: number; labels?: { name: string }[] };
}

function readEvent(): PrEvent {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PrEvent;
  } catch {
    return {};
  }
}

/** Why the gate blocks, or null when it lets the PR through. */
export function blocker(mode: Mode, { status, verdict }: Outcome): string | null {
  if (mode === "advisory") return null;
  if (status !== "done") return `No review for this commit (${status}). Re-run this job to retry or collect a pending batch.`;
  if (mode === "pass" && verdict === "changes") return "The review asks for changes. Fix them and push.";
  if (mode === "pass" && verdict === "unknown") return "The review has no recognisable verdict line. Re-run with force to redo it.";
  return null;
}

/** Runs the action and returns the process exit code. */
export async function main(deps: Deps = {}): Promise<number> {
  const mode = input("mode", "advisory") as Mode;
  const overrideLabel = input("override-label", "review-override");
  const backend = input("backend", "anthropic") as Backend;
  const event = readEvent();
  if (!["advisory", "complete", "pass"].includes(mode)) {
    log.error(`Input mode must be advisory, complete or pass, got "${mode}".`);
    return 1;
  }
  if (!["anthropic", "openai"].includes(backend)) {
    log.error(`Input backend must be anthropic or openai, got "${backend}".`);
    return 1;
  }
  try {
    const outcome = await run({ mode, overrideLabel, backend, event }, deps);
    setOutput("status", outcome.status);
    setOutput("verdict", outcome.verdict ?? "");
    const why = blocker(mode, outcome);
    if (!why) return 0;
    if (outcome.overridden) {
      log.notice(`${why} The \`${overrideLabel}\` label overrides it.`);
      return 0;
    }
    log.error(`${why} To merge anyway, add the \`${overrideLabel}\` label.`);
    return 1;
  } catch (e) {
    setOutput("status", "failed");
    const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
    // The event's labels are known even when run() fails, so a crash still honours the override.
    if (mode !== "advisory" && (event.pull_request?.labels ?? []).some((l) => l.name === overrideLabel)) {
      log.notice(`${msg}\nThe \`${overrideLabel}\` label overrides the failure.`);
      return 0;
    }
    log.error(msg);
    return 1;
  }
}
