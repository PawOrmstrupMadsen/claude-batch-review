import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { denyRules, parseResult, rewriteBody, scrub, startRelay } from "../src/local.js";

describe("rewriteBody", () => {
  it("drops the billing line and folds a leading system message into the system prompt", () => {
    const b = rewriteBody({
      system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=1.2.3.abc;\nYou are Claude Code." }],
      messages: [
        { role: "system", content: "Agents: none." },
        { role: "user", content: "hi" },
      ],
    });
    assert.equal(b.system, "You are Claude Code.\n\nAgents: none.");
    assert.deepEqual(b.messages, [{ role: "user", content: "hi" }]);
  });

  it("attaches later system notes to the neighbouring user turn as reminders", () => {
    const b = rewriteBody({
      system: "S",
      messages: [
        { role: "user", content: "a" },
        { role: "system", content: "<total_tokens>5</total_tokens>" },
        { role: "assistant", content: "b" },
        { role: "system", content: "note" },
        { role: "user", content: [{ type: "text", text: "c" }] },
      ],
    });
    assert.deepEqual(b.messages, [
      { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "<system-reminder>\n<total_tokens>5</total_tokens>\n</system-reminder>" }] },
      { role: "assistant", content: "b" },
      { role: "user", content: [{ type: "text", text: "c" }, { type: "text", text: "<system-reminder>\nnote\n</system-reminder>" }] },
    ]);
  });
});

describe("denyRules", () => {
  it("denies the runner's credentials, temp and system folders", () => {
    const rules = denyRules({ HOME: "/home/gh", RUNNER_WORKSPACE: "/srv/runner/_work/repo" });
    for (const r of ["Read(//etc/**)", "Read(//home/gh/.*)", "Read(//srv/runner/.*)", "Read(//srv/runner/_work/_temp/**)", "Read(//srv/runner/_work/**/.env*)"])
      assert.ok(rules.includes(r), r);
    assert.ok(!rules.some((r) => r.includes("/tmp")), "the review's own files stay readable");
  });
});

describe("parseResult", () => {
  const run = (stdout: string) => ({ code: 0, stdout, stderr: "boom", timedOut: false });
  it("reads the last JSON line", () => {
    const r = parseResult(run('{"type":"system"}\n{"type":"result","result":" ok ","num_turns":3,"duration_ms":9000}\n'), 1);
    assert.deepEqual(r, { ok: true, answer: { text: "ok", turns: 3, ms: 9000 } });
  });
  it("tells no result, an error and an empty answer apart", () => {
    const none = parseResult(run(""), 1);
    assert.equal(!none.ok && none.reason, "the local model gave no answer");
    const err = parseResult(run('{"is_error":true,"result":"API Error"}'), 1);
    assert.equal(!err.ok && err.reason, "the local review failed");
    const empty = parseResult(run('{"result":"","num_turns":40}'), 1);
    assert.equal(!empty.ok && empty.reason, "the local model gave an empty answer");
  });
});

describe("scrub", () => {
  it("removes the pull request's instruction files, Claude Code config, MCP servers and links", () => {
    const d = mkdtempSync(join(tmpdir(), "scrub-"));
    mkdirSync(join(d, "a", ".claude"), { recursive: true });
    mkdirSync(join(d, ".claude"));
    mkdirSync(join(d, ".git"));
    mkdirSync(join(d, ".github", ".claude"), { recursive: true });
    for (const f of ["CLAUDE.md", "a/AGENTS.md", "a/CLAUDE.local.md", ".mcp.json", "a/.claude/x.json", "a/b.ts", ".git/CLAUDE.md", ".github/CLAUDE.md", ".github/.claude/x.json"])
      writeFileSync(join(d, f), "x");
    symlinkSync("/etc/hostname", join(d, "a", "link"));
    symlinkSync("/etc/hostname", join(d, ".github", "link"));
    scrub(d);
    assert.throws(() => lstatSync(join(d, "a", "link")), "symbolic links go");
    assert.throws(() => lstatSync(join(d, ".github", "link")), "under .github/ too");
    assert.ok(!existsSync(join(d, ".github", "CLAUDE.md")) && !existsSync(join(d, ".github", ".claude")), ".github/ is no .git/");
    assert.deepEqual(
      ["CLAUDE.md", "a/AGENTS.md", "a/CLAUDE.local.md", ".mcp.json", "a/.claude", ".claude", "a/b.ts", ".git/CLAUDE.md"].map((f) => existsSync(join(d, f))),
      [false, false, false, false, false, false, true, true],
    );
  });
});

describe("startRelay", () => {
  it("survives an upstream that drops the stream mid-answer", async () => {
    const up = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: ping\n\n");
      setTimeout(() => res.socket?.destroy(), 20);
    });
    await new Promise<void>((r) => up.listen(0, "127.0.0.1", r));
    const relay = await startRelay(`http://127.0.0.1:${(up.address() as { port: number }).port}`);
    try {
      const res = await fetch(`http://127.0.0.1:${relay.port}/v1/messages`, { method: "POST", body: "{}" });
      await res.text().catch(() => "");
      // The relay still answers the next request.
      const again = await fetch(`http://127.0.0.1:${relay.port}/v1/messages`, { method: "POST", body: "{}" }).catch(() => null);
      assert.ok(again);
      await again.text().catch(() => "");
    } finally {
      await relay.close();
      up.closeAllConnections();
      up.close();
    }
  });

  it("reshapes a messages body on its way upstream and streams the answer back", async () => {
    let seen: { path?: string; body?: unknown; auth?: string } = {};
    const up = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        seen = { path: req.url, body: JSON.parse(raw), auth: req.headers.authorization };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end("event: message_stop\ndata: {}\n\n");
      });
    });
    await new Promise<void>((r) => up.listen(0, "127.0.0.1", r));
    const addr = up.address() as { port: number };
    const relay = await startRelay(`http://127.0.0.1:${addr.port}`);
    try {
      const res = await fetch(`http://127.0.0.1:${relay.port}/v1/messages?beta=true`, {
        method: "POST",
        headers: { authorization: "Bearer local", "content-type": "application/json" },
        body: JSON.stringify({ model: "local", system: "x-anthropic-billing-header: a\nS", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "event: message_stop\ndata: {}\n\n");
      assert.equal(seen.path, "/v1/messages?beta=true");
      assert.equal(seen.auth, "Bearer local");
      assert.deepEqual(seen.body, { model: "local", system: "S", messages: [{ role: "user", content: "hi" }] });
    } finally {
      await relay.close();
      up.close();
    }
  });
});
