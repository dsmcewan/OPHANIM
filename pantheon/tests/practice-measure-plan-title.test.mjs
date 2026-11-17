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
