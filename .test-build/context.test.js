// tests/context.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// src/context.ts
var CHARS_PER_TOKEN = 3;
var MAX_FULL_FILE_CHARS = 15e4;
var MAX_GUIDANCE_CHARS = 4e4;
var GENERATED = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|packages\.lock\.json|Cargo\.lock|poetry\.lock|uv\.lock|go\.sum|composer\.lock|Gemfile\.lock)$|\.min\.(js|css)$|\.(map|snap)$/;
var GUIDANCE_NAMES = ["CLAUDE.md", "AGENTS.md"];
var FETCH_CONCURRENCY = 8;
async function buildContext(gh, pr, maxInputTokens, promptFile) {
  const repo = `/repos/${gh.owner}/${gh.repo}`;
  const files = await gh.paginate(`${repo}/pulls/${pr.number}/files`);
  const omitted = [];
  let budget = maxInputTokens * CHARS_PER_TOKEN;
  const guidance = [];
  const parts = [];
  const add = (into, s) => {
    into.push(s);
    budget -= s.length;
  };
  const baseTree = await tree(gh, pr.base.sha);
  for (const path of guidancePaths(baseTree.truncated ? null : baseTree.blobs, files, promptFile)) {
    const content = await gh.file(path, pr.base.sha);
    if (content === null) continue;
    add(guidance, `<repository_guidance path="${path}">
${clip(content, MAX_GUIDANCE_CHARS)}
</repository_guidance>
`);
  }
  add(
    parts,
    `<pull_request number="${pr.number}" author="${pr.user.login}" base="${pr.base.ref}" head="${pr.head.ref}">
<title>${pr.title}</title>
<description>
${clip(pr.body ?? "", 2e4)}
</description>
<changed_files>
${files.map((f) => `${f.status}	+${f.additions} -${f.deletions}	${f.previous_filename ? `${f.previous_filename} -> ` : ""}${f.filename}`).join("\n")}
</changed_files>
</pull_request>
`
  );
  const patches = files.map((f) => ({ f, text: patchText(f) }));
  const diffBudget = Math.floor(budget * 0.6);
  let diffSize = patches.reduce((n, p) => n + p.text.length, 0);
  for (const p of [...patches].sort((a, b) => b.text.length - a.text.length)) {
    if (diffSize <= diffBudget) break;
    const keep = Math.max(2e3, p.text.length - (diffSize - diffBudget));
    if (keep >= p.text.length) continue;
    diffSize -= p.text.length - keep;
    p.text = `${p.text.slice(0, keep)}
\u2026 [diff truncated: ${p.text.length - keep} more characters]
`;
    omitted.push(`part of the diff of \`${p.f.filename}\``);
  }
  for (const p of [...patches].sort((a, b) => a.text.length - b.text.length)) {
    if (diffSize <= diffBudget) break;
    const stub = `--- ${p.f.filename}
[diff not shown: over the token cap]
`;
    if (stub.length >= p.text.length) continue;
    diffSize -= p.text.length - stub.length;
    p.text = stub;
    omitted.push(`diff of \`${p.f.filename}\``);
  }
  add(parts, `<diff>
${patches.map((p) => p.text).join("")}</diff>
`);
  const sizes = new Map((await tree(gh, pr.head.sha)).blobs.map((e) => [e.path, e.size ?? 0]));
  const queue = files.filter((f) => f.status !== "removed" && f.patch !== void 0 && !GENERATED.test(f.filename)).map((f) => ({ f, size: sizes.get(f.filename) ?? 0 })).sort((a, b) => a.size - b.size);
  let reserved = 0;
  const picked = [];
  for (const q of queue) {
    const cost = Math.ceil(q.size * 1.1) + 64;
    if (q.size > MAX_FULL_FILE_CHARS || reserved + cost > budget) omitted.push(`full text of \`${q.f.filename}\``);
    else {
      picked.push(q);
      reserved += cost;
    }
  }
  const fetched = await mapLimit(picked, FETCH_CONCURRENCY, async ({ f }) => ({
    f,
    content: await gh.file(f.filename, pr.head.sha).catch(() => null)
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
    add(parts, `<file path="${f.filename}" ref="head">
${numbered}</file>
`);
  }
  return { guidance: guidance.join("\n"), text: parts.join("\n"), files: files.length, omitted };
}
async function tree(gh, sha) {
  const t = await gh.json(
    `/repos/${gh.owner}/${gh.repo}/git/trees/${sha}?recursive=1`
  );
  return { blobs: t.tree.filter((e) => e.type === "blob"), truncated: t.truncated };
}
function guidancePaths(blobs, files, promptFile) {
  const present = blobs ? new Set(blobs.map((e) => e.path)) : null;
  const has = (p) => present === null || present.has(p);
  const dirs = /* @__PURE__ */ new Set([""]);
  for (const f of files) {
    const segs = f.filename.split("/").slice(0, -1);
    for (let i = 1; i <= segs.length; i++) dirs.add(segs.slice(0, i).join("/"));
  }
  const paths = [...dirs].sort((a, b) => a.length - b.length).flatMap((d) => GUIDANCE_NAMES.map((n) => d ? `${d}/${n}` : n)).filter(has);
  for (const extra of [".github/claude-review.md", promptFile]) {
    if (extra && has(extra) && !paths.includes(extra)) paths.push(extra);
  }
  return paths;
}
function patchText(f) {
  const header = `--- ${f.previous_filename ?? f.filename}
+++ ${f.filename} (${f.status})
`;
  if (GENERATED.test(f.filename)) return `${header}[generated or lock file: +${f.additions} -${f.deletions}, diff not shown]
`;
  if (f.patch === void 0) return `${header}[binary or too large for the GitHub diff API]
`;
  return `${header}${f.patch}
`;
}
function numberLines(content) {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const width = String(lines.length).length;
  return lines.map((l, i) => `${String(i + 1).padStart(width)}| ${l}`).join("\n") + "\n";
}
function clip(s, max) {
  return s.length <= max ? s : `${s.slice(0, max)}
\u2026 [${s.length - max} more characters not shown]`;
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
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

// src/github.ts
var GitHub = class {
  constructor(token, owner, repo, fetchImpl = fetch) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this.fetchImpl = (input, init) => fetchImpl(input, init);
    this.api = process.env.GITHUB_API_URL || "https://api.github.com";
  }
  token;
  owner;
  repo;
  api;
  fetchImpl;
  async request(path, init = {}) {
    const url = path.startsWith("http") ? path : `${this.api}${path}`;
    const res = await this.fetchImpl(url, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: init.accept ?? "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "claude-batch-review",
        ...init.body ? { "content-type": "application/json" } : {}
      }
    });
    return res;
  }
  async json(path, init = {}) {
    const res = await this.request(path, init);
    if (!res.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
    return await res.json();
  }
  /** Follows `Link: rel="next"` up to `maxPages`. */
  async paginate(path, maxPages = 30) {
    const out = [];
    let next = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    for (let page = 0; next && page < maxPages; page++) {
      const res = await this.request(next);
      if (!res.ok) throw new Error(`GitHub GET ${next}: ${res.status} ${await res.text()}`);
      out.push(...await res.json());
      next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ?? null;
    }
    return out;
  }
  /** Raw file content at `ref`, or null when the path does not exist there. */
  async file(path, ref) {
    const res = await this.request(
      `/repos/${this.owner}/${this.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`,
      { accept: "application/vnd.github.raw" }
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub raw ${path}@${ref}: ${res.status}`);
    return await res.text();
  }
};

// tests/fake.ts
var VERDICT_PASS = "**Verdict:** \u2705 Looks good. Adds a thing.\n\n### Findings\nNo issues found.";
var World = class {
  pr = {
    number: 1,
    title: "Add a thing",
    body: "Adds a thing.",
    draft: false,
    html_url: "https://github.com/o/r/pull/1",
    user: { login: "paw" },
    labels: [],
    base: { sha: "base1", ref: "main" },
    head: { sha: "head1", ref: "feat" }
  };
  files = [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-x\n+y" }];
  /** Files per commit SHA. */
  trees = {
    base1: { "CLAUDE.md": "House rules.", "src/a.ts": "x\n" },
    head1: { "CLAUDE.md": "House rules.", "src/a.ts": "y\n" }
  };
  comments = [];
  batches = [];
  /** Per API key: how batch creation answers. */
  keys = {};
  /** Polls before a batch ends. */
  pollsToEnd = 1;
  /** The batch result for a request; defaults to a passing review. */
  result = () => succeeded(VERDICT_PASS);
  get comment() {
    return this.comments[0]?.body ?? "";
  }
  fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : void 0;
    if (url.host === "api.anthropic.com") return this.anthropic(url, method, headers.get("x-api-key") ?? "", body);
    return this.github(url, method, body);
  };
  anthropic(url, method, key, body) {
    const p = url.pathname;
    if (method === "POST" && p === "/v1/messages/batches") {
      const mode = this.keys[key] ?? "ok";
      if (mode === "billing") return error(402, "billing_error", "Your credit balance is too low to access the Anthropic API.");
      if (mode === "auth") return error(401, "authentication_error", "invalid x-api-key");
      const req = body.requests[0];
      const params = req.params;
      const b = { id: `msgbatch_${this.batches.length + 1}`, key, model: String(params.model), polls: 0, ended: false, canceled: false, params };
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
  batch(id) {
    const b = this.batches.find((x) => x.id === id);
    if (!b) throw new Error(`unknown batch ${id}`);
    return b;
  }
  github(url, method, body) {
    const p = url.pathname.replace(/^\/repos\/o\/r/, "");
    if (method === "GET" && p === "/pulls/1") return json(this.pr);
    if (method === "GET" && p === "/pulls/1/files") return json(this.files);
    let m = /^\/git\/trees\/([^/]+)$/.exec(p);
    if (method === "GET" && m) {
      const files = this.trees[m[1]] ?? {};
      return json({ truncated: false, tree: Object.entries(files).map(([path, c]) => ({ path, type: "blob", size: c.length })) });
    }
    m = /^\/contents\/(.+)$/.exec(p);
    if (method === "GET" && m) {
      const content = this.trees[url.searchParams.get("ref") ?? ""]?.[decodeURIComponent(m[1])];
      return content === void 0 ? new Response("Not Found", { status: 404 }) : new Response(content, { status: 200 });
    }
    if (method === "GET" && p === "/issues/1/comments") return json(this.comments);
    if (method === "POST" && p === "/issues/1/comments") {
      const c = { id: this.comments.length + 100, body: String(body.body), user: { login: "github-actions[bot]" } };
      this.comments.push(c);
      return json(c, 201);
    }
    m = /^\/issues\/comments\/(\d+)$/.exec(p);
    if (method === "PATCH" && m) {
      const c = this.comments.find((x) => x.id === Number(m[1]));
      c.body = String(body.body);
      return json(c);
    }
    return new Response(`no route ${method} ${p}`, { status: 404 });
  }
};
function succeeded(text, extra = {}) {
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
      usage: { input_tokens: 1e3, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      ...extra
    }
  };
}
function batchObject(b) {
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
    results_url: b.ended ? `https://api.anthropic.com/v1/messages/batches/${b.id}/results` : null
  };
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function error(status, type, message) {
  return json({ type: "error", error: { type, message } }, status);
}

// tests/context.test.ts
process.env.GITHUB_API_URL = "https://api.github.test";
var build = (w, maxTokens = 3e5, promptFile = "") => buildContext(new GitHub("t", "o", "r", w.fetch), w.pr, maxTokens, promptFile);
describe("buildContext", () => {
  it("takes guidance from the base commit, root and the changed file's directories", async () => {
    const w = new World();
    w.files = [{ filename: "src/deep/b.ts", status: "added", additions: 1, deletions: 0, patch: "@@ +1 @@\n+b" }];
    w.trees.base1 = { "CLAUDE.md": "root rules", "src/AGENTS.md": "src rules", "other/CLAUDE.md": "unrelated", ".github/claude-review.md": "review rules" };
    w.trees.head1 = { ...w.trees.base1, "src/deep/b.ts": "b\n", "src/AGENTS.md": "PR edit" };
    const c = await build(w);
    assert.match(c.guidance, /root rules/);
    assert.match(c.guidance, /src rules/);
    assert.match(c.guidance, /review rules/);
    assert.doesNotMatch(c.guidance, /unrelated|PR edit/);
  });
  it("numbers the lines of full files", async () => {
    const c = await build(new World());
    assert.match(c.text, /<file path="src\/a\.ts" ref="head">\n1\| y\n<\/file>/);
  });
  it("shows only counts for lock files", async () => {
    const w = new World();
    w.files.push({ filename: "package-lock.json", status: "modified", additions: 900, deletions: 800, patch: "huge" });
    w.trees.head1["package-lock.json"] = "{}";
    const c = await build(w);
    assert.match(c.text, /package-lock\.json \(modified\)\n\[generated or lock file: \+900 -800/);
    assert.doesNotMatch(c.text, /<file path="package-lock\.json"/);
  });
  it("cuts the largest patch first and lists what was left out", async () => {
    const w = new World();
    const big = "+" + "x".repeat(6e4);
    w.files = [
      { filename: "big.ts", status: "added", additions: 1, deletions: 0, patch: big },
      { filename: "small.ts", status: "added", additions: 1, deletions: 0, patch: "+s" }
    ];
    w.trees.head1 = { "big.ts": big, "small.ts": "s\n" };
    const c = await build(w, 1e4);
    assert.match(c.text, /\+s/);
    assert.match(c.text, /diff truncated/);
    assert.ok(c.omitted.includes("part of the diff of `big.ts`"));
    assert.ok(c.omitted.includes("full text of `big.ts`"));
  });
  it("stubs many small patches when they alone exceed the budget", async () => {
    const w = new World();
    w.files = Array.from({ length: 200 }, (_, i) => ({ filename: `f${i}.ts`, status: "added", additions: 1, deletions: 0, patch: "+" + "y".repeat(1500) }));
    w.trees.head1 = {};
    const c = await build(w, 2e4);
    assert.ok(c.text.length < 2e4 * 3, `context is ${c.text.length} chars`);
    assert.ok(c.omitted.some((o) => /^diff of `f\d+\.ts`$/.test(o)));
  });
  it("lists a full file whose fetch failed", async () => {
    const w = new World();
    w.files.push({ filename: "gone.ts", status: "modified", additions: 1, deletions: 0, patch: "+g" });
    const c = await build(w);
    assert.ok(c.omitted.includes("full text of `gone.ts` (fetch failed)") || c.omitted.includes("full text of `gone.ts`"));
  });
});
