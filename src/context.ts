// Collects what the reviewer sees for one PR, within a character budget.
import { GitHub } from "./github.js";

export interface Pull {
  number: number;
  title: string;
  body: string | null;
  draft: boolean;
  html_url: string;
  user: { login: string };
  base: { sha: string; ref: string };
  head: { sha: string; ref: string };
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
  const parts: string[] = [];
  const add = (s: string) => {
    parts.push(s);
    budget -= s.length;
  };

  // Guidance comes from the base branch, so a PR cannot rewrite its own review instructions.
  for (const path of await guidancePaths(gh, pr, files, promptFile)) {
    const content = await gh.file(path, pr.base.sha);
    if (content === null) continue;
    add(`<repository_guidance path="${path}">\n${clip(content, MAX_GUIDANCE_CHARS)}\n</repository_guidance>\n`);
  }

  add(
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
  add(`<diff>\n${patches.map((p) => p.text).join("")}</diff>\n`);

  // Full post-change files, smallest first, while they fit.
  const candidates = files.filter((f) => f.status !== "removed" && f.patch !== undefined && !GENERATED.test(f.filename));
  const contents = await Promise.all(
    candidates.map(async (f) => ({ f, content: await gh.file(f.filename, pr.head.sha).catch(() => null) })),
  );
  contents.sort((a, b) => (a.content?.length ?? 0) - (b.content?.length ?? 0));
  for (const { f, content } of contents) {
    if (content === null) continue;
    const numbered = numberLines(content);
    if (content.length > MAX_FULL_FILE_CHARS || numbered.length > budget) {
      omitted.push(`full text of \`${f.filename}\``);
      continue;
    }
    add(`<file path="${f.filename}" ref="head">\n${numbered}</file>\n`);
  }

  return { text: parts.join("\n"), files: files.length, omitted };
}

async function guidancePaths(gh: GitHub, pr: Pull, files: PrFile[], promptFile: string): Promise<string[]> {
  const tree = await gh.json<{ tree: { path: string; type: string }[] }>(
    `/repos/${gh.owner}/${gh.repo}/git/trees/${pr.base.sha}?recursive=1`,
  );
  const present = new Set(tree.tree.filter((e) => e.type === "blob").map((e) => e.path));
  const dirs = new Set<string>([""]);
  for (const f of files) {
    const segs = f.filename.split("/").slice(0, -1);
    for (let i = 1; i <= segs.length; i++) dirs.add(segs.slice(0, i).join("/"));
  }
  const paths = [...dirs]
    .sort((a, b) => a.length - b.length)
    .flatMap((d) => GUIDANCE_NAMES.map((n) => (d ? `${d}/${n}` : n)))
    .filter((p) => present.has(p));
  for (const extra of [".github/claude-review.md", promptFile]) {
    if (extra && present.has(extra) && !paths.includes(extra)) paths.push(extra);
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
