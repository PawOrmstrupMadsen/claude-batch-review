// Collects what the reviewer sees for one PR, within a character budget.
import { GitHub } from "./github.js";

export interface Pull {
  number: number;
  title: string;
  body: string | null;
  draft: boolean;
  labels: { name: string }[];
  html_url: string;
  user: { login: string };
  base: { sha: string; ref: string; repo?: { full_name: string } | null };
  head: { sha: string; ref: string; repo?: { full_name: string } | null };
}

interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  previous_filename?: string;
}

export interface ReviewContext {
  /** Base-commit guidance files; sent in the system prompt. */
  guidance: string;
  /** PR text, diff and files: untrusted, sent as the user turn. */
  text: string;
  files: number;
  omitted: string[];
}

const CHARS_PER_TOKEN = 3;
const MAX_FULL_FILE_CHARS = 150_000;
const MAX_GUIDANCE_CHARS = 40_000;
const GENERATED =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|packages\.lock\.json|Cargo\.lock|poetry\.lock|uv\.lock|go\.sum|composer\.lock|Gemfile\.lock)$|\.min\.(js|css)$|\.(map|snap)$/;
const GUIDANCE_NAMES = ["CLAUDE.md", "AGENTS.md"];
const FETCH_CONCURRENCY = 8;

interface TreeEntry {
  path: string;
  type: string;
  size?: number;
}

export async function buildContext(
  gh: GitHub,
  pr: Pull,
  maxInputTokens: number,
  promptFile: string,
): Promise<ReviewContext> {
  const repo = `/repos/${gh.owner}/${gh.repo}`;
  const files = await gh.paginate<PrFile>(`${repo}/pulls/${pr.number}/files`);
  const omitted: string[] = [];
  let budget = maxInputTokens * CHARS_PER_TOKEN;
  const guidance: string[] = [];
  const parts: string[] = [];
  const add = (into: string[], s: string) => {
    into.push(s);
    budget -= s.length;
  };

  // Guidance comes from the base commit, so a PR cannot rewrite its own review instructions.
  const baseTree = await tree(gh, pr.base.sha);
  for (const path of guidancePaths(baseTree.truncated ? null : baseTree.blobs, files, promptFile)) {
    const content = await gh.file(path, pr.base.sha);
    if (content === null) continue;
    add(guidance, `<repository_guidance path="${path}">\n${clip(content, MAX_GUIDANCE_CHARS)}\n</repository_guidance>\n`);
  }

  add(
    parts,
    `<pull_request number="${pr.number}" author="${pr.user.login}" base="${pr.base.ref}" head="${pr.head.ref}">\n` +
      `<title>${pr.title}</title>\n<description>\n${clip(pr.body ?? "", 20_000)}\n</description>\n` +
      `<changed_files>\n${files.map((f) => `${f.status}\t+${f.additions} -${f.deletions}\t${f.previous_filename ? `${f.previous_filename} -> ` : ""}${f.filename}`).join("\n")}\n</changed_files>\n</pull_request>\n`,
  );

  // The diff gets up to 60% of what is left; the largest patches are cut first.
  const patches = files.map((f) => ({ f, text: patchText(f) }));
  const diffBudget = Math.floor(budget * 0.6);
  let diffSize = patches.reduce((n, p) => n + p.text.length, 0);
  for (const p of [...patches].sort((a, b) => b.text.length - a.text.length)) {
    if (diffSize <= diffBudget) break;
    const keep = Math.max(2_000, p.text.length - (diffSize - diffBudget));
    if (keep >= p.text.length) continue;
    diffSize -= p.text.length - keep;
    p.text = `${p.text.slice(0, keep)}\n… [diff truncated: ${p.text.length - keep} more characters]\n`;
    omitted.push(`part of the diff of \`${p.f.filename}\``);
  }
  // Still over: many small patches. Replace the smallest with stubs until it fits.
  for (const p of [...patches].sort((a, b) => a.text.length - b.text.length)) {
    if (diffSize <= diffBudget) break;
    const stub = `--- ${p.f.filename}\n[diff not shown: over the token cap]\n`;
    if (stub.length >= p.text.length) continue;
    diffSize -= p.text.length - stub.length;
    p.text = stub;
    omitted.push(`diff of \`${p.f.filename}\``);
  }
  add(parts, `<diff>\n${patches.map((p) => p.text).join("")}</diff>\n`);

  // Full post-change files, smallest first (blob sizes from the head tree), while they fit.
  const sizes = new Map((await tree(gh, pr.head.sha)).blobs.map((e) => [e.path, e.size ?? 0]));
  const queue = files
    .filter((f) => f.status !== "removed" && f.patch !== undefined && !GENERATED.test(f.filename))
    .map((f) => ({ f, size: sizes.get(f.filename) ?? 0 }))
    .sort((a, b) => a.size - b.size);
  let reserved = 0;
  const picked: typeof queue = [];
  for (const q of queue) {
    // Line numbers add roughly 10 %.
    const cost = Math.ceil(q.size * 1.1) + 64;
    if (q.size > MAX_FULL_FILE_CHARS || reserved + cost > budget) omitted.push(`full text of \`${q.f.filename}\``);
    else {
      picked.push(q);
      reserved += cost;
    }
  }
  const fetched = await mapLimit(picked, FETCH_CONCURRENCY, async ({ f }) => ({
    f,
    content: await gh.file(f.filename, pr.head.sha).catch(() => null),
  }));
  for (const { f, content } of fetched) {
    if (content === null) {
      omitted.push(`full text of \`${f.filename}\` (fetch failed)`);
      continue;
    }
    const numbered = numberLines(content);
    if (numbered.length > budget) {
      omitted.push(`full text of \`${f.filename}\``);
      continue;
    }
    add(parts, `<file path="${f.filename}" ref="head">\n${numbered}</file>\n`);
  }

  return { guidance: guidance.join("\n"), text: parts.join("\n"), files: files.length, omitted };
}

async function tree(gh: GitHub, sha: string): Promise<{ blobs: TreeEntry[]; truncated: boolean }> {
  const t = await gh.json<{ tree: TreeEntry[]; truncated: boolean }>(
    `/repos/${gh.owner}/${gh.repo}/git/trees/${sha}?recursive=1`,
  );
  return { blobs: t.tree.filter((e) => e.type === "blob"), truncated: t.truncated };
}

/** Candidate guidance paths; with no listing (truncated tree) every candidate is tried and 404s skipped. */
function guidancePaths(blobs: TreeEntry[] | null, files: PrFile[], promptFile: string): string[] {
  const present = blobs ? new Set(blobs.map((e) => e.path)) : null;
  const has = (p: string) => present === null || present.has(p);
  const dirs = new Set<string>([""]);
  for (const f of files) {
    const segs = f.filename.split("/").slice(0, -1);
    for (let i = 1; i <= segs.length; i++) dirs.add(segs.slice(0, i).join("/"));
  }
  const paths = [...dirs]
    .sort((a, b) => a.length - b.length)
    .flatMap((d) => GUIDANCE_NAMES.map((n) => (d ? `${d}/${n}` : n)))
    .filter(has);
  for (const extra of [".github/claude-review.md", promptFile]) {
    if (extra && has(extra) && !paths.includes(extra)) paths.push(extra);
  }
  return paths;
}

function patchText(f: PrFile): string {
  const header = `--- ${f.previous_filename ?? f.filename}\n+++ ${f.filename} (${f.status})\n`;
  if (GENERATED.test(f.filename)) return `${header}[generated or lock file: +${f.additions} -${f.deletions}, diff not shown]\n`;
  if (f.patch === undefined) return `${header}[binary or too large for the GitHub diff API]\n`;
  return `${header}${f.patch}\n`;
}

function numberLines(content: string): string {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const width = String(lines.length).length;
  return lines.map((l, i) => `${String(i + 1).padStart(width)}| ${l}`).join("\n") + "\n";
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… [${s.length - max} more characters not shown]`;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
