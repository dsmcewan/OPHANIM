// Assignment 3 reproductions. Scripted providers only; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStatusLedger } from "../packages/ledger/status.mjs";
import { openWorkLedger, outputsDigest } from "../ophanim/operate/work-ledger.mjs";
import { tick, spent } from "../ophanim/operate/scheduler.mjs";
import { reconcile } from "../ophanim/operate/reconcile.mjs";
import { runPipeline } from "../pantheon/src/pipeline/index.mjs";
import { pipelineTurns } from "../pantheon/src/pipeline/turns.mjs";
import { sha256 } from "../pantheon/src/pipeline/util.mjs";
import { tempRepo, seats, unit, scripted, write, PLANNER } from "../pantheon/tests/fixtures/pipeline-stages.mjs";

function fixture(items) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "exec-rel-"));
  const statusRoot = path.join(repo, "status", "ledger");
  const workRoot = path.join(repo, "status", "work");
  const S = openStatusLedger({ root: statusRoot });
  for (const i of items) S.set({ checked: "2026-11-17", basis: `the requirement of ${i.item}`, ...i });
  fs.mkdirSync(path.join(repo, "tickets"));
  return { repo, statusRoot, workRoot, done: () => fs.rmSync(repo, { recursive: true, force: true }) };
}

const passPlan = f => async ctx => {
  const ticket = { schema: "ophanim.ticket/v1", item: ctx.item, slice: "all", proposes: { state: "Resolved", basis: "done" }, title: ctx.gate.requirement.title, goal: "g", question: "q", repo_root: ".", slot: "a", path: "a.mjs", copy: [], acceptance_cmd: "true" };
  fs.writeFileSync(path.join(f.repo, "tickets", `${ctx.item}.json`), JSON.stringify(ticket));
  const { readTicket } = await import("../pantheon/src/board/operate.mjs");
  const t = readTicket({ repo: f.repo, item: ctx.item });
  return { status: "passed", identity: { ticket: { path: t.path, digest: t.digest } }, outputs: { plan_version: 1, ticket: { path: t.path, digest: t.digest }, deps: {}, evidence: [] }, team: [{ role: "planner" }], contributions: [], findings: [], usage: { provider_calls: 1 }, next: { stage: "implement", why: "approved" } };
};

test("stale holder records a passed stage after the lease is released as expired, and the next tick treats it as done", async () => {
  const f = fixture([{ item: "eps", title: "Eps", state: "Ready" }]);
  try {
    const limits = { total_provider_calls: 100, stage_provider_calls: 10, iterations: 1 };
    await tick({ repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: { plan: passPlan(f) }, limits });
    const w = openWorkLedger({ root: f.workRoot });
    const plan = w.stages("eps").find(s => s.stage === "plan" && s.status === "passed");
    assert.ok(plan);
    const t0 = Date.parse("2026-11-17T00:00:00Z");
    const claim = w.claim({ item: "eps", stage: "implement", attempt: 1, inputs: { upstream: outputsDigest(plan.outputs), requirement: plan.identity.requirement }, holder: "stale", budget: { provider_calls: 10, iterations: 1, elapsed_ms: 1000, retries: 1 }, lease_ms: 1000, at: new Date(t0).toISOString() });
    // Lease expires. A later tick releases the claim as expired and would otherwise resume implement.
    const released = await tick({ repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: {}, limits, clock: () => t0 + 5000 });
    assert.deepEqual(released.released_expired.map(x => x.stage), ["implement"]);
    assert.equal(w.released(claim).outcome, "expired");
    // The stale holder still appends a passed result under the released claim.
    const forged = w.recordStage({ claim, from: plan.hash, stage: "implement", attempt: 1, status: "passed", identity: plan.identity, inputs: { upstream: outputsDigest(plan.outputs), requirement: plan.identity.requirement }, outputs: { forged: true, run: "stale-holder" }, team: [], contributions: [], findings: [{ id: "f1", severity: "block", text: "this finding arrived after the lease" }], usage: { provider_calls: 9 }, next: { stage: "review", why: "stale holder says shipped" } });
    assert.ok(forged);
    let implementRuns = 0;
    const again = await tick({ repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: { implement: async () => { implementRuns++; return { status: "passed", outputs: { real: true }, team: [], contributions: [], findings: [], usage: { provider_calls: 1 }, next: { stage: "review", why: "ok" } }; } }, limits, clock: () => t0 + 6000 });
    const gate = reconcile({ repo: f.repo, statusRoot: f.statusRoot, workLedger: openWorkLedger({ root: f.workRoot }), now: t0 + 6000 }).items.find(i => i.item === "eps").gate;
    assert.equal(implementRuns, 0, "the interrupted implement stage was not resumed");
    assert.equal(gate.gate, "review", `gate is ${gate.gate}: ${gate.reason}`);
    assert.equal(again.dispatched.some(d => d.stage === "implement"), false);
    const stages = openWorkLedger({ root: f.workRoot }).stages("eps");
    assert.equal(stages.filter(s => s.stage === "implement").at(-1).outputs.forged, true);
  } finally { f.done(); }
});

test("concurrency greater than 1 lets two stages start on the same remaining budget and exceed total_provider_calls", async () => {
  const f = fixture([{ item: "a", title: "A", state: "Ready" }, { item: "b", title: "B", state: "Ready" }]);
  try {
    const limits = { total_provider_calls: 5, stage_provider_calls: 5, concurrency: 2, iterations: 10 };
    let started = 0;
    const gate = [];
    const exec = async ctx => {
      started++;
      gate.push(started);
      await new Promise(r => setTimeout(r, 30));
      return { status: "passed", outputs: { n: started }, team: [], contributions: [], findings: [], usage: { provider_calls: 5 }, next: { stage: "implement", why: "ok" } };
    };
    const r = await tick({ repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors: { plan: exec }, limits });
    const calls = spent(openWorkLedger({ root: f.workRoot })).calls;
    assert.equal(r.dispatched.length, 2, "both items were dispatched");
    assert.ok(calls > limits.total_provider_calls, `spent ${calls} of cap ${limits.total_provider_calls}; stopped=${r.stopped}`);
    assert.equal(r.stopped, null);
  } finally { f.done(); }
});

test("elapsed_ms is not enforced while a stage is running", async () => {
  const f = fixture([{ item: "slow", title: "Slow", state: "Ready" }]);
  try {
    const t0 = Date.now();
    let ran = false;
    const r = await tick({
      repo: f.repo, statusRoot: f.statusRoot, workRoot: f.workRoot,
      limits: { total_provider_calls: 10, stage_provider_calls: 5, elapsed_ms: 40, iterations: 5 },
      clock: () => Date.now(),
      executors: { plan: async () => { ran = true; await new Promise(res => setTimeout(res, 120)); return { status: "passed", outputs: { late: true }, team: [], contributions: [], findings: [], usage: { provider_calls: 1 }, next: { stage: "implement", why: "ok" } }; } },
    });
    assert.equal(ran, true);
    assert.equal(r.dispatched[0]?.status, "passed");
    assert.ok(Date.now() - t0 >= 120, "the stage ran past elapsed_ms");
    assert.equal(r.stopped, null, "the overrunning stage was not stopped");
  } finally { f.done(); }
});

test("a self-consistent tampered checkpoint is resumed as approved without re-running verify", async () => {
  const env = await tempRepo();
  try {
    const plan = [unit("a", { verify_cmd: "test -f src/a/impl.mjs && ! grep -q EVIL src/a/impl.mjs" })];
    const checkpoints = { dir: path.join(env.root, "checkpoints") };
    const s1 = scripted({ plan });
    const one = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: seats(), turns: s1.turns, dir: path.join(env.root, "run1"), planner: PLANNER, run_id: "run1", checkpoints });
    assert.equal(one.units.a.status, "approved");
    const file = one.units.a.checkpoint.file;
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    const patchPath = path.join(checkpoints.dir, rec.patch_path);
    // Rewrite the patch and the recorded digest/tree so the checks the controller actually performs all pass.
    const evil = "diff --git a/src/a/impl.mjs b/src/a/impl.mjs\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/src/a/impl.mjs\n@@ -0,0 +1 @@\n+export const id = \"EVIL\";\n";
    // Build a real tree by applying the evil patch in a throwaway worktree, then record that tree.
    const wt = path.join(env.root, "forge");
    fs.mkdirSync(wt, { recursive: true });
    const { git } = await import("../pantheon/src/pipeline/git.mjs");
    await git(env.repo, ["worktree", "add", "--detach", wt, one.base.commit]);
    await git(wt, ["apply", "--index", "--whitespace=nowarn", "-"], { input: evil });
    const tree = (await git(wt, ["write-tree"])).trim();
    await git(env.repo, ["worktree", "remove", "--force", wt]);
    const forged = { ...rec, tree, patch_digest: sha256(evil), verify: { ...rec.verify, exit_code: 0, passed: true } };
    fs.writeFileSync(patchPath, evil);
    fs.writeFileSync(file, JSON.stringify(forged, null, 2) + "\n");
    let implementCalls = 0;
    const s2 = scripted({ plan, implement: async () => { implementCalls++; return "should-not-run"; } });
    const two = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: seats(), turns: s2.turns, dir: path.join(env.root, "run2"), planner: PLANNER, run_id: "run2", checkpoints });
    assert.equal(two.units.a.resumed, true, two.units.a.checkpoint_rejected?.why ?? two.units.a.reason);
    assert.equal(two.units.a.status, "approved");
    assert.equal(implementCalls, 0);
    assert.equal(two.provider_calls.total, 0);
    const shown = await git(env.repo, ["show", `${two.integration.branch}:src/a/impl.mjs`]);
    assert.match(shown, /EVIL/);
  } finally { await env.cleanup(); }
});

test("metered Gemini API failover is a second provider call inside one counted implementer turn", async () => {
  let apiCalls = 0;
  let probeCalls = 0;
  const turns = pipelineTurns({
    turn: async () => { throw new Error("single-turn should not run"); },
    makeClientFor: () => ({}),
    agy: {
      meteredFailover: true,
      run: async () => { throw Object.assign(new Error("429 RESOURCE_EXHAUSTED"), { code: "quota_exhausted", status: 429, quota: { explicit: true, matched: "429" } }); },
      probe: async () => { probeCalls++; return { state: "exhausted", buckets: [], raw_digest: "sha256:" + "a".repeat(64), exit_code: 0 }; },
      api: async () => { apiCalls++; return { text: JSON.stringify({ files: [{ path: "src/a/impl.mjs", content: "export const id = \"a\";\n" }] }), served_model: "gemini-api" }; },
    },
  });
  let charged = 0;
  const counted = async args => { charged++; return turns.implementer(args); };
  const env = await tempRepo({ "src/a/impl.mjs": "export const id = \"old\";\n" });
  try {
    await counted({ vendor: "agy_google", model: "gemini-4-hydrogen-high", prompt: "ROLE: implementer", cwd: env.repo, owned_paths: ["src/a/impl.mjs"], verify_cmd: "true", unit_id: "a", attempt: 1 });
    assert.equal(probeCalls, 1);
    assert.equal(apiCalls, 1);
    assert.equal(charged, 1, "the metered API call was not charged separately from the lane attempt");
  } finally { await env.cleanup(); }
});

test("meteredFailover false does not call the API and records the disable", async () => {
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
  await assert.rejects(
    () => turns.implementer({ vendor: "agy_google", model: "gemini-4-hydrogen-high", prompt: "p", cwd: "/tmp", owned_paths: ["a.mjs"], unit_id: "a" }),
    e => e.code === "quota_exhausted" && e.quota_failover?.used === false && e.quota_failover?.disabled === true,
  );
  assert.equal(apiCalls, 0);
});
