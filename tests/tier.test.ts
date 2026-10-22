import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseTier, docsOnly, planEngines, renovateMajor, stricter, type TierFacts, type TierRules } from "../src/tier.js";

const rules: TierRules = {
  forced: "auto",
  secondOpinionLabel: "needs 2nd opinion",
  opusLabels: ["security"],
  opusAuthors: ["agent-bot"],
  sonnetFloorOwners: ["WhistleSafe"],
  localMaxLines: 150,
};
const facts = (over: Partial<TierFacts> = {}): TierFacts => ({
  owner: "paw",
  author: { login: "paw", type: "User" },
  labels: [],
  title: "Add a thing",
  headRef: "feat",
  files: [{ filename: "src/a.ts", additions: 100, deletions: 50 }],
  prior: null,
  ...over,
});
const big = [{ filename: "src/a.ts", additions: 120, deletions: 31 }];
const tier = (over: Partial<TierFacts> = {}, r: Partial<TierRules> = {}) => chooseTier(facts(over), { ...rules, ...r });

describe("chooseTier", () => {
  it("sends a small change in a personal repository local, up to the line limit", () => {
    assert.deepEqual(tier(), { tier: "local", secondOpinion: false, why: "150 changed lines" });
    assert.equal(tier({ files: big }).tier, "sonnet");
    assert.equal(tier({ files: big }, { localMaxLines: 200 }).tier, "local");
  });

  it("sends docs-only changes local whatever their size", () => {
    const docs = [
      { filename: "docs/a.txt", additions: 900, deletions: 0 },
      { filename: "README.md", additions: 50, deletions: 0 },
      { filename: "changelog.d/x.yml", additions: 3, deletions: 0 },
    ];
    assert.deepEqual(tier({ files: docs }), { tier: "local", secondOpinion: false, why: "docs only" });
    assert.equal(tier({ files: [...docs, ...big] }).tier, "sonnet");
  });

  it("never goes below sonnet for a floor owner, matched without case", () => {
    const t = tier({ owner: "whistlesafe" });
    assert.equal(t.tier, "sonnet");
    assert.match(t.why, /whistlesafe reviews never go below sonnet/);
    assert.equal(tier({ owner: "WhistleSafe", files: [{ filename: "docs/a.md", additions: 1, deletions: 0 }] }).tier, "sonnet");
    assert.equal(tier({ owner: "WhistleSafe", files: big }).tier, "sonnet");
  });

  it("gives the second-opinion label opus and both engines", () => {
    assert.deepEqual(tier({ labels: ["Needs 2nd Opinion"] }), { tier: "opus", secondOpinion: true, why: "the `needs 2nd opinion` label" });
  });

  it("gives a security label and the listed authors opus", () => {
    assert.deepEqual(tier({ labels: ["bug", "Security"] }), { tier: "opus", secondOpinion: false, why: "the `Security` label" });
    assert.equal(tier({ author: { login: "Agent-Bot", type: "User" } }).tier, "opus");
    assert.equal(tier({ author: { login: "someone", type: "User" } }).tier, "local");
  });

  it("gives Renovate's major updates opus, and its minor ones the usual rules", () => {
    const renovate = { login: "renovate[bot]", type: "Bot" };
    assert.equal(tier({ author: renovate, title: "Update dependency esbuild to v1" }).why, "a Renovate major update");
    assert.equal(tier({ author: renovate, title: "Update dependency esbuild to v0.29.0" }).tier, "local");
    assert.ok(renovateMajor({ author: renovate, labels: ["major"], title: "x", headRef: "x" }));
    assert.ok(renovateMajor({ author: renovate, labels: [], title: "x", headRef: "renovate/major-esbuild" }));
    assert.ok(renovateMajor({ author: renovate, labels: [], title: "chore(deps): update esbuild (major)", headRef: "x" }));
    assert.ok(!renovateMajor({ author: { login: "paw" }, labels: ["major"], title: "to v2", headRef: "x" }));
  });

  it("keeps an earlier round's tier, unless that round produced no review", () => {
    assert.deepEqual(tier({ prior: { tier: "sonnet", reviewed: true } }), { tier: "sonnet", secondOpinion: false, why: "the tier of the earlier round" });
    assert.equal(tier({ files: big, prior: { tier: "local", reviewed: true } }).tier, "local");
    assert.equal(tier({ prior: { tier: "sonnet", reviewed: false } }).tier, "local");
    // Labels and authors still raise it, and the floor still holds.
    assert.equal(tier({ labels: ["security"], prior: { tier: "local", reviewed: true } }).tier, "opus");
    assert.equal(tier({ owner: "WhistleSafe", prior: { tier: "local", reviewed: true } }).tier, "sonnet");
  });

  it("uses a forced tier as it is, within the floor", () => {
    assert.deepEqual(tier({ labels: ["needs 2nd opinion"] }, { forced: "sonnet" }), { tier: "sonnet", secondOpinion: false, why: "the tier input" });
    assert.equal(tier({ files: big }, { forced: "local" }).tier, "local");
    assert.equal(tier({ owner: "WhistleSafe" }, { forced: "local" }).tier, "sonnet");
  });
});

describe("docsOnly", () => {
  it("needs every path under docs/ or changelog.d/, or Markdown", () => {
    assert.ok(docsOnly(["docs/x.png", "a/b/C.MD", "changelog.d/b.md"]));
    assert.ok(!docsOnly(["docs/x.md", "src/a.ts"]));
    assert.ok(!docsOnly([]));
    assert.ok(!docsOnly(["mydocs/x.ts"]));
  });
});

describe("planEngines", () => {
  const local = { tier: "local" as const, secondOpinion: false, why: "" };
  const second = { tier: "opus" as const, secondOpinion: true, why: "" };
  it("checks a same-repository pull request out for the local model", () => {
    assert.deepEqual(planEngines(local, { event: "pull_request", fork: false }), { local: true, claude: null, note: "" });
    assert.deepEqual(planEngines(local, { event: "workflow_dispatch", fork: false }), { local: true, claude: null, note: "" });
  });
  it("never checks out a fork or a pull_request_target run: sonnet reviews instead", () => {
    const fork = planEngines(local, { event: "pull_request", fork: true });
    assert.equal(fork.local, false);
    assert.equal(fork.claude, "sonnet");
    assert.match(fork.note, /a fork pull request is never checked out/);
    const target = planEngines(local, { event: "pull_request_target", fork: false });
    assert.equal(target.local, false);
    assert.equal(target.claude, "sonnet");
    assert.match(target.note, /pull_request_target/);
  });
  it("runs both engines for a second opinion, and only Claude where no checkout is allowed", () => {
    assert.deepEqual(planEngines(second, { event: "pull_request", fork: false }), { local: true, claude: "opus", note: "" });
    const target = planEngines(second, { event: "pull_request_target", fork: false });
    assert.equal(target.local, false);
    assert.equal(target.claude, "opus");
  });
  it("runs sonnet and opus alone", () => {
    assert.deepEqual(planEngines({ tier: "sonnet", secondOpinion: false, why: "" }, { event: "pull_request", fork: true }), { local: false, claude: "sonnet", note: "" });
  });
});

describe("stricter", () => {
  it("ranks ❌ over no verdict over ⚠️ over ✅", () => {
    assert.equal(stricter("pass", "minor"), "minor");
    assert.equal(stricter("changes", "minor"), "changes");
    assert.equal(stricter("pass", "unknown"), "unknown");
    assert.equal(stricter("unknown", "changes"), "changes");
    assert.equal(stricter("pass", "pass"), "pass");
  });
});
