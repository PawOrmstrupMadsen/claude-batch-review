import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildContext } from "../src/context.js";
import { GitHub } from "../src/github.js";
import { World } from "./fake.js";

process.env.GITHUB_API_URL = "https://api.github.test";
const build = (w: World, maxTokens = 300_000, promptFile = "") =>
  buildContext(new GitHub("t", "o", "r", w.fetch), w.pr, maxTokens, promptFile);

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
    const big = "+" + "x".repeat(60_000);
    w.files = [
      { filename: "big.ts", status: "added", additions: 1, deletions: 0, patch: big },
      { filename: "small.ts", status: "added", additions: 1, deletions: 0, patch: "+s" },
    ];
    w.trees.head1 = { "big.ts": big, "small.ts": "s\n" };
    const c = await build(w, 10_000);
    assert.match(c.text, /\+s/);
    assert.match(c.text, /diff truncated/);
    assert.ok(c.omitted.includes("part of the diff of `big.ts`"));
    assert.ok(c.omitted.includes("full text of `big.ts`"));
  });

  it("stubs many small patches when they alone exceed the budget", async () => {
    const w = new World();
    w.files = Array.from({ length: 200 }, (_, i) => ({ filename: `f${i}.ts`, status: "added", additions: 1, deletions: 0, patch: "+" + "y".repeat(1_500) }));
    w.trees.head1 = {};
    const c = await build(w, 20_000);
    assert.ok(c.text.length < 20_000 * 3, `context is ${c.text.length} chars`);
    assert.ok(c.omitted.some((o) => /^diff of `f\d+\.ts`$/.test(o)));
  });

  it("lists a full file whose fetch failed", async () => {
    const w = new World();
    w.files.push({ filename: "gone.ts", status: "modified", additions: 1, deletions: 0, patch: "+g" });
    const c = await build(w);
    assert.ok(c.omitted.includes("full text of `gone.ts` (fetch failed)") || c.omitted.includes("full text of `gone.ts`"));
  });
});
