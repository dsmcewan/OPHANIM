// The paired measurement of the work item's title source (docs/reviews/2026-11-17-review-capacity/MEASUREMENT.md):
// compareArms over planTitle model (baseline) and planTitle ticket (candidate) on the same tickets, under a declared
// per-run bound and a TOTAL boundary, order alternating per ticket, the plan pinned by hash. Fake providers only:
// these qualify the mechanics, not the result.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { compareArms, pairedSummary, dispatchRunner, verifyComparison } from "../src/practice/compare.mjs";
import { withDispatch } from "./fixtures/dispatch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "..", "bin", "pantheon-compare.mjs");
const FIXTURE = pathToFileURL(join(HERE, "fixtures", "dispatch.mjs")).href;
const ARMS = [{ label: "model-title", profile: "argo", runOpts: { planTitle: "model" } }, { label: "ticket-title", profile: "argo", runOpts: { planTitle: "ticket" } }];
// The planner's own instruction; a reviewer's prompt can quote a work item title, so a bare /TITLE:/ also matches reviews.
const PLANNER = /nothing else: TITLE:/;
const PLAN = { path: "docs/reviews/2026-11-17-review-capacity/MEASUREMENT.md", sha256: "sha256:" + "0".repeat(64) };

test("both arms run every ticket, order alternates, only the baseline asks a planner, and the paired summary is candidate - baseline", async () => {
  await withDispatch(async ({ spec, dir, makeClientFor, calls }) => {
    const tickets = ["t0", "t1", "t2", "t3"].map(k => spec(k));
    const r = await compareArms({ tickets, arms: ARMS, bounds: { maxProviderCalls: 12, revisions: 2 }, totalProviderCalls: 200, plan: PLAN,
      providers: { kind: "fake" }, runner: dispatchRunner({ makeClientFor, dir: join(dir, "m") }) });
    assert.equal(verifyComparison(r).ok, true);
    assert.deepEqual([r.kind, r.synthetic, r.plan.sha256], ["arms", true, PLAN.sha256]);
    assert.deepEqual(r.results.map(x => x.order[0]), ["baseline", "candidate", "baseline", "candidate"], "the first arm alternates per ticket");
    assert.equal(calls.filter(c => PLANNER.test(c.prompt)).length, 4, "one planner call per baseline run, none in the candidate arm");
    for (const row of r.results) assert.equal(row.baseline.provider_calls.value - row.candidate.provider_calls.value, 1, `${row.ticket}: the candidate makes one call fewer`);
    assert.equal(r.paired.pairs, 4);
    assert.deepEqual(r.paired.all.accepted.cells, { e: 4, f: 0, g: 0, h: 0 });
    assert.equal(r.paired.all.cost.provider_calls.median_diff, -1, "candidate - baseline");
    assert.ok(r.spent_provider_calls <= r.total_provider_calls);
  });
});

test("the total boundary stops runs before they start; unrun arms are kept as not_run, and spend never passes the total", async () => {
  await withDispatch(async ({ spec, dir, makeClientFor }) => {
    const tickets = ["u0", "u1", "u2"].map(k => spec(k));
    const r = await compareArms({ tickets, arms: ARMS, bounds: { maxProviderCalls: 12, revisions: 1 }, totalProviderCalls: 20, plan: PLAN,
      providers: { kind: "fake" }, runner: dispatchRunner({ makeClientFor, dir: join(dir, "m") }) });
    const statuses = r.results.flatMap(x => [x.baseline.status, x.candidate.status]);
    assert.ok(statuses.includes("not_run"), JSON.stringify(statuses));
    assert.ok(r.spent_provider_calls <= 20);
    assert.equal(r.results.length, 3, "every ticket stays in the record");
    assert.ok(r.paired.unpaired >= 1);
    await assert.rejects(() => compareArms({ tickets, arms: ARMS, bounds: { maxProviderCalls: 12 }, providers: { kind: "fake" }, runner: async () => ({}) }),
      /total provider-call boundary .* is required/);
    await assert.rejects(() => compareArms({ tickets, arms: [ARMS[0], { ...ARMS[0], label: "same" }], bounds: { maxProviderCalls: 12 }, totalProviderCalls: 10,
      providers: { kind: "fake" }, runner: async () => ({}) }), /must differ/);
  });
});

test("pairedSummary: a candidate-only acceptance is f, a baseline-only acceptance is g, and the interval is of candidate - baseline", () => {
  const row = (c, b) => ({ candidate: { status: "x", accepted: c, first_pass: c, stakes: { value: "normal" } }, baseline: { status: "x", accepted: b, first_pass: b, stakes: { value: "normal" } } });
  const s = pairedSummary([row(true, false), row(true, false), row(true, true), row(false, false)]);
  assert.deepEqual(s.all.accepted.cells, { e: 1, f: 2, g: 0, h: 1 });
  assert.ok(s.all.accepted.diff_ci[0] < 0.5 && s.all.accepted.diff_ci[1] > 0.5, "the point estimate 0.5 is inside the interval");
  assert.ok(s.all.accepted.diff_ci[1] > 0, "positive when the candidate accepts more");
});

test("CLI --measure plan-title: refuses without a total boundary; writes a record pinned to the declared plan's hash", async () => {
  await withDispatch(async ({ dir: repo }) => {
    writeFileSync(join(repo, "alpha.mjs"), "export const ok = false;\n");
    writeFileSync(join(repo, "verify.mjs"), 'import assert from "node:assert/strict"; import {ok} from "./alpha.mjs"; assert.equal(ok, true);\n');
    mkdirSync(join(repo, "tickets"));
    for (const item of ["m-a", "m-b"]) writeFileSync(join(repo, "tickets", `${item}.json`), JSON.stringify({
      schema: "ophanim.ticket/v1", item, slice: "s", proposes: { state: "Resolved", basis: "b" }, title: "alpha.mjs exports ok = true",
      goal: "Make alpha.mjs export `ok` as true.", question: "fixture", repo_root: ".", slot: "alpha", path: "alpha.mjs",
      copy: ["alpha.mjs", "verify.mjs"], acceptance_cmd: "node verify.mjs", difficulty: "easy" }, null, 2) + "\n");
    writeFileSync(join(repo, "clients.fixture.mjs"), `import { scriptedClients } from ${JSON.stringify(FIXTURE)};\nexport default scriptedClients();\n`);
    const plan = join(repo, "PLAN.md");
    writeFileSync(plan, "# declared before any result\n");
    const out = join(repo, "measure.json");
    const cli = (...a) => spawnSync(process.execPath, [CLI, "--repo", repo, "--item", "m-a", "--item", "m-b", "--dir", join(repo, "w"), "--clients", join(repo, "clients.fixture.mjs"), ...a],
      { encoding: "utf8", env: process.env, timeout: 240_000 });
    const noTotal = cli("--measure", "plan-title", "--max-provider-calls", "12", "--out", out, "--plan", plan);
    assert.equal(noTotal.status, 2);
    assert.match(noTotal.stderr, /--total-provider-calls/);
    assert.equal(existsSync(out), false);
    const ok = cli("--measure", "plan-title", "--max-provider-calls", "12", "--total-provider-calls", "100", "--out", out, "--plan", plan);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const rec = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(rec.plan.sha256, "sha256:" + createHash("sha256").update(readFileSync(plan)).digest("hex"));
    assert.deepEqual([rec.arms.baseline.runOpts.planTitle, rec.arms.candidate.runOpts.planTitle], ["model", "ticket"]);
    assert.equal(rec.paired.pairs, 2);
    assert.equal(rec.synthetic, true);
  });
});

// ---------------------------------------------------------------- the total boundary charges the raw attempts (#126)
//
// A run's summary (resources.provider_calls) used to outrank its raw attempt list, and any integer passed: a summary
// of 0 or -2 over two recorded attempts charged 0 or -2, so the other arm was admitted past the total. The raw list
// is what is charged; a summary that disagrees with it, or is not a non-negative integer, makes the arm invalid
// (inconclusive, deciding nothing) and is charged conservatively; with no raw list the run is charged at least its bound.
const attempt = purpose => ({ purpose, vendor: "xai", model: "m", pool: "xai", outcome: "ok", usage: { input_tokens: 10, output_tokens: 2 } });
const fakeRun = ({ attempts = 2, summary, shipped = true } = {}) => ({
  shipped, gates: shipped ? [{ gate: "REVIEW", ok: true }, { gate: "TESTS", ok: true }] : null, revisions: [{ rev: 1 }],
  started_at: "2026-11-22T00:00:00.000Z", finished_at: "2026-11-22T00:00:01.000Z", turns: [],
  ...(attempts === null ? {} : { attempts: Array.from({ length: attempts }, (_, i) => attempt(`t${i}`)) }),
  resources: { usd: null, usd_basis: "unknown", ...(summary === undefined ? {} : { provider_calls: summary }) } });
const keys = n => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, goal: "g" }));
async function measure({ n = 5, bound = 2, total = 2, shape }) {
  const admitted = [];
  const r = await compareArms({ tickets: keys(n), arms: ARMS, bounds: { maxProviderCalls: bound, revisions: 1 }, totalProviderCalls: total, plan: PLAN,
    providers: { kind: "fake" }, runner: async ({ spec, arm }) => {
      admitted.push(`${spec.key}:${arm}`);
      const s = shape({ ticket: spec.key, arm });
      if (s instanceof Error) throw s;
      return { result: { shipped: s.shipped ?? true }, run: fakeRun(s) };
    } });
  return { r, admitted };
}
const arm = (r, t, name) => r.results.find(x => x.ticket === t)[name];
const acct = a => [a.provider_calls_raw, a.provider_calls_counted, a.provider_calls_basis];

for (const mask of [0, -2]) {
  test(`raw budget: a baseline summary of ${mask} over two recorded attempts is invalid, charged 2, and admits nothing past the total of 2`, async () => {
    const { r, admitted } = await measure({ shape: ({ arm }) => (arm === "baseline" ? { attempts: 2, summary: mask } : { attempts: 2 }) });
    assert.deepEqual(admitted, ["k0:baseline"], "only the first run fits a total of 2");
    assert.equal(r.spent_provider_calls, 2);
    const b = arm(r, "k0", "baseline");
    assert.deepEqual(acct(b), [2, 2, "invalid"]);
    assert.deepEqual([b.status, b.accepted, b.provider_calls_before], ["inconclusive", null, 0]);
    assert.match(b.why, /summary/);
    assert.equal(arm(r, "k0", "candidate").status, "not_run");
    assert.equal(r.results.flatMap(x => [x.baseline.status, x.candidate.status]).filter(s => s === "not_run").length, 9);
    assert.equal(r.paired.pairs, 0, "an invalid arm decides nothing");
  });
}

test("raw budget, phase order: on an odd ticket the candidate runs first; its masked summary cannot admit the baseline after it", async () => {
  // k0: both arms make no calls (a valid zero-call run keeps its meaning). k1: candidate first, two attempts, summary 0.
  const { r, admitted } = await measure({ n: 2, shape: ({ ticket, arm }) => (ticket === "k0" ? { attempts: 0 } : arm === "candidate" ? { attempts: 2, summary: 0 } : { attempts: 2 }) });
  assert.deepEqual(r.results.map(x => x.order), [["baseline", "candidate"], ["candidate", "baseline"]]);
  assert.deepEqual(admitted, ["k0:baseline", "k0:candidate", "k1:candidate"]);
  assert.deepEqual([acct(arm(r, "k0", "baseline")), acct(arm(r, "k0", "candidate"))], [[0, 0, "raw"], [0, 0, "raw"]]);
  assert.deepEqual([arm(r, "k0", "baseline").accepted, arm(r, "k0", "candidate").accepted], [true, true]);
  assert.deepEqual([...acct(arm(r, "k1", "candidate")), arm(r, "k1", "candidate").status], [2, 2, "invalid", "inconclusive"]);
  assert.equal(arm(r, "k1", "baseline").status, "not_run");
  assert.equal(r.spent_provider_calls, 2);
});

test("raw budget controls: a matching summary and an absent summary charge the raw count; a legal remaining fit is admitted; no raw list reserves the bound", async () => {
  const matching = await measure({ n: 2, total: 4, shape: () => ({ attempts: 2, summary: 2 }) });
  assert.deepEqual(matching.admitted, ["k0:baseline", "k0:candidate"]);
  assert.deepEqual([acct(arm(matching.r, "k0", "baseline")), acct(arm(matching.r, "k0", "candidate"))], [[2, 2, "raw"], [2, 2, "raw"]]);
  assert.deepEqual([arm(matching.r, "k0", "candidate").provider_calls_before, matching.r.spent_provider_calls, matching.r.paired.pairs], [2, 4, 1]);

  const absent = await measure({ n: 2, total: 4, shape: () => ({ attempts: 2 }) });
  assert.deepEqual(absent.admitted, ["k0:baseline", "k0:candidate"]);
  assert.deepEqual(acct(arm(absent.r, "k0", "candidate")), [2, 2, "raw"]);

  // A total of 5 with one-call runs: 1+1+1+1 = 4 spent, and the fifth (4 + bound 2 > 5) is not started.
  const fit = await measure({ n: 3, total: 5, shape: () => ({ attempts: 1, summary: 1 }) });
  assert.deepEqual(fit.admitted, ["k0:baseline", "k0:candidate", "k1:candidate", "k1:baseline"]);
  assert.deepEqual([fit.r.spent_provider_calls, arm(fit.r, "k1", "baseline").provider_calls_before, arm(fit.r, "k2", "baseline").status], [4, 3, "not_run"]);

  // A bounded failed run keeps its meaning: raw 2, charged 2, not invalidated by the accounting.
  const failed = await measure({ n: 1, total: 4, shape: ({ arm }) => (arm === "baseline" ? { attempts: 2, summary: 2, shipped: false } : { attempts: 1 }) });
  assert.deepEqual(acct(arm(failed.r, "k0", "baseline")), [2, 2, "raw"]);
  assert.notEqual(arm(failed.r, "k0", "baseline").status, "inconclusive");

  // No raw attempt list: the run is charged at least its bound, whatever its summary says; a crash likewise.
  const reserve = await measure({ n: 1, total: 6, bound: 3, shape: ({ arm }) => (arm === "baseline" ? { attempts: null, summary: 1 } : new Error("runner crashed")) });
  assert.deepEqual([acct(arm(reserve.r, "k0", "baseline")), acct(arm(reserve.r, "k0", "candidate"))], [[null, 3, "reserve"], [null, 3, "reserve"]]);
  assert.equal(reserve.r.spent_provider_calls, 6);
});

test("raw budget: no attempt list reserves capacity but a shipped summary decides nothing; a recorded empty list is a real zero that decides", async () => {
  const { r, admitted } = await measure({ n: 1, total: 4, shape: ({ arm }) => (arm === "baseline" ? { attempts: null, summary: 0, shipped: true } : { attempts: 0 }) });
  assert.deepEqual(admitted, ["k0:baseline", "k0:candidate"]);
  const b = arm(r, "k0", "baseline"), c = arm(r, "k0", "candidate");
  assert.deepEqual([...acct(b), b.status, b.accepted], [null, 2, "reserve", "inconclusive", null], "shipped, but its calls are not on record");
  assert.deepEqual([...acct(c), c.status, c.accepted], [0, 0, "raw", "accepted", true], "an empty list records zero calls");
  assert.deepEqual([r.spent_provider_calls, r.paired.pairs], [2, 0]);
});

test("raw budget: raw attempts past the per-run bound are an overrun even when the summary agrees; the comparison is invalid and admits nothing more", async () => {
  const { r, admitted } = await measure({ n: 3, total: 20, shape: ({ arm }) => (arm === "baseline" ? { attempts: 3, summary: 3 } : { attempts: 1 }) });
  assert.deepEqual(admitted, ["k0:baseline"], "what was admitted stands; nothing after it is admitted");
  const b = arm(r, "k0", "baseline");
  assert.deepEqual([...acct(b), b.provider_calls_overrun, b.status, b.accepted], [3, 3, "raw", true, "inconclusive", null]);
  assert.match(b.why, /overran its per-run bound: 3 recorded attempts > 2/);
  assert.equal(r.spent_provider_calls, 3, "the actual spend is kept");
  assert.deepEqual(r.budget, { valid: false, overruns: [{ ticket: "k0", arm: "baseline", raw: 3, bound: 2 }], why: "a run spent more provider calls than its admission reserved" });
  assert.equal(r.results.flatMap(x => [x.baseline.status, x.candidate.status]).filter(s => s === "not_run").length, 5);
  assert.match(arm(r, "k0", "candidate").why, /overran its per-run bound/);
});
