// REGISTER L-136 (extending L-124): ONE CENTRALLY ENFORCED GEMINI BILLING POLICY, shown through the REAL pantheon entry
// points (owner decisions 2026-11-19; docs/billing-policy.md). The policy's own units are pantheon/tests/l136-policy.test.mjs;
// the ophanim entry points (operate tick, watch, serve) are ophanim/operate/l136-billing.test.mjs.
//
//   pantheon-board   `run` (spawned): primary (an operator's Gemini API reviewer seat; the python SDK seat when asked for)
//                    and failover (the in-run critique's lane refused for quota, its metered spare); the reviewer's default
//                    transport (the subscription CLI lane)
//   pantheon-compare (spawned, --clients fakes): primary (a ticket's Gemini API pin) and failover (the fit arm's spare)
//   pantheon-review-cycle `review` / `resume` (spawned, the live API seat over a recorded fetch): primary (a Google reviewer
//                    is served by the API itself, no lane in front of it); failover unreachable (see its row)
//   run-review --via api (its main, real argv parsing, a recorded fetch): primary (a Google reviewer); failover unreachable
//
// THE PROVIDER EDGE ONLY IS FAKE: scripted clients that RECORD every Gemini request (--clients), a recorded fetch (preloaded
// into the child), the fake agy CLI of fixtures/dispatch.mjs. Every child runs with SYNTHETIC GEMINI_API_KEY / GOOGLE_API_KEY
// and environment variables that look like an authorization (METERED_GEMINI_FAILOVER=true, ...): a key or a variable
// never admits a billed request. "Charged before it is sent" is asserted at the edge itself: each recorded request carries
// the number of usage rows that were already persisted when it was sent. This file imports nothing the change added, so it
// runs unchanged against the base commit (the base-failure evidence of register L-136).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { withDispatch } from "./fixtures/dispatch.mjs";
import { boardFixture } from "./fixtures/board-repo.mjs";
import { main as reviewMain, EXIT } from "../src/review-runner/index.mjs";
import { fixtureRepo, fakeFetch, capture, deps, LIMITS, mkdtemp as rrTemp, cleanup as rrCleanup } from "./review-runner-helper.mjs";

// The refusal codes, spelled out (this file loads on a tree without the new exports).
const METERED_GEMINI_DISABLED = "METERED_GEMINI_DISABLED", GEMINI_PRIMARY_DISABLED = "GEMINI_PRIMARY_DISABLED", METERED_GEMINI_BUDGET_EXHAUSTED = "METERED_GEMINI_BUDGET_EXHAUSTED";
const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = name => resolve(HERE, "..", "bin", name);
const PRELOAD = pathToFileURL(join(HERE, "fixtures", "l136-fetch-preload.mjs")).href;
const DISPATCH = pathToFileURL(join(HERE, "fixtures", "dispatch.mjs")).href;
// Synthetic credentials, and names that LOOK like an authorization: the policy reads neither.
const KEYS = { GEMINI_API_KEY: "AIza-l136-synthetic-not-a-key-0000000000", GOOGLE_API_KEY: "AIza-l136-synthetic-not-a-key-1111111111",
  METERED_GEMINI_FAILOVER: "true", GEMINI_API_PRIMARY: "100", PANTHEON_METERED_GEMINI_FAILOVER: "1" };
const jsonl = f => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
/** Each billed request at the edge was preceded by its own persisted usage row: request k saw at least k rows. */
const chargedBefore = (edge, key = "usage_rows") => edge.forEach((r, i) => assert.ok(r[key] >= i + 1, `billed request ${i + 1} was sent with only ${r[key]} usage row(s) persisted: it was not charged before it was sent`));
/** A usage row as an earlier attempt would have persisted it (a killed run's, a counterpart's): consumption already recorded. */
const seed = (file, kind) => { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, JSON.stringify({ schema: "ophanim.gemini-billing/v1", kind,
  setting: kind === "failover" ? "metered_gemini_failover" : "gemini_api_primary", vendor: "agy_google", model: "gemini-4-carbon", purpose: "an earlier attempt",
  source: "test seed", budget: 1, used_before: 0, at: new Date().toISOString() }) + "\n"); };

// ---- pantheon-board --------------------------------------------------------------------------------------------------
const BOARD_ITEM = "billing-item";
const RECORDING_CLIENTS = `import { scriptedClients } from ${JSON.stringify(DISPATCH)};
import { appendFileSync, existsSync, readFileSync } from "node:fs";
// The provider edge: every Gemini request a scripted client receives is recorded with the usage rows persisted before it.
const rows = f => (f && existsSync(f) ? readFileSync(f, "utf8").split("\\n").filter(Boolean).length : 0);
export default scriptedClients([], undefined, ({ vendor, model }) => {
  if (vendor === "agy_google") appendFileSync(process.env.L136_EDGE_LOG, JSON.stringify({ vendor, model, usage_rows: rows(process.env.L136_USAGE_FILE) }) + "\\n");
  return null;
});
`;
/** One `pantheon-board run` of the fixture item on a fresh board dir. */
function boardRun(f, name, { seats = [], flags = [], seedUsage = null } = {}) {
  const board = join(f.repo, "boards", name), edge = join(f.repo, `${name}.edge.jsonl`), usage = join(board, "gemini-billing.jsonl");
  mkdirSync(board, { recursive: true });
  if (seedUsage) seed(usage, seedUsage);
  const out = spawnSync(process.execPath, [BIN("pantheon-board.mjs"), "run", BOARD_ITEM, "--repo", f.repo, "--status-ledger", f.statusRoot,
    "--clients", join(f.repo, "l136.clients.fixture.mjs"), "--turn", join(f.repo, "turn.fixture.mjs"), ...seats.flatMap(s => ["--seat", s]),
    "--dir", board, "--out", join(f.repo, "bundles", name), "--branch", `pantheon/l136-${name}`, "--checked", "2026-11-19", ...flags],
  { encoding: "utf8", env: { ...process.env, ...KEYS, L136_EDGE_LOG: edge, L136_USAGE_FILE: usage }, timeout: 180_000 });
  let result = null;
  try { result = JSON.parse(out.stdout); } catch { result = null; }
  const runFile = join(board, "run.json");
  return { status: out.status, out, result, run: existsSync(runFile) ? JSON.parse(readFileSync(runFile, "utf8")) : null, edge: jsonl(edge), usage: jsonl(usage),
    progress: jsonl(join(board, "progress.jsonl")), said: `exit ${out.status}\n${out.stdout.slice(-1500)}\n${out.stderr.slice(-2500)}` };
}
async function withBoard(fn) {
  await withDispatch(async ctx => {
    const repo = ctx.dir;
    const { statusRoot, keys } = boardFixture(repo, { item: BOARD_ITEM });
    try {
      writeFileSync(join(repo, "l136.clients.fixture.mjs"), RECORDING_CLIENTS);
      await fn({ ...ctx, repo, statusRoot });
    } finally { rmSync(keys, { recursive: true, force: true }); }
  });
}
// The in-run critique: an operator's Gemini API reviewer (PRIMARY), or the default Google lane with its metered spare (FAILOVER).
const PRIMARY_SEATS = ["implementer=xai/grok-4.6", "reviewer=agy_google/gemini-4-carbon"];
const FAILOVER_SEATS = ["implementer=xai/grok-4.6"];
const LANE = "gemini-4-carbon-high";

test("pantheon-board run, PRIMARY (an operator's Gemini API reviewer seat): with a key present and nothing declared it is refused before it is admitted, recorded, and the item stays recoverable; declared, it is charged before it is sent and recorded; the budget spent refuses the next", { timeout: 300_000 }, async () => {
  await withBoard(async f => {
    // (a) the key present, nothing declared (the failover switch alone does not count either).
    for (const [name, flags] of [["primary-off", []], ["primary-failover-only", ["--metered-gemini-failover", "5"]]]) {
      const r = boardRun(f, name, { seats: PRIMARY_SEATS, flags });
      assert.equal(r.result?.shipped, false, r.said);
      assert.deepEqual(r.edge, [], "no billed Gemini request reached the provider edge");
      assert.deepEqual(r.usage, [], "nothing was charged on the usage record");
      assert.deepEqual(r.run.attempts.filter(a => a.vendor === "agy_google").map(a => [a.purpose, a.model, a.code, a.provider_requests]), [["critique", "gemini-4-carbon", GEMINI_PRIMARY_DISABLED, 0]], r.said);
      assert.equal(r.run.error?.code, GEMINI_PRIMARY_DISABLED);
      assert.deepEqual(r.run.billing.refusals.map(x => [x.code, x.kind, x.model]), [[GEMINI_PRIMARY_DISABLED, "primary", "gemini-4-carbon"]], "the refusal is on the run's record");
      assert.equal(r.result.gemini_billing.used.primary, 0);
    }
    // (b) declared with a budget: the SAME item (still Ready: nothing was recorded as done) runs, the request is charged first.
    const ok = boardRun(f, "primary-on", { seats: PRIMARY_SEATS, flags: ["--gemini-api-primary", "2"] });
    assert.equal(ok.result?.shipped, true, ok.said);
    assert.equal(ok.edge.length, 1, ok.said);
    chargedBefore(ok.edge);
    assert.deepEqual(ok.usage.map(u => [u.kind, u.model, u.purpose, u.role, u.source, u.budget, u.used_before, u.remaining_after]),
      [["primary", "gemini-4-carbon", "critique", "reviewer", "flag --gemini-api-primary 2", 2, 0, 1]], "the usage record: kind, seat, model, purpose, source, budget remaining");
    assert.deepEqual(ok.run.billing.rows.map(x => [x.kind, x.model, x.remaining_after]), [["primary", "gemini-4-carbon", 1]], "and the run's own record");
    assert.equal(ok.result.gemini_billing.used.primary, 1);
    // (c) the budget already spent on this board (recorded by an earlier attempt): refused before it is admitted or sent.
    const spent = boardRun(f, "primary-spent", { seats: PRIMARY_SEATS, flags: ["--gemini-api-primary", "1"], seedUsage: "primary" });
    assert.equal(spent.result?.shipped, false, spent.said);
    assert.deepEqual(spent.edge, [], "the next billed request was never sent");
    assert.equal(spent.usage.length, 1, "nothing more was charged");
    assert.deepEqual(spent.run.attempts.filter(a => a.vendor === "agy_google").map(a => [a.code, a.provider_requests, a.billing?.kind]), [[METERED_GEMINI_BUDGET_EXHAUSTED, 0, "primary"]], spent.said);
    // A malformed or unbudgeted flag: nothing runs (usage, exit 2), nothing is created.
    const bad = boardRun(f, "primary-bad", { seats: PRIMARY_SEATS, flags: ["--gemini-api-primary", "yes"] });
    assert.equal(bad.status, 2, bad.said);
    assert.match(bad.out.stderr, /GEMINI_BILLING_INVALID: --gemini-api-primary takes its budget/);
    assert.equal(bad.run, null);
  });
});

test("pantheon-board run, FAILOVER (the in-run critique's Antigravity lane refused for quota; its metered spare): refused and recorded with a key present and nothing declared, charged before it is sent when declared, refused once its budget is spent; primary never admits it", { timeout: 300_000 }, async () => {
  await withBoard(async f => {
    f.agyQuota([LANE]);
    for (const [name, flags] of [["failover-off", []], ["failover-primary-only", ["--gemini-api-primary", "5"]]]) {
      const r = boardRun(f, name, { seats: FAILOVER_SEATS, flags });
      assert.equal(r.result?.shipped, false, r.said);
      assert.deepEqual(r.edge, [], "no billed Gemini request");
      assert.deepEqual(r.usage, []);
      assert.ok(r.progress.some(p => p.event === "quota_failover.skipped" && p.model === "gemini-4-carbon" && /METERED_GEMINI_DISABLED/.test(p.detail)), r.said);
      assert.deepEqual(r.run.billing.refusals.map(x => [x.code, x.kind]), [[METERED_GEMINI_DISABLED, "failover"]]);
      assert.deepEqual(r.run.attempts.filter(a => a.vendor === "agy_google" && a.transport === "api"), [], "the spare was never attempted");
    }
    const ok = boardRun(f, "failover-on", { seats: FAILOVER_SEATS, flags: ["--metered-gemini-failover", "3"] });
    assert.equal(ok.result?.shipped, true, ok.said);
    assert.equal(ok.edge.length, 1, ok.said);
    chargedBefore(ok.edge);
    assert.deepEqual(ok.usage.map(u => [u.kind, u.model, u.purpose, u.source, u.remaining_after]), [["failover", "gemini-4-carbon", "critique", "flag --metered-gemini-failover 3", 2]]);
    assert.equal(ok.run.turns.find(t => t.purpose === "critique").quota_failover.used, true);
    const spent = boardRun(f, "failover-spent", { seats: FAILOVER_SEATS, flags: ["--metered-gemini-failover", "1"], seedUsage: "failover" });
    assert.equal(spent.result?.shipped, false, spent.said);
    assert.deepEqual(spent.edge, []);
    assert.ok(spent.progress.some(p => p.event === "quota_failover.skipped" && /METERED_GEMINI_BUDGET_EXHAUSTED/.test(p.detail)), spent.said);
    assert.deepEqual(spent.run.billing.refusals.map(x => [x.code, x.kind]), [[METERED_GEMINI_BUDGET_EXHAUSTED, "failover"]]);
  });
});

// ---- pantheon-compare ------------------------------------------------------------------------------------------------
function compareRun(f, name, { flags = [], seedUsage = null, item } = {}) {
  const dir = join(f.repo, "compare", name), edge = join(f.repo, `${name}.edge.jsonl`), usage = join(dir, "gemini-billing.jsonl"), out = join(f.repo, `${name}.record.json`);
  mkdirSync(dir, { recursive: true });
  if (seedUsage) seed(usage, seedUsage);
  const r = spawnSync(process.execPath, [BIN("pantheon-compare.mjs"), "--item", item, "--max-provider-calls", "40", "--out", out, "--clients", join(f.repo, "l136.clients.fixture.mjs"),
    "--repo", f.repo, "--dir", dir, ...flags], { encoding: "utf8", env: { ...process.env, ...KEYS, L136_EDGE_LOG: edge, L136_USAGE_FILE: usage }, timeout: 300_000 });
  let result = null;
  try { result = JSON.parse(r.stdout); } catch { result = null; }
  const runs = ["argo", "fit"].map(p => join(dir, `${item}.${p}`, "run.json")).filter(existsSync).map(x => JSON.parse(readFileSync(x, "utf8")));
  return { status: r.status, result, runs, edge: jsonl(edge), usage: jsonl(usage), said: `exit ${r.status}\n${r.stdout.slice(-1500)}\n${r.stderr.slice(-2500)}` };
}
const refusalsOf = runs => runs.flatMap(r => r.billing?.refusals ?? []).map(x => [x.code, x.kind]);
async function withCompare(fn) {
  await withDispatch(async ctx => {
    const repo = ctx.dir;
    writeFileSync(join(repo, "alpha.mjs"), "export const ok = false;\n");
    writeFileSync(join(repo, "verify.mjs"), 'import assert from "node:assert/strict"; import {ok} from "./alpha.mjs"; assert.equal(ok, true);\n');
    mkdirSync(join(repo, "tickets"), { recursive: true });
    const ticket = (item, extra) => writeFileSync(join(repo, "tickets", `${item}.json`), JSON.stringify({ schema: "ophanim.ticket/v1", item, slice: "the whole item",
      proposes: { state: "Resolved", basis: "alpha.mjs exports ok = true" }, title: "alpha.mjs exports ok = true", goal: "Make alpha.mjs export `ok` as true.", question: "fixture",
      repo_root: ".", copy: ["alpha.mjs", "verify.mjs"], acceptance_cmd: "node verify.mjs", ...extra }, null, 2) + "\n");
    // PRIMARY: the ticket pins its work to a Gemini API id. FAILOVER: a hard ticket whose fit arm walks its lane ladder to the spare.
    ticket("pinned", { slots: [{ slot: "alpha", path: "alpha.mjs", model: "gemini-4-carbon" }], difficulty: "easy" });
    ticket("ladder", { slot: "alpha", path: "alpha.mjs", difficulty: "hard" });
    writeFileSync(join(repo, "l136.clients.fixture.mjs"), RECORDING_CLIENTS);
    await fn({ ...ctx, repo });
  });
}

test("pantheon-compare, PRIMARY (a ticket's Gemini API pin, both arms): refused and recorded with a key present and nothing declared; charged before it is sent when declared; the comparison's budget spent by one arm refuses the other's request", { timeout: 300_000 }, async () => {
  await withCompare(async f => {
    for (const [name, flags] of [["pinned-off", []], ["pinned-failover-only", ["--metered-gemini-failover", "5"]]]) {
      const r = compareRun(f, name, { item: "pinned", flags });
      assert.equal(r.status, 0, r.said);
      assert.deepEqual([r.edge, r.usage], [[], []], "no billed Gemini request, nothing charged");
      assert.ok(r.runs.length === 2 && refusalsOf(r.runs).every(([c, k]) => c === GEMINI_PRIMARY_DISABLED && k === "primary") && refusalsOf(r.runs).length >= 2, `${JSON.stringify(refusalsOf(r.runs))}\n${r.said}`);
      assert.ok(r.runs.every(run => run.attempts.filter(a => a.vendor === "agy_google").every(a => a.code === GEMINI_PRIMARY_DISABLED && a.provider_requests === 0)));
      assert.equal(r.result.gemini_billing.used.primary, 0);
    }
    const ok = compareRun(f, "pinned-on", { item: "pinned", flags: ["--gemini-api-primary", "6"] });
    assert.equal(ok.status, 0, ok.said);
    assert.ok(ok.edge.length >= 2, `each arm's pinned work made a billed request: ${ok.said}`);
    chargedBefore(ok.edge);
    assert.equal(ok.usage.length, ok.edge.length, "every billed request has its usage row, and only those");
    assert.ok(ok.usage.every(u => u.kind === "primary" && u.model === "gemini-4-carbon" && u.purpose === "work" && u.source === "flag --gemini-api-primary 6"));
    // One request of budget: the first arm spends it, the second arm's request is refused before it is sent.
    const spent = compareRun(f, "pinned-spent", { item: "pinned", flags: ["--gemini-api-primary", "1"] });
    assert.equal(spent.status, 0, spent.said);
    assert.equal(spent.edge.length, 1, spent.said);
    assert.equal(spent.usage.length, 1);
    assert.ok(refusalsOf(spent.runs).some(([c, k]) => c === METERED_GEMINI_BUDGET_EXHAUSTED && k === "primary"), JSON.stringify(refusalsOf(spent.runs)));
  });
});

test("pantheon-compare, FAILOVER (the fit arm's lane ladder refused for quota; the spare of its pick): refused with a key present and nothing declared, charged before it is sent when declared, refused once the comparison's budget is spent", { timeout: 300_000 }, async () => {
  await withCompare(async f => {
    f.agyQuota(["gemini-4-carbon-high", "gemini-4-hydrogen-xhigh", "gemini-4-argon-high"]);
    for (const [name, flags] of [["ladder-off", []], ["ladder-primary-only", ["--gemini-api-primary", "5"]]]) {
      const r = compareRun(f, name, { item: "ladder", flags });
      assert.equal(r.status, 0, r.said);
      assert.deepEqual([r.edge, r.usage], [[], []]);
      assert.ok(refusalsOf(r.runs).some(([c, k]) => c === METERED_GEMINI_DISABLED && k === "failover"), `${JSON.stringify(refusalsOf(r.runs))}\n${r.said}`);
    }
    const ok = compareRun(f, "ladder-on", { item: "ladder", flags: ["--metered-gemini-failover", "4"] });
    assert.equal(ok.status, 0, ok.said);
    assert.ok(ok.edge.length >= 1, ok.said);
    chargedBefore(ok.edge);
    assert.equal(ok.usage.length, ok.edge.length);
    assert.ok(ok.usage.every(u => u.kind === "failover" && u.source === "flag --metered-gemini-failover 4"));
    const spent = compareRun(f, "ladder-spent", { item: "ladder", flags: ["--metered-gemini-failover", "1"], seedUsage: "failover" });
    assert.equal(spent.status, 0, spent.said);
    assert.deepEqual(spent.edge, [], spent.said);
    assert.ok(refusalsOf(spent.runs).some(([c, k]) => c === METERED_GEMINI_BUDGET_EXHAUSTED && k === "failover"), JSON.stringify(refusalsOf(spent.runs)));
  });
});

// ---- pantheon-review-cycle -------------------------------------------------------------------------------------------
// FAILOVER IS NOT REACHABLE HERE: the command's live reviewer turn is the API seat itself (bin/pantheon-review-cycle.mjs
// liveTurn -> sdk/live.mjs apiTurn), with no Antigravity lane in front of it, so a Google seat is primary execution.
function cycleCli(f, args, { flags = [], mode = null } = {}) {
  const r = spawnSync(process.execPath, [BIN("pantheon-review-cycle.mjs"), ...args, "--repo", f.repo, "--ledger", f.ledger, ...flags], { encoding: "utf8",
    env: { ...process.env, ...KEYS, OPENAI_API_KEY: "sk-l136-synthetic", XAI_API_KEY: "xai-l136-synthetic", NODE_OPTIONS: `--import ${PRELOAD}`, L136_FETCH_LOG: f.fetchLog,
      L136_USAGE_FILE: join(f.ledger, "gemini-billing.jsonl"), ...(mode ? { L136_GEMINI_MODE: mode } : {}) }, timeout: 180_000 });
  let result = null;
  try { result = JSON.parse(r.stdout); } catch { result = null; }
  return { status: r.status, result, said: `exit ${r.status}\n${r.stdout.slice(-2000)}\n${r.stderr.slice(-1500)}` };
}
function cycleFixture(root, name) {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main"); git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "f@example.invalid");
  writeFileSync(join(repo, "a.mjs"), "export const a = 1;\n"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD").trim();
  writeFileSync(join(repo, "a.mjs"), "export const a = 2;\n"); git(repo, "commit", "-qam", "change");
  return { repo, base, ledger: join(root, `${name}-ledger`), fetchLog: join(root, `${name}.fetch.jsonl`) };
}
const googleOf = r => ({ reviewed: (r.result?.reviews ?? []).some(x => x.lab === "google"), why: (r.result?.attempts ?? []).filter(a => a.vendor === "agy_google").map(a => a.why ?? "").join(" | ") });
const billedFetches = f => jsonl(f.fetchLog).filter(x => x.billed);

test("pantheon-review-cycle review/resume, PRIMARY (a Google reviewer served by the Gemini API): refused with a key present and nothing declared (the cycle stays open); a resume with the setting declared is charged before it is sent; a spent budget survives the restart (resume) and refuses again until raised", { timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "l136-cycle-"));
  try {
    const f = cycleFixture(root, "off");
    const off = cycleCli(f, ["review", "--base", f.base]);
    assert.equal(off.status, 1, off.said);
    assert.equal(googleOf(off).reviewed, false);
    assert.match(googleOf(off).why, /GEMINI_PRIMARY_DISABLED/, off.said);
    assert.deepEqual(billedFetches(f), [], "no billed Gemini request with the key present");
    assert.equal(existsSync(join(f.ledger, "gemini-billing.jsonl")), false, "nothing charged");
    assert.equal(off.result.gemini_billing.refusals[0].code, GEMINI_PRIMARY_DISABLED);
    // The failover switch alone does not admit it either; then the owner declares primary: the open cycle is resumed.
    const still = cycleCli(f, ["resume"], { flags: ["--metered-gemini-failover", "5"] });
    assert.equal(googleOf(still).reviewed, false, still.said);
    assert.deepEqual(billedFetches(f), []);
    const on = cycleCli(f, ["resume"], { flags: ["--gemini-api-primary", "2"] });
    assert.equal(googleOf(on).reviewed, true, on.said);
    assert.equal(billedFetches(f).length, 1);
    chargedBefore(billedFetches(f));
    assert.deepEqual(jsonl(join(f.ledger, "gemini-billing.jsonl")).map(u => [u.kind, u.vendor, u.source, u.remaining_after]), [["primary", "agy_google", "flag --gemini-api-primary 2", 1]]);

    // The budget already spent on this cycle ledger (a request an earlier run persisted): refused before it is sent.
    const g = cycleFixture(root, "spent");
    seed(join(g.ledger, "gemini-billing.jsonl"), "primary");
    const spent = cycleCli(g, ["review", "--base", g.base], { flags: ["--gemini-api-primary", "1"] });
    assert.equal(googleOf(spent).reviewed, false, spent.said);
    assert.match(googleOf(spent).why, /METERED_GEMINI_BUDGET_EXHAUSTED/, spent.said);
    assert.deepEqual(billedFetches(g), [], "the request over the budget was never sent");
    // THE RESTART: a resume with the same budget counts the request already recorded; nothing is sent.
    const restart = cycleCli(g, ["resume"], { flags: ["--gemini-api-primary", "1"] });
    assert.match(googleOf(restart).why, /METERED_GEMINI_BUDGET_EXHAUSTED/, restart.said);
    assert.deepEqual(billedFetches(g), [], "a restart did not reset the budget");
    // The owner raises it: the open cycle's seat is asked again and answers.
    const raised = cycleCli(g, ["resume"], { flags: ["--gemini-api-primary", "2"] });
    assert.equal(googleOf(raised).reviewed, true, raised.said);
    chargedBefore(billedFetches(g), "usage_rows");
    assert.deepEqual(jsonl(join(g.ledger, "gemini-billing.jsonl")).map(u => [u.used_before, u.budget]), [[0, 1], [1, 2]]);

    // NO HIDDEN BILLED REQUEST: the SDK's own unary continuation is off on this (direct) path, so a CONTINUATION answer
    // ends the turn incomplete after ONE admitted, recorded request; no second request reaches the edge.
    const h = cycleFixture(root, "hop");
    const hop = cycleCli(h, ["review", "--base", h.base], { flags: ["--gemini-api-primary", "5"], mode: "continue" });
    assert.equal(googleOf(hop).reviewed, false, hop.said);
    assert.match(googleOf(hop).why, /did not complete \(CONTINUATION\)/, hop.said);
    assert.equal(billedFetches(h).length, 1, "exactly the one admitted request was sent");
    chargedBefore(billedFetches(h));
    assert.equal(jsonl(join(h.ledger, "gemini-billing.jsonl")).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- the review runner, --via api ------------------------------------------------------------------------------------
// FAILOVER IS NOT REACHABLE HERE: --via api sends the reviewer's requests to its own lab's API (review-runner/vendors.mjs),
// with no Antigravity lane in front of it; --via subscription runs the vendors' CLIs and drops GEMINI_API_KEY from them
// (review-runner/subscription.mjs DROP). A Google reviewer over the API is primary execution.
test("run-review --via api, PRIMARY (a Google reviewer): refused with a key present and nothing declared (recorded, incomplete, continuable); each request charged before it is sent when declared; a spent budget survives --continue until raised", { timeout: 300_000 }, async t => {
  t.after(rrCleanup);
  const repo = await fixtureRepo();
  const g = (parts, fr = "STOP") => () => ({ json: { modelVersion: "gemini-4-carbon-001", usageMetadata: { totalTokenCount: 5 }, candidates: [{ finishReason: fr, content: { role: "model", parts } }] } });
  const FINAL = "# Findings\n\nNone: the change is right.";
  const toolTurn = g([{ functionCall: { name: "read_file", args: { path: "hello.txt" } } }, { functionCall: { name: "run_tests", args: { files: ["pantheon/tests/other.test.mjs"] } } }]);
  const run = async (outDir, script, args = []) => {
    const out = capture();
    let usage = null;
    const recorded = fakeFetch(script);
    // The provider edge: each request records how many usage rows were persisted when it was sent.
    const seen = [];
    const fetch = async (url, init) => { seen.push({ usage_rows: jsonl(usage).length }); return recorded(url, init); };
    const d = await deps({ root: repo.root, env: { GEMINI_API_KEY: KEYS.GEMINI_API_KEY, GOOGLE_API_KEY: KEYS.GOOGLE_API_KEY, METERED_GEMINI_FAILOVER: "true" }, fetch, out });
    usage = join(outDir, "findings-1-google.gemini-billing.jsonl");
    const code = await reviewMain(["--assignment", "1", "--commit", repo.commit, ...LIMITS, "--out", outDir, ...args], d);
    const tpath = join(outDir, "findings-1-google.transcript.json");
    return { code, seen, out, usage: jsonl(usage), transcript: existsSync(tpath) ? JSON.parse(readFileSync(tpath, "utf8")) : null, tpath };
  };
  // (a) nothing declared: refused before the first request, recorded on the transcript, incomplete.
  const offDir = await rrTemp(join(tmpdir(), "l136-rr-"));
  const off = await run(offDir, []);
  assert.equal(off.code, EXIT.incomplete, off.out.err);
  assert.deepEqual(off.seen, [], "no request was sent");
  assert.deepEqual(off.usage, []);
  const refusedEv = off.transcript.events.filter(e => e.type === "provider_call_refused");
  assert.deepEqual(refusedEv.map(e => [e.code, e.kind, e.provider_requests]), [[GEMINI_PRIMARY_DISABLED, "primary", 0]]);
  assert.equal(off.transcript.gemini_billing.refusals[0].code, GEMINI_PRIMARY_DISABLED);
  // ... and recoverable: --continue with the setting declared completes the same review.
  const resumed = await run(offDir, [toolTurn, g([{ text: FINAL }])], ["--continue", off.tpath, "--gemini-api-primary", "4"]);
  assert.equal(resumed.code, EXIT.complete, resumed.out.err);
  assert.equal(resumed.seen.length, 2);
  chargedBefore(resumed.seen);
  assert.deepEqual(resumed.usage.map(u => [u.kind, u.vendor, u.model, u.role, u.source, u.remaining_after]), [["primary", "gemini", "gemini-4-carbon", "reviewer", "flag --gemini-api-primary 4", 3], ["primary", "gemini", "gemini-4-carbon", "reviewer", "flag --gemini-api-primary 4", 2]]);
  assert.ok(resumed.transcript.events.filter(e => e.type === "provider_call").every(e => e.gemini?.kind === "primary"), "each billed request's event carries its usage");
  // (c) a budget of one: the second request is refused before it is sent; a --continue with the same budget sends nothing.
  const spentDir = await rrTemp(join(tmpdir(), "l136-rr-"));
  const spent = await run(spentDir, [toolTurn], ["--gemini-api-primary", "1"]);
  assert.equal(spent.code, EXIT.incomplete, spent.out.err);
  assert.equal(spent.seen.length, 1);
  assert.deepEqual(spent.transcript.events.filter(e => e.type === "provider_call_refused").map(e => [e.code, e.used, e.budget]), [[METERED_GEMINI_BUDGET_EXHAUSTED, 1, 1]]);
  const restart = await run(spentDir, [], ["--continue", spent.tpath, "--gemini-api-primary", "1"]);
  assert.deepEqual(restart.seen, [], "the restart counted the persisted request: nothing was sent");
  assert.equal(restart.transcript.events.filter(e => e.type === "provider_call_refused").at(-1).code, METERED_GEMINI_BUDGET_EXHAUSTED);
  const raised = await run(spentDir, [g([{ text: FINAL }])], ["--continue", restart.tpath, "--gemini-api-primary", "3"]);
  assert.equal(raised.code, EXIT.complete, raised.out.err);
  assert.deepEqual(raised.usage.map(u => [u.used_before, u.budget]), [[0, 1], [1, 3]]);
  // A malformed flag: a usage error, nothing read or run.
  const bad = capture();
  assert.equal(await reviewMain(["--assignment", "1", "--commit", repo.commit, ...LIMITS, "--gemini-api-primary", "on"], await deps({ root: repo.root, fetch: fakeFetch([]), out: bad })), EXIT.usage);
  assert.match(bad.err, /GEMINI_BILLING_INVALID/);
});

// ---- pantheon-board: the reviewer's default transport (owner decision 2026-11-19) -------------------------------------
test("pantheon-board run: the reviewer's default transport is the subscription CLI lane (nothing billed); PANTHEON_AGY_TRANSPORT=sdk asks for the python SDK seat, which is PRIMARY execution: refused with a key present and nothing declared (never spawned), not admitted by the failover switch, spawned once gemini_api_primary is declared -- with nothing charged for the launch, and its one request charged before it is sent (L-150)", { timeout: 300_000 }, async () => {
  await withBoard(async f => {
    // The fake python SDK seat (its environment is scrubbed, so its paths are written into it): it logs each spawn with the
    // usage rows persisted at that moment and whether a Gemini key reached it, makes ONE Gemini request through the
    // controller's metering relay with the capability it was given (register L-150: the seat holds no key; every request
    // is charged at the relay before it is forwarded), and answers as the seat would.
    const pyLog = join(f.repo, "python.log"), python = join(f.repo, "fake-python");
    const usageOf = name => join(f.repo, "boards", name, "gemini-billing.jsonl");
    writeFileSync(python, `#!/bin/sh
for a in "$@"; do case "$prev" in --out) out="$a" ;; --model) model="$a" ;; --role) role="$a" ;; esac; prev="$a"; done
rows=$(cat ${JSON.stringify(f.repo)}/boards/*/gemini-billing.jsonl 2>/dev/null | wc -l)
printf '%s %s %s %s\\n' "$role" "$model" "$rows" "\${GEMINI_API_KEY:-no-key}" >> ${JSON.stringify(pyLog)}
MODEL="$model" ${JSON.stringify(process.execPath)} -e 'fetch(process.env.PANTHEON_AGY_RELAY_URL + "/v1beta/models/" + process.env.MODEL + ":streamGenerateContent?alt=sse", { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": process.env.PANTHEON_AGY_RELAY_CAPABILITY ?? "" }, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "review" }] }], sessionId: "1" }) }).then(r => r.text()).catch(() => null)'
printf 'VERDICT: approve\\n' > "$out/response.md"
printf '{"ok": true, "role": "%s", "model": "%s", "conversation_id": "fake-sdk", "tool_calls": 0, "subagent_calls": 0}\\n' "$role" "$model"
`, { mode: 0o755 });
    // THE PROVIDER EDGE OF THE RELAY: a local fake Gemini API in its own process (the board runs under spawnSync), recording
    // each request with the key it carried and the usage rows persisted when it arrived. Never a real provider.
    const edgeLog = join(f.repo, "relay-edge.jsonl"), edgeScript = join(f.repo, "relay-edge.mjs");
    writeFileSync(edgeScript, `import http from "node:http";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
const boards = ${JSON.stringify(join(f.repo, "boards"))};
const rows = () => (existsSync(boards) ? readdirSync(boards) : []).reduce((n, b) => { const u = boards + "/" + b + "/gemini-billing.jsonl"; return n + (existsSync(u) ? readFileSync(u, "utf8").split("\\n").filter(Boolean).length : 0); }, 0);
const s = http.createServer((req, res) => { req.resume(); req.on("end", () => {
  appendFileSync(${JSON.stringify(edgeLog)}, JSON.stringify({ path: req.url, key: req.headers["x-goog-api-key"] ?? null, usage_rows: rows() }) + "\\n");
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end("data: " + JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "VERDICT: approve" }] }, finishReason: "STOP" }], responseId: "edge-1" }) + "\\r\\n\\r\\n");
}); });
s.listen(0, "127.0.0.1", () => console.log(s.address().port));
`);
    const edgeProc = spawn(process.execPath, [edgeScript], { stdio: ["ignore", "pipe", "inherit"] });
    const edgePort = await new Promise(r => edgeProc.stdout.once("data", d => r(String(d).trim())));
    const seats = ["implementer=xai/grok-4.6", "reviewer=agy_google/gemini-3.8-flash"];
    const spawned = () => (existsSync(pyLog) ? readFileSync(pyLog, "utf8").split("\n").filter(Boolean) : []);
    const saved = { PANTHEON_AGY_TRANSPORT: process.env.PANTHEON_AGY_TRANSPORT, PANTHEON_AGY_PYTHON: process.env.PANTHEON_AGY_PYTHON, PANTHEON_AGY_RELAY_UPSTREAM: process.env.PANTHEON_AGY_RELAY_UPSTREAM };
    try {
      process.env.PANTHEON_AGY_PYTHON = python;
      process.env.PANTHEON_AGY_RELAY_UPSTREAM = `http://127.0.0.1:${edgePort}`;
      delete process.env.PANTHEON_AGY_TRANSPORT;
      const byDefault = boardRun(f, "transport-default", { seats });
      assert.equal(byDefault.result?.shipped, true, byDefault.said);
      assert.deepEqual(f.agy().filter(a => a.agent === "pantheon-reviewer"), [{ agent: "pantheon-reviewer", model: "gemini-3.8-flash" }], "the reviewer ran on the CLI lane");
      assert.deepEqual([spawned(), byDefault.usage], [[], []], "no SDK seat, nothing billed");
      process.env.PANTHEON_AGY_TRANSPORT = "sdk";
      for (const [name, flags] of [["sdk-off", []], ["sdk-failover-only", ["--metered-gemini-failover", "5"]]]) {
        const r = boardRun(f, name, { seats, flags });
        assert.equal(r.result?.shipped, false, r.said);
        assert.deepEqual(spawned(), [], "the SDK seat was never spawned");
        assert.deepEqual(r.run.attempts.filter(a => a.vendor === "agy_google").map(a => [a.purpose, a.code, a.provider_requests]), [["critique", GEMINI_PRIMARY_DISABLED, 0]], r.said);
      }
      assert.deepEqual(jsonl(edgeLog), [], "the refused seats sent nothing");
      const on = boardRun(f, "sdk-on", { seats, flags: ["--gemini-api-primary", "2"] });
      assert.equal(on.result?.shipped, true, on.said);
      // L-150: a launch is not a request. Spawned once with NOTHING charged and no key; its one request was charged at the
      // relay before it reached the provider, and forwarded with the controller's key.
      assert.deepEqual(spawned(), ["reviewer gemini-3.8-flash 0 no-key"], "spawned once, nothing charged for the launch, no key in the seat");
      assert.deepEqual(jsonl(edgeLog).map(e => [e.path, e.key, e.usage_rows]), [["/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse", KEYS.GEMINI_API_KEY, 1]], "its request was charged before it was sent");
      assert.deepEqual(jsonl(usageOf("sdk-on")).map(u => [u.kind, u.transport, u.model, u.source]), [["primary", "sdk", "gemini-3.8-flash", "flag --gemini-api-primary 2"]]);
      assert.deepEqual(on.run.attempts.filter(a => a.vendor === "agy_google").map(a => [a.purpose, a.provider_requests]), [["critique", 1]]);
    } finally {
      edgeProc.kill();
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});
