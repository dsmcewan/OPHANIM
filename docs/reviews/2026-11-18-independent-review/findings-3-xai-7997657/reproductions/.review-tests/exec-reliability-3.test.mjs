import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStatusLedger } from "../packages/ledger/status.mjs";
import { openWorkLedger } from "../ophanim/operate/work-ledger.mjs";
import { git } from "../pantheon/src/pipeline/git.mjs";
import { readCheckpoint } from "../pantheon/src/pipeline/checkpoint.mjs";
import { tempRepo } from "../pantheon/tests/fixtures/pipeline-stages.mjs";

test("two processes: the ledger lock refuses a second live claim", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "exec-claim-"));
  const workRoot = path.join(repo, "work");
  openWorkLedger({ root: workRoot }).intake({ source: "status", ref: "status:one", item: "one", classification: "item", why: "fixture" });
  const child = path.join(repo, "claim.mjs");
  fs.writeFileSync(child, `
    import { openWorkLedger } from ${JSON.stringify(path.resolve("ophanim/operate/work-ledger.mjs"))};
    const w = openWorkLedger({ root: ${JSON.stringify(workRoot)}, create: false });
    try {
      const h = w.claim({ item: "one", stage: "plan", attempt: 1, inputs: { n: 1 }, holder: process.argv[2], budget: { provider_calls: 1, iterations: 1, elapsed_ms: 1000, retries: 1 }, lease_ms: 60_000 });
      process.stdout.write(JSON.stringify({ ok: true, hash: h }));
    } catch (e) {
      process.stdout.write(JSON.stringify({ ok: false, message: String(e.message) }));
    }
  `);
  const run = holder => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [child, holder], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", d => { out += d; });
    c.stderr.on("data", d => { err += d; });
    c.on("close", code => resolve({ code, out, err }));
  });
  try {
    const [a, b] = await Promise.all([run("a"), run("b")]);
    const parsed = [a, b].map(x => { try { return JSON.parse(x.out); } catch { return { ok: false, raw: x }; } });
    const oks = parsed.filter(x => x.ok);
    assert.equal(oks.length, 1, JSON.stringify({ a, b, parsed }));
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("orphan worktree and index.lock: what the next git command does", async () => {
  const env = await tempRepo();
  try {
    const wt = path.join(env.root, "orphan");
    await git(env.repo, ["worktree", "add", "--detach", wt, "HEAD"]);
    fs.rmSync(wt, { recursive: true, force: true });
    // Next bind to a different path still works; the registration is stale but not fatal.
    const wt2 = path.join(env.root, "next");
    await git(env.repo, ["worktree", "add", "--detach", wt2, "HEAD"]);
    const list = await git(env.repo, ["worktree", "list", "--porcelain"]);
    assert.match(list, /orphan/);
    // A lock left in the common git dir blocks commands that take the index.
    const gitDir = path.resolve(env.repo, (await git(env.repo, ["rev-parse", "--git-path", "index.lock"])).trim());
    // git-path of a missing lock still names where it would be; write it, then status.
    fs.writeFileSync(gitDir, "killed\n");
    let statusFailed = false;
    try { await git(env.repo, ["status", "--porcelain"]); } catch (e) { statusFailed = /index.lock|Unable to create/.test(e.message); }
    assert.equal(statusFailed, true, "index.lock should block git status");
  } finally { await env.cleanup(); }
});

test("a half-written checkpoint temp file is not a checkpoint", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
  try {
    const key = "sha256:" + "ab".repeat(32);
    fs.writeFileSync(path.join(dir, `${"ab".repeat(32)}.json.deadbeef.tmp`), "{not json");
    const got = await readCheckpoint({ dir, unit_key: key });
    assert.equal(got.found, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
