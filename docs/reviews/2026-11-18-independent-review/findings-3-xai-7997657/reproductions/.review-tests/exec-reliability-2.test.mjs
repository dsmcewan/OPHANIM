// More assignment-3 reproductions: budget exceed details, failover-off, worktree interference, two-process claims.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStatusLedger } from "../packages/ledger/status.mjs";
import { openWorkLedger } from "../ophanim/operate/work-ledger.mjs";
import { tick, spent } from "../ophanim/operate/scheduler.mjs";
import { pipelineTurns } from "../pantheon/src/pipeline/turns.mjs";
import { git } from "../pantheon/src/pipeline/git.mjs";
import { tempRepo } from "../pantheon/tests/fixtures/pipeline-stages.mjs";

function fixture(items) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "exec-rel-"));
  const statusRoot = path.join(repo, "status", "ledger");
  const workRoot = path.join(repo, "status", "work");
  const S = openStatusLedger({ root: statusRoot });
  for (const i of items) S.set({ checked: "2026-11-17", basis: `the requirement of ${i.item}`, ...i });
  fs.mkdirSync(path.join(repo, "tickets"));
  return { repo, statusRoot, workRoot, done: () => fs.rmSync(repo, { recursive: true, force: true }) };
}

test("concurrent stages that exceed the budget are recorded passed; the stop does not unwind them", async () => {
  const f = fixture([{ item: "a", title: "A", state: "Ready" }, { item: "b", title: "B", state: "Ready" }]);
  try {
    const limits = { total_provider_calls: 5, stage_provider_calls: 5, concurrency: 2, iterations: 10 };
    const r = await tick({
      repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, limits,
      executors: { plan: async () => { await new Promise(res => setTimeout(res, 40)); return { status: "passed", outputs: { ok: true }, team: [], contributions: [], findings: [], usage: { provider_calls: 5 }, next: { stage: "implement", why: "ok" } }; } },
    });
    const w = openWorkLedger({ root: f.workRoot });
    const plans = w.stages().filter(s => s.stage === "plan");
    assert.equal(plans.length, 2);
    assert.deepEqual(plans.map(s => s.status), ["passed", "passed"]);
    assert.ok(spent(w).calls > limits.total_provider_calls, `spent ${spent(w).calls}`);
    assert.match(r.stopped ?? "", /provider-call budget/);
    assert.equal(r.dispatched.filter(d => d.status === "passed").length, 2);
  } finally { f.done(); }
});

test("a stage that overruns elapsed_ms is still recorded passed", async () => {
  const f = fixture([{ item: "slow", title: "Slow", state: "Ready" }]);
  try {
    const t0 = Date.now();
    const r = await tick({
      repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot,
      limits: { total_provider_calls: 10, stage_provider_calls: 5, elapsed_ms: 30, iterations: 5 },
      clock: () => Date.now(),
      executors: { plan: async () => { await new Promise(res => setTimeout(res, 80)); return { status: "passed", outputs: { late: true }, team: [], contributions: [], findings: [], usage: { provider_calls: 1 }, next: { stage: "implement", why: "ok" } }; } },
    });
    assert.ok(Date.now() - t0 >= 80);
    assert.equal(r.dispatched[0].status, "passed");
    assert.match(r.stopped ?? "", /elapsed limit/);
  } finally { f.done(); }
});

test("meteredFailover false never calls the API", async () => {
  const env = await tempRepo();
  const control = path.join(env.root, "control");
  fs.mkdirSync(control);
  let apiCalls = 0;
  const turns = pipelineTurns({
    turn: async () => ({ text: "", served_model: "x" }),
    agy: {
      meteredFailover: false,
      run: async () => { throw Object.assign(new Error("429 RESOURCE_EXHAUSTED"), { code: "quota_exhausted", status: 429, quota: { explicit: true, matched: "429" } }); },
      probe: async () => ({ state: "exhausted", buckets: [] }),
      api: async () => { apiCalls++; return { text: "{}", served_model: "gemini-api" }; },
    },
  });
  try {
    await assert.rejects(
      () => turns.implementer({ vendor: "agy_google", model: "gemini-4-hydrogen-high", prompt: "p", cwd: env.repo, control_dir: control, owned_paths: ["README.md"], unit_id: "a" }),
      e => e.code === "quota_exhausted" && e.quota_failover?.used === false && e.quota_failover?.disabled === true,
    );
    assert.equal(apiCalls, 0);
  } finally { await env.cleanup(); }
});

test("a leftover git index.lock from a killed git blocks the next worktree bind", async () => {
  const env = await tempRepo();
  try {
    const gitDir = (await git(env.repo, ["rev-parse", "--git-dir"])).trim();
    const lock = path.resolve(env.repo, gitDir, "index.lock");
    fs.writeFileSync(lock, "killed\n");
    await assert.rejects(() => git(env.repo, ["worktree", "add", "--detach", path.join(env.root, "wt"), "HEAD"]), /index.lock|Unable to create/);
  } finally { await env.cleanup(); }
});

test("two processes cannot both claim the same item while the lease is live", async () => {
  const f = fixture([{ item: "one", title: "One", state: "Ready" }]);
  const child = path.join(f.repo, "claim-child.mjs");
  fs.writeFileSync(child, `
    import { openWorkLedger } from ${JSON.stringify(path.join(process.cwd(), "ophanim/operate/work-ledger.mjs"))};
    const w = openWorkLedger({ root: ${JSON.stringify(f.workRoot)} });
    try {
      const h = w.claim({ item: "one", stage: "plan", attempt: 1, inputs: { n: 1 }, holder: process.argv[2], budget: { provider_calls: 1, iterations: 1, elapsed_ms: 1000, retries: 1 }, lease_ms: 60_000 });
      console.log(JSON.stringify({ ok: true, hash: h }));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, message: e.message }));
    }
  `);
  const run = holder => new Promise(resolve => {
    const c = spawn(process.execPath, [child, holder], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", d => { out += d; });
    c.on("close", () => resolve(JSON.parse(out)));
  });
  try {
    const [a, b] = await Promise.all([run("a"), run("b")]);
    const oks = [a, b].filter(x => x.ok);
    assert.equal(oks.length, 1, JSON.stringify([a, b]));
    assert.match([a, b].find(x => !x.ok).message, /already claimed/);
  } finally { f.done(); }
});
