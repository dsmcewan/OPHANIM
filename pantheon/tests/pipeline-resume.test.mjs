// Unit resume via checkpoints: an approved unit is kept across runs of the same item and re-verified before use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runPipeline, unitKey, CHECKPOINT_SCHEMA } from "../src/pipeline/index.mjs";
import { tempRepo, seats, unit, scripted, sh, write, PLANNER } from "./fixtures/pipeline-stages.mjs";

const PLAN = [unit("a"), unit("b"), unit("c", { depends_on: ["a"], verify_cmd: "test -f src/a/impl.mjs && test -f src/c/impl.mjs" })];
const laneError = () => Object.assign(new Error("lane down"), { code: "lane_failure", kind: "exit" });
const good = async args => { await write(args.cwd, `src/${args.unit_id}/impl.mjs`, `export const id = ${JSON.stringify(args.unit_id)};\n`); return "done"; };
const failB = async args => { if (args.unit_id === "b") throw laneError(); return good(args); };

const go = async (env, name, implement, checkpoints) => {
  const s = scripted({ plan: PLAN, implement });
  const out = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: PLAN }, seats: seats(), turns: s.turns, dir: join(env.root, name), planner: PLANNER, run_id: name, ...(checkpoints ? { checkpoints } : {}) });
  return { out, calls: s.calls, tree: out.integration ? (await sh(`git rev-parse ${out.integration.branch}^{tree}`, env.repo)).trim() : null };
};

test("run 2 resumes the approved units with zero provider calls, runs the one that failed, and integrates the same tree as a clean run", async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  const checkpoints = { dir: join(env.root, "checkpoints") };
  const one = await go(env, "run1", failB, checkpoints);
  assert.deepEqual(Object.fromEntries(Object.values(one.out.units).map(u => [u.unit_id, [u.status, u.code ?? null]])), { a: ["approved", null], b: ["blocked", "LANE_LADDER_EXHAUSTED"], c: ["approved", null] });
  assert.deepEqual(one.out.checkpoints.written.sort(), ["a", "c"]);
  const files = readdirSync(checkpoints.dir).sort();
  assert.equal(files.filter(f => f.endsWith(".json")).length, 2); assert.equal(files.filter(f => f.endsWith(".patch")).length, 2);
  assert.equal(files.some(f => f.endsWith(".tmp")), false);
  const cpA = JSON.parse(readFileSync(one.out.units.a.checkpoint.file, "utf8"));
  assert.equal(cpA.schema, CHECKPOINT_SCHEMA);
  assert.deepEqual(Object.keys(cpA).sort(), ["base_commit", "commit", "patch_digest", "patch_path", "recorded_at", "review_digest", "reviewer", "rubric_hash", "schema", "tree", "unit_base_commit", "unit_id", "unit_key", "upstream", "verdict", "verify"].sort());
  assert.deepEqual([cpA.unit_id, cpA.verdict, cpA.unit_key, cpA.tree, cpA.commit, cpA.verify.exit_code, cpA.reviewer.model], ["a", "approve", one.out.units.a.unit_key, one.out.units.a.tree, one.out.units.a.commit, 0, "gpt-6-luna"]);
  const cpC = JSON.parse(readFileSync(one.out.units.c.checkpoint.file, "utf8"));
  assert.deepEqual(cpC.upstream, [{ unit_id: "a", unit_key: one.out.units.a.unit_key, tree: one.out.units.a.tree }]);
  // The key is the documented one: the validated unit, the base commit and the upstream keys; stable across runs.
  assert.equal(one.out.units.a.unit_key, unitKey({ unit: PLAN[0], base_commit: one.out.base.commit, upstream: [] }));
  assert.equal(one.out.units.c.unit_key, unitKey({ unit: PLAN[2], base_commit: one.out.base.commit, upstream: [{ unit_id: "a", unit_key: one.out.units.a.unit_key }] }));

  const two = await go(env, "run2", good, checkpoints);
  assert.equal(two.out.status, "completed");
  for (const id of ["a", "c"]) {
    const u = two.out.units[id];
    assert.deepEqual([u.status, u.resumed, u.merged, u.dispatch, u.attempts.length, u.reviews.length], ["approved", true, true, null, 0, 0], id);
    assert.equal(u.unit_key, one.out.units[id].unit_key);
  }
  assert.equal(two.out.units.b.resumed, false);
  assert.deepEqual([...new Set(two.calls.map(c => c.unit_id))], ["b"], "a resumed unit asked a provider");
  assert.deepEqual(two.out.provider_calls.by_role, { dispatcher: 1, implementer: 1, subagent: 0, reviewer: 1 });
  assert.deepEqual(two.out.checkpoints.resumed.sort(), ["a", "c"]); assert.deepEqual(two.out.checkpoints.written, ["b"]);

  const clean = await go(env, "clean", good, null);
  assert.equal(clean.out.status, "completed");
  assert.equal(two.tree, clean.tree, "the resumed integration differs from a clean full run");
  for (const id of ["a", "b", "c"]) assert.match(await sh(`git show ${two.out.integration.branch}:src/${id}/impl.mjs`, env.repo), new RegExp(`"${id}"`));
});

test("a tampered checkpoint is rejected with the reason and its unit re-runs: patch bytes changed, or the recorded tree changed", async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  const checkpoints = { dir: join(env.root, "checkpoints") };
  const one = await go(env, "run1", good, checkpoints);
  assert.equal(one.out.status, "completed");
  // a: the patch bytes are changed (the digest no longer matches).
  const cpA = JSON.parse(readFileSync(one.out.units.a.checkpoint.file, "utf8"));
  const patchA = join(checkpoints.dir, cpA.patch_path);
  writeFileSync(patchA, readFileSync(patchA, "utf8").replace('"a"', '"evil"'));
  // b: the recorded tree is changed (its patch is left intact, so only the re-apply check can catch it).
  const fileB = one.out.units.b.checkpoint.file, cpB = JSON.parse(readFileSync(fileB, "utf8"));
  writeFileSync(fileB, JSON.stringify({ ...cpB, tree: "0".repeat(40) }));
  const two = await go(env, "run2", good, checkpoints);
  assert.equal(two.out.status, "completed");
  assert.match(two.out.units.a.checkpoint_rejected.why, /patch hashes to .* not the recorded/);
  assert.match(two.out.units.b.checkpoint_rejected.why, /yields tree [0-9a-f]+, not the recorded 0{40}/);
  for (const id of ["a", "b"]) { assert.equal(two.out.units[id].resumed, false); assert.equal(two.out.units[id].attempts.length, 1); }
  // c depends on a: a re-ran with identical content, so its tree is the same and c's checkpoint still holds.
  assert.equal(two.out.units.c.resumed, true);
  assert.deepEqual(two.out.checkpoints.rejected.sort(), ["a", "b"]);
  assert.deepEqual([...new Set(two.calls.map(c => c.unit_id))].sort(), ["a", "b"]);
  assert.doesNotMatch(await sh(`git show ${two.out.integration.branch}:src/a/impl.mjs`, env.repo), /evil/);
});

test("a checkpoint whose upstream tree differs from this run's is not trusted", async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  const checkpoints = { dir: join(env.root, "checkpoints") };
  await go(env, "run1", good, checkpoints);
  // Run 2: a's checkpoint is gone and a now writes different bytes; c's upstream tree no longer matches.
  const one = JSON.parse(readFileSync(join(env.root, "run1", "pipeline.json"), "utf8"));
  writeFileSync(one.units.a.checkpoint.file, "{}");
  const two = await go(env, "run2", async args => { if (args.unit_id === "a") { await write(args.cwd, "src/a/impl.mjs", "export const id = 'a2';\n"); return "done"; } return good(args); }, checkpoints);
  assert.equal(two.out.status, "completed");
  assert.match(two.out.units.a.checkpoint_rejected.why, /names no patch file/);
  assert.match(two.out.units.c.checkpoint_rejected.why, /upstream units or their trees differ/);
  assert.equal(two.out.units.c.resumed, false); assert.equal(two.out.units.b.resumed, true);
});
