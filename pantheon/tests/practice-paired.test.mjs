// Paired runs for evaluating `fit` against `argo` (owner decision 2026-11-17; docs/routing-task-profile.md,
// "Continuous evaluation", "Paired runs").
//
//   - sampling: pairFor is a deterministic hash of the ticket key at a configured rate (default 0, off), with
//     its basis recorded, for every stakes stratum; a halted stratum is not paired.
//   - the counterpart: the same ticket under the other profile in a separate dry board, on a snapshot of the
//     target repository: it never ships to the real shipping ref, never merges into the target repository,
//     never writes the status ledger, never closes the real review cycle. Pairing needs an explicit provider-
//     call bound (refused, by name and on record, without one). Counterpart failures are outcomes.
//   - the paired evaluation: discordant counts, Newcombe's paired interval (method 10, checked against the
//     published Table III), an exact Wilcoxon signed-rank test on the per-pair cost differences, the decision
//     rule with its stop rule, and the projection of pairs needed. Paired evidence takes precedence.
// Every provider is scripted (tests/fixtures/dispatch.mjs); no network, no keys, no spend.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, chmodSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { pairFor, PAIR_SCHEMA, PAIR_BASIS, DEFAULT_PAIR_POLICY, bucketOf } from "../src/practice/assign.mjs";
import { evaluate, automaticAssessment, pairedNewcombe, wilcoxonSignedRank, pairsNeeded,
  MIN_PAIRS, PAIR_STOP_MIN_N, PAIRED_COST_ALPHA, NONINFERIORITY_MARGIN, STOP_MARGIN, MIN_N } from "../src/practice/evaluate.mjs";
import { ASSIGN_SCHEMA, BASIS } from "../src/practice/assign.mjs";
import { runBoardItem } from "../src/board/operate.mjs";
import { currentPolicy } from "../src/ledger/practice-kinds.mjs";
import { openStatusLedger } from "../../packages/ledger/status.mjs";
import { withDispatch } from "./fixtures/dispatch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOARD_CLI = resolve(HERE, "..", "bin", "pantheon-board.mjs");
const near = (a, b, tol = 5e-5) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------- sampling

test("pairFor: deterministic per ticket key, respects the rate, off by default, recorded with its basis", () => {
  assert.equal(DEFAULT_PAIR_POLICY.pairRate, 0, "pairing is off unless the owner sets a rate");
  for (const k of ["a", "ticket-42", "obs-1.slice"]) assert.deepEqual(pairFor({ ticketKey: k, policy: { pairRate: 0.3 } }), pairFor({ ticketKey: k, policy: { pairRate: 0.3 } }));
  const keys = Array.from({ length: 4000 }, (_, i) => `p-${i}`);
  const at = rate => keys.filter(k => pairFor({ ticketKey: k, policy: { pairRate: rate } }).sampled);
  assert.equal(at(0).length, 0);
  assert.equal(pairFor({ ticketKey: "x" }).sampled, false);
  assert.equal(pairFor({ ticketKey: "x" }).basis, PAIR_BASIS.off);
  assert.equal(at(1).length, keys.length);
  const quarter = at(0.25).length;
  assert.ok(quarter > 880 && quarter < 1120, `about a quarter are paired (${quarter} of 4000)`);
  // Monotone in the rate: raising it only adds tickets.
  const low = new Set(at(0.1));
  assert.ok([...low].every(k => at(0.3).includes(k)));
  // Independent of the interleaving hash: paired tickets are spread over both arms.
  const arms = at(0.25).map(k => bucketOf(k));
  const ones = arms.filter(Boolean).length;
  assert.ok(ones > arms.length * 0.4 && ones < arms.length * 0.6, `${ones} of ${arms.length}`);
  const p = pairFor({ ticketKey: "p-7", stakes: "critical", policy: { pairRate: 1 } });
  assert.deepEqual([p.schema, p.sampled, p.rate, p.basis, p.stakes], [PAIR_SCHEMA, true, 1, PAIR_BASIS.hash, "critical"]);
  assert.ok(p.u >= 0 && p.u < 1);
  // Every stakes stratum is paired, high and critical included (the counterpart never ships), and unknown stakes.
  for (const stakes of ["low", "normal", "high", "critical", null]) assert.equal(pairFor({ ticketKey: "p-7", stakes, policy: { pairRate: 1 } }).sampled, true, String(stakes));
  // A stratum the stop rule has halted is not paired.
  const h = pairFor({ ticketKey: "p-7", stakes: "low", policy: { pairRate: 1, halted: ["low"] } });
  assert.deepEqual([h.sampled, h.basis], [false, PAIR_BASIS.halted]);
  for (const bad of [-0.1, 1.5, "0.5", NaN]) assert.throws(() => pairFor({ ticketKey: "x", policy: { pairRate: bad } }), /pairRate/);
});

// ---------------------------------------------------------------- the statistics

test("pairedNewcombe: Newcombe (1998) paired method 10 reproduces the published Table III and StatsDirect's worked example", () => {
  // Newcombe RG. Improved confidence intervals for the difference between binomial proportions based on paired
  // data. Stat Med 1998;17:2635-2650, Table III, method 10 (95%); cells e (both), f (first only), g (second only), h (neither).
  const table3 = [
    [[36, 12, 2, 0], [0.0569, 0.3404]],
    [[20, 12, 2, 16], [0.0562, 0.3292]],
    [[18, 12, 2, 18], [0.0562, 0.3290]],
    [[36, 14, 0, 0], [0.1528, 0.4167]],
    [[35, 14, 0, 1], [0.1461, 0.4175]],
    [[18, 14, 0, 18], [0.1441, 0.3963]],
    [[2, 97, 1, 0], [0.8721, 0.9854]],
    [[1, 97, 1, 1], [0.8736, 0.9850]],
    [[0, 29, 1, 0], [0.6666, 0.9882]],
    [[0, 30, 0, 0], [0.8395, 1.0]],
    [[54, 0, 0, 0], [-0.0664, 0.0664]],
    [[53, 0, 0, 1], [-0.0729, 0.0729]],
    [[30, 0, 0, 24], [-0.0358, 0.0358]],
  ];
  // The table prints 4 decimals (and at least one entry, 0.87367 for 1/97/1/1, is printed 0.8736, i.e.
  // truncated): agreement within one unit of the 4th decimal.
  for (const [[e, f, g, h], [lo, hi]] of table3) {
    const ci = pairedNewcombe({ e, f, g, h });
    assert.ok(near(ci[0], lo, 1e-4) && near(ci[1], hi, 1e-4), `${[e, f, g, h]}: ${ci} vs ${lo}, ${hi}`);
  }
  // StatsDirect, "Paired proportions" (Armitage and Berry's example, n = 50): 0.056156 to 0.329207.
  const sd = pairedNewcombe({ e: 20, f: 12, g: 2, h: 16 });
  assert.ok(near(sd[0], 0.056156, 1e-6) && near(sd[1], 0.329207, 1e-6), String(sd));
  assert.equal(pairedNewcombe({ e: 0, f: 0, g: 0, h: 0 }), null);
  // Wider at 99%.
  const w = pairedNewcombe({ e: 20, f: 12, g: 2, h: 16 }, 2.5758293035489004);
  assert.ok(w[0] < sd[0] && w[1] > sd[1]);
});

test("wilcoxonSignedRank: exact for small n (R's example: V = 40, one-sided p = 0.01953), zeros dropped, ties by mid-ranks", () => {
  // Hollander & Wolfe (1973), p. 29; the example of R's wilcox.test: Hamilton depression scale, paired, n = 9.
  const x = [1.83, 0.50, 1.62, 2.48, 1.68, 1.88, 1.55, 3.06, 1.30];
  const y = [0.878, 0.647, 0.598, 2.05, 1.06, 1.29, 1.06, 3.14, 1.29];
  const r = wilcoxonSignedRank(x.map((v, i) => v - y[i]));
  assert.equal(r.n, 9);
  assert.equal(r.w_plus, 40);
  assert.equal(r.exact, true);
  assert.ok(near(r.p_greater, 10 / 512, 1e-12), String(r.p_greater));
  assert.ok(near(r.p_two_sided, 20 / 512, 1e-12), String(r.p_two_sided));
  const z = wilcoxonSignedRank([0, 0, -1, -1, -1, -1, -1, -1, -1, -1]);
  assert.deepEqual([z.n, z.zeros, z.w_plus], [8, 2, 0]);
  assert.ok(near(z.p_less, 1 / 256, 1e-12));
  assert.equal(wilcoxonSignedRank([]).p_two_sided, null);
  // Large n: the normal approximation, still in the right direction.
  const big = wilcoxonSignedRank(Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? 1 : -2)));
  assert.equal(big.exact, false);
  assert.ok(big.p_less < 1e-6);
});

// ---------------------------------------------------------------- constructed pair sets

const T0 = Date.parse("2026-11-17T00:00:00.000Z");
let seq = 0;
function mkRun({ profile, stakes = "normal", accepted = true, firstPass = true, calls = 4, tokens = 400, usage = true, elapsed = 60_000, kind = "fake", assignment = null }) {
  const key = `pr-${++seq}`;
  const attempts = Array.from({ length: calls }, (_, i) => ({ n: i + 1, purpose: i === 0 ? "plan" : "work", vendor: "openai", model: "gpt-6-sol", outcome: "ok",
    usage: usage ? { input_tokens: tokens / calls, output_tokens: 0 } : null }));
  return { format: 2, key, ticket_cid: `cid-${key}`, started_at: new Date(T0 + seq).toISOString(), finished_at: new Date(T0 + seq + elapsed).toISOString(),
    turns: [{ purpose: "work", vendor: "openai", model: "gpt-6-sol", selection: { profile, role: "implementer", policy: "pantheon.selection/v1", policy_hash: "sha256:" + "0".repeat(64), rank: 0 } }],
    attempts, shipped: accepted, gates: [{ gate: "TESTS", ok: accepted }, { gate: "REVIEW", ok: accepted }], revisions: firstPass ? [1] : [1, 2],
    provider_calls: { limit: null, made: calls, refused: null }, providers: { kind }, profile,
    ...(assignment ? { assignment } : {}) };
}
/**
 * One pair, in memory, as the evidence store holds it (pair.json with the two run records beside it). The
 * primary is a randomized interleaved run of `primary`'s arm; the counterpart runs the other profile.
 */
function mkPair({ stakes = "normal", fit = {}, argo = {}, primary = "argo", counterpartRun = undefined, kindPrimary = "fake", kindCounterpart = "fake" }) {
  const other = primary === "argo" ? "fit" : "argo";
  const sides = { fit, argo };
  const p = mkRun({ profile: primary, stakes, kind: kindPrimary, ...sides[primary],
    assignment: { schema: ASSIGN_SCHEMA, arm: primary, basis: BASIS.hash, stakes, randomized: true } });
  const c = counterpartRun === undefined ? mkRun({ profile: other, stakes, kind: kindCounterpart, ...sides[other] }) : counterpartRun;
  const id = `pair-${p.key}`;
  // test-lint: allow scripted-terminal-status -- mkPair builds evaluate()'s INPUT (a stored pair record), and its tests assert evaluate()'s statistics, never this status; every asserted "completed" is r.bundle.pair.status from a real runBoardItem pair run (the counterpart tests)
  return { schema: PAIR_SCHEMA, pair_id: id, status: "completed", stakes, ticket: { key: p.key, digest: `sha256:${p.key}` },
    primary: { profile: primary, run_digest: `sha256:p-${p.key}`, run: p },
    counterpart: { profile: other, run_digest: c ? `sha256:c-${p.key}` : null, dry: true, run: c, ...(c ? {} : { error: { message: "the counterpart threw before writing run.json" } }) },
    bounds: { max_provider_calls: 40, revisions: 3 } };
}
/** `n` pairs of the given outcomes: {e, f, g, h} = both accepted, fit only, argo only, neither. */
function pairSet({ e = 0, f = 0, g = 0, h = 0, stakes = "normal", fitCost = {}, argoCost = {}, firstPassFit = true, firstPassArgo = true, kind = "fake" } = {}) {
  const out = [];
  const add = (n, fa, aa) => { for (let i = 0; i < n; i++) out.push(mkPair({ stakes, primary: i % 2 ? "fit" : "argo", kindPrimary: kind, kindCounterpart: kind,
    fit: { accepted: fa, firstPass: fa && firstPassFit, ...fitCost }, argo: { accepted: aa, firstPass: aa && firstPassArgo, ...argoCost } })); };
  add(e, true, true); add(f, true, false); add(g, false, true); add(h, false, false);
  return out;
}

test("paired evaluation: where the unpaired comparison is insufficient, paired runs reach a verdict (stop rule: halt and flag fit)", () => {
  // 16 pairs on normal stakes, argo accepts every ticket, fit fails 8 of them. Unpaired, the 16 interleaved
  // primaries give 8 runs per arm: below MIN_N, nothing is claimed.
  const pairs = pairSet({ e: 8, g: 8 });
  const e = evaluate({ runs: pairs });
  const s = e.strata.normal;
  assert.equal(s.unpaired.outcome, "insufficient_evidence", s.unpaired.why);
  assert.ok(s.unpaired.n.fit < MIN_N && s.unpaired.n.argo < MIN_N);
  assert.equal(s.basis, "paired");
  assert.deepEqual([s.outcome, s.halted], ["retain", true], s.why);
  assert.equal(s.paired.n, 16);
  assert.deepEqual(s.paired.accepted.discordant, { fit_only: 0, argo_only: 8 });
  assert.ok(s.paired.accepted.stop_ci[1] <= -STOP_MARGIN);
  assert.deepEqual(e.halted, ["normal"], "the halt stops interleaving that stratum");
  assert.deepEqual(e.flags.map(x => [x.profile, x.stratum]), [["fit", "normal"]]);
  assert.equal(e.outcome, "retain");
  // Below PAIR_STOP_MIN_N pairs the stop rule does not fire, however bad it looks.
  const early = evaluate({ runs: pairSet({ e: 1, g: PAIR_STOP_MIN_N - 2 }) });
  assert.deepEqual([early.strata.normal.halted, early.strata.normal.outcome], [false, "insufficient_evidence"]);
});

test("paired evaluation: propose_policy when the lower 99% bounds clear -0.05 and fit is significantly cheaper; unpaired on the same runs is not enough", () => {
  // 150 pairs: 120 accepted by both, 30 failed by both (hard tickets), no discordance; fit uses 3 calls, argo 4.
  const pairs = pairSet({ e: 120, h: 30, fitCost: { calls: 3 }, argoCost: { calls: 4 } });
  const e = evaluate({ runs: pairs });
  const s = e.strata.normal;
  assert.equal(s.basis, "paired");
  assert.equal(s.outcome, "propose_policy", s.why);
  assert.ok(s.paired.accepted.diff_ci[0] >= -NONINFERIORITY_MARGIN && s.paired.first_pass.diff_ci[0] >= -NONINFERIORITY_MARGIN);
  assert.equal(s.paired.cost.calls.status, "lower");
  assert.ok(s.paired.cost.calls.test.p_two_sided < PAIRED_COST_ALPHA);
  assert.equal(s.paired.cost.tokens.status, "not_lower", "same tokens: not lower");
  // The unpaired comparison of the same 150 primaries (75 per arm, 80% accepted) cannot show it.
  assert.notEqual(s.unpaired.outcome, "propose_policy");
  assert.deepEqual([e.outcome, e.measured, e.deciding_strata], ["propose_policy", true, ["normal"]]);
  // A cost significantly worse blocks it.
  const slow = evaluate({ runs: pairSet({ e: 120, h: 30, fitCost: { calls: 3, elapsed: 120_000 }, argoCost: { calls: 4 } }) });
  assert.equal(slow.strata.normal.paired.cost.elapsed_ms.status, "worse");
  assert.equal(slow.strata.normal.outcome, "retain");
  // Below MIN_PAIRS: insufficient, whatever the data.
  const few = evaluate({ runs: pairSet({ e: MIN_PAIRS - 1, fitCost: { calls: 3 }, argoCost: { calls: 4 } }) });
  assert.equal(few.strata.normal.outcome, "insufficient_evidence");
  assert.match(few.strata.normal.why, new RegExp(`${MIN_PAIRS} pairs`));
});

test("paired evaluation: sensitive to discordance only; between-ticket variance (which tickets both arms pass) does not move it", () => {
  // Same marginal acceptance (fit 70%, argo 70%) in both sets. Unpaired, they are the same evidence.
  const concordant = evaluate({ runs: pairSet({ e: 70, h: 30 }) }).strata.normal;
  const discordant = evaluate({ runs: pairSet({ e: 40, f: 30, g: 30 }) }).strata.normal;
  assert.equal(concordant.paired.accepted.diff, 0);
  assert.equal(discordant.paired.accepted.diff, 0);
  assert.deepEqual(concordant.unpaired.rates.accepted.diff_ci, discordant.unpaired.rates.accepted.diff_ci, "unpaired cannot tell them apart");
  const wc = concordant.paired.accepted.diff_ci, wd = discordant.paired.accepted.diff_ci;
  assert.ok(wc[1] - wc[0] < (wd[1] - wd[0]) / 3, `no discordance gives a far narrower interval: ${wc} vs ${wd}`);
  // The point estimate is (f - g)/n: the concordant split (both pass / both fail) does not enter it.
  for (const [ee, hh] of [[90, 0], [45, 45], [0, 90]]) {
    const s = evaluate({ runs: pairSet({ e: ee, h: hh, f: 2, g: 8 }) }).strata.normal;
    assert.equal(s.paired.accepted.diff, (2 - 8) / 100);
    assert.deepEqual(s.paired.accepted.discordant, { fit_only: 2, argo_only: 8 });
  }
  // The power note: pairs needed at the observed discordance, and more of them when discordance is higher.
  const pc = concordant.paired.power.accepted, pd = discordant.paired.power.accepted;
  assert.ok(Number.isInteger(pc.pairs_needed_at_observed) && Number.isInteger(pd.pairs_needed_at_observed));
  assert.ok(pd.pairs_needed_at_observed > pc.pairs_needed_at_observed, JSON.stringify({ pc, pd }));
  assert.ok(pd.pairs_needed_80 > pd.pairs_needed_at_observed);
  assert.equal(pairsNeeded({ e: 0, f: 0, g: 10, h: 0 }).pairs_needed_at_observed, null, "fit always worse: no number of pairs shows non-inferiority");
});

test("paired evaluation: unknown cost never counts as cheaper; differences only over pairs where both sides have the value", () => {
  // fit reports no usage: its tokens are unknown, never fewer.
  const none = evaluate({ runs: pairSet({ e: 150, fitCost: { usage: false }, argoCost: { tokens: 400 } }) }).strata.normal;
  assert.equal(none.paired.cost.tokens.status, "unknown");
  assert.equal(none.paired.cost.tokens.n, 0);
  assert.equal(none.outcome, "retain", "fit's unreported tokens are not fewer tokens");
  // Half of fit's pairs report far fewer tokens, half report none: the reporting half shows "lower", but a gap
  // on fit's side makes the measure unknown.
  const partial = evaluate({ runs: [...pairSet({ e: 75, fitCost: { tokens: 40 }, argoCost: { tokens: 400 } }), ...pairSet({ e: 75, fitCost: { usage: false }, argoCost: { tokens: 400 } })] }).strata.normal;
  assert.equal(partial.paired.cost.tokens.n, 75, "only pairs with both values are differenced");
  assert.equal(partial.paired.cost.tokens.missing.fit, 75);
  assert.equal(partial.paired.cost.tokens.status, "unknown");
  // A counterpart that never produced a run is an outcome (not accepted), and its cost is unknown.
  const crashed = evaluate({ runs: [...pairSet({ e: 20 }), mkPair({ primary: "argo", counterpartRun: null })] }).strata.normal;
  assert.equal(crashed.paired.n, 21);
  assert.deepEqual(crashed.paired.accepted.discordant, { fit_only: 0, argo_only: 1 });
});

test("automatic assessment cites the paired evaluation; synthetic propagates from either side of a pair", () => {
  const live = pairSet({ e: 120, h: 30, fitCost: { calls: 3 }, argoCost: { calls: 4 }, kind: "live" });
  const e = evaluate({ runs: live });
  assert.equal(e.synthetic, false);
  const a = automaticAssessment(e, { policy: currentPolicy("argo") });
  assert.equal(a.outcome, "propose_policy");
  assert.notEqual(a.outcome, "promote");
  assert.match(a.question, /paired/);
  assert.match(a.question, /normal: propose_policy \(paired, 150 pairs/);
  assert.deepEqual(a.evidence, [{ kind: "digest", schema: e.schema, sha: e.digest, synthetic: false }]);
  // One counterpart run on fake providers makes the whole record synthetic.
  const mixed = [...live, mkPair({ kindPrimary: "live", kindCounterpart: "fake", fit: { calls: 3 }, argo: { calls: 4 } })];
  assert.equal(evaluate({ runs: mixed }).synthetic, true);
  const mixed2 = [...live, mkPair({ kindPrimary: "fake", kindCounterpart: "live" })];
  assert.equal(evaluate({ runs: mixed2 }).synthetic, true);
  for (const p of ["argo", "fit"]) for (const r of [e, evaluate({ runs: pairSet({ e: 8, g: 8 }) })]) assert.notEqual(automaticAssessment(r, { policy: currentPolicy(p) }).outcome, "promote");
});

// ---------------------------------------------------------------- the counterpart on a real board run

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
  const keys = mkdtempSync(join(tmpdir(), "pantheon-pair-keys-"));
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
const approve = async ({ vendor, model }) => ({ text: APPROVE, response_id: `pair_${vendor}_${++replies}`, served_model: model });

/** Every byte of the target repository (its .git included) and its status ledger, except the named directories. */
function snapshot(root, skip) {
  const out = {};
  const walk = d => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (skip.some(s => p === s || p.startsWith(s + "/"))) continue;
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out[relative(root, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(root);
  return out;
}

test("counterpart: runs the other profile in a dry board on a snapshot; the target repo's refs, worktree and status ledger are byte-identical with and without it", async () => {
  await withDispatch(async ({ dir: repo, makeClientFor, calls }) => {
    const { statusRoot, keys } = boardRepo(repo, ["pair-a", "pair-b"]);
    const store = join(repo, "store");
    try {
      let before = null, after = null, pairDir = null;
      // agy.log is the fake Antigravity CLI's own call log (tests/fixtures/dispatch.mjs writes it into the fixture
      // directory, which is this test's repository): the fit counterpart's implementer is an Antigravity lane, so the
      // fake CLI appends to it. It is the fixture's file, not the target repository's.
      const skipFor = () => [join(repo, "store"), pairDir, join(repo, "cooldowns"), join(repo, "agy.log")].filter(Boolean);
      const r = await runBoardItem({ repo, item: "pair-a", statusRoot, makeClientFor, turn: approve, dir: join(repo, "boards", "pair-a"), out: join(repo, "bundles", "pair-a"),
        runOpts: { scouts: ["xai"], revisions: 2 }, evidenceStore: store, pairRate: 1, pairMaxProviderCalls: 40, pairBudgetCalls: 200,
        progress: ev => {
          if (ev.event === "pair.start") { pairDir = ev.board; before = snapshot(repo, skipFor()); }
          if (ev.event === "pair.end") after = snapshot(repo, skipFor());
        } });
      assert.equal(r.bundle.run.shipped, true, JSON.stringify(r.bundle.run.error));
      assert.ok(r.proposal, r.why);
      assert.ok(before && after, "the counterpart ran");
      assert.ok(!pairDir.startsWith(join(repo, "boards", "pair-a") + "/worktree"));
      assert.deepEqual(after, before, "the counterpart changed nothing in the target repository or its status ledger");
      assert.ok(Object.keys(before).some(k => k.startsWith(".git/refs/") || k === ".git/packed-refs" || k.startsWith(".git/HEAD")), "refs are in the snapshot");
      assert.ok(Object.keys(before).some(k => k.startsWith("status/ledger/")), "the status ledger is in the snapshot");
      // Only the primary's branch was created in the target repository; the counterpart shipped only to its dry board.
      const branches = execFileSync("git", ["-C", repo, "for-each-ref", "--format=%(refname)"], { encoding: "utf8" }).trim().split("\n").sort();
      assert.deepEqual(branches, ["refs/heads/main", "refs/heads/pantheon/pair-a"]);
      // The pair record.
      const pr = r.bundle.pair;
      assert.equal(pr.status, "completed", JSON.stringify(pr));
      const rec = JSON.parse(readFileSync(join(store, "pairs", pr.pair_id, "pair.json"), "utf8"));
      assert.equal(rec.schema, PAIR_SCHEMA);
      assert.equal(rec.ticket.key, "pair-a");
      assert.equal(rec.ticket.digest, r.bundle.ticket.digest);
      assert.deepEqual([rec.primary.profile, rec.counterpart.profile, rec.counterpart.dry], ["argo", "fit", true]);
      assert.deepEqual(rec.bounds, { max_provider_calls: 40, revisions: 2, total_provider_calls: 200 });
      // Comparable starting conditions are recorded: same base, ticket, revisions and bound; order; cooldown state.
      assert.deepEqual([rec.starting.order, rec.starting.revisions, rec.starting.primary_bound, rec.starting.counterpart_bound],
        ["primary-first", 2, 40, 40], "the sampled primary ran under the counterpart's bound");
      assert.equal(rec.starting.ticket_digest, r.bundle.ticket.digest);
      assert.match(rec.starting.base, /^[0-9a-f]{40}$/);
      assert.ok("cooldown_at_counterpart_start" in rec.starting);
      assert.equal(rec.sampling.basis, PAIR_BASIS.hash);
      const sha = f => "sha256:" + createHash("sha256").update(readFileSync(f)).digest("hex");
      assert.equal(rec.primary.run_digest, r.bundle.run.run_json_digest);
      assert.equal(sha(join(store, "pairs", pr.pair_id, "primary.run.json")), rec.primary.run_digest);
      assert.equal(sha(join(store, "pairs", pr.pair_id, "counterpart.run.json")), rec.counterpart.run_digest);
      const crun = JSON.parse(readFileSync(join(store, "pairs", pr.pair_id, "counterpart.run.json"), "utf8"));
      assert.equal(crun.profile, "fit");
      assert.ok(crun.turns.every(t => t.selection.profile === "fit"));
      assert.equal(crun.provider_calls.limit, 40);
      assert.equal(crun.shipped, true, "the counterpart shipped, to its own dry board");
      assert.ok(!crun.repo_root.startsWith(repo + "/") || crun.repo_root.startsWith(pairDir), `${crun.repo_root} is the snapshot`);
      // The counterpart's ledger is its own: the review cycle on the run ledger is the primary's only.
      assert.ok(!existsSync(join(pairDir, "ledger")) || resolve(join(pairDir, "ledger")) !== resolve(r.bundle.run.ledger));
      // The evaluator finds the pair.
      const e = evaluate({ runs: store });
      assert.equal(e.paired.pairs.length, 1);
      assert.equal(e.paired.pairs[0].pair_id, pr.pair_id);
      assert.ok(calls.length > 0);

      // Pairing without a bound: refused by name, recorded, and no provider is called for a counterpart.
      const n0 = calls.length;
      const b = await runBoardItem({ repo, item: "pair-b", statusRoot, makeClientFor, turn: approve, dir: join(repo, "boards", "pair-b"), out: join(repo, "bundles", "pair-b"),
        runOpts: { scouts: ["xai"], revisions: 2, profile: "fit" }, evidenceStore: store, pairRate: 1, pairBudgetCalls: 200 });
      assert.equal(b.bundle.pair.status, "refused");
      assert.equal(b.bundle.pair.refusal.code, "PAIR_UNBOUNDED");
      const brec = JSON.parse(readFileSync(join(store, "pairs", b.bundle.pair.pair_id, "pair.json"), "utf8"));
      assert.deepEqual([brec.status, brec.refusal.code, brec.counterpart], ["refused", "PAIR_UNBOUNDED", null]);
      const primaryRun = JSON.parse(readFileSync(join(repo, "boards", "pair-b", "run.json"), "utf8"));
      assert.equal(calls.length - n0, primaryRun.attempts.filter(a => a.vendor !== "agy_google").length, "every provider call after the refusal is the primary's");
      const e2 = evaluate({ runs: store });
      assert.equal(e2.paired.refused.length, 1, "a refused pair is listed, not dropped, and is no outcome of either arm");
      assert.equal(e2.paired.pairs.length, 1);
    } finally { rmSync(keys, { recursive: true, force: true }); }
  });
});

test("counterpart: a failure under its bound is kept as an outcome (not accepted), never dropped", async () => {
  await withDispatch(async ({ dir: repo, makeClientFor }) => {
    const { statusRoot, keys } = boardRepo(repo, ["pair-c"]);
    const store = join(repo, "store");
    try {
      const r = await runBoardItem({ repo, item: "pair-c", statusRoot, makeClientFor, turn: approve, dir: join(repo, "boards", "pair-c"), out: join(repo, "bundles", "pair-c"),
        runOpts: { scouts: ["xai"], revisions: 2 }, evidenceStore: store, pairRate: 1, pairMaxProviderCalls: 1, pairBudgetCalls: 100 });
      // Both arms run under the same 1-call bound (comparable starting conditions), so both fail alike; the
      // counterpart's failure is still kept as an outcome of the pair, not dropped.
      assert.equal(r.bundle.run.shipped, false, "the sampled primary ran under the counterpart's bound too");
      assert.equal(r.bundle.pair.status, "completed");
      const rec = JSON.parse(readFileSync(join(store, "pairs", r.bundle.pair.pair_id, "pair.json"), "utf8"));
      const crun = JSON.parse(readFileSync(join(store, "pairs", r.bundle.pair.pair_id, "counterpart.run.json"), "utf8"));
      assert.equal(crun.shipped, false);
      assert.equal(crun.provider_calls.refused.code, "PROVIDER_CALL_LIMIT");
      assert.equal(rec.counterpart.outcome.accepted, false);
      const e = evaluate({ runs: store });
      const s = Object.values(e.paired.strata)[0];
      assert.equal(s.n, 1);
      assert.deepEqual(s.accepted.discordant, { fit_only: 0, argo_only: 0 }, "a concordant failure: neither arm accepted");
    } finally { rmSync(keys, { recursive: true, force: true }); }
  });
});

test("owner condition 3: no total boundary, an exhausted boundary, or a different primary bound refuses the counterpart, by name, with no counterpart call", async () => {
  await withDispatch(async ({ dir: repo, makeClientFor, calls }) => {
    const { statusRoot, keys } = boardRepo(repo, ["pt-a", "pt-b", "pt-c", "pt-d"]);
    const store = join(repo, "store");
    const go = (item, extra) => runBoardItem({ repo, item, statusRoot, makeClientFor, turn: approve, dir: join(repo, "boards", item), out: join(repo, "bundles", item),
      runOpts: { scouts: ["xai"], revisions: 2, ...(extra.runOpts ?? {}) }, evidenceStore: store, pairRate: 1, pairMaxProviderCalls: 40, ...extra.top });
    const primaryCalls = item => JSON.parse(readFileSync(join(repo, "boards", item, "run.json"), "utf8")).attempts.filter(a => a.vendor !== "agy_google").length;
    try {
      let n0 = calls.length;
      const a = await go("pt-a", { top: {} });
      assert.equal(a.bundle.pair.refusal?.code, "PAIR_NO_TOTAL");
      assert.equal(calls.length - n0, primaryCalls("pt-a"), "a sampling rate alone runs no counterpart");
      const b = await go("pt-b", { top: { pairBudgetCalls: 100 } });
      assert.equal(b.bundle.pair.status, "completed");
      const { pairSpend } = await import("../src/board/operate.mjs");
      const spent = pairSpend(store).calls;
      assert.ok(spent > 0 && spent <= 40, `spent ${spent}`);
      n0 = calls.length;
      const c = await go("pt-c", { top: { pairBudgetCalls: spent + 39 } });
      assert.equal(c.bundle.pair.refusal?.code, "PAIR_BUDGET_EXHAUSTED", "spent + this bound would exceed the total");
      assert.equal(calls.length - n0, primaryCalls("pt-c"));
      const d = await go("pt-d", { top: { pairBudgetCalls: 1000 }, runOpts: { maxProviderCalls: 25 } });
      assert.equal(d.bundle.pair.refusal?.code, "PAIR_NOT_COMPARABLE", "an explicit different primary bound is kept and the pair refused");
    } finally { rmSync(keys, { recursive: true, force: true }); }
  });
});

test("CLI: run refuses --pair-rate without --pair-max-provider-calls; evaluate prints the paired section", () => {
  const noTotal = spawnSync(process.execPath, [BOARD_CLI, "run", "some-item", "--pair-rate", "0.2", "--pair-max-provider-calls", "10"], { encoding: "utf8" });
  assert.equal(noTotal.status, 2);
  assert.match(noTotal.stderr, /--pair-budget-calls/);
  assert.match(noTotal.stderr, /not a spending cap/);
  const usage = spawnSync(process.execPath, [BOARD_CLI, "run", "some-item", "--pair-rate", "0.2"], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /--pair-max-provider-calls/);
  const bad = spawnSync(process.execPath, [BOARD_CLI, "run", "some-item", "--pair-rate", "2", "--pair-max-provider-calls", "10"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  const dir = mkdtempSync(join(tmpdir(), "pantheon-paired-cli-"));
  try {
    for (const p of pairSet({ e: 120, h: 30, fitCost: { calls: 3 }, argoCost: { calls: 4 } })) {
      const d = join(dir, "pairs", p.pair_id);
      mkdirSync(d, { recursive: true });
      const write = (name, run) => { const bytes = JSON.stringify(run); writeFileSync(join(d, name), bytes); return "sha256:" + createHash("sha256").update(bytes).digest("hex"); };
      const rec = { ...p, primary: { profile: p.primary.profile, run_digest: write("primary.run.json", p.primary.run) },
        counterpart: { profile: p.counterpart.profile, dry: true, run_digest: write("counterpart.run.json", p.counterpart.run) } };
      writeFileSync(join(d, "pair.json"), JSON.stringify(rec));
      mkdirSync(join(dir, `board-${p.pair_id}`));
      writeFileSync(join(dir, `board-${p.pair_id}`, "run.json"), JSON.stringify(p.primary.run));
    }
    const text = spawnSync(process.execPath, [BOARD_CLI, "evaluate", "--runs", dir], { encoding: "utf8" });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /Paired runs/);
    assert.match(text.stdout, /normal\s+propose_policy/);
    assert.match(text.stdout, /discordant/);
    assert.match(text.stdout, /pairs needed/);
    const json = JSON.parse(spawnSync(process.execPath, [BOARD_CLI, "evaluate", "--runs", dir, "--json"], { encoding: "utf8" }).stdout);
    assert.equal(json.paired.pairs.length, 150);
    assert.equal(json.strata.normal.basis, "paired");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
