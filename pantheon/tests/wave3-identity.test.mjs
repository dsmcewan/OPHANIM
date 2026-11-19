// WAVE 3, register L-504 invariant 2: a model's identity -- the model REQUESTED, the model SERVED, where the served name
// came from (served_model_source: provider / input / unnamed / unknown) and the lab -- is kept, unchanged and complete,
// through every projection Pantheon makes of it, and every consumer that decides exclusion, independence or a lab reads
// the SERVED identity. Each test feeds producer records whose requested model differs from the served one (or whose
// served name is the stamped input, or none) through the real production chain and reads the identity back at the
// consumer with the reader of both row shapes that review/identity.mjs identityOf documents (`who`, below):
//   the five-stage pipeline (runPipeline: real git worktrees, the real dispatcher/implementer/A2A/Stage 5 code, scripted
//     turns only at the provider edge) -> its run record -> contributionsOf / arbitersOf -> its sealed checkpoint -> a
//     resumed run, and Stage 5's exclusion of an escalation rung;
//   the change scope (reviewScope) -> the review cycle (reviewCycle: the v3 cycle's recorded contributors on a real
//     ledger, append + verify) -> a resumed cycle's retained reviews -> a reassessment under a corrected policy;
//   the status ledger's evidence shape (packages/ledger/status.mjs).
// The lifecycle's own projections (stages.mjs, live-run.mjs, the outcome's proposal, the public record) are in
// ophanim/operate/wave3-identity.test.mjs. Mutations that prove the paths the base already held: wave3-identity.mutate.mjs.
// No provider is called. Every model name is a declared one (pantheon/src/config) unless the test says otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPipeline, contributionsOf, arbitersOf } from "../src/pipeline/index.mjs";
import { checkpointKey, sealOf } from "../src/pipeline/checkpoint.mjs";
import { digestOf } from "../src/pipeline/util.mjs";
import { contributorKeys, currentPolicy, reassess, resolveModel } from "../src/review/identity.mjs";
import { reviewScope } from "../src/review/scope.mjs";
import { cycleReviewers } from "../src/board/operate.mjs";
import { reviewCycle } from "../src/ledger/review-cycle.mjs";
import { openPantheonLedger } from "../src/ledger/system.mjs";
import { evidenceRefusal, EVIDENCE_SCHEMA } from "../../packages/ledger/status.mjs";
import { tempRepo, seats, unit, scripted, write, ask, approve, reject, RUBRIC, PLANNER, LUNA, SOL, ASTRA } from "./fixtures/pipeline-stages.mjs";

const L504 = "wave 3, L-504 invariant 2";
/**
 * The identity a row states, without its vendor and lab (asserted separately where the lab is the point). The TEST'S
 * OWN reader of the two documented row shapes (review/identity.mjs identityOf states the same rule; it is not imported,
 * so the oracle does not depend on the code under test): an ANSWER row names the model asked as `model` and the model
 * that answered as `served_model` (null: none was named; omitted on a finder row when it is the asked name); a
 * CONTRIBUTION row names the model that answered as `model` (the asked one, marked "unnamed", when none was named) and
 * the model asked as `requested_model` when it differs.
 */
const who = r => ({ requested_model: r.requested_model ?? r.model ?? null,
  served_model: Object.hasOwn(r, "served_model") ? r.served_model ?? null : r.served_model_source === "unnamed" ? null : r.model ?? null,
  served_model_source: r.served_model_source ?? null });
const id = (requested_model, served_model, served_model_source) => ({ requested_model, served_model, served_model_source });
/** Identities as a set: sorted by their canonical text, so only what they are is compared, not the record's order. */
const set = list => [...list].map(x => JSON.stringify(x)).sort().map(x => JSON.parse(x));
/**
 * THE SOURCES, table-driven. A CONTRIBUTOR's answer (implementer, subagent) may be served by another model; a JUDGING
 * seat (dispatcher, Stage 5 reviewer) is admitted only when the model asked answered (util.mjs judgingTurn), so its
 * served name is the asked model under a dated snapshot (another NAME, the same identity). "input" is the stamped input
 * model: by the vocabulary the served name IS the requested one. "unnamed" (no served name) is the subject of its own tests.
 */
const SOURCES = [
  { source: "provider", other: "unknown", contributor: m => (m.startsWith("gemini-4-hydrogen") ? "gemini-4-carbon-high" : { "grok-4.5": "grok-4.7" }[m]), judge: m => `${m}-20261101` },
  { source: "unknown", other: "provider", contributor: m => (m.startsWith("gemini-4-hydrogen") ? "gemini-4-argon-high" : { "grok-4.5": "grok-4.6" }[m]), judge: m => `${m}-20261101` },
  { source: "input", other: "provider", contributor: m => m, judge: m => m },
];
const answer = (text, served_model, served_model_source) => ({ text: typeof text === "string" ? text : JSON.stringify(text), served_model, served_model_source });
const pipe = async (env, name, { plan, implement, review, subagent, dispatch, checkpoints, seatsOver = {}, limits } = {}) => {
  const sc = scripted({ plan, implement, review, subagent, dispatch });
  return runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, seats: seats(seatsOver), turns: sc.turns, dir: path.join(env.root, name), planner: PLANNER, run_id: name,
    ...(checkpoints ? { checkpoints } : {}), ...(limits ? { limits } : {}) });
};

for (const S of SOURCES) {
  // ONE run (and its resumed run) per source; each projection is its own subtest, so each one passes or fails on its own.
  test(`${L504}, source "${S.source}": every projection of the pipeline's run record keeps requested, served and marker`, { timeout: 300_000 }, async t => {
    const env = await tempRepo(); t.after(env.cleanup);
    const checkpoints = { dir: path.join(env.root, "checkpoints") };
    const plan = [unit("a", { allowed_subagents: ["helper"] })];
    const SUB = S.contributor("grok-4.5"), JUDGE = S.judge("gpt-6-luna");
    // The implementer asks its subagent twice (first attempt); both answers are served by SUB, the second under ANOTHER
    // marker of the vocabulary (two calls of one model through two transports). The pinned reviewer rejects once, then approves.
    const one = await pipe(env, "run1", { plan, checkpoints,
      dispatch: args => answer({ unit_id: args.unit_id, cohesive: true, specialist_role: "node-esm-library-engineer", difficulty: "medium", rubric: RUBRIC, notes: "" }, JUDGE, S.source),
      implement: async args => {
        if (args.attempt === 1) for (const text of ["first question", "second question"]) assert.equal((await ask(args.a2a, { role: "helper", unit_id: "a", text })).status, 200);
        await write(args.cwd, "src/a/impl.mjs", `export const id = "a${args.attempt}";\n`);
        return answer("done", S.contributor(args.model), S.source);
      },
      subagent: (args, n) => answer("an answer", SUB, n === 1 ? S.source : S.other),
      review: (args, n) => answer(n === 1 ? reject(RUBRIC, ["say why the id changes"]) : approve(RUBRIC), JUDGE, S.source) });
    assert.equal(one.status, "completed", JSON.stringify(Object.values(one.units).map(u => [u.status, u.reason])));
    // A RESUMED RUN: no call is made; every identity is restored from the sealed checkpoint.
    const two = await pipe(env, "run2", { plan, checkpoints, implement: () => { throw new Error("a resumed unit is not implemented"); }, review: () => { throw new Error("a resumed unit is not reviewed"); } });
    assert.equal(two.status, "completed");
    assert.equal(two.units.a.resumed, true);
    const u = one.units.a;
    // The implementer is raised one thinking level after the rejection: each attempt is asked of its own rung.
    assert.deepEqual(u.attempts.map(a => a.model), ["gemini-4-hydrogen-medium", "gemini-4-hydrogen-high"]);
    const WORK = u.attempts.map(a => id(a.model, S.contributor(a.model), S.source));
    const authored = run => contributionsOf(run).filter(c => c.kind !== "plan").map(who);

    await t.test("P1-P4 the producers: attempts, subagent calls, the dispatch and the Stage 5 reviews", () => {
      assert.deepEqual(u.attempts.map(who), WORK);
      assert.deepEqual(set(u.a2a.calls.map(who)), set([id("grok-4.5", SUB, S.source), id("grok-4.5", SUB, S.other)]));
      assert.deepEqual(who(u.dispatch), id("gpt-6-luna", JUDGE, S.source));
      assert.deepEqual(u.reviews.map(who), Array(2).fill(id("gpt-6-luna", JUDGE, S.source)));
    });
    await t.test("R1 contributionsOf: work, subtask and critique rows (two answers of one served model under two markers stay two rows)", () => {
      const rows = kind => contributionsOf(one).filter(c => c.kind === kind).map(who);
      assert.deepEqual(set(rows("work")), set(WORK), "the work rows");
      assert.deepEqual(set(rows("subtask")), set([id("grok-4.5", SUB, S.source), id("grok-4.5", SUB, S.other)]), "a subagent answer's marker was dropped by the run record's de-duplication");
      assert.deepEqual(rows("critique"), [id("gpt-6-luna", JUDGE, S.source)], "the critique row");
      assert.deepEqual(one.contributions, contributionsOf(one), "the record on disk is the projection");
    });
    await t.test("R2 arbitersOf: the dispatcher by requested and served model, with the marker", () => {
      assert.deepEqual(arbitersOf(one).map(who), [id("gpt-6-luna", JUDGE, S.source)]);
    });
    await t.test("R3 the Stage 5 finding names its reviewer by requested and served model, with the marker", () => {
      const f = u.findings.filter(x => x.source === "reviewer");
      assert.equal(f.length, 1);
      assert.deepEqual(who(f[0]), id("gpt-6-luna", JUDGE, S.source), "the Stage 5 finding dropped the served identity of its reviewer");
    });
    await t.test("R5 the sealed checkpoint: its reviewer, its dispatch and its lineage", () => {
      const cp = JSON.parse(fs.readFileSync(u.checkpoint.file, "utf8"));
      assert.deepEqual(who(cp.reviewer), id("gpt-6-luna", JUDGE, S.source), "the checkpoint's reviewer dropped its marker");
      assert.deepEqual(who(cp.dispatch), id("gpt-6-luna", JUDGE, S.source));
      assert.deepEqual(who(cp.review), id("gpt-6-luna", JUDGE, S.source));
      assert.deepEqual(set(cp.contributions.map(who)), set([...WORK, id("grok-4.5", SUB, S.source), id("grok-4.5", SUB, S.other), id("gpt-6-luna", JUDGE, S.source)]), "the sealed lineage lost an identity");
    });
    await t.test("R6 a resumed run: its lineage, its arbiter and its reviewer, restored from the checkpoint", () => {
      assert.deepEqual(set(authored(two)), set(authored(one)), "a resumed unit's lineage lost an identity");
      assert.ok(contributionsOf(two).filter(c => c.kind !== "plan").every(c => c.from_checkpoint === true));
      assert.deepEqual(arbitersOf(two).map(a => [who(a), a.from_checkpoint]), [[id("gpt-6-luna", JUDGE, S.source), true]], "the resumed arbiter");
      assert.deepEqual(who(two.units.a.checkpoint.reviewer), id("gpt-6-luna", JUDGE, S.source), "the resumed unit's reviewer dropped its marker");
    });
    await t.test("the decision downstream excludes the requested AND the served identity of every author after resume", () => {
      const keys = contributorKeys(contributionsOf(two));
      for (const m of new Set(["gemini-4-hydrogen-medium", ...WORK.map(w => w.served_model), "grok-4.5", SUB, "gpt-6-luna"])) {
        assert.ok(keys.models.includes(resolveModel(null, m).id), `${m} is not excluded after resume`);
      }
    });
  });
}

test(`${L504}: Stage 5's exclusion of an escalation rung reads the SERVED identity of the unit's implementer`, { timeout: 300_000 }, async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  const plan = [unit("a")];
  // The implementer asked of a Gemini lane is served by gpt-6-sol: an author of the unit. After two rejections by the
  // pinned reviewer the ladder rises to its next rung, gpt-6-sol, which may not judge the work it served.
  const run = await pipe(env, "esc", { plan,
    implement: async args => { await write(args.cwd, "src/a/impl.mjs", `export const id = "a${args.attempt}";\n`); return answer("done", "gpt-6-sol", "provider"); },
    review: (args, n) => answer(n <= 2 ? reject(RUBRIC, [`round ${n}: not yet`]) : approve(RUBRIC), args.model, "provider") });
  const u = run.units.a;
  assert.equal(run.status, "completed", JSON.stringify([u.status, u.reason, u.reviewer_exclusions]));
  assert.deepEqual((u.reviewer_exclusions ?? []).map(x => [x.model, /openai\/gpt-6-sol contributed to the change under review/.test(x.why)]), [["gpt-6-sol", true]],
    "the rung that served the implementer's answer was not excluded");
  assert.deepEqual(u.reviews.map(r => r.model), ["gpt-6-luna", "gpt-6-luna", "gpt-6-astra"]);
  assert.ok(u.escalations.some(e => e.kind === "reviewer_excluded" && e.from.model === "gpt-6-sol" && e.to.model === "gpt-6-astra"));
});

test(`${L504}: a sealed checkpoint whose dispatch or review names no serving model is not resumed (an unknown served model is not the model asked)`, { timeout: 300_000 }, async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  const checkpoints = { dir: path.join(env.root, "checkpoints") };
  const plan = [unit("a"), unit("b")];
  const one = await pipe(env, "run1", { plan, checkpoints });
  assert.equal(one.status, "completed");
  // Each checkpoint is rewritten with one served name removed and RE-SEALED under the controller's own key: the seal
  // holds, so only the identity rule can refuse it.
  const key = checkpointKey({ dir: checkpoints.dir });
  const unname = (file, field) => {
    const { seal: _seal, ...rec } = JSON.parse(fs.readFileSync(file, "utf8"));
    const { served_model_source: _s, ...rest } = rec[field];
    const body = { ...rec, [field]: { ...rest, served_model: null } };
    if (field === "review") body.review_digest = digestOf(body.review);   // the review re-hashes: only the identity rule can refuse it
    fs.writeFileSync(file, JSON.stringify({ ...body, seal: sealOf(body, key) }, null, 2) + "\n");
  };
  unname(one.units.a.checkpoint.file, "dispatch");
  unname(one.units.b.checkpoint.file, "review");
  const two = await pipe(env, "run2", { plan, checkpoints });
  assert.equal(two.status, "completed");
  assert.deepEqual([two.units.a.resumed, two.units.b.resumed], [false, false], "a checkpoint with an unnamed judging answer was resumed");
  assert.match(two.units.a.checkpoint_rejected.why, /dispatcher \(gpt-6-luna\) names no serving model/);
  assert.match(two.units.b.checkpoint_rejected.why, /reviewer \(gpt-6-luna\) names no serving model|the answer names no serving model/);
  // Each unit ran again, so no arbiter or lineage row of the run rests on an unnamed judging answer.
  assert.ok(arbitersOf(two).every(a => a.served_model && !a.from_checkpoint), JSON.stringify(arbitersOf(two)));
});

test(`${L504} (P1, the model guard routed from L-504 invariant 3): an implementer turn refused because its CLI started on another model is recorded under AGY_MODEL_MISMATCH with BOTH identities, and the unit is blocked with no second attempt`, { timeout: 300_000 }, async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  // The throw is simulated at the turn (board/agy-cli.mjs raises it on the guard's own branch): requested X, reported Y.
  const guard = args => Object.assign(new Error(`the agy CLI reported model gemini-4-carbon-high at start-up, not ${args.model}`),
    { code: "AGY_MODEL_MISMATCH", identity: { requested: args.model, reported: "gemini-4-carbon-high" } });
  let asked = 0;
  const run = await pipe(env, "guard", { plan: [unit("a")], implement: async args => { asked += 1; throw guard(args); } });
  const u = run.units.a;
  assert.equal(u.status, "blocked", JSON.stringify([u.status, u.reason]));
  assert.equal(u.attempts.length, 1, "a second attempt was made on a CLI that reported another model");
  const a = u.attempts[0];
  assert.deepEqual([a.code, a.identity, a.requested_model, a.served_model], ["AGY_MODEL_MISMATCH", { requested: "gemini-4-hydrogen-medium", reported: "gemini-4-carbon-high" }, "gemini-4-hydrogen-medium", null],
    "the refused attempt lost the code or one of the two identities");
  assert.match(u.reason, /refused by the model guard/);
  // Nothing was written: the refused turn is no contribution, and the implementer was asked exactly once.
  assert.deepEqual(contributionsOf(run).filter(c => c.kind === "work"), []);
  assert.equal(asked, 1);
});

// ---- the change scope and the review cycle -------------------------------------------------------------------------
const C = n => String(n).repeat(40).slice(0, 40);
const DIFF = "diff --git a/src/x.mjs b/src/x.mjs\n--- a/src/x.mjs\n+++ b/src/x.mjs\n@@ -1 +1 @@\n-export const x = 1;\n+export const x = 2;\n";
const APPROVE = "```json\n{\"verdict\": \"approve\", \"findings\": []}\n```";
async function withLedger(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pantheon-wave3-identity-"));
  try { const sys = openPantheonLedger({ root: path.join(dir, "ledger") }); return await fn(sys, sys.recorder()); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const payloadOf = (sys, h) => sys.ledger.payloadOf(sys.ledger.read().find(e => sys.ledger.hashOf(e) === h));
const assess = (rec, cycle) => rec.recordDisposition({ cycle, outcome: "insufficient_evidence", question: "fixture", provenance: { by: { role: "lead@orch" }, method: "fixture" } });
/** Each vendor answers as scripted: {text, served_model, served_model_source} or a thrown error. */
const cycleTurn = (by = {}) => async ({ vendor, model }) => {
  const r = typeof by[vendor] === "function" ? by[vendor]({ vendor, model }) : by[vendor] ?? {};
  if (r instanceof Error) throw r;
  return { text: r.text ?? APPROVE, response_id: `resp_${vendor}_${model}`, served_model: "served_model" in r ? r.served_model : model, ...(r.served_model_source ? { served_model_source: r.served_model_source } : {}) };
};
// Every row shape and every marker: a contribution row served by another model (requested_model beside it), a finder
// row (served_model beside the asked name), a stamped input, an unnamed answer, and a plain seat row.
const CONTRIBUTIONS = [
  { purpose: "subtask", vendor: "xai", model: "grok-4.6", requested_model: "grok-4.7", served_model_source: "provider", lab: "xai" },
  { purpose: "critique", vendor: "openai", model: "gpt-6-astra", served_model: "gpt-6-astra-20261101", served_model_source: "unknown", lab: "openai" },
  { purpose: "work", vendor: "agy_google", model: "gemini-4-hydrogen-medium", served_model_source: "input", lab: "google" },
  { purpose: "work", vendor: "agy_google", model: "gemini-4-carbon-high", served_model_source: "unnamed", lab: "google" },
  { purpose: "plan", vendor: "anthropic", model: "claude-opus-5-5", lab: "anthropic" },
];
const PANEL = [{ vendor: "agy_google", model: "gemini-3.8-flash-high" }, { vendor: "openai", model: "gpt-6-sol" }, { vendor: "anthropic", model: "claude-sonnet-5" }];
const v3 = (scope, contributions = CONTRIBUTIONS) => ({ scope, base: C("a"), head: C("b"), diff: DIFF, files: ["src/x.mjs"], independence: "model", contributions,
  author_labs: [...new Set(contributions.map(c => c.lab))].sort() });

test(`${L504}: a v3 cycle records, on every contributor name row, which name was asked, which answered and the marker; the ledger verifies, and refuses an inconsistent statement`, () => withLedger(async (sys, rec) => {
  const r = await reviewCycle({ ledger: rec, change: v3("ident"), seats: PANEL, turn: cycleTurn() });
  assert.equal(r.reviews.length, 3, JSON.stringify(r.failed));
  const c = payloadOf(sys, r.cycle);
  // Each contribution: every name it carries is a row of the cycle, and each such row states the contribution's identity.
  for (const k of CONTRIBUTIONS) {
    const names = [...new Set([k.model, k.served_model, k.requested_model].filter(Boolean))];
    const got = c.contributors.filter(x => x.vendor === k.vendor && names.includes(x.model));
    assert.deepEqual(got.map(x => x.model).sort(), [...names].sort(), `${k.purpose}: a name was not recorded`);
    for (const x of got) assert.deepEqual(who(x), who(k), `${k.purpose} ${x.model}: the cycle lost which name was asked, which answered, or the marker`);
  }
  // A plain row stays the shape it always had (recorded cycles and their tests are unchanged).
  assert.deepEqual(c.contributors.find(x => x.model === "claude-opus-5-5"), { vendor: "anthropic", model: "claude-opus-5-5" });
  // THE DECISION: the exclusions re-derive from the rows; every requested and served identity is a contributor.
  assert.deepEqual(c.author_models, contributorKeys(CONTRIBUTIONS).models);
  for (const m of ["xai/grok-4.6", "xai/grok-4.7", "openai/gpt-6-astra", "google/gemini-4-hydrogen", "google/gemini-4-carbon"]) assert.ok(c.author_models.includes(m), m);
  assess(rec, r.cycle);
  assert.equal(rec.closeCycle(r.cycle).outcome, "verified");
  assert.equal(sys.ledger.verify().ok, true);
  // A contribution whose statement contradicts the vocabulary ("input" names the required input model as served, so it
  // IS the model asked) is not recorded as a v3 contributor: the ledger refuses the cycle.
  await assert.rejects(reviewCycle({ ledger: rec, change: v3("contradiction", [{ purpose: "work", vendor: "openai", model: "gpt-6-luna", requested_model: "gpt-6-astra", served_model_source: "input", lab: "openai" }]),
    seats: [PANEL[0], { vendor: "xai", model: "grok-4.7" }, PANEL[2]], turn: cycleTurn() }), /a turn marked "input" records the required input model as served/);
  assert.equal(sys.ledger.verify().ok, true);
}));

test(`${L504}: a resumed cycle's retained reviews keep the served name AND its marker`, () => withLedger(async (sys, rec) => {
  const marked = { served_model_source: "provider" };
  const first = await reviewCycle({ ledger: rec, change: v3("resume"), seats: PANEL, turn: cycleTurn({ agy_google: { ...marked, served_model: "gemini-3.8-flash-high" }, openai: { ...marked, served_model: "gpt-6-sol-20261101" }, anthropic: new Error("503 from the provider") }) });
  assert.deepEqual([first.reviews.length, first.failed.map(f => f.lab)], [2, ["anthropic"]]);
  const again = await reviewCycle({ ledger: rec, resume: true, change: v3("resume"), seats: PANEL, turn: cycleTurn({ anthropic: { ...marked } }) });
  const retained = again.reviews.filter(x => x.retained);
  assert.equal(retained.length, 2);
  for (const x of retained) assert.deepEqual([x.served_model, x.served_model_source], [x.vendor === "openai" ? "gpt-6-sol-20261101" : "gemini-3.8-flash-high", "provider"], `${x.vendor}: a retained review lost its marker`);
  assert.deepEqual(again.reviews.filter(x => !x.retained).map(x => [x.vendor, x.served_model_source]), [["anthropic", "provider"]]);
}));

test(`${L504}: a reassessment under a corrected policy reads the SERVED model of each recorded review`, () => withLedger(async (sys, rec) => {
  // The xAI seat was asked of grok-4.7 and answered as grok-4.6 (one lab: admitted). A later correction declares grok-4.6
  // to be grok-4.5, a contributor: only the SERVED name makes that review a contributor's.
  const contributions = [{ purpose: "work", vendor: "xai", model: "grok-4.5", lab: "xai" }, { purpose: "plan", vendor: "anthropic", model: "claude-opus-5-5", lab: "anthropic" }];
  const r = await reviewCycle({ ledger: rec, change: v3("reassess", contributions), seats: [{ vendor: "xai", model: "grok-4.7" }, { vendor: "openai", model: "gpt-6-sol" }, { vendor: "agy_google", model: "gemini-3.8-flash-high" }],
    turn: cycleTurn({ xai: { served_model: "grok-4.6", served_model_source: "provider" } }) });
  assert.equal(r.reviews.length, 3, JSON.stringify(r.failed));
  const state = rec.cycleState(r.cycle);
  const xai = state.reviews.find(x => x.seat.vendor === "xai");
  assert.deepEqual([xai.model, xai.served_model, xai.served_model_source], ["grok-4.7", "grok-4.6", "provider"]);
  const base = currentPolicy();
  const corrected = { ...base, same_model: { ...base.same_model, "grok-4.6": "grok-4.5" } };
  assert.deepEqual(reassess({ cycle: state.cycle, reviews: state.reviews }).findings, [], "under the recorded policy nothing changes");
  const found = reassess({ cycle: state.cycle, reviews: state.reviews, policy: corrected });
  assert.deepEqual(found.findings.map(x => [x.review, /xai\/grok-4\.5 contributed to the change under review/.test(x.why)]), [[xai.hash, true]],
    "the review served by an alias of a contributor was not found: the reassessment did not read the served model");
}));

test(`${L504}: the change scope carries an unnamed served model as unknown ("unnamed"), never as the model asked, and the panel excludes every name`, () => {
  const turns = [
    { purpose: "work", vendor: "openai", model: "gpt-6-astra", served_model: null },
    { purpose: "work", vendor: "xai", model: "grok-4.7", served_model: "grok-4.6", served_model_source: "provider" },
    { purpose: "plan", vendor: "anthropic", model: "claude-opus-5-5", served_model: "claude-opus-5-5", served_model_source: "input" },
    { purpose: "work", vendor: "agy_google", model: "gemini-4-carbon-high", served_model: "gemini-4-carbon-high-20261101", served_model_source: "unknown" },
    // A critique row (run.files contributors) omits the served name when it is the name asked: read as it states.
    { purpose: "critique", vendor: "openai", model: "gpt-6-sol", revision_input: true },
  ];
  const scope = reviewScope({ kind: "change", turns });
  const want = [id("gpt-6-astra", null, "unnamed"), id("grok-4.7", "grok-4.6", "provider"), id("claude-opus-5-5", "claude-opus-5-5", "input"), id("gemini-4-carbon-high", "gemini-4-carbon-high-20261101", "unknown"), id("gpt-6-sol", "gpt-6-sol", null)];
  assert.deepEqual(scope.contributions.map(who), want, "a projection of the scope replaced a served identity");
  // The lab rides with the model that answered (the asked one only when none was named).
  assert.deepEqual(scope.contributions.map(c => c.lab), ["openai", "xai", "anthropic", "google", "openai"]);
  // THE DECISION (operate.mjs cycleReviewers, model rule): every requested and served identity is excluded.
  const chosen = cycleReviewers({ scope, independence: "model" });
  for (const m of ["openai/gpt-6-astra", "xai/grok-4.7", "xai/grok-4.6", "anthropic/claude-opus-5-5", "google/gemini-4-carbon"]) assert.ok(chosen.author_models.includes(m), m);
});

test(`${L504}: the status ledger's evidence names a reviewer's served-model marker when it has one, consistent with the names; recorded entries without one verify as before`, () => {
  const h = c => "sha256:" + c.repeat(64);
  const ev = reviewers => ({ schema: EVIDENCE_SCHEMA, proposal: h("1"), checked: "structural",
    run: { ledger_anchor: h("2"), ledger_head: h("3"), run_json_digest: h("4"), shipped: true, gate_entry: null },
    review: { cycle_ledger_anchor: h("5"), cycle: h("6"), close_entry: h("7"), outcome: "verified", reviewers },
    commit: C("c"), tests: { cmd: "node verify.mjs", exit: 0 }, ticket: { path: "tickets/x.json", digest: h("8"), slice: "s" } });
  const R = (vendor, model, served_model, lab, extra = {}) => ({ vendor, model, served_model, lab, ...extra });
  const plain = [R("openai", "gpt-6-sol", "gpt-6-sol", "openai"), R("xai", "grok-4.7", "grok-4.6", "xai"), R("agy_google", "gemini-3.8-flash-high", null, "google")];
  assert.equal(evidenceRefusal(ev(plain), "Resolved"), null, "recorded evidence without markers");
  const marked = [R("openai", "gpt-6-sol", "gpt-6-sol-20261101", "openai", { served_model_source: "provider" }), R("xai", "grok-4.7", "grok-4.6", "xai", { served_model_source: "unknown" }),
    R("agy_google", "gemini-3.8-flash-high", "gemini-3.8-flash-high", "google", { served_model_source: "input" })];
  assert.equal(evidenceRefusal(ev(marked), "Resolved"), null, "the evidence cannot carry a reviewer's marker");
  for (const [bad, why] of [[{ served_model_source: "input", served_model: "gemini-3.8-flash" }, "an input-stamped name that is not the model asked"],
    [{ served_model_source: "unnamed" }, "an unnamed answer that names a served model"], [{ served_model_source: "guessed" }, "a marker outside the vocabulary"]]) {
    const rows = [marked[0], marked[1], { ...marked[2], ...bad }];
    assert.match(evidenceRefusal(ev(rows), "Resolved") ?? "", /evidence\.review lists its reviewers/, why);
  }
});
