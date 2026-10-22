// Which tier reviews a pull request (backend router), and which engines run it.

export type Tier = "local" | "sonnet" | "opus";
export type TierInput = "auto" | Tier;

export interface TierFacts {
  owner: string;
  author: { login: string; type?: string };
  labels: string[];
  title: string;
  headRef: string;
  files: { filename: string; additions: number; deletions: number }[];
  /** The tier the sticky comment recorded for an earlier round, and whether that round produced a review. */
  prior: { tier: Tier; reviewed: boolean } | null;
}

export interface TierRules {
  /** The `tier` input: `auto` applies the rules below; anything else is used as it is. */
  forced: TierInput;
  secondOpinionLabel: string;
  opusLabels: string[];
  opusAuthors: string[];
  /** Owners whose pull requests never get a gating review below `sonnet`. */
  sonnetFloorOwners: string[];
  /** A personal repository's pull request with at most this many changed lines goes `local`. */
  localMaxLines: number;
}

export interface TierChoice {
  tier: Tier;
  /** Both engines review: a local pass and a Claude pass. */
  secondOpinion: boolean;
  why: string;
}

export const TIERS: readonly Tier[] = ["local", "sonnet", "opus"];

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Docs, Markdown and changelog fragments: nothing that runs. */
export function docsOnly(paths: string[]): boolean {
  return paths.length > 0 && paths.every((p) => p.startsWith("docs/") || p.startsWith("changelog.d/") || /\.md$/i.test(p));
}

/** Renovate's major updates: its `major` label or branch, `(major)` in the title, or "to v5" without a minor version. */
export function renovateMajor(f: Pick<TierFacts, "author" | "labels" | "title" | "headRef">): boolean {
  if (!/^renovate(\[bot\])?$/i.test(f.author.login)) return false;
  return (
    f.labels.some((l) => same(l, "major")) ||
    /(^|\/)major-/i.test(f.headRef) ||
    /\(major\)/i.test(f.title) ||
    /\bto v?\d+$/i.test(f.title.trim())
  );
}

export function chooseTier(f: TierFacts, r: TierRules): TierChoice {
  const floored = (c: TierChoice): TierChoice =>
    c.tier === "local" && r.sonnetFloorOwners.some((o) => same(o, f.owner))
      ? { ...c, tier: "sonnet", why: `${c.why}; ${f.owner} reviews never go below sonnet` }
      : c;
  if (r.forced !== "auto") return floored({ tier: r.forced, secondOpinion: false, why: "the tier input" });
  if (r.secondOpinionLabel && f.labels.some((l) => same(l, r.secondOpinionLabel)))
    return { tier: "opus", secondOpinion: true, why: `the \`${r.secondOpinionLabel}\` label` };
  const label = f.labels.find((l) => r.opusLabels.some((o) => same(o, l)));
  if (label) return { tier: "opus", secondOpinion: false, why: `the \`${label}\` label` };
  if (r.opusAuthors.some((a) => same(a, f.author.login))) return { tier: "opus", secondOpinion: false, why: `a pull request by ${f.author.login}` };
  if (renovateMajor(f)) return { tier: "opus", secondOpinion: false, why: "a Renovate major update" };
  if (f.prior?.reviewed) return floored({ tier: f.prior.tier, secondOpinion: false, why: "the tier of the earlier round" });
  const lines = f.files.reduce((n, x) => n + x.additions + x.deletions, 0);
  if (docsOnly(f.files.map((x) => x.filename))) return floored({ tier: "local", secondOpinion: false, why: "docs only" });
  if (lines <= r.localMaxLines) return floored({ tier: "local", secondOpinion: false, why: `${lines} changed lines` });
  return { tier: "sonnet", secondOpinion: false, why: `${lines} changed lines` };
}

export interface EnginePlan {
  /** Claude Code over a checkout of the pull request's head, with the local model. */
  local: boolean;
  /** The one-shot review by batch, on this tier; null for none. */
  claude: Exclude<Tier, "local"> | null;
  /** Why the plan differs from the tier, for the log and the comment. */
  note: string;
}

/**
 * Only a `pull_request` (or a dispatched run) from a branch of the same repository may check out the
 * pull request's code. A fork, or a `pull_request_target` run, never does: its local pass becomes a
 * one-shot `sonnet` review, which reads the pull request through the API only.
 */
export function planEngines(c: TierChoice, ctx: { event: string; fork: boolean }): EnginePlan {
  const checkout = !ctx.fork && (ctx.event === "pull_request" || ctx.event === "workflow_dispatch");
  const why = ctx.fork ? "a fork pull request" : `a ${ctx.event || "unknown"} run`;
  if (c.tier === "local")
    return checkout
      ? { local: true, claude: null, note: "" }
      : { local: false, claude: "sonnet", note: `${why} is never checked out, so sonnet reviews it instead of the local model` };
  if (c.secondOpinion && !checkout) return { local: false, claude: c.tier, note: `${why} is never checked out, so only the Claude pass runs` };
  return { local: c.secondOpinion, claude: c.tier, note: "" };
}

/** ❌ and no verdict outrank ⚠️, which outranks ✅. */
const RANK = { pass: 0, minor: 1, unknown: 2, changes: 3 } as const;
export type PassVerdict = keyof typeof RANK;
export function stricter(a: PassVerdict, b: PassVerdict): PassVerdict {
  return RANK[a] >= RANK[b] ? a : b;
}
