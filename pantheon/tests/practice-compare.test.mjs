// CYCLE_CONTRACT.md step 6 and its acceptance case: "A synthetic matched comparison verifies the mechanics; a
// scoped live comparison is needed before claiming measured provider cost/quality improvement."
//
//   - compareProfiles runs the SAME tickets under the baseline and the candidate profile, through the real
//     dispatcher (runOpenItem), with the same declared bounds, and reports per ticket and in aggregate:
//     accepted results, provider calls by outcome, usage with usage_complete, USD (unknown is null, never
//     0), elapsed time, rework, retries/fallbacks and coordination overhead. Failed and inconclusive
//     tickets are included, never dropped. Reviewer agreement is not reported as correctness.
//   - the comparison record has a digest a practice disposition cites, says `synthetic: true` and names
//     the fake providers; a promote resting only on synthetic evidence is refused by the ledger.
//   - pantheon-compare.mjs runs it with --clients/--turn fake modules and writes the record.
// Every provider is scripted; no network, no keys, no spend.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { compareProfiles, dispatchRunner, comparisonEvidence, verifyComparison, COMPARE_SCHEMA } from "../src/practice/compare.mjs";
import { openPantheonLedger } from "../src/ledger/system.mjs";
import { reviewCycle } from "../src/ledger/review-cycle.mjs";
import { ledgerView } from "../src/ledger/cycle-kinds.mjs";
import { withDispatch, WORK, USAGE } from "./fixtures/dispatch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "..", "bin", "pantheon-compare.mjs");
const FIXTURE = pathToFileURL(join(HERE, "fixtures", "dispatch.mjs")).href;
const BOUNDS = { maxProviderCalls: 12, revisions: 2 };
const FAKE = { kind: "fake", clients: "tests/fixtures/dispatch.mjs scriptedClients" };
const quota = () => Object.assign(new Error("You exceeded your current quota"), { status: 429, code: "insufficient_quota" });

test("compareProfiles: the same tickets under argo and fit, through the real dispatcher, with the same bounds; nothing dropped", async () => {
  await withDispatch(async ({ dir, spec, makeClientFor, fault, agyQuotaOnce }) => {
    // The first implementer request of each "flaky" run is refused for quota: the router falls back. Under argo the
    // implementer is an API seat (the scripted fault); under the fit matrix it is an Antigravity lane, so the fake CLI
    // refuses that run's first lane turn for quota and the next rung of the lane ladder answers.
    agyQuotaOnce("flaky-marker");
    let refuseNext = true;
    fault(c => {
      if (!WORK.test(c.prompt) || !/flaky-marker/.test(c.prompt)) return null;
      const r = refuseNext; refuseNext = !refuseNext;
      return r ? { error: quota() } : null;
    });
    const tickets = [
      spec("cmp-ok"),
      spec("cmp-flaky", { goal: "fixture goal flaky-marker" }),
      spec("cmp-fails", { acceptance_cmd: "false" }),
    ];
    const seen = [];
    const inner = dispatchRunner({ makeClientFor, dir: join(dir, "compare"), runOpts: { scouts: ["xai"] } });
    const runner = async a => { seen.push({ key: a.spec.key, profile: a.profile, bounds: a.bounds }); return inner(a); };
    const rec = await compareProfiles({ tickets, baseline: "argo", candidate: "fit", bounds: BOUNDS, runner, providers: FAKE,
      question: "Does fit change accepted results or provider usage against argo on these fixture tickets?" });

    assert.equal(rec.schema, COMPARE_SCHEMA);
    assert.equal(rec.synthetic, true, "fake providers: the record can never be read as a live measurement");
    assert.equal(rec.providers.kind, "fake");
    assert.deepEqual(rec.bounds, { maxProviderCalls: 12, revisions: 2 });
    // Matched: every ticket under both profiles, interleaved, with the identical bounds object passed in.
    assert.deepEqual(seen.map(s => `${s.key}:${s.profile}`), ["cmp-ok:argo", "cmp-ok:fit", "cmp-flaky:argo", "cmp-flaky:fit", "cmp-fails:argo", "cmp-fails:fit"]);
    for (const s of seen) assert.deepEqual(s.bounds, rec.bounds);
    assert.equal(rec.profiles.baseline.profile, "argo");
    assert.equal(rec.profiles.candidate.profile, "fit");
    assert.match(rec.profiles.candidate.policy.hash, /^sha256:/);
    assert.notEqual(rec.profiles.baseline.policy.hash, rec.profiles.candidate.policy.hash);
    assert.deepEqual(rec.results.map(r => r.ticket), ["cmp-ok", "cmp-flaky", "cmp-fails"], "every ticket is reported, the failing one included");

    for (const r of rec.results) for (const arm of ["baseline", "candidate"]) {
      const a = r[arm], profile = rec.profiles[arm];
      assert.equal(a.profile, profile.profile);
      assert.equal(a.policy_hash, profile.policy.hash, `${r.ticket}/${arm}: the run ran the policy the record names`);
      assert.equal(a.provider_call_limit, 12, `${r.ticket}/${arm}: the dispatcher ran under the declared bound`);
      assert.ok(a.provider_calls.value > 0 && a.provider_calls.value <= 12);
      assert.equal(a.usd.value, null, "no attempt states a cost: unknown, never 0");
      assert.match(a.usd.basis, /unknown/);
      assert.ok(Number.isFinite(a.elapsed_ms.value) && a.elapsed_ms.value >= 0);
      assert.ok(a.coordination.scout_turns >= 1, `${r.ticket}/${arm}: scouts are coordination overhead`);
      assert.ok(a.coordination_overhead.value > 0 && a.coordination_overhead.value < 1);
      assert.equal(a.coordination_overhead.n, a.provider_calls.value);
      assert.ok(a.operating_points.length >= 3 && a.operating_points.every(o => o.model && o.purpose)); // scout, work, critique: no planner model under the board default planTitle ticket
      if (arm === "candidate") assert.ok(a.operating_points.some(o => o.class), "fit records each seat's class");
      assert.ok(a.stakes.value, `${r.ticket}/${arm}: a stakes stratum (${a.stakes.basis})`);
    }
    const ok = rec.results[0];
    for (const arm of ["baseline", "candidate"]) {
      const a = ok[arm];
      assert.equal(a.status, "accepted");
      assert.equal(a.accepted, true);
      assert.equal(a.first_pass, true);
      assert.equal(a.revisions_to_accept, 1);
      assert.equal(a.gates.REVIEW, true);
      assert.equal(a.coordination.review_turns, 1);
      assert.equal(a.review_rejections.value, 0);
      assert.equal(a.usage_complete, true, "every scripted request reported usage");
      assert.equal(a.tokens_in.value, a.provider_calls.value * USAGE.input_tokens, "the providers' own counts, summed");
      assert.equal(a.calls_per_accept, a.provider_calls.value);
      assert.equal(a.tokens_per_accept, a.provider_calls.value * (USAGE.input_tokens + USAGE.output_tokens));
    }
    const flaky = rec.results[1];
    for (const arm of ["baseline", "candidate"]) {
      const a = flaky[arm];
      assert.equal(a.by_outcome.quota, 1, `${arm}: the refused request is counted`);
      assert.equal(a.failed_attempts.value, 1);
      // baseline: the fallback after the refused API request. candidate (fit matrix): the next lane rung after the
      // refused lane, and the reviewer's fallback -- its pinned OpenAI seat is on the pool the baseline arm's quota
      // refusal just closed (the shared cooldown store), so the next admitted reviewer answered.
      assert.equal(a.retries.value + a.fallbacks.value, arm === "baseline" ? 1 : 2, `${arm}: the recovery from it is counted`);
      assert.equal(a.usage_complete, false, "the refused request reported no usage");
      assert.equal(a.tokens_in.value, null, "so the token total is unknown, not a partial sum");
      assert.equal(a.tokens_in.missing, 1);
      assert.equal(a.tokens_per_accept, null);
      assert.equal(a.accepted, true);
    }
    const fails = rec.results[2];
    for (const arm of ["baseline", "candidate"]) {
      const a = fails[arm];
      assert.notEqual(a.status, "accepted");
      assert.equal(a.accepted, false);
      assert.equal(a.first_pass, false);
      assert.ok(a.revisions.value >= 1 && a.revisions.value <= 2, `${arm}: within the declared revision bound`);
      assert.ok(a.revisions.value === 2 || a.escalations.by_action.stop >= 1, `${arm}: the bound was used up, or a recorded stop ended it`);
      assert.equal(a.revisions_to_accept, null);
      assert.ok(a.escalations.value >= 1, "the failed acceptance escalated");
      assert.equal(Object.values(a.escalations.by_action).reduce((x, y) => x + y, 0), a.escalations.value);
    }
    // Aggregate: every ticket counted; unknown cost stays unknown; rates carry intervals; n is too small.
    for (const arm of ["baseline", "candidate"]) {
      const g = rec.aggregate[arm].all, rows = rec.results.map(r => r[arm]);
      assert.equal(g.n, 3);
      assert.equal(g.accepted.count, 2);
      assert.equal(g.accepted.n, 3);
      assert.ok(g.accepted.wilson95[0] < 2 / 3 && g.accepted.wilson95[1] > 2 / 3);
      assert.equal(Object.values(g.status).reduce((x, y) => x + y, 0), 3);
      assert.equal(g.provider_calls.value, rows.reduce((n, a) => n + a.provider_calls.value, 0));
      assert.equal(g.by_outcome.quota, 1);
      assert.equal(g.usd.value, null);
      assert.equal(g.usage_complete, false);
      assert.equal(g.tokens_in.value, null);
      assert.equal(g.insufficient, true, "three tickets are an anecdote");
      assert.equal(g.min_n, 20);
      assert.ok(Object.keys(rec.aggregate[arm].strata).length >= 1, "stratified by stakes");
    }
    // Agreement is not correctness: nothing is reported as "correct"; the definition says so.
    assert.doesNotMatch(JSON.stringify(rec.results), /"correct/);
    assert.match(rec.interpretation.accepted, /agreement, not correctness/);
    assert.match(rec.interpretation.synthetic, /mechanics/);
    assert.equal(rec.interpretation.verdict, null, "the comparison draws no conclusion of its own");
    // The digest re-derives; any edit breaks it.
    assert.equal(verifyComparison(rec).ok, true);
    assert.equal(verifyComparison({ ...rec, synthetic: false }).ok, false, "a synthetic record cannot be relabelled live");
    assert.deepEqual(comparisonEvidence(rec), { kind: "digest", schema: COMPARE_SCHEMA, sha: rec.digest, synthetic: true });
  });
});

test("compareProfiles: an inconclusive ticket (the runner failed, or the bound refused a call) is kept; unknown usage and cost stay unknown", async () => {
  const attempt = (purpose, over = {}) => ({ purpose, vendor: "xai", model: "m", pool: "xai", outcome: "ok", usage: { input_tokens: 10, output_tokens: 2 }, ...over });
  const run = (over = {}) => ({ shipped: true, gates: [{ gate: "REVIEW", ok: true }, { gate: "TESTS", ok: true }], revisions: [{ rev: 1 }],
    started_at: "2026-11-17T00:00:00.000Z", finished_at: "2026-11-17T00:00:02.500Z",
    turns: [{ purpose: "scout" }, { purpose: "critique" }], provider_calls: { limit: 5, made: 2, refused: null },
    attempts: [attempt("scout"), attempt("critique", { usage: null })], resources: { usd: null, usd_basis: "unknown: no versioned price source" }, ...over });
  const runner = async ({ spec, profile }) => {
    if (spec.key === "boom" && profile === "fit") throw new Error("the runner crashed");
    if (spec.key === "bounded") return { result: { shipped: false, error: { stage: "work", message: "PROVIDER_CALL_LIMIT" } },
      run: run({ shipped: false, gates: null, provider_calls: { limit: 5, made: 5, refused: { code: "PROVIDER_CALL_LIMIT" } } }) };
    if (spec.key === "priced") return { result: { shipped: true }, run: run({ attempts: [attempt("scout", { usd: 0.25 }), attempt("critique", { usd: 0.25 })] }) };
    return { result: { shipped: true }, run: run() };
  };
  const tickets = ["boom", "bounded", "plain"].map(key => ({ key, goal: "g" }));
  const rec = await compareProfiles({ tickets, bounds: { maxProviderCalls: 5 }, runner, providers: FAKE });
  assert.deepEqual(rec.bounds, { maxProviderCalls: 5, revisions: 3 }, "the default revision bound is declared, not implied");
  const boom = rec.results.find(r => r.ticket === "boom");
  assert.equal(boom.baseline.status, "accepted");
  assert.equal(boom.candidate.status, "inconclusive");
  assert.equal(boom.candidate.accepted, null);
  assert.match(boom.candidate.why, /crashed/);
  const bounded = rec.results.find(r => r.ticket === "bounded");
  for (const arm of ["baseline", "candidate"]) {
    assert.equal(bounded[arm].status, "inconclusive", "a bound that refused a call leaves the ticket undecided, not failed");
    assert.equal(bounded[arm].bound_hit, true);
  }
  const plain = rec.results.find(r => r.ticket === "plain").baseline;
  assert.equal(plain.usage_complete, false);
  assert.deepEqual([plain.tokens_in.value, plain.tokens_in.n, plain.tokens_in.missing], [null, 1, 1], "not a partial sum: unknown, with what is missing");
  assert.equal(plain.usd.value, null);
  assert.equal(plain.elapsed_ms.value, 2500, "the run's own start and finish");
  assert.equal(plain.coordination_overhead.value, 1, "scout and critique calls only");
  assert.equal(rec.aggregate.candidate.all.status.inconclusive, 2);
  assert.equal(rec.aggregate.candidate.all.n, 3);
  assert.equal(rec.aggregate.candidate.all.accepted.n, 1, "an inconclusive run decides nothing: it is not counted in the rate");
  assert.equal(rec.aggregate.baseline.all.usd.value, null);
  // A priced arm sums; one unknown makes the total unknown.
  const priced = await compareProfiles({ tickets: [{ key: "priced" }], bounds: { maxProviderCalls: 5 }, runner, providers: FAKE });
  assert.equal(priced.aggregate.baseline.all.usd.value, 0.5);
  const mixed = await compareProfiles({ tickets: [{ key: "priced" }, { key: "plain" }], bounds: { maxProviderCalls: 5 }, runner, providers: FAKE });
  assert.equal(mixed.aggregate.baseline.all.usd.value, null, "one unknown cost makes the total unknown");
  assert.equal(mixed.aggregate.baseline.all.usd.missing, 1);
  // Bounds and provider identity are required.
  await assert.rejects(compareProfiles({ tickets, bounds: {}, runner, providers: FAKE }), /maxProviderCalls/);
  await assert.rejects(compareProfiles({ tickets, bounds: { maxProviderCalls: 5 }, runner }), /providers/);
  await assert.rejects(compareProfiles({ tickets, bounds: { maxProviderCalls: 5 }, runner, providers: FAKE, baseline: "fit", candidate: "fit" }), /differ/);
  // A live record says synthetic: false; nothing but `kind: live` makes it so.
  const live = await compareProfiles({ tickets: [{ key: "plain" }], bounds: { maxProviderCalls: 5 }, runner, providers: { kind: "live", vendors: ["xai"] } });
  assert.equal(live.synthetic, false);
  const other = await compareProfiles({ tickets: [{ key: "plain" }], bounds: { maxProviderCalls: 5 }, runner, providers: { kind: "recorded" } });
  assert.equal(other.synthetic, true);
});

// ---------------------------------------------------------------- the practice disposition rule
const C = n => String(n).repeat(40).slice(0, 40);
const DIFF = "diff --git a/src/x.mjs b/src/x.mjs\n--- a/src/x.mjs\n+++ b/src/x.mjs\n@@ -1 +1 @@\n-export const x = 1;\n+export const x = 2;\n";
const APPROVE = "```json\n{\"verdict\":\"approve\",\"findings\":[]}\n```";
const approve = async ({ vendor, model }) => ({ text: APPROVE, response_id: `resp_${vendor}_${Math.random()}`, served_model: model });
const QUESTION = "Does fit change accepted results or provider usage against argo?";
const CANDIDATE_POLICY = { version: "pantheon.selection/v1", hash: "sha256:" + "f".repeat(64), profile: "argo" };
const CANDIDATE = { id: "fit-default", policy: CANDIDATE_POLICY, change: "make fit the default routing profile" };
const CONDITIONS = { applicability: "fixture", rollback: "retain argo on any regression", reevaluate: "after 20 tickets" };
const SYNTH = { kind: "digest", schema: COMPARE_SCHEMA, sha: "sha256:" + "1".repeat(64), synthetic: true };
const LIVE = { kind: "digest", schema: COMPARE_SCHEMA, sha: "sha256:" + "2".repeat(64), synthetic: false };

async function practiceLedger(fn) {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const d = mkdtempSync(join(tmpdir(), "pantheon-compare-practice-"));
  try { const sys = openPantheonLedger({ root: join(d, "ledger") }); return await fn(sys, sys.recorder()); }
  finally { rmSync(d, { recursive: true, force: true }); }
}
const cycleOf = async (rec, head) => {
  const r = await reviewCycle({ ledger: rec, change: { scope: "ophanim", ...(head ? { head } : { base: C("a"), head: C("b") }), diff: DIFF, files: ["src/x.mjs"], author_labs: ["anthropic"] }, turn: approve });
  assert.equal(r.complete, true);
  return r.cycle;
};
const by = { by: { role: "lead@orch" }, method: "matched comparison" };

test("practice: a promote resting only on synthetic comparison evidence is refused; a live comparison may carry it", () => practiceLedger(async (sys, rec) => {
  const first = await cycleOf(rec);
  // The synthetic comparison is cited by a propose_measurement: that is what it is for.
  const measure = rec.recordDisposition({ cycle: first, outcome: "propose_measurement", question: QUESTION, evidence: [SYNTH], provenance: by });
  assert.equal(ledgerView(sys.ledger).payload(measure).evidence[0].synthetic, true);
  // A comparison digest must say whether it is synthetic.
  assert.throws(() => rec.recordDisposition({ cycle: first, outcome: "propose_measurement", question: QUESTION,
    evidence: [{ kind: "digest", schema: COMPARE_SCHEMA, sha: SYNTH.sha }], provenance: by }), /synthetic/);
  const proposal = rec.recordDisposition({ cycle: first, outcome: "propose_policy", question: QUESTION, evidence: [SYNTH], provenance: by,
    candidate: CANDIDATE, proposer: { vendor: "openai", model: "gpt-6-sol", lab: "openai" } });
  rec.closeCycle(first);
  const second = await cycleOf(rec, C("d"));
  const promote = over => rec.recordDisposition({ cycle: second, stage: "candidate", proposal, outcome: "promote", question: QUESTION, measured: true,
    conditions: CONDITIONS, by: { vendor: "xai", model: "grok-4.7", lab: "xai" }, provenance: { by: { role: "check@review" }, method: "review of the comparison" }, ...over });
  // Only synthetic: refused, directly or through the disposition that cites it.
  assert.throws(() => promote({ evidence: [{ kind: "ledger", hash: measure }, SYNTH] }), /synthetic/);
  assert.throws(() => promote({ evidence: [{ kind: "ledger", hash: measure }] }), /synthetic/, "a disposition resting on a synthetic comparison is synthetic evidence");
  const promoted = promote({ evidence: [{ kind: "ledger", hash: measure }, SYNTH, LIVE] });
  assert.equal(ledgerView(sys.ledger).payload(promoted).outcome, "promote");
  assert.equal(sys.ledger.verify().ok, true, "and the chain re-derives with the rule applied");
}));
// The older promote (citing a non-comparison ledger entry, no synthetic flag anywhere) still verifies:
// tests/ledger-practice.test.mjs is unchanged, and fixtures/cycle-v1-ledger re-derives hash for hash.

// ---------------------------------------------------------------- the CLI
test("pantheon-compare.mjs: --clients/--turn fake modules, an explicit --max-provider-calls, the record written to --out", async () => {
  await withDispatch(async ({ dir: repo }) => {
    writeFileSync(join(repo, "alpha.mjs"), "export const ok = false;\n");
    writeFileSync(join(repo, "verify.mjs"), 'import assert from "node:assert/strict"; import {ok} from "./alpha.mjs"; assert.equal(ok, true);\n');
    mkdirSync(join(repo, "tickets"));
    for (const [item, difficulty] of [["cmp-easy", "easy"], ["cmp-hard", "hard"]]) {
      writeFileSync(join(repo, "tickets", `${item}.json`), JSON.stringify({
        schema: "ophanim.ticket/v1", item, slice: "alpha.mjs exports ok = true", proposes: { state: "Resolved", basis: "alpha.mjs exports ok = true" },
        title: "alpha.mjs exports ok = true", goal: "Make alpha.mjs export `ok` as true.", question: "fixture",
        repo_root: ".", slot: "alpha", path: "alpha.mjs", copy: ["alpha.mjs", "verify.mjs"], acceptance_cmd: "node verify.mjs", difficulty,
      }, null, 2) + "\n");
    }
    writeFileSync(join(repo, "clients.fixture.mjs"), `import { scriptedClients } from ${JSON.stringify(FIXTURE)};\nexport default scriptedClients();\n`);
    writeFileSync(join(repo, "turn.fixture.mjs"), "let n = 0;\nexport default async ({ vendor, model }) => ({ text: '```json\\n{\"verdict\": \"approve\", \"findings\": []}\\n```', response_id: `cli_${vendor}_${++n}`, served_model: model });\n");
    const out = join(repo, "comparison.json");
    const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: process.env, timeout: 240_000 });
    const base = ["--repo", repo, "--item", "cmp-easy", "--item", "cmp-hard", "--dir", join(repo, "compare")];

    // Live is never the default, and nothing runs without a declared provider-call bound.
    assert.equal(cli(...base, "--max-provider-calls", "20", "--out", out).status, 2, "no --clients and no --live: refused");
    assert.equal(cli(...base, "--clients", join(repo, "clients.fixture.mjs"), "--out", out).status, 2, "no --max-provider-calls: refused");
    assert.equal(cli(...base, "--live", "--out", out).status, 2, "--live without --max-provider-calls: refused");
    assert.equal(existsSync(out), false, "a refused invocation writes nothing");

    const r = cli(...base, "--clients", join(repo, "clients.fixture.mjs"), "--turn", join(repo, "turn.fixture.mjs"),
      "--max-provider-calls", "20", "--revisions", "2", "--question", "fixture: fit against argo", "--out", out);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr.slice(-3000)}`);
    const rec = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(rec.schema, COMPARE_SCHEMA);
    assert.equal(rec.synthetic, true);
    assert.equal(rec.providers.kind, "fake");
    assert.match(rec.providers.clients.sha256, /^sha256:[0-9a-f]{64}$/, "the fake module is identified by its bytes");
    assert.match(rec.providers.turn.sha256, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(rec.bounds, { maxProviderCalls: 20, revisions: 2, cycle_review: { n: 3, max_attempts: 1 } });
    assert.deepEqual(rec.tickets.map(t => t.key), ["cmp-easy", "cmp-hard"]);
    for (const t of rec.tickets) assert.match(t.digest, /^sha256:/);
    assert.equal(verifyComparison(rec).ok, true);
    for (const row of rec.results) for (const arm of ["baseline", "candidate"]) {
      const a = row[arm];
      assert.equal(a.status, "accepted", `${row.ticket}/${arm}: ${a.why}`);
      const cr = a.coordination.cycle_review;
      assert.equal(cr.reviews, 3, "the independent cycle review ran on three labs");
      assert.equal(cr.approvals, 3);
      assert.match(cr.note, /agreement, not correctness/);
    }
    const summary = JSON.parse(r.stdout);
    assert.equal(summary.record, out);
    assert.equal(summary.digest, rec.digest);
    assert.equal(summary.synthetic, true);
    assert.deepEqual(summary.evidence, comparisonEvidence(rec));
  });
});
