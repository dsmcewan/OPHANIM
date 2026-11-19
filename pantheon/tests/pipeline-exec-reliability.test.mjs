// Execution reliability of the five-stage pipeline: the defects an independent review found, as regressions. Each
// test asserts the CORRECT behaviour; each failed on the code the review read (commit 7997657).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runPipeline } from "../src/pipeline/index.mjs";
import { pipelineTurns } from "../src/pipeline/turns.mjs";
import { git } from "../src/pipeline/git.mjs";
import { sha256 } from "../src/pipeline/util.mjs";
import { tempRepo, seats, unit, scripted, sh, PLANNER } from "./fixtures/pipeline-stages.mjs";

const QUOTA = () => Object.assign(new Error("429 RESOURCE_EXHAUSTED"), { code: "quota_exhausted", status: 429, quota: { explicit: true, matched: "429" } });
const API_FILES = JSON.stringify({ files: [{ path: "src/a/impl.mjs", content: "export const id = \"a\";\n" }] });

// Independent review, assignment 3 (xAI grok-4.7, 7997657), question 1: the metered Gemini API call made after a
// lane quota refusal sat inside the one charge of the implementer turn (charged === 1 with two provider calls). The
// adapter now calls the pipeline's charge() BEFORE the API call; a refused charge means the API is not called.
test("metered failover: the API call is charged on its own, before it is made, and a refused charge stops it", async t => {
  const env = await tempRepo({ "src/a/impl.mjs": "export const id = \"old\";\n" }); t.after(env.cleanup);
  const control = join(env.root, "control"); mkdirSync(control);
  const order = [];
  const turns = pipelineTurns({
    turn: async () => { throw new Error("no single-turn seat here"); },
    agy: { meteredFailover: true, run: async () => { order.push("lane"); throw QUOTA(); },
      probe: async () => ({ state: "exhausted", buckets: [], raw_digest: "sha256:" + "a".repeat(64), exit_code: 0 }),
      api: async () => { order.push("api"); return { text: API_FILES, served_model: "gemini-api" }; } },
  });
  const args = { vendor: "agy_google", model: "gemini-4-hydrogen-high", prompt: "ROLE: implementer", cwd: env.repo, control_dir: control, owned_paths: ["src/a/impl.mjs"], verify_cmd: "true", unit_id: "a", attempt: 1 };
  const r = await turns.implementer({ ...args, charge: () => order.push("charge") });
  assert.equal(r.transport, "api");
  assert.deepEqual(order, ["lane", "charge", "api"], "the API call is charged before it is made");
  order.length = 0;
  await assert.rejects(() => turns.implementer({ ...args, charge: () => { order.push("charge"); throw Object.assign(new Error("bound exhausted"), { code: "PROVIDER_LIMIT" }); } }),
    e => e.code === "PROVIDER_LIMIT");
  assert.deepEqual(order, ["lane", "charge"], "a refused charge: the metered API is not called");
});

// Same question, at the pipeline: the `charge` the implementer turn receives is the run's own `counted` admission:
// it counts toward max_provider_calls (by_role.metered_failover) and is refused past the bound, before the call.
test("runPipeline: a failover call inside an implementer turn is counted and bounded by max_provider_calls", async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  const plan = [unit("a")];
  const charged = [];
  const s = scripted({ plan, implement: async (args) => { charged.push(args.charge()); await sh(`mkdir -p src/a && echo 'export const id = "a";' > src/a/impl.mjs`, args.cwd); return "done"; } });
  const out = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: seats(), turns: s.turns, dir: join(env.root, "run"), planner: PLANNER, limits: { max_provider_calls: 10 } });
  assert.equal(out.units.a.status, "approved");
  assert.equal(out.provider_calls.by_role.metered_failover, 1);
  assert.equal(out.provider_calls.total, 4, "dispatcher + implementer + its failover call + reviewer");
  // At the bound: dispatcher (1) + implementer (2) leaves nothing for the failover call: refused, never made.
  const s2 = scripted({ plan, implement: async (args) => { args.charge(); return "unreachable"; } });
  const capped = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: seats(), turns: s2.turns, dir: join(env.root, "run2"), planner: PLANNER, limits: { max_provider_calls: 2 } });
  assert.equal(capped.provider_calls.total, 2);
  assert.equal(capped.provider_calls.refused_at_limit, 1);
  assert.notEqual(capped.units.a.status, "approved");
});

// Question 1/8 at the pipeline edge: every counted call is first offered to the caller's charge (the work ledger's
// spend); a refused charge refuses the call.
test("runPipeline: onCharge is called before every counted call, and a throwing charge refuses the call", async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  const plan = [unit("a")];
  const seen = [];
  const s = scripted({ plan });
  // Seats that take the per-request contract (L-301): each admits its call before sending it.
  const turns = Object.fromEntries(Object.entries(s.turns).map(([k, f]) => [k, async a => { a.admitRequest(); return f(a); }]));
  const out = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: seats(), turns, dir: join(env.root, "run"), planner: PLANNER,
    onCharge: ({ role }) => { seen.push(role); if (seen.length > 1) throw new Error("the stage budget is spent"); } });
  assert.deepEqual(seen, ["dispatcher", "implementer"]);
  assert.equal(out.provider_calls.total, 1);
  assert.equal(s.calls.length, 1, "the refused implementer call was never made");
  assert.notEqual(out.units.a.status, "approved");
});

// Question 7: a checkpoint whose patch, digest and tree were rewritten consistently (to write EVIL) was resumed as
// approved with zero provider calls and merged EVIL, although the unit's own verify_cmd fails on it. The resume now
// re-runs verify_cmd on the rebuilt tree: ground truth wins, the checkpoint is rejected, and the unit runs normally.
test("a self-consistent forged checkpoint whose verify_cmd fails is rejected and the unit re-runs", async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  const plan = [unit("a", { verify_cmd: "test -f src/a/impl.mjs && ! grep -q EVIL src/a/impl.mjs" })];
  const checkpoints = { dir: join(env.root, "checkpoints") };
  const one = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: seats(), turns: scripted({ plan }).turns, dir: join(env.root, "run1"), planner: PLANNER, run_id: "run1", checkpoints });
  assert.equal(one.units.a.status, "approved");
  const file = one.units.a.checkpoint.file;
  const rec = JSON.parse(readFileSync(file, "utf8"));
  assert.match(rec.review_digest, /^sha256:[0-9a-f]{64}$/, "the approval is bound by the Stage 5 review record's digest");
  const evil = "diff --git a/src/a/impl.mjs b/src/a/impl.mjs\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/src/a/impl.mjs\n@@ -0,0 +1 @@\n+export const id = \"EVIL\";\n";
  const wt = join(env.root, "forge");
  await git(env.repo, ["worktree", "add", "--detach", wt, one.base.commit]);
  await git(wt, ["apply", "--index", "--whitespace=nowarn", "-"], { input: evil });
  const tree = (await git(wt, ["write-tree"])).trim();
  await git(env.repo, ["worktree", "remove", "--force", wt]);
  writeFileSync(join(checkpoints.dir, rec.patch_path), evil);
  writeFileSync(file, JSON.stringify({ ...rec, tree, patch_digest: sha256(evil) }, null, 2) + "\n");
  const s2 = scripted({ plan });
  const two = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: seats(), turns: s2.turns, dir: join(env.root, "run2"), planner: PLANNER, run_id: "run2", checkpoints });
  assert.equal(two.units.a.resumed, false);
  assert.match(two.units.a.checkpoint_rejected?.why ?? "", /verify_cmd fails/);
  assert.equal(two.units.a.status, "approved", "the unit ran normally");
  assert.ok(two.provider_calls.total > 0);
  assert.doesNotMatch(await git(env.repo, ["show", `${two.integration.branch}:src/a/impl.mjs`]), /EVIL/);
});

// Question 8: incremental pipeline.json writes swallowed their errors, so a run could carry on with no record. A
// failed write now surfaces: the run rejects with code RECORD_WRITE.
test("a pipeline.json that cannot be written fails the run instead of being swallowed", async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  const dir = join(env.root, "run");
  mkdirSync(join(dir, "pipeline.json", "occupied"), { recursive: true });   // rename onto a non-empty directory fails
  const plan = [unit("a")];
  await assert.rejects(() => runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: seats(), turns: scripted({ plan }).turns, dir, planner: PLANNER }),
    e => e.code === "RECORD_WRITE");
});
