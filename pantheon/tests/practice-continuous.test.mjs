// Continuous evaluation (docs/reviews/2026-11-17-routing-evaluation/DESIGN.md; owner direction 2026-11-17:
// "test going forward continuously from current state, or create an effective test and metrics").
//
//   - shadow selection: every dispatch records, beside each role choice, the seat the other profile would
//     have chosen with the same inputs; it is never sent to a provider, and the primary picks and policy
//     hashes of argo and legacy are unchanged.
//   - interleaved assignment: a deterministic 50/50 hash of the ticket key, only for eligible strata (low,
//     normal); high/critical, unknown stakes and halted strata stay on argo; an explicit profile wins.
//   - the evaluator: insufficient at small n, propose_policy only when fit is non-inferior AND cheaper,
//     retain otherwise, the stop rule halts a stratum where fit is clearly worse; unknown usage is never cheaper.
//   - every cycle close gets an assessment: without a stated one, the controller records the evaluation's,
//     synthetic-flagged on fixture runs, and never a promote.
// Every provider is scripted (tests/fixtures/dispatch.mjs); no network, no keys, no spend.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { assignArm, bucketOf, BASIS, ASSIGN_SCHEMA, DEFAULT_ELIGIBLE_STRATA } from "../src/practice/assign.mjs";
import { evaluate, newcombe, automaticAssessment, evaluationDigest, evaluationEvidence, defaultEvidenceStore, EVALUATION_SCHEMA,
  MIN_N, STOP_MIN_N, NONINFERIORITY_MARGIN, STOP_MARGIN, PROMOTION_CONFIDENCE, STOP_CONFIDENCE, FIT_PROPOSER } from "../src/practice/evaluate.mjs";
import { shadowSeat, withShadow } from "../src/practice/shadow.mjs";
import { selectSeat, selectionPolicy, readPools } from "../src/route/frontier.mjs";
import { runOpenItem } from "../src/board/run-item.mjs";
import { runBoardItem } from "../src/board/operate.mjs";
import { openPantheonLedger } from "../src/ledger/system.mjs";
import { reviewCycle } from "../src/ledger/review-cycle.mjs";
import { currentPolicy } from "../src/ledger/practice-kinds.mjs";
import { openStatusLedger } from "../../packages/ledger/status.mjs";
import { withDispatch } from "./fixtures/dispatch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOARD_CLI = resolve(HERE, "..", "bin", "pantheon-board.mjs");
const readRun = dir => JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
const keyFor = (arm, prefix) => { for (let i = 0; ; i++) { const k = `${prefix}-${i}`; if (bucketOf(k) === (arm === "fit" ? 1 : 0)) return k; } };

// ---------------------------------------------------------------- shadow selection

test("shadow: withShadow adds shadow/agrees to each selection and changes nothing else of the argo or legacy choice", () => {
  const pools = readPools();
  for (const profile of ["argo", "legacy"]) for (const role of ["planner", "implementer", "reviewer", "scout"]) {
    const args = { difficulty: "medium", pools, needsContext: 2000, roleOverride: null };
    const before = selectSeat(role, { profile, ...args });
    const shadow = shadowSeat(role, { profile, args, task: undefined });
    assert.equal(shadow.profile, "fit");
    const after = withShadow(before, shadow);
    assert.equal(after.seat, after.candidates[0], "the seat stays the first candidate");
    assert.deepEqual(after.candidates.map(c => [c.vendor, c.model, c.pool, c.rank]), before.candidates.map(c => [c.vendor, c.model, c.pool, c.rank]));
    for (const [i, c] of after.candidates.entries()) {
      const { shadow: s, agrees, ...rest } = c.selection;
      assert.deepEqual(rest, before.candidates[i].selection, `${profile}/${role}: the primary selection is unchanged`);
      assert.equal(s, shadow);
      assert.equal(agrees, c.vendor === shadow.vendor && c.model === shadow.model);
    }
    assert.equal(after.selection.policy_hash, selectionPolicy(profile, { pools }).hash, `${profile}: the policy hash is the profile's own`);
    assert.equal(shadow.policy_hash, selectionPolicy("fit", { pools }).hash);
  }
});

test("shadow: an argo dispatch records the fit seat on every turn, sends it to no provider, and keeps argo's picks and hash", async () => {
  await withDispatch(async ({ spec, opts, calls, agy }) => {
    const o = opts();
    const result = await runOpenItem(spec("shadow-argo"), o);
    assert.equal(result.shipped, true, JSON.stringify(result.error));
    const run = readRun(o.dir), pools = readPools();
    assert.ok(run.turns.length >= 4);
    for (const t of run.turns) {
      assert.equal(t.selection.profile, "argo");
      assert.equal(t.selection.policy_hash, selectionPolicy("argo", { pools }).hash, "argo's policy hash is unchanged");
      assert.equal(t.selection.shadow.profile, "fit");
      assert.equal(t.selection.shadow.policy_hash, selectionPolicy("fit", { pools }).hash);
      assert.ok(t.selection.shadow.vendor && t.selection.shadow.model, JSON.stringify(t.selection.shadow));
      assert.equal(t.selection.agrees, t.vendor === t.selection.shadow.vendor && t.model === t.selection.shadow.model);
    }
    // Only the primary seats were requested: every provider request (API and lane) is a recorded turn's seat.
    const primaries = new Set(run.turns.map(t => `${t.vendor}/${t.model}`));
    const requested = new Set([...calls.map(c => `${c.vendor}/${c.model}`), ...agy().map(a => `agy_google/${a.model}`)]);
    for (const r of requested) assert.ok(primaries.has(r), `${r} was requested but is no turn's primary seat`);
    const disagreeing = run.turns.filter(t => t.selection.agrees === false);
    assert.ok(disagreeing.length > 0, "fit would have seated someone else at least once (the disagreement map is non-empty)");
    for (const t of disagreeing) {
      const s = `${t.selection.shadow.vendor}/${t.selection.shadow.model}`;
      assert.ok(!requested.has(s) || primaries.has(s), `the shadow ${s} was never dispatched`);
    }
    assert.equal(run.providers.kind, "fake", "the fixture providers mark the run synthetic");
    assert.equal(run.assignment, undefined, "no interleave, no assignment");
  });
});

test("shadow: a fit dispatch is shadowed by argo; a legacy dispatch by fit, with legacy's hash unchanged", async () => {
  await withDispatch(async ({ spec, opts }) => {
    const pools = readPools();
    for (const [profile, other] of [["fit", "argo"], ["legacy", "fit"]]) {
      const o = opts({ profile });
      const r = await runOpenItem(spec(`shadow-${profile}`), o);
      assert.equal(r.shipped, true, JSON.stringify(r.error));
      for (const t of readRun(o.dir).turns) {
        assert.equal(t.selection.policy_hash, selectionPolicy(profile, { pools }).hash);
        assert.equal(t.selection.shadow.profile, other);
        assert.equal(t.selection.shadow.policy_hash, selectionPolicy(other, { pools }).hash);
        assert.equal(typeof t.selection.agrees, "boolean");
      }
    }
  });
});

// ---------------------------------------------------------------- interleaved assignment

test("assignArm: deterministic per ticket key, 50/50 over keys, only for eligible strata", () => {
  assert.deepEqual(DEFAULT_ELIGIBLE_STRATA, ["low", "normal"]);
  for (const k of ["a", "ticket-42", "obs-1.slice"]) assert.deepEqual(assignArm({ ticketKey: k, stakes: "low" }), assignArm({ ticketKey: k, stakes: "low" }));
  const arms = Array.from({ length: 2000 }, (_, i) => assignArm({ ticketKey: `t-${i}`, stakes: "normal" }));
  const fit = arms.filter(a => a.arm === "fit").length;
  assert.ok(fit > 900 && fit < 1100, `about half are fit (${fit} of 2000)`);
  assert.ok(arms.every(a => a.randomized && a.basis === BASIS.hash && a.schema === ASSIGN_SCHEMA));
  const k = keyFor("fit", "gate");
  assert.equal(assignArm({ ticketKey: k, stakes: "normal" }).arm, "fit");
  for (const stakes of ["high", "critical"]) assert.deepEqual([assignArm({ ticketKey: k, stakes }).arm, assignArm({ ticketKey: k, stakes }).basis, assignArm({ ticketKey: k, stakes }).randomized], ["argo", "stratum not eligible", false]);
  assert.equal(assignArm({ ticketKey: k, stakes: null }).arm, "argo");
  assert.equal(assignArm({ ticketKey: k, stakes: null }).randomized, false);
  const halted = assignArm({ ticketKey: k, stakes: "normal", policy: { eligible: ["low", "normal"], halted: ["normal"] } });
  assert.deepEqual([halted.arm, halted.basis, halted.randomized], ["argo", BASIS.halted, false]);
  assert.equal(assignArm({ ticketKey: k, stakes: "high", policy: { eligible: ["high"], halted: [] } }).arm, "fit", "the policy decides eligibility");
});

test("interleave: the assigned arm is dispatched and recorded on run.json and on each turn's selection; an explicit profile wins", async () => {
  await withDispatch(async ({ spec, opts }) => {
    const pools = readPools();
    const cases = [
      { key: keyFor("fit", "il"), o: { interleave: true }, arm: "fit", basis: BASIS.hash, randomized: true },
      { key: keyFor("argo", "il"), o: { interleave: true }, arm: "argo", basis: BASIS.hash, randomized: true },
      { key: keyFor("fit", "il"), o: { interleave: true, profile: "argo" }, arm: "argo", basis: BASIS.explicit, randomized: false },
      { key: keyFor("fit", "il-high"), extra: { stakes: "high" }, o: { interleave: true }, arm: "argo", basis: BASIS.ineligible, randomized: false },
      { key: keyFor("fit", "il-halt"), o: { interleave: true, assignmentPolicy: { eligible: ["low", "normal"], halted: ["normal"] } }, arm: "argo", basis: BASIS.halted, randomized: false },
    ];
    for (const c of cases) {
      const o = opts(c.o);
      const r = await runOpenItem(spec(c.key, c.extra ?? {}), o);
      assert.equal(r.shipped, true, `${c.key}: ${JSON.stringify(r.error)}`);
      const run = readRun(o.dir);
      assert.deepEqual([run.assignment.arm, run.assignment.basis, run.assignment.randomized], [c.arm, c.basis, c.randomized], c.key);
      assert.equal(run.profile, c.arm);
      for (const t of run.turns) {
        assert.equal(t.selection.profile, c.arm, `${c.key}: the turn ran the assigned arm`);
        assert.equal(t.selection.policy_hash, selectionPolicy(c.arm, { pools }).hash);
        assert.deepEqual(t.selection.assignment, { arm: c.arm, basis: c.basis, randomized: c.randomized });
      }
    }
  });
});

// ---------------------------------------------------------------- the evaluator

const T0 = Date.parse("2026-11-17T00:00:00.000Z");
let seq = 0;
function mkRun({ arm, stakes = "normal", accepted = true, firstPass = true, calls = 4, tokens = 400, usage = true, elapsed = 60_000, kind = "fake", randomized = true }) {
  const key = `ev-${++seq}`;
  const attempts = Array.from({ length: calls }, (_, i) => ({ n: i + 1, purpose: i === 0 ? "plan" : "work", vendor: "openai", model: "gpt-6-sol", outcome: "ok",
    usage: usage ? { input_tokens: tokens / calls, output_tokens: 0 } : null }));
  return { format: 2, key, ticket_cid: `cid-${key}`, started_at: new Date(T0 + seq).toISOString(), finished_at: new Date(T0 + seq + elapsed).toISOString(),
    turns: [{ purpose: "work", vendor: "openai", model: "gpt-6-sol", selection: { profile: arm, role: "implementer", policy: "pantheon.selection/v1", policy_hash: "sha256:" + "0".repeat(64), rank: 0 } }],
    attempts, shipped: accepted, gates: [{ gate: "TESTS", ok: accepted }, { gate: "REVIEW", ok: accepted }], revisions: firstPass ? [1] : [1, 2],
    provider_calls: { limit: null, made: calls, refused: null }, providers: { kind }, profile: arm,
    assignment: { schema: ASSIGN_SCHEMA, arm, basis: randomized ? BASIS.hash : BASIS.explicit, stakes, randomized } };
}
const many = (n, o) => Array.from({ length: n }, () => mkRun(o));

test("newcombe: the hybrid score interval for a difference of proportions (Newcombe 1998, method 10)", () => {
  // Newcombe's worked example 56/70 vs 48/80: 95% interval 0.0524 to 0.3339.
  const [lo, hi] = newcombe(56, 70, 48, 80);
  assert.ok(Math.abs(lo - 0.0524) < 5e-4 && Math.abs(hi - 0.3339) < 5e-4, `${lo} ${hi}`);
  assert.equal(newcombe(1, 0, 1, 1), null);
  assert.deepEqual([PROMOTION_CONFIDENCE, STOP_CONFIDENCE, MIN_N, STOP_MIN_N, NONINFERIORITY_MARGIN, STOP_MARGIN], [0.95, 0.95, 20, 10, 0.05, 0.10]);  // 95%: owner decision 2026-11-17
});

test("evaluate: insufficient_evidence below MIN_N per arm; explicit-profile runs are never evidence", () => {
  const e = evaluate({ runs: [...many(5, { arm: "argo" }), ...many(5, { arm: "fit" }), ...many(50, { arm: "fit", randomized: false })] });
  assert.equal(e.schema, EVALUATION_SCHEMA);
  assert.equal(e.strata.normal.outcome, "insufficient_evidence");
  assert.match(e.strata.normal.why, /20 per arm/);
  assert.equal(e.outcome, "insufficient_evidence");
  assert.equal(e.measured, false);
  assert.equal(e.runs.length, 10);
  assert.equal(e.excluded.filter(x => /not randomized \(explicit profile\)/.test(x.why)).length, 50);
  assert.equal(e.synthetic, true);
  assert.equal(e.digest, evaluationDigest(e));
  const a = automaticAssessment(e, { policy: currentPolicy("argo") });
  assert.deepEqual([a.outcome, a.measured, a.provisional], ["insufficient_evidence", false, true]);
});

test("evaluate: propose_policy when fit is clearly non-inferior and cheaper (99% Newcombe bounds); retain when it is not", () => {
  const good = evaluate({ runs: [...many(300, { arm: "argo", calls: 4 }), ...many(300, { arm: "fit", calls: 3 })] });
  const s = good.strata.normal;
  assert.equal(s.outcome, "propose_policy", s.why);
  assert.ok(s.rates.accepted.diff_ci[0] >= -NONINFERIORITY_MARGIN);
  assert.deepEqual([s.cost.calls.status, s.cost.tokens.status, s.cost.elapsed_ms.status], ["lower", "not_lower", "not_lower"]);
  assert.deepEqual([good.outcome, good.measured, good.deciding_strata], ["propose_policy", true, ["normal"]]);
  // The same sample at MIN_N cannot show non-inferiority within 5 points at 99%: it is retained, not proposed.
  const small = evaluate({ runs: [...many(20, { arm: "argo", calls: 4 }), ...many(20, { arm: "fit", calls: 3 })] });
  assert.equal(small.strata.normal.outcome, "retain");
  assert.match(small.strata.normal.why, /accepted lower bound/);
  // Fit accepts fewer: retained (and, at this size, not halted).
  const worse = evaluate({ runs: [...many(30, { arm: "argo" }), ...many(25, { arm: "fit" }), ...many(5, { arm: "fit", accepted: false, firstPass: false })] });
  assert.deepEqual([worse.strata.normal.outcome, worse.strata.normal.halted], ["retain", false]);
  // Non-inferior but slower beyond the elapsed margin, though fewer calls: retained.
  const slow = evaluate({ runs: [...many(300, { arm: "argo", calls: 4 }), ...many(300, { arm: "fit", calls: 3, elapsed: 120_000 })] });
  assert.equal(slow.strata.normal.outcome, "retain");
  assert.equal(slow.strata.normal.cost.elapsed_ms.status, "worse");
  // Equal cost: nothing is cheaper, retained.
  const same = evaluate({ runs: [...many(300, { arm: "argo" }), ...many(300, { arm: "fit" })] });
  assert.equal(same.strata.normal.outcome, "retain");
  assert.match(same.strata.normal.why, /lower on no known cost/);
});

test("evaluate: unknown usage never counts as cheaper", () => {
  const none = evaluate({ runs: [...many(300, { arm: "argo", tokens: 400 }), ...many(300, { arm: "fit", usage: false })] });
  assert.equal(none.strata.normal.cost.tokens.status, "unknown");
  assert.equal(none.strata.normal.outcome, "retain", "fit's unreported tokens are not fewer tokens");
  // Half of fit's runs report far fewer tokens, half report none: a median over the reporting half is not the arm's.
  const partial = evaluate({ runs: [...many(300, { arm: "argo", tokens: 400 }), ...many(150, { arm: "fit", tokens: 40 }), ...many(150, { arm: "fit", usage: false })] });
  assert.equal(partial.strata.normal.cost.tokens.status, "unknown");
  assert.equal(partial.strata.normal.outcome, "retain");
});

test("evaluate: the stop rule halts a stratum where fit is clearly worse, after STOP_MIN_N per arm only", () => {
  const halted = evaluate({ runs: [...many(10, { arm: "argo", stakes: "low" }), ...many(10, { arm: "fit", stakes: "low", accepted: false, firstPass: false }),
    ...many(10, { arm: "argo" }), ...many(10, { arm: "fit" })] });
  assert.equal(halted.strata.low.halted, true, halted.strata.low.why);
  assert.equal(halted.strata.low.outcome, "retain");
  assert.ok(halted.strata.low.rates.accepted.stop_ci[1] <= -STOP_MARGIN);
  assert.deepEqual(halted.halted, ["low"]);
  assert.equal(halted.strata.normal.outcome, "insufficient_evidence", "strata are decided separately");
  assert.equal(halted.outcome, "retain");
  assert.equal(halted.measured, false, "a halt at n < MIN_N is recorded, but not as measured");
  const early = evaluate({ runs: [...many(9, { arm: "argo", stakes: "low" }), ...many(9, { arm: "fit", stakes: "low", accepted: false, firstPass: false })] });
  assert.equal(early.strata.low.halted, false);
  assert.equal(early.strata.low.outcome, "insufficient_evidence");
  // The halt feeds the assignment: the stratum is no longer interleaved.
  const k = keyFor("fit", "stop");
  assert.deepEqual([assignArm({ ticketKey: k, stakes: "low", policy: { eligible: ["low", "normal"], halted: halted.halted } }).basis], [BASIS.halted]);
});

test("evaluate: reads a directory of boards like a list; synthetic iff any included run did not declare live providers", () => {
  const dir = mkdtempSync(join(tmpdir(), "pantheon-evaluate-"));
  try {
    const runs = [...many(3, { arm: "argo", kind: "live" }), ...many(3, { arm: "fit", kind: "live" })];
    runs.forEach((r, i) => { mkdirSync(join(dir, `board-${String(i).padStart(3, "0")}`)); writeFileSync(join(dir, `board-${String(i).padStart(3, "0")}`, "run.json"), JSON.stringify(r)); });
    const fromDir = evaluate({ runs: dir }), fromList = evaluate({ runs });
    assert.equal(fromDir.digest, fromList.digest);
    assert.equal(fromDir.synthetic, false);
    assert.deepEqual(evaluationEvidence(fromDir), { kind: "digest", schema: EVALUATION_SCHEMA, sha: fromDir.digest, synthetic: false });
    assert.equal(evaluate({ runs: [...runs, mkRun({ arm: "fit", kind: "fake" })] }).synthetic, true);
    const { providers, ...undeclared } = mkRun({ arm: "fit" });
    assert.equal(evaluate({ runs: [...runs, undeclared] }).synthetic, true, "a run that declares no providers counts as synthetic");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(defaultEvidenceStore({ ledgerRoot: "/x/ophanim/ledger", configured: null }), "/x/ophanim/runs");
  assert.equal(defaultEvidenceStore({ ledgerRoot: "/x/ledger", configured: "/y/store" }), "/y/store");
});

test("automaticAssessment: never promote; propose_policy names fit and its proposer; on a fit cycle it is a measurement", () => {
  const good = evaluate({ runs: [...many(300, { arm: "argo", calls: 4 }), ...many(300, { arm: "fit", calls: 3 })] });
  const a = automaticAssessment(good, { policy: currentPolicy("argo") });
  assert.equal(a.outcome, "propose_policy");
  assert.deepEqual(a.proposer, FIT_PROPOSER);
  assert.equal(a.candidate.policy.profile, "fit");
  assert.deepEqual(a.evidence, [{ kind: "digest", schema: EVALUATION_SCHEMA, sha: good.digest, synthetic: true }]);
  assert.equal(automaticAssessment(good, { policy: currentPolicy("fit") }).outcome, "propose_measurement");
  for (const r of [good, evaluate({ runs: [] }), evaluate({ runs: many(30, { arm: "argo" }).concat(many(30, { arm: "fit", accepted: false })) })]) {
    for (const p of ["argo", "fit"]) assert.notEqual(automaticAssessment(r, { policy: currentPolicy(p) }).outcome, "promote");
  }
});

// ---------------------------------------------------------------- every cycle close gets an assessment

function boardRepo(repo, items) {
  writeFileSync(join(repo, "alpha.mjs"), "export const ok = false;\n");
  writeFileSync(join(repo, "verify.mjs"), 'import assert from "node:assert/strict"; import {ok} from "./alpha.mjs"; assert.equal(ok, true);\n');
  writeFileSync(join(repo, ".gitignore"), "outputs/\ncooldowns/\nboards/\nbundles/\nstore/\nagy.log\nfake-agy\n");
  mkdirSync(join(repo, "tickets"));
  for (const item of items) writeFileSync(join(repo, "tickets", `${item}.json`), JSON.stringify({
    schema: "ophanim.ticket/v1", item, slice: "the whole item: alpha.mjs exports ok = true", proposes: { state: "Resolved", basis: "alpha.mjs exports ok = true" },
    title: "alpha.mjs exports ok = true", goal: "Make alpha.mjs export `ok` as true.", question: "fixture",
    repo_root: ".", slot: "alpha", path: "alpha.mjs", copy: ["alpha.mjs", "verify.mjs"], acceptance_cmd: "node verify.mjs", difficulty: "easy",
  }, null, 2) + "\n");
  const statusRoot = join(repo, "status", "ledger");
  openStatusLedger({ root: statusRoot });
  const keys = mkdtempSync(join(tmpdir(), "pantheon-eval-keys-"));
  chmodSync(keys, 0o700);
  for (const f of readdirSync(join(statusRoot, "keys"))) renameSync(join(statusRoot, "keys", f), join(keys, f));
  rmSync(join(statusRoot, "keys"), { recursive: true });
  for (const item of items) openStatusLedger({ root: statusRoot, keys }).set({ item, title: item, state: "Ready", basis: "nothing external awaited", checked: "2026-11-17" });
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Fixture Owner"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "owner@example.invalid"]);
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "fixture base"]);
  return { statusRoot, keys };
}
const APPROVE = "```json\n{\"verdict\": \"approve\", \"findings\": []}\n```";
let replies = 0;
const approve = async ({ vendor, model }) => ({ text: APPROVE, response_id: `eval_${vendor}_${++replies}`, served_model: model });

test("cycle close: without a stated assessment the controller records the evaluation's (synthetic on fixtures); a stated one is kept; never a promote", async () => {
  await withDispatch(async ({ dir: repo, makeClientFor }) => {
    const { statusRoot, keys } = boardRepo(repo, ["eval-a", "eval-b", "eval-c"]);
    const store = join(repo, "store");
    try {
      const run = (item, extra = {}) => runBoardItem({ repo, item, statusRoot, makeClientFor, turn: approve, dir: join(repo, "boards", item), out: join(repo, "bundles", item),
        runOpts: { scouts: ["xai"], revisions: 2 }, evidenceStore: store, ...extra });

      // 1. Nothing stated, nothing accumulated: the cycle closes on the automatic insufficient_evidence.
      const a = await run("eval-a");
      assert.equal(a.bundle.run.shipped, true, JSON.stringify(a.bundle.run.error));
      assert.ok(a.proposal, a.why);
      assert.deepEqual(a.bundle.review.practice.map(d => [d.stage, d.outcome, d.provisional]), [["assessment", "insufficient_evidence", true]]);
      const sys = openPantheonLedger({ root: a.bundle.review.ledger });
      const disp = sys.ledger.read().filter(e => e.kind === "practice.disposition").map(e => sys.ledger.payloadOf(e));
      assert.equal(disp.length, 1);
      assert.equal(disp[0].measured, false);
      assert.equal(disp[0].provenance.by.role, "controller");
      assert.equal(disp[0].evidence[0].schema, EVALUATION_SCHEMA);
      assert.equal(disp[0].evidence[0].synthetic, true, "fixture runs: the evaluation is synthetic");
      // The run was deposited in the store, and the cited record is on disk and re-derives.
      const stored = readdirSync(store).filter(d => d !== "evaluations");
      assert.equal(stored.length, 1);
      assert.equal(JSON.parse(readFileSync(join(store, stored[0], "run.json"), "utf8")).providers.kind, "fake");
      const record = JSON.parse(readFileSync(a.bundle.review.evaluation.file, "utf8"));
      assert.equal(record.digest, disp[0].evidence[0].sha);
      assert.equal(evaluationDigest(record), record.digest);

      // 2. A stated assessment wins: no automatic one is added.
      const b = await run("eval-b", { practice: { outcome: "retain", question: "stated by the operator" } });
      assert.deepEqual(b.bundle.review.practice.map(d => d.outcome), ["retain"]);
      assert.equal(b.bundle.review.evaluation, undefined);

      // 3. With enough accumulated interleaved evidence for fit, the strongest automatic outcome is propose_policy.
      for (const [i, r] of [...many(300, { arm: "argo", calls: 9 }), ...many(300, { arm: "fit", calls: 3 })].entries()) {
        mkdirSync(join(store, `seed-${String(i).padStart(4, "0")}`)); writeFileSync(join(store, `seed-${String(i).padStart(4, "0")}`, "run.json"), JSON.stringify(r));
      }
      const c = await run("eval-c");
      assert.ok(c.proposal, c.why);
      assert.deepEqual(c.bundle.review.practice.map(d => d.outcome), ["propose_policy"]);
      const sysC = openPantheonLedger({ root: c.bundle.review.ledger });
      const view = { entry: h => sysC.ledger.read().find(e => sysC.ledger.hashOf(e) === h) };
      const proposal = c.bundle.review.practice[0].disposition;
      const p = sysC.ledger.payloadOf(view.entry(proposal));
      // Provisional even with a sufficient sample: a sufficient sample is not a qualified measurement (owner audit,
      // learning P2), and the controller is not an independent decision.
      assert.deepEqual([p.stage, p.candidate.policy.profile, p.proposer.lab, p.evidence[0].synthetic, p.measured, p.provisional],
        ["assessment", "fit", "anthropic", true, false, true]);
      assert.match(p.question, /not qualification: provisional until an independent decision/);
      assert.ok(!sysC.ledger.read().some(e => e.kind === "practice.disposition" && sysC.ledger.payloadOf(e).outcome === "promote"));
      // Nobody can promote it on this evidence: not the proposer's lab, and not another lab (synthetic).
      const rec = sysC.recorder();
      const later = await reviewCycle({ ledger: rec, change: { scope: "eval-promote", base: "a".repeat(40), head: "b".repeat(40),
        diff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-1\n+2\n", files: ["x"], author_labs: ["openai"] }, turn: approve, n: 1 });
      const promote = seat => rec.recordDisposition({ cycle: later.cycle, stage: "candidate", proposal, outcome: "promote", question: "promote fit?", measured: true,
        evidence: [{ kind: "ledger", hash: proposal }], by: seat, provenance: { by: { role: "check@review" }, method: "review" },
        conditions: { applicability: "fixture", rollback: "argo", reevaluate: "next cycle" } });
      assert.throws(() => promote({ vendor: "anthropic", model: "claude-opus-5", lab: "anthropic" }), /may not record its own promotion/);
      assert.throws(() => promote({ vendor: "xai", model: "grok-4.7", lab: "xai" }), /synthetic/);
      assert.equal(sysC.ledger.verify().ok, true);

      // pantheon-board evaluate prints the store's evaluation and halted strata.
      const out = spawnSync(process.execPath, [BOARD_CLI, "evaluate", "--runs", store, "--json"], { encoding: "utf8" });
      assert.equal(out.status, 0, out.stderr);
      const printed = JSON.parse(out.stdout);
      assert.deepEqual([printed.outcome, printed.synthetic, printed.halted], ["propose_policy", true, []]);
      const text = spawnSync(process.execPath, [BOARD_CLI, "evaluate", "--runs", store], { encoding: "utf8" });
      assert.equal(text.status, 0, text.stderr);
      assert.match(text.stdout, /normal\s+propose_policy/);
      assert.match(text.stdout, /halted strata: none/);
    } finally { rmSync(keys, { recursive: true, force: true }); }
  });
});
