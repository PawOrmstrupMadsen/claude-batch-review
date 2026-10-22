import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildContext, pullFiles, type PrFile, type Pull, type ReviewContext } from "./context.js";
import { GitHub, input, log, setOutput, summary } from "./github.js";
import { localReview, type Checkout, type LocalAnswer, type LocalResult, type RunClaude } from "./local.js";
import { chatReview, httpPost, type ChatAnswer, type Post } from "./openai.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { chooseTier, planEngines, renovateMajor, stricter, TIERS, type EnginePlan, type Tier, type TierChoice, type TierInput } from "./tier.js";

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
export type Backend = "anthropic" | "openai" | "router";

/** Seams for tests: the network and the clock. */
export interface Deps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** The `openai` backend's HTTP POST. */
  post?: Post;
  /** The local engine's Claude Code run and checkout (backend router). */
  runClaude?: RunClaude;
  checkout?: Checkout;
}

interface Settings {
  mode: Mode;
  overrideLabel: string;
  backend: Backend;
  /** Reviews instead when the Anthropic API cannot (backend anthropic only). */
  fallback: "" | "openai";
  event: PrEvent;
}

export interface State {
  /** overridden: the override label let the commit through without a review. */
  status: "pending" | "done" | "failed" | "overridden";
  verdict?: Verdict;
  sha: string;
  batch?: string;
  key?: string;
  model?: string;
  submitted?: string;
  /** Backend router: the tier this round chose, which a later round keeps. */
  tier?: Tier;
}

interface Job {
  batch: string;
  slot: number;
  model: string;
  submitted: string;
  /** When the batch was submitted (ms since the epoch); `sync-after-minutes` counts from it. */
  started: number;
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
  /** Why there is no usable review, as the one-liner after "No review:". */
  reason?: string;
  /** What gets a review after all. */
  next?: string;
  /** Who reviewed, for the job summary. */
  note?: string;
  /** The model that reviewed through the fallback backend. */
  fallbackModel?: string;
  /** Backend router: why this pull request needs no review (a bot's), which passes the gate. */
  exempt?: string;
  /** A label run that decided nothing: it leaves the `check-name` check to the review run. */
  undecided?: boolean;
  sha?: string;
}

/** The head commit the run reviews, once it has read the pull request; a crash's check goes there. */
let reviewedSha: string | undefined;

async function run({ mode, overrideLabel, backend, fallback, event }: Settings, deps: Deps): Promise<Outcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const router = backend === "router";
  const routerUrl = input("router-url").replace(/\/+$/, "");
  if (router && !/^https?:\/\/[^/]/.test(routerUrl)) throw new Error("backend router needs the `router-url` input (http://host:port).");
  // The router hands the token to the gateway, which picks the billing key and books the spend.
  const keys = router
    ? [input("router-token")].filter(Boolean)
    : input("api-keys")
        .split(/\r?\n/)
        .map((k) => k.trim())
        .filter((k) => k && !k.startsWith("#"));
  keys.forEach(log.mask);
  const slots: Slot[] = keys.map((key) => ({
    key,
    fp: createHash("sha256").update(key).digest("hex").slice(0, 8),
    client: new Anthropic({ apiKey: key, maxRetries: 4, fetch: deps.fetch, ...(router ? { baseURL: routerUrl } : {}) }),
  }));

  const [owner, repo] = input("repository", process.env.GITHUB_REPOSITORY ?? "").split("/");
  const gh = new GitHub(input("github-token"), owner, repo, deps.fetch);
  const prNumber = Number(input("pr") || event.pull_request?.number || "");
  if (!prNumber) throw new Error("No pull request number: pass the `pr` input.");
  const pr = await gh.json<Pull>(`/repos/${owner}/${repo}/pulls/${prNumber}`);

  const openai = backend === "openai";
  const openaiModel = input("openai-model");
  const cfg = {
    model: openai ? openaiModel : input("model", "claude-opus-5-5"),
    fallbackModel: input("fallback-model", "claude-opus-4-8"),
    effort: input("effort", "high") as "low" | "medium" | "high" | "xhigh" | "max",
    maxOutputTokens: num("max-output-tokens", 32000),
    maxInputTokens: num("max-input-tokens", 300000),
    maxWaitMs: num("max-wait-minutes", openai ? 30 : 20) * 60_000,
    syncAfterMinutes: num("sync-after-minutes", 5, true),
    promptFile: input("prompt-file"),
    reasoningEffort: input("openai-reasoning-effort"),
    force: input("force") === "true",
  };
  const overridden = pr.labels.some((l) => l.name === overrideLabel);
  const sha = pr.head.sha;
  reviewedSha = sha;
  const openaiKey = input("openai-api-key");
  if (openaiKey) log.mask(openaiKey);
  const baseUrl = input("openai-base-url");
  const usesOpenAI = openai || !!fallback;
  if (usesOpenAI && (!baseUrl || !openaiModel))
    throw new Error(`${openai ? "backend" : "fallback-backend"} openai needs the \`openai-base-url\` and \`openai-model\` inputs.`);
  if (usesOpenAI && openaiKey && !baseUrl.startsWith("https:"))
    log.warning("openai-api-key goes to a plain-HTTP endpoint: keep that endpoint on a private network.");
  // A fork PR's token cannot write the comment, and its untrusted code should not reach a private endpoint unasked.
  const fork = pr.head.repo?.full_name !== pr.base.repo?.full_name;
  if (openai && fork) {
    log.notice("Fork pull request: the openai backend skips it.");
    return { status: "skipped", overridden, sha, reason: "the openai backend skips fork pull requests", next: "" };
  }
  if (router && pr.user.type === "Bot") {
    const r = tierRules();
    const facts = { author: pr.user, labels: pr.labels.map((l) => l.name), title: pr.title, headRef: pr.head.ref };
    if (!renovateMajor(facts) && !r.opusAuthors.some((a) => a.toLowerCase() === pr.user.login.toLowerCase())) {
      log.notice(`A pull request by ${pr.user.login}: not reviewed.`);
      return { status: "skipped", overridden, sha, exempt: `a pull request by ${pr.user.login}` };
    }
  }
  if (router && keys.length === 0) {
    log.warning("No router token (the `router-token` input is empty, or a fork PR without secrets).");
    return { status: "failed", overridden, sha, reason: NO_TOKEN, next: TOKEN_NEXT };
  }
  if (!openai && keys.length === 0) {
    log.notice("No API keys (secret unset, or a fork PR without secrets): skipping the review.");
    return { status: "skipped", overridden, sha, reason: "no API keys", next: "Set the `api-keys` input, then re-run this job." };
  }
  const canFallBack = fallback === "openai" && !fork;

  const sha7 = sha.slice(0, 7);

  const author = input("comment-author", "github-actions[bot]");
  let comment = await findComment(gh, prNumber, author);
  const prior = comment ? parseState(comment.body) : null;
  let job: Job | null = null;

  if (prior?.status === "done" && prior.sha === pr.head.sha && !cfg.force) {
    log.notice(`PR #${prNumber} @ ${sha7} already has a review; dispatch with force=true to redo it.`);
    const verdict = prior.verdict ?? parseVerdict(comment?.body ?? "");
    return { status: "done", verdict, overridden, sha, ...(verdict === "unknown" ? { reason: NO_VERDICT } : {}), note: `Stored review of ${sha7}.` };
  }
  // Backend router: the tier rules, then the engines this run may use.
  let files: PrFile[] | undefined;
  let choice: TierChoice | null = null;
  let plan: EnginePlan = { local: false, claude: null, note: "" };
  const localModel = input("local-model", "local");
  if (router) {
    files = await pullFiles(gh, prNumber);
    // An earlier round that produced a review (or is still waiting for one) hands its tier on.
    const reviewed = prior?.status === "pending" || (prior?.status === "done" && !!prior.verdict && prior.verdict !== "unknown");
    choice = chooseTier(
      {
        owner,
        author: pr.user,
        labels: pr.labels.map((l) => l.name),
        title: pr.title,
        headRef: pr.head.ref,
        files,
        prior: prior?.tier && TIERS.includes(prior.tier) ? { tier: prior.tier, reviewed } : null,
      },
      tierRules(),
    );
    plan = planEngines(choice, { event: process.env.GITHUB_EVENT_NAME ?? "", fork });
    cfg.model = plan.claude ? tierModel(plan.claude) : localModel;
    // The gateway allows only its tiers' models: a refusal is retried on the other Claude tier.
    cfg.fallbackModel = tierModel(plan.claude === "opus" ? "sonnet" : "opus");
    log.notice(`Tier ${choice.tier}${plan.local && plan.claude ? " and a local pass" : ""}: ${choice.why}.${plan.note ? ` ${capitalise(plan.note)}.` : ""}`);
  }
  const recordedTier: Tier = plan.claude ?? "local";
  const mayCheckOut = planEngines({ tier: "local", secondOpinion: false, why: "" }, { event: process.env.GITHUB_EVENT_NAME ?? "", fork }).local;

  // A label change only re-evaluates the gate: it may resume a pending batch, never pay for a new one.
  const labelEvent = process.env.GITHUB_EVENT_NAME === "pull_request" && /^(un)?labeled$/.test(event.action ?? "");
  // Only a batch can be resumed; the openai backend has none.
  // With a local pass beside it, only the review run collects the batch: it alone holds both answers.
  const resumable = !openai && prior?.status === "pending" && prior.sha === pr.head.sha && !!prior.batch && (!router || (!!plan.claude && !plan.local));
  // The label already lets the PR through: no batch is submitted or waited for (force reviews anyway).
  const skipForLabel = overridden && mode !== "advisory" && !cfg.force;
  if (labelEvent && !skipForLabel && (overridden || !resumable)) {
    log.info(`Label change: review state for ${sha7} is ${prior?.sha === pr.head.sha ? prior.status : "missing"}; nothing submitted.`);
    const failed = prior?.sha === pr.head.sha && prior.status === "failed";
    return {
      status: failed ? "failed" : "pending",
      overridden,
      sha,
      reason: failed ? "the last attempt failed" : `${sha7} has none yet`,
      next: "Re-run the review job for the last push.",
      // An overridden commit has no review to wait for: the check must go red again without the label.
      undecided: !(prior?.sha === sha && prior.status === "overridden"),
    };
  }
  if (!openai && prior?.status === "pending" && prior.batch) {
    const slot = slots.findIndex((s) => s.fp === prior.key);
    if (prior.sha === pr.head.sha && slot >= 0 && !cfg.force && (!router || !!plan.claude)) {
      const submitted = prior.submitted ?? "";
      job = { batch: prior.batch, slot, model: prior.model ?? cfg.model, submitted, started: Date.parse(submitted) || Date.now() };
      log.info(`Resuming batch ${job.batch} for ${sha7}.`);
    } else if (slot >= 0) {
      await slots[slot].client.messages.batches.cancel(prior.batch).then(
        () => log.info(`Canceled superseded batch ${prior.batch} (${prior.sha.slice(0, 7)}).`),
        (e: unknown) => log.info(`Could not cancel ${prior.batch}: ${String(e)}`),
      );
    }
  }

  let ctx: ReviewContext | null = null;
  const context = async () => (ctx ??= await buildContext(gh, pr, cfg.maxInputTokens, cfg.promptFile, files));

  /** The one request a review sends, as a batch request or a direct Messages API call. */
  const request = async (model: string): Promise<Anthropic.Messages.MessageCreateParamsNonStreaming> => {
    const c = await context();
    return {
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
  };

  /**
   * Makes `call` on key `from`, moving on to the next key when one is unusable or rate-limited.
   * Null when no key can be used; an AnthropicDown when the API cannot serve and a fallback can.
   */
  const onKeys = async <T>(from: number, call: (s: Slot) => Promise<T>): Promise<{ value: T; slot: number } | null> => {
    let limited: unknown = null;
    const raise = (e: unknown): never => {
      const why = canFallBack ? apiDown(e) : null;
      throw why ? new AnthropicDown(why, e instanceof Error ? e.message : String(e)) : e;
    };
    for (let i = from; i < slots.length; i++) {
      try {
        return { value: await call(slots[i]), slot: i };
      } catch (e) {
        // The gateway's own answers: an unknown token, or a batch over the review client's budget.
        if (router && e instanceof Anthropic.APIError && (e.status === 401 || e.status === 403)) throw new RouterRefused(e.status === 401 ? "token" : "budget", e.message);
        if (e instanceof Anthropic.APIError && keyUnusable(e.status, e.type, e.message)) {
          log.warning(`Key ${i + 1}/${slots.length} (${slots[i].fp}) unusable: ${e.type ?? e.status} — ${e.message}`);
          continue;
        }
        // Rate limits are per organisation, and the next key may belong to another one.
        if (e instanceof Anthropic.APIError && rateLimited(e) && i + 1 < slots.length) {
          log.warning(`Key ${i + 1}/${slots.length} (${slots[i].fp}) rate-limited; trying the next key.`);
          limited = e;
          continue;
        }
        raise(e);
      }
    }
    if (limited) raise(limited);
    return null;
  };

  const submit = async (from: number, model: string): Promise<Job | null> => {
    const params = await request(model);
    const custom_id = `${owner}-${repo}-${prNumber}-${sha7}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
    const r = await onKeys(from, (s) => s.client.messages.batches.create({ requests: [{ custom_id, params }] }));
    if (!r) return null;
    log.info(`Submitted ${r.value.id} on key ${r.slot + 1}/${slots.length} (${model}).`);
    return { batch: r.value.id, slot: r.slot, model, submitted: r.value.created_at, started: Date.now() };
  };

  /** Backend router, `needs 2nd opinion`: the local pass, added to the Claude pass's comment. */
  let companion: LocalPass | null = null;
  const tierLine = choice ? `<sub>Tier \`${recordedTier}\`${plan.local && plan.claude ? " and a local pass" : ""}: ${choice.why}${plan.note ? `; ${plan.note}` : ""}. Through the LLM router.</sub>` : "";
  const upsert = async (state: State, body: string) => {
    if (router) {
      state = { ...state, tier: recordedTier };
      if (state.status === "done" && companion) state.verdict = stricter(state.verdict ?? "unknown", companion.verdict);
      if (state.status === "done" || state.status === "failed") body = [body, companion?.section, tierLine].filter(Boolean).join("\n\n");
    }
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
  const isLocal = (model: string) => openai || (router && !model.startsWith("claude"));
  const header = (model: string, local = isLocal(model)) => `## ${local ? "Review" : "Claude review"} · \`${model}\` · ${sha7}\n\n`;
  const wayOut = (next: string, blocks: boolean) => (blocks ? `${next} To merge anyway, add the \`${overrideLabel}\` label.` : next);
  // The same line the check's title and the job summary give.
  const noReview = (reason: string, next: string, blocks: boolean, detail = "") =>
    [`### ⚠️ No review: ${reason}`, detail, wayOut(next, blocks)].filter(Boolean).join("\n\n");

  const queue = async (j: Job) =>
    upsert(
      { status: "pending", sha, batch: j.batch, key: slots[j.slot].fp, model: j.model, submitted: j.submitted },
      `${header(j.model)}⏳ Queued in batch \`${j.batch}\` (key ${j.slot + 1}/${slots.length}). ` +
        "This comment becomes the review when the batch ends. If the workflow times out first, re-run it to collect the result.",
    );
  const fail = async (model: string, why: string, reason: string, next = RETRY, local = isLocal(model)): Promise<Outcome> => {
    await upsert({ status: "failed", sha }, `${header(model, local)}${noReview(reason, next, mode !== "advisory", capitalise(why))}`);
    log.warning(why);
    return { status: "failed", overridden, sha, reason, next };
  };
  /** A done review without a usable verdict: the reason and the line that heads its comment. */
  const unusable = (text: string, verdict: Verdict) => {
    if (verdict !== "unknown") return { reason: undefined, head: "" };
    const reason = text ? NO_VERDICT : EMPTY_ANSWER;
    return { reason, head: `${noReview(reason, FORCE, mode === "pass")}\n\n---\n\n` };
  };

  const reviewOpenAI = async (because = ""): Promise<Outcome> => {
    running = { model: openaiModel, local: true };
    const c = await context();
    if (because) log.warning(`Falling back to the openai backend: ${because}.`);
    const via = because ? `> ↪️ Fallback review: ${because}, so \`${openaiModel}\` reviewed this instead of Claude.\n\n` : "";
    const after = because ? ` (in the fallback review: ${because})` : "";
    await upsert(
      { status: "pending", sha, model: openaiModel },
      `${header(openaiModel, true)}${via}⏳ Reviewing with \`${openaiModel}\`. This comment becomes the review when the model answers.`,
    );
    const waitMs = num("max-wait-minutes", 30) * 60_000;
    log.info(`Asking ${openaiModel} at ${baseUrl} (waits up to ${waitMs / 60_000} min).`);
    const deadline = Date.now() + waitMs;
    const ask = (reasoningEffort: string) =>
      chatReview(deps.post ?? httpPost, sleep, {
        baseUrl,
        apiKey: openaiKey,
        model: openaiModel,
        maxTokens: cfg.maxOutputTokens,
        reasoningEffort,
        timeoutMs: Math.max(1, deadline - Date.now()),
        system: `${SYSTEM_PROMPT}\n\n${c.guidance || "(The repository has no guidance files.)"}`,
        user: c.text,
      });
    let r = await ask(cfg.reasoningEffort);
    if (!r.ok) return fail(openaiModel, r.why + after, r.reason, RETRY, true);
    let a = r.answer;
    let retried = "";
    // A reasoning model can spend the whole output budget thinking: ask once more, thinking less.
    if (thoughtOut(a) && deadline - Date.now() > MIN_RETRY_MS) {
      const effort = RETRY_EFFORT;
      const first = a;
      log.warning(`${openaiModel} gave ${a.text ? "no verdict before max-output-tokens" : "an empty answer"}; retrying at reasoning effort ${effort}.`);
      r = await ask(effort);
      if (!r.ok)
        return fail(openaiModel, `${r.why} (on a retry after ${first.text ? "an answer cut off before its verdict" : "an empty answer"})${after}`, r.reason, RETRY, true);
      a = { ...r.answer, ms: first.ms + r.answer.ms, inputTokens: first.inputTokens + r.answer.inputTokens, outputTokens: first.outputTokens + r.answer.outputTokens };
      retried = ` · retried at reasoning effort ${effort} after ${first.text ? "an answer cut off before its verdict" : "an empty answer"}`;
    }
    const truncated = a.truncated ? "\n\n> ⚠️ Cut off at `max-output-tokens`." : "";
    const verdict = parseVerdict(a.text);
    const bad = unusable(a.text, verdict);
    await upsert(
      { status: "done", verdict, sha, model: a.model },
      `${header(a.model, true)}${via}${bad.head}${a.text || "_Empty response._"}${truncated}\n\n${openaiFooter(a, c, retried + (because ? " · fallback from the Anthropic API" : ""))}`,
    );
    log.info(`Posted the review for #${prNumber} @ ${sha7} (verdict: ${verdict}).`);
    const note = `Reviewed by \`${a.model}\` through the OpenAI-compatible API${because ? `, the fallback backend: ${because}` : ""}.`;
    return { status: "done", verdict, overridden, sha, reason: bad.reason, note, ...(because ? { fallbackModel: a.model } : {}) };
  };

  const keysWhy = `none of the ${slots.length} API keys can be used (out of credit, at a spend limit, or refused).`;
  /** Every key is out: the fallback reviews, or the run ends without a review. */
  const outOfCredit = (model: string, why: string): Promise<Outcome> => {
    job = null;
    if (router) return fail(model, why === keysWhy ? "the gateway's Anthropic key cannot be used (out of credit, at a spend limit, or refused)." : why, OUT_OF_CREDIT, "Add credit to the gateway's key, then re-run this job.");
    return canFallBack
      ? reviewOpenAI("no Anthropic API key can be used (out of credit, at a spend limit, or refused)")
      : fail(model, why, OUT_OF_CREDIT, "Add credit or a key to `ANTHROPIC_REVIEW_KEYS`, then re-run this job.");
  };

  /** Whose comment a crash rewrites: the fallback's once it runs. */
  let running = { model: cfg.model, local: isLocal(cfg.model) };

  /** Posts a finished Claude answer, from a batch or a direct call, as the review. */
  const postReview = async (msg: Anthropic.Messages.Message, foot: string, via: string): Promise<Outcome> => {
    const text = msg.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n\n")
      .trim();
    const truncated = msg.stop_reason === "max_tokens" ? "\n\n> ⚠️ Cut off at `max-output-tokens`." : "";
    const verdict = parseVerdict(text);
    const bad = unusable(text, verdict);
    await upsert(
      { status: "done", verdict, sha, model: msg.model },
      `${header(msg.model)}${bad.head}${text || "_Empty response._"}${truncated}\n\n${foot}`,
    );
    log.info(`Posted the review for #${prNumber} @ ${sha7} (verdict: ${verdict}).`);
    // The gateway may step a new session down a tier when the client is ahead of its pace.
    if (router) log.info(`Asked the router for ${cfg.model} (tier ${recordedTier}); ${msg.model} answered.`);
    return { status: "done", verdict, overridden, sha, reason: bad.reason, note: `Reviewed by \`${msg.model}\` through the ${via}.` };
  };

  const syncAfter = `${cfg.syncAfterMinutes} min`;
  /**
   * The batch sat in the queue past `sync-after-minutes`: ask the Messages API directly instead,
   * at full price, on the key that submitted the batch (then the next ones).
   */
  const reviewSync = async (from: Job): Promise<Outcome> => {
    const why = `batch still queued after ${syncAfter}`;
    // The batch is canceled: a crash from here on leaves nothing to resume, and a re-run reviews afresh.
    job = null;
    let model = from.model;
    let slot = from.slot;
    for (;;) {
      const params = await request(model);
      const t0 = Date.now();
      // Streamed: a request with this many output tokens may run longer than a plain request may.
      const r = await onKeys(slot, (s) => s.client.messages.stream(params).finalMessage());
      if (!r) return outOfCredit(model, keysWhy);
      const msg = r.value;
      slot = r.slot;
      log.info(`Direct request on key ${slot + 1}/${slots.length} (${model}) answered in ${Math.round((Date.now() - t0) / 1000)} s.`);
      if (msg.stop_reason === "refusal" && model !== cfg.fallbackModel) {
        log.warning(`${model} declined (${msg.stop_details?.category ?? "no category"}); retrying on ${cfg.fallbackModel}.`);
        model = cfg.fallbackModel;
        continue;
      }
      if (msg.stop_reason === "refusal")
        return fail(model, `the model declined to review this PR (${msg.stop_details?.category ?? "no category"}).`, "the model declined to review this PR");
      const foot = syncFooter(msg, why, Math.round((Date.now() - t0) / 1000), slot, slots.length, await context());
      return postReview(msg, foot, `Messages API directly (${why})`);
    }
  };

  /**
   * Cancels a batch that is still unfinished. The batch it returns has ended after all, so its result
   * is used if it succeeded, instead of paying again; null when the batch is still not done.
   */
  const cancelSlow = async (j: Job): Promise<Anthropic.Messages.MessageBatch | null> => {
    const client = slots[j.slot].client;
    log.notice(`Batch ${j.batch} still queued after ${syncAfter}; canceling it and reviewing through the Messages API directly.`);
    // Before the cancel: a label run waiting for this batch then finds that this run took over.
    await upsert(
      { status: "pending", sha, model: j.model },
      `${header(j.model)}⏳ Batch \`${j.batch}\` was still queued after ${syncAfter}, so it is canceled and this review goes to the Messages API directly. This comment becomes the review when the model answers.`,
    );
    try {
      const b = await client.messages.batches.cancel(j.batch);
      if (b.processing_status === "ended") return b;
      // A request the model is already working on still finishes, and is billed, after a cancel:
      // give it a short while to end before paying for a second answer.
      const settled = await waitForBatch(client, j.batch, Date.now() + CANCEL_SETTLE_MS, sleep);
      if (!settled) log.info(`Batch ${j.batch} is still ${b.processing_status} after ${CANCEL_SETTLE_MS / 1000} s; going direct.`);
      return settled;
    } catch (e) {
      log.warning(`Could not cancel ${j.batch}: ${e instanceof Error ? e.message : String(e)}`);
      // Canceling an ended batch fails too: look once more before paying for a direct request.
      const b = await client.messages.batches.retrieve(j.batch).catch(() => null);
      return b?.processing_status === "ended" ? b : null;
    }
  };

  /**
   * Another run canceled this batch: the run for a newer commit, or the review run that went to the
   * Messages API directly. Waits for that run's review instead of writing over its comment; null when
   * the comment still names this batch, so nobody else took over.
   */
  const reviewedElsewhere = async (batch: string, deadline: number): Promise<Outcome | null> => {
    for (;;) {
      const c = await findComment(gh, prNumber, author);
      const s = c ? parseState(c.body) : null;
      if (!c || !s || (s.sha === sha && s.status === "pending" && s.batch === batch)) return null;
      comment = c;
      if (s.sha !== sha) return { status: "failed", overridden, sha, reason: `the review moved on to ${s.sha.slice(0, 7)}`, next: "Re-run the review job for the last push." };
      if (s.status === "done") {
        const verdict = s.verdict ?? parseVerdict(c.body);
        log.info(`Batch ${batch} was canceled by another run, which reviewed ${sha7}.`);
        return { status: "done", verdict, overridden, sha, ...(verdict === "unknown" ? { reason: NO_VERDICT } : {}), note: `Review of ${sha7} by another run.` };
      }
      if (s.status === "failed") return { status: "failed", overridden, sha, reason: "the last attempt failed", next: RETRY };
      if (Date.now() >= deadline)
        return { status: "pending", overridden, sha, reason: "another run is still reviewing", next: "Re-run this job to collect the review." };
      log.info(`Batch ${batch} was canceled by another run; waiting for its review.`);
      await sleep(15_000);
    }
  };

  const reviewAnthropic = async (): Promise<Outcome> => {
    if (!job) {
      job = await submit(0, cfg.model);
      if (!job) return outOfCredit(cfg.model, keysWhy);
      await queue(job);
    }

    const deadline = Date.now() + cfg.maxWaitMs;
    for (let round = 0; round < slots.length + 3; round++) {
      const client = slots[job.slot].client;
      // A label run never pays: it leaves the direct request to the review run, which waits for the same batch.
      const syncAt = cfg.syncAfterMinutes && !labelEvent ? job.started + cfg.syncAfterMinutes * 60_000 : Number.POSITIVE_INFINITY;
      let batch = await waitForBatch(client, job.batch, Math.min(deadline, syncAt), sleep);
      // Set when the batch ended while being canceled: only a succeeded result spares the direct request.
      let raced = false;
      if (!batch && syncAt <= deadline) {
        // Another run for this commit went direct already: take its review instead of paying again.
        const other = await reviewedElsewhere(job.batch, deadline);
        if (other) return other;
        batch = await cancelSlow(job);
        if (!batch) return reviewSync(job);
        raced = true;
        log.info(`Batch ${job.batch} ended before the cancel reached it; collecting its result.`);
      }
      if (!batch) {
        log.notice(`Batch ${job.batch} still running after ${cfg.maxWaitMs / 60_000} min; re-run the workflow to collect it.`);
        return { status: "pending", overridden, sha, reason: `batch still running after ${cfg.maxWaitMs / 60_000} min`, next: "Re-run this job to collect it." };
      }
      let result: Anthropic.Messages.MessageBatchResult | null = null;
      for await (const r of await client.messages.batches.results(job.batch)) result = r.result;
      if (raced && result?.type !== "succeeded") return reviewSync(job);
      if (!result) return fail(job.model, `batch \`${job.batch}\` ended without a result.`, "the batch ended without a result");

      if (result.type === "succeeded") {
        const msg = result.message;
        if (msg.stop_reason === "refusal" && job.model !== cfg.fallbackModel) {
          log.warning(`${job.model} declined (${msg.stop_details?.category ?? "no category"}); retrying on ${cfg.fallbackModel}.`);
          const next = await submit(job.slot, cfg.fallbackModel);
          if (!next) return outOfCredit(job.model, "the model declined and no key had credit for the fallback model.");
          await queue((job = next));
          continue;
        }
        if (msg.stop_reason === "refusal")
          return fail(job.model, `the model declined to review this PR (${msg.stop_details?.category ?? "no category"}).`, "the model declined to review this PR");
        return postReview(msg, footer(msg, job, batch, slots.length, await context()), "Message Batches API");
      }

      if (result.type === "errored") {
        const err = result.error.error;
        if (keyUnusable(undefined, err.type, err.message)) {
          log.warning(`Key ${job.slot + 1}/${slots.length} ran out during the batch: ${err.message}`);
          const next = await submit(job.slot + 1, job.model);
          if (!next) return outOfCredit(job.model, "every API key is out of credit.");
          await queue((job = next));
          continue;
        }
        return fail(job.model, `the batch request failed: \`${err.type}\` ${err.message}`, "the batch request failed");
      }
      if (result.type === "canceled") {
        const other = await reviewedElsewhere(job.batch, deadline);
        if (other) return other;
      }
      return fail(job.model, `batch \`${job.batch}\` ended as \`${result.type}\`. Re-run the workflow to try again.`, `the batch ended as ${result.type}`);
    }
    return fail(job.model, "gave up after too many resubmissions.", "too many resubmissions");
  };

  /** The override label is set: say so in the comment and pass at once, keeping a queued batch to collect later. */
  const skipOverridden = async (): Promise<Outcome> => {
    log.notice(`PR #${prNumber} carries the \`${overrideLabel}\` label: not reviewing ${sha7}.`);
    const kept = job
      ? ` Batch \`${job.batch}\` stays queued: a run after the label is removed collects it.`
      : "";
    const state: State = job
      ? { status: "pending", sha, batch: job.batch, key: slots[job.slot].fp, model: job.model, submitted: job.submitted }
      : { status: "overridden", sha };
    await upsert(
      state,
      `${header(cfg.model)}⏭️ Not reviewed: the \`${overrideLabel}\` label lets this pull request through.${kept} To get a review, remove the label and re-run the review job for the last push.`,
    );
    job = null;
    return { status: "skipped", overridden, sha, reason: "skipped for the label", next: "" };
  };

  /** The local engine on this pull request's head, as the router's local tier reaches it. */
  const runLocal = async (): Promise<LocalResult> => {
    const c = await context();
    const prJson = JSON.stringify(
      {
        number: pr.number,
        title: pr.title,
        body: pr.body ?? "",
        author: pr.user.login,
        labels: pr.labels.map((l) => l.name),
        base: pr.base.ref,
        head: pr.head.ref,
        files: (files ?? []).map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })),
      },
      null,
      2,
    );
    const res = await gh.request(`/repos/${owner}/${repo}/pulls/${prNumber}`, { accept: "application/vnd.github.diff" });
    // GitHub refuses the whole diff of a very large pull request; the per-file patches still exist.
    const diff = res.ok ? await res.text() : (files ?? []).map((f) => `--- ${f.filename}\n${f.patch ?? "[binary or too large]"}\n`).join("");
    return localReview(
      {
        pr,
        owner,
        repo,
        routerUrl,
        model: localModel,
        guidance: c.guidance,
        prJson,
        diff,
        githubToken: input("github-token"),
        timeoutMs: num("local-timeout-minutes", 60) * 60_000,
        maxOutputTokens: cfg.maxOutputTokens,
        contextTokens: num("local-context-tokens", 262144),
        claudeVersion: input("claude-code-version", "2.1.263"),
      },
      deps,
    );
  };
  const localFooter = (a: LocalAnswer) =>
    `---\n<sub>Claude Code over the checkout, read-only · \`${localModel}\` through the LLM router · ${a.turns} turns · took ${duration(Math.round(a.ms / 1000))} · ${LINK}</sub>`;

  /** The local tier's review, or the local model standing in for Claude (`because`). */
  const reviewLocal = async (because = ""): Promise<Outcome> => {
    running = { model: localModel, local: true };
    const via = because ? `> ↪️ ${capitalise(because)}, so the local model reviewed this instead of Claude.\n\n` : "";
    await upsert({ status: "pending", sha, model: localModel }, `${header(localModel, true)}${via}⏳ Reviewing with the local model. This comment becomes the review when it answers.`);
    const r = await runLocal();
    if (!r.ok) return fail(localModel, r.why, r.reason, RETRY, true);
    const verdict = parseVerdict(r.answer.text);
    const bad = unusable(r.answer.text, verdict);
    await upsert({ status: "done", verdict, sha, model: localModel }, `${header(localModel, true)}${via}${bad.head}${r.answer.text}\n\n${localFooter(r.answer)}`);
    log.info(`Posted the local review for #${prNumber} @ ${sha7} (verdict: ${verdict}).`);
    return { status: "done", verdict, overridden, sha, reason: bad.reason, note: `Reviewed by \`${localModel}\` (Claude Code over the checkout)${because ? `: ${because}` : ""}.` };
  };

  /** The local pass beside the Claude pass (`needs 2nd opinion`); it writes no comment of its own. */
  const localPass = async (): Promise<LocalPass> => {
    const r = await runLocal();
    const title = `## Second opinion · \`${localModel}\` · ${sha7}`;
    if (!r.ok) {
      log.warning(`Local pass: ${r.why}`);
      const reason = `the local pass gave no review (${r.reason})`;
      return { verdict: "unknown", reason, section: `---\n\n${title}\n\n### ⚠️ No review: ${reason}\n\n${capitalise(r.why)}` };
    }
    const verdict = parseVerdict(r.answer.text);
    log.info(`Local pass for #${prNumber} @ ${sha7}: verdict ${verdict}.`);
    return {
      verdict,
      reason: verdict === "unknown" ? "the local pass has no verdict line" : undefined,
      section: `---\n\n${title}\n\n${r.answer.text}\n\n${localFooter(r.answer)}`,
    };
  };

  /** Both passes ran: the stricter verdict counts. */
  const combine = (o: Outcome): Outcome => {
    if (!companion || o.status !== "done") return o;
    const verdict = stricter(o.verdict ?? "unknown", companion.verdict);
    const reason = verdict !== "unknown" ? undefined : o.verdict === "unknown" ? (o.reason ?? NO_VERDICT) : (companion.reason ?? NO_VERDICT);
    return { ...o, verdict, reason, note: `${o.note ?? ""} A local pass by \`${localModel}\` reviewed beside it; the stricter verdict counts.`.trim() };
  };

  /** The gateway refused: the token is not set up (401), or the batch is over the review budget (403). */
  const refusedByRouter = async (e: RouterRefused): Promise<Outcome> => {
    job = null;
    if (e.kind === "token") return fail(cfg.model, `the router refused the review token (HTTP 401: ${e.message}).`, NO_TOKEN, TOKEN_NEXT);
    log.warning(`Over the review budget (HTTP 403: ${e.message}).`);
    const because = "the review budget is used up for now";
    // The floor holds here too: such a repository waits for Claude rather than take the local model's word.
    if (tierRules().sonnetFloorOwners.some((o) => o.toLowerCase() === owner.toLowerCase()))
      return fail(cfg.model, `the gateway refused the batch (HTTP 403: ${e.message}), and ${owner} reviews never go below sonnet.`, OVER_BUDGET, "Re-run this job once the review budget allows it.");
    if (companion) {
      // The local pass already ran: it is the review.
      const c = companion;
      companion = null;
      await upsert(
        { status: "done", verdict: c.verdict, sha, model: localModel },
        `${header(localModel, true)}> ↪️ ${capitalise(because)}, so only the local pass reviewed this.\n\n${c.section.replace(/^---\n\n/, "")}`,
      );
      return { status: "done", verdict: c.verdict, overridden, sha, reason: c.reason, note: `Reviewed by \`${localModel}\` only: ${because}.` };
    }
    if (mayCheckOut) return reviewLocal(because);
    return fail(cfg.model, `the gateway refused the batch (HTTP 403: ${e.message}), and this pull request may not be checked out for the local model.`, OVER_BUDGET, "Re-run this job once the review budget allows it.");
  };

  const review = async (): Promise<Outcome> => {
    if (skipForLabel) return skipOverridden();
    if (openai) return reviewOpenAI();
    if (router && !plan.claude) return reviewLocal();
    try {
      if (router && plan.local) {
        // The batch is queued first, so it runs while the local model reads the checkout.
        if (!job) {
          job = await submit(0, cfg.model);
          if (!job) return await outOfCredit(cfg.model, keysWhy);
          await queue(job);
        }
        companion = await localPass();
      }
      return combine(await reviewAnthropic());
    } catch (e) {
      if (e instanceof RouterRefused) return refusedByRouter(e);
      if (router && e instanceof Anthropic.APIError && e.status === 401) return refusedByRouter(new RouterRefused("token", e.message));
      if (!(e instanceof AnthropicDown)) throw e;
      log.warning(`${e.reason}: ${e.message}`);
      job = null;
      return reviewOpenAI(e.reason);
    }
  };

  try {
    return await review();
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    // A submitted batch stays collectable: keep the pending state and say what went wrong.
    if (job)
      await upsert(
        { status: "pending", sha, batch: job.batch, key: slots[job.slot].fp, model: job.model, submitted: job.submitted },
        `${header(job.model)}⏳ Batch \`${job.batch}\` is queued, but the job hit an error (\`${why.slice(0, 300)}\`). Re-run the workflow to collect the result.`,
      ).catch(() => {});
    else await fail(running.model, `the job hit an error: \`${why.slice(0, 300)}\``, crashReason(e), RETRY, running.local).catch(() => {});
    throw e;
  }
}

const RETRY = "Re-run this job to try again.";
const NO_TOKEN = "the review token is not set up";
const TOKEN_NEXT = "Set the `router-token` input to the gateway's review token, then re-run this job.";
const OVER_BUDGET = "over the review budget";
/** How long a canceled batch gets to end (its request may already be running) before the direct request. */
const CANCEL_SETTLE_MS = 30_000;
const FORCE = "Re-run with force to redo it.";
const OUT_OF_CREDIT = "out of API credit";
const EMPTY_ANSWER = "the model gave an empty answer";
const NO_VERDICT = "the answer has no verdict line";

/** The gateway's refusal: an unknown token (401), or a batch over the review client's budget (403). */
class RouterRefused extends Error {
  constructor(
    readonly kind: "token" | "budget",
    detail: string,
  ) {
    super(detail);
  }
}

interface LocalPass {
  section: string;
  verdict: Verdict;
  reason?: string;
}

/** Backend router: the model id the gateway takes for a Claude tier. */
function tierModel(tier: Exclude<Tier, "local">): string {
  return tier === "opus" ? input("opus-model", "claude-opus-5-5") : input("sonnet-model", "claude-sonnet-5-5");
}

function tierRules() {
  const forced = input("tier", "auto") as TierInput;
  if (forced !== "auto" && !TIERS.includes(forced)) throw new Error(`Input tier must be auto, local, sonnet or opus, got "${forced}".`);
  const list = (name: string, fallback: string) =>
    input(name, fallback)
      .split(/[\n,]/)
      .map((x) => x.trim())
      .filter(Boolean);
  return {
    forced,
    secondOpinionLabel: input("second-opinion-label", "needs 2nd opinion"),
    opusLabels: list("opus-labels", "security"),
    opusAuthors: list("opus-authors", ""),
    sonnetFloorOwners: list("sonnet-floor-owners", "WhistleSafe"),
    localMaxLines: num("local-max-lines", 150, true),
  };
}

/** The Anthropic API cannot take the request now (after the SDK's own retries); a fallback can review instead. */
class AnthropicDown extends Error {
  constructor(
    readonly reason: string,
    detail: string,
  ) {
    super(detail);
  }
}

/**
 * Rate-limited (429), overloaded (529), failing (5xx) or unreachable, after the SDK's retries: a
 * re-run later may work, the fallback works now. Null for errors in the request itself (other 4xx),
 * which a fallback would only hide.
 */
export function apiDown(e: unknown): string | null {
  if (e instanceof Anthropic.APIConnectionError) return "the Anthropic API is unreachable";
  if (!(e instanceof Anthropic.APIError)) return null;
  // An error event in the middle of a streamed answer carries no status, only its type.
  if (e.status === undefined)
    return e.type === "overloaded_error"
      ? "the Anthropic API is overloaded"
      : e.type === "api_error"
        ? "the Anthropic API failed"
        : e.type === "rate_limit_error"
          ? "the Anthropic API is rate-limited"
          : null;
  if (e.status === 429) return "the Anthropic API is rate-limited";
  if (e.status === 529) return "the Anthropic API is overloaded";
  return e.status >= 500 ? `the Anthropic API failed (HTTP ${e.status})` : null;
}

/** A 429, or a streamed answer that broke off with a rate-limit error event. */
function rateLimited(e: InstanceType<typeof Anthropic.APIError>): boolean {
  return e.status === 429 || (e.status === undefined && e.type === "rate_limit_error");
}

function crashReason(e: unknown): string {
  return apiDown(e) ?? "the job hit an error";
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function parseVerdict(text: string): Verdict {
  // ⚠ may come with or without the U+FE0F variation selector.
  const m = /\*\*Verdict:\*\*\s*(✅|⚠\uFE0F?|❌)/u.exec(text);
  return !m ? "unknown" : m[1] === "✅" ? "pass" : m[1] === "❌" ? "changes" : "minor";
}

function num(name: string, fallback: number, zero = false): number {
  const raw = input(name, String(fallback));
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || (n === 0 && !zero)) throw new Error(`Input ${name} must be a ${zero ? "non-negative" : "positive"} number, got "${raw}".`);
  return n;
}

/** Out of credit, at a spend limit, revoked or not allowed: move on to the next key. */
export function keyUnusable(status: number | undefined, type: string | null | undefined, message: string): boolean {
  if (status === 401 || status === 402 || status === 403) return true;
  if (type === "billing_error" || type === "authentication_error" || type === "permission_error") return true;
  // Only the message tells these apart from other errors of their type: an empty balance (400
  // invalid_request_error), a spend limit the account set ("You have reached your specified API usage
  // limits", 400) and the tier's monthly spend cap ("You have reached your API usage limits", a 429
  // rate_limit_error without retry-after that fails until the month ends).
  return /credit balance|API usage limits/i.test(message);
}

async function waitForBatch(client: Anthropic, id: string, deadline: number, sleep: (ms: number) => Promise<void>) {
  for (let i = 0; ; i++) {
    const batch = await client.messages.batches.retrieve(id);
    if (batch.processing_status === "ended") return batch;
    if (Date.now() >= deadline) return null;
    if (i % 4 === 0) log.info(`Batch ${id}: ${batch.processing_status}…`);
    // Never sleeps far past the deadline, so `sync-after-minutes` is kept to the second.
    await sleep(Math.min(i < 8 ? 15_000 : 30_000, Math.max(1_000, deadline - Date.now())));
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

/** The footer of a review the Messages API gave directly, at full price, because the batch was slow. */
function syncFooter(msg: Anthropic.Messages.Message, why: string, seconds: number, slot: number, keyCount: number, ctx: ReviewContext): string {
  const u = msg.usage;
  const input = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const price = PRICES[msg.model];
  const cost = price ? ` · ≈ $${((input * price[0] + u.output_tokens * price[1]) / 1e6).toFixed(3)} (full price)` : "";
  return (
    `---\n<sub>Messages API, synchronous: ${why} · ${ctx.files} files · ${input.toLocaleString("en")} in / ${u.output_tokens.toLocaleString("en")} out tokens${cost}` +
    ` · took ${duration(seconds)} · key ${slot + 1}/${keyCount} · ${LINK}</sub>${omittedList(ctx)}`
  );
}

/** The answer is empty, or ran out of output tokens before its verdict line. */
function thoughtOut(a: ChatAnswer): boolean {
  return !a.text || (a.truncated && parseVerdict(a.text) === "unknown");
}

/** The effort a retry uses, whatever the first request asked for: `low` again when that was it. */
const RETRY_EFFORT = "low";
/** A retry needs at least this much of `max-wait-minutes` left. */
const MIN_RETRY_MS = 60_000;

function openaiFooter(a: ChatAnswer, ctx: ReviewContext, retried: string): string {
  return (
    `---\n<sub>OpenAI-compatible API · ${ctx.files} files · ${a.inputTokens.toLocaleString("en")} in / ${a.outputTokens.toLocaleString("en")} out tokens` +
    ` · took ${duration(Math.round(a.ms / 1000))}${retried} · ${LINK}</sub>${omittedList(ctx)}`
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
  pull_request?: { number: number; labels?: { name: string }[]; head?: { sha: string } };
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

const VERDICT_NAMES: Record<Verdict, string> = { pass: "✅ Looks good", minor: "⚠️ Minor issues", changes: "❌ Changes needed", unknown: "no verdict" };

/** One line on the outcome: "No review: <why>" without a usable review, else the verdict. */
export function headline(o: Outcome, mode: Mode = "pass"): string {
  if (o.status !== "done") return `No review: ${o.reason ?? (o.status === "pending" ? "the batch is still running" : `the review ${o.status}`)}`;
  const via = o.fallbackModel ? ` (fallback: ${o.fallbackModel})` : "";
  // Only `pass` needs a verdict: elsewhere a review without one still counts.
  if ((!o.verdict || o.verdict === "unknown") && mode === "pass") return `No review: ${o.reason ?? NO_VERDICT}${via}`;
  return `Review: ${VERDICT_NAMES[o.verdict ?? "unknown"]}${via}`;
}

/** Why the gate blocks (the check's title) and what to do, or null when it lets the PR through. */
export function blocker(mode: Mode, o: Outcome): { title: string; next: string } | null {
  if (mode === "advisory") return null;
  const title = headline(o, mode);
  if (o.status !== "done") return { title, next: o.next ?? (o.status === "pending" ? "Re-run this job to collect the batch." : RETRY) };
  if (mode === "pass" && o.verdict === "changes") return { title, next: "Fix the findings and push." };
  if (mode === "pass" && o.verdict === "unknown") return { title, next: o.next ?? FORCE };
  return null;
}

/**
 * Puts the one-liner on this job's own check run, where the PR's checks list shows it. Needs
 * `checks: write`; without it the annotation and the job summary still carry the line.
 */
async function titleCheck(deps: Deps, shas: (string | undefined)[], title: string, text: string): Promise<void> {
  const runId = process.env.GITHUB_RUN_ID;
  const [owner, repo] = input("repository", process.env.GITHUB_REPOSITORY ?? "").split("/");
  if (!runId || !owner || !repo) return;
  const gh = new GitHub(input("github-token"), owner, repo, deps.fetch);
  try {
    for (const sha of new Set(shas.filter((s): s is string => !!s))) {
      const { check_runs } = await gh.json<{ check_runs: { id: number; details_url: string | null }[] }>(
        `/repos/${owner}/${repo}/commits/${sha}/check-runs?status=in_progress&per_page=100`,
      );
      // An Actions check run's id is its job's; its details URL names the workflow run.
      const mine = check_runs.filter((c) => c.details_url?.includes(`/actions/runs/${runId}/job/`));
      if (mine.length !== 1) continue;
      await gh.json(`/repos/${owner}/${repo}/check-runs/${mine[0].id}`, { method: "PATCH", body: JSON.stringify({ output: { title, summary: text } }) });
      return;
    }
    log.info("Found no single check run of this job to title.");
  } catch (e) {
    log.info(`Could not title the check run (the workflow needs \`checks: write\`): ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
  }
}

/**
 * Writes the verdict as a completed check run of its own (`check-name`) on the pull request's head,
 * where a ruleset can require it whatever the job is called and whichever event ran it.
 */
async function publishCheck(deps: Deps, name: string, sha: string | undefined, conclusion: "success" | "failure" | "neutral", title: string, text: string): Promise<void> {
  const [owner, repo] = input("repository", process.env.GITHUB_REPOSITORY ?? "").split("/");
  if (!name || !sha || !owner || !repo) return;
  const gh = new GitHub(input("github-token"), owner, repo, deps.fetch);
  try {
    await gh.json(`/repos/${owner}/${repo}/check-runs`, {
      method: "POST",
      body: JSON.stringify({ name, head_sha: sha, status: "completed", conclusion, output: { title, summary: text || title } }),
    });
  } catch (e) {
    log.warning(`Could not write the ${name} check run (the workflow needs \`checks: write\`): ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
  }
}

/** Runs the action and returns the process exit code. */
export async function main(deps: Deps = {}): Promise<number> {
  const mode = input("mode", "advisory") as Mode;
  const overrideLabel = input("override-label", "review-override");
  const backend = input("backend", "anthropic") as Backend;
  const fallback = input("fallback-backend") as Settings["fallback"];
  const event = readEvent();
  if (!["advisory", "complete", "pass"].includes(mode)) {
    log.error(`Input mode must be advisory, complete or pass, got "${mode}".`);
    return 1;
  }
  if (!["anthropic", "openai", "router"].includes(backend)) {
    log.error(`Input backend must be anthropic, openai or router, got "${backend}".`);
    return 1;
  }
  if (fallback && (fallback !== "openai" || backend !== "anthropic")) {
    log.error(`Input fallback-backend must be empty or openai, with backend anthropic; got "${fallback}" with backend ${backend}.`);
    return 1;
  }
  const label = `To merge anyway, add the \`${overrideLabel}\` label.`;
  const shas = [event.pull_request?.head?.sha, process.env.GITHUB_SHA];
  reviewedSha = undefined;
  const labelRun = /^(un)?labeled$/.test(event.action ?? "");
  const checkName = input("check-name", backend === "router" ? "Review" : "");
  try {
    const outcome = await run({ mode, overrideLabel, backend, fallback, event }, deps);
    setOutput("status", outcome.status);
    setOutput("verdict", outcome.verdict ?? "");
    if (outcome.exempt) {
      const title = `Not reviewed: ${outcome.exempt}`;
      summary(`### ${title}`);
      // Neutral passes a required check, as a skipped job does.
      await publishCheck(deps, checkName, outcome.sha, "neutral", title, "Bots' pull requests are not reviewed, except Renovate's major updates and the listed authors.");
      return 0;
    }
    const b = blocker(mode, outcome);
    const title = headline(outcome, mode);
    const overrides = `The \`${overrideLabel}\` label lets the pull request through.`;
    const way = !b ? "" : outcome.overridden ? overrides : [b.next, label].filter(Boolean).join(" ");
    summary(`### ${b && outcome.overridden ? `${title} (overridden by the label)` : title}\n\n${[way, outcome.note].filter(Boolean).join("\n\n")}`);
    const sha = outcome.sha ?? event.pull_request?.head?.sha;
    if (!b) {
      // A gate that reads the check, not the comment, still sees that the fallback reviewed.
      if (outcome.fallbackModel) await titleCheck(deps, [outcome.sha, ...shas], title, outcome.note ?? "");
      await publishCheck(deps, checkName, sha, "success", title, outcome.note ?? "");
      return 0;
    }
    if (outcome.overridden) {
      log.notice(`${b.title}. The \`${overrideLabel}\` label overrides it.`, b.title);
      await titleCheck(deps, [outcome.sha, ...shas], `${b.title} (overridden by the label)`, overrides);
      await publishCheck(deps, checkName, sha, "success", `${b.title} (overridden by the label)`, overrides);
      return 0;
    }
    log.error(`${b.title}. ${way}`, b.title);
    await titleCheck(deps, [outcome.sha, ...shas], b.title, way);
    // A finished review run may post its verdict any moment: a label run that knows none never writes over it.
    if (!outcome.undecided) await publishCheck(deps, checkName, sha, "failure", b.title, way);
    return 1;
  } catch (e) {
    setOutput("status", "failed");
    const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
    const title = `No review: ${crashReason(e)}`;
    // The event's labels are known even when run() fails, so a crash still honours the override.
    if (mode !== "advisory" && (event.pull_request?.labels ?? []).some((l) => l.name === overrideLabel)) {
      log.notice(`${msg}\nThe \`${overrideLabel}\` label overrides the failure.`, title);
      await publishCheck(deps, checkName, reviewedSha ?? event.pull_request?.head?.sha, "success", `${title} (overridden by the label)`, msg.split("\n")[0]);
      return 0;
    }
    summary(`### ${title}\n\n${RETRY} ${mode === "advisory" ? "" : label}`.trim());
    log.error(msg, title);
    if (mode !== "advisory") await titleCheck(deps, shas, title, `${RETRY} ${label}`);
    // A label run that crashed decided nothing: the review run's verdict stands.
    if (!labelRun) await publishCheck(deps, checkName, reviewedSha ?? event.pull_request?.head?.sha, mode === "advisory" ? "success" : "failure", title, `${RETRY} ${label}`);
    return 1;
  }
}
