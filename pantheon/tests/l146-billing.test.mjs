// REGISTER L-146: THE FIVE OPERATOR PATHS UNDER THE ONE L-136 GEMINI BILLING POLICY (owner decisions 2026-11-20;
// docs/billing-policy.md, "Operator scripts"). Each script is SPAWNED as the operator runs it (real argv), with the
// provider edge preloaded (fixtures/l146-fetch-preload.mjs over the L-136 recorder): every request is recorded with the
// number of usage rows already persisted when it was sent, so "charged, then sent" is read at the edge itself, and none
// leaves the machine. Credentials are synthetic; the environment also carries look-alikes of an authorization and of an
// authenticated Google session (ADC, Vertex): none of them may admit a billed request.
//
//   bin/cross-lab-review.mjs   every agy_google seat (an API id, or a lane-named model: the HTTPS module has no lane)
//   scripts/live-check.mjs     two turns on one seat (and a continuation hop): every request charged
//   scripts/stream-check.mjs   one streamed turn (and a continuation hop)
//   scripts/view-check.mjs     a multi-seat turn through the view server, gated in the script's own client factory
//   scripts/live-ship.mjs      the planner and implementer seats that fall through to agy_google (their 429s at the
//                              edge), and the same-seat retry after a 5xx. UNREACHABLE without editing the script: the
//                              agy_google scout (SCOUTS = ["xai"], agy_google commented out) and an agy_google reviewer
//                              (reviewPlan pairs the openai maker with xai whoever planned; the implementer stage stops
//                              before review when it falls through to another lab).
//   pantheon-review-cycle --turn bin/cycle-review-http-turn.mjs   the same HTTPS module through billedTurnModule: its
//                              default Google seat is lane-named (gemini-3.8-flash-high), which was passed through unbilled
//
// This file imports nothing the change added, so it runs unchanged against the base commit (the base evidence of L-146).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const GEMINI_PRIMARY_DISABLED = "GEMINI_PRIMARY_DISABLED", METERED_GEMINI_BUDGET_EXHAUSTED = "METERED_GEMINI_BUDGET_EXHAUSTED", GEMINI_BILLING_INVALID = "GEMINI_BILLING_INVALID";
const OFF = "default: absent, off";
const HERE = dirname(fileURLToPath(import.meta.url));
const P = (...p) => resolve(HERE, "..", ...p);
const PRELOAD = pathToFileURL(join(HERE, "fixtures", "l146-fetch-preload.mjs")).href;
const ROOT = mkdtempSync(join(tmpdir(), "l146-billing-"));
test.after(() => rmSync(ROOT, { recursive: true, force: true }));

// Synthetic credentials (owner item 3: environment keys, an authenticated Google session, names that look like a grant).
const ADC_FILE = join(ROOT, "adc.json");
writeFileSync(ADC_FILE, JSON.stringify({ type: "authorized_user", client_id: "l146-synthetic", client_secret: "l146-synthetic", refresh_token: "l146-synthetic" }));
const GEMINI_KEYS = { GEMINI_API_KEY: "AIza-l146-synthetic-not-a-key-0000000000", GOOGLE_API_KEY: "AIza-l146-synthetic-not-a-key-1111111111" };
const SESSION = { GOOGLE_APPLICATION_CREDENTIALS: ADC_FILE, GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_CLOUD_PROJECT: "l146-synthetic", GOOGLE_CLOUD_LOCATION: "us-central1",
  METERED_GEMINI_FAILOVER: "true", GEMINI_API_PRIMARY: "100" };
const OTHER_KEYS = { OPENAI_API_KEY: "sk-l146-synthetic", XAI_API_KEY: "xai-l146-synthetic", ANTHROPIC_API_KEY: "sk-ant-l146-synthetic" };
const KEYED = { ...GEMINI_KEYS, ...SESSION, ...OTHER_KEYS };

const jsonl = f => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);
const seed = file => { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, JSON.stringify({ schema: "ophanim.gemini-billing/v1", kind: "primary",
  setting: "gemini_api_primary", vendor: "agy_google", model: "gemini-4-carbon", purpose: "an earlier invocation", source: "test seed", budget: 1, used_before: 0,
  at: new Date().toISOString() }) + "\n"); };

/** One operator invocation: the script, its argv, an environment built from nothing but what is named here. */
function run(script, args, { env = {}, usage = null, cwd = null } = {}) {
  const dir = mkdtempSync(join(ROOT, "run-")), log = join(dir, "edge.jsonl");
  return new Promise(done => {
    const child = spawn(process.execPath, [P(script), ...args], { cwd: cwd ?? dir,
      env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, NODE_OPTIONS: `--import ${PRELOAD}`, L136_FETCH_LOG: log, ...(usage ? { L136_USAGE_FILE: usage } : {}), ...env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    const kill = setTimeout(() => child.kill("SIGKILL"), 150_000);
    child.on("close", status => {
      clearTimeout(kill);
      const edge = jsonl(log), line = stdout.split("\n").find(l => l.startsWith("gemini_billing "));
      let record = null;
      try { record = line ? JSON.parse(line.slice("gemini_billing ".length)) : null; } catch { record = null; }
      // BILLED = ANY GOOGLE HOST, not only the Gemini API's: with the Vertex look-alikes set, the base SDK client sent its
      // request to Vertex (aiplatform.googleapis.com), which the L-136 recorder's own `billed` flag does not count.
      const google = e => /googleapis\.com/.test(e.url);
      done({ status, stdout, stderr, edge, billed: edge.filter(google), others: edge.filter(e => !google(e)), record,
        said: `${script} ${args.join(" ")}: exit ${status}\n${stdout.slice(-2500)}\n${stderr.slice(-1500)}` });
    });
  });
}
const refusalsOf = r => (r.record?.refusals ?? []).map(x => [x.code, x.kind, x.vendor, x.model, x.purpose, x.source, x.provider_requests]);
/** Each billed request at the edge was sent with exactly the rows before it plus its own persisted: charged, then sent. */
const chargedBefore = (r, seeded = 0) => assert.deepEqual(r.billed.map(e => e.usage_rows), r.billed.map((_, i) => seeded + i + 1),
  `each billed request must be sent only after its own usage row was persisted\n${r.said}`);
const rowsOf = file => jsonl(file).map(u => [u.kind, u.vendor, u.model, u.purpose, u.source, u.used_before]);
/** Default off: no billed request reached the edge, the policy's refusal is on the printed record, nothing was charged. */
function refusedOff(r, { model, purpose, source = OFF }) {
  assert.notEqual(r.status, 0, r.said);
  assert.deepEqual(r.billed, [], `no billed Gemini request may reach the edge\n${r.said}`);
  assert.deepEqual(refusalsOf(r), [[GEMINI_PRIMARY_DISABLED, "primary", "agy_google", model, purpose, source, 0]], r.said);
  assert.deepEqual(r.record.rows, [], "nothing was charged");
  assert.doesNotMatch(r.stdout + r.stderr, /needs GEMINI_API_KEY/, "the policy refused it, not a missing credential");
}
/** A startup refusal: GEMINI_BILLING_INVALID, exit 2, and nothing ran (no request of any lab reached the edge). */
function invalidAtStartup(r) {
  assert.equal(r.status, 2, r.said);
  assert.match(r.stderr, new RegExp(GEMINI_BILLING_INVALID), r.said);
  assert.deepEqual(r.edge, [], "nothing ran");
}

// The cells of each path are SUBTESTS with the same names, so a run (the base run included) reports every cell on its own.
const OFF_KEYS = "off: keys and a Google session present", OFF_PROXY = "off: no key, the proxy path", FAILOVER = "failover-only: still refused";
const STARTUP = "startup refusal: nothing runs", DECLARED = "primary declared: every request charged before it is sent, and recorded";
const SHORT = "budget smaller than the requests: the next one refused before it is sent", SPENT = "budget spent earlier: refused before any request";

// ---- scripts/live-check.mjs: two turns on one seat ------------------------------------------------------------------
test("live-check (agy_google): two turns on one seat", { timeout: 180_000 }, async t => {
  const S = "scripts/live-check.mjs", M = ["agy_google", "gemini-4-carbon"];
  const u = name => join(ROOT, `live-check-${name}.jsonl`);
  seed(u("seeded"));
  const [keyed, proxy, failover, unrecorded, declared, short, seeded] = await Promise.all([
    run(S, M, { env: KEYED }),
    run(S, M, { env: OTHER_KEYS }),
    run(S, [...M, "--metered-gemini-failover", "5", "--gemini-usage", u("failover")], { env: KEYED, usage: u("failover") }),
    run(S, [...M, "--gemini-api-primary", "3"], { env: KEYED }),
    run(S, [...M, "--gemini-api-primary", "3", "--gemini-usage", u("declared")], { env: { ...GEMINI_KEYS, L136_GEMINI_MODE: "continue" }, usage: u("declared") }),
    run(S, [...M, "--gemini-api-primary", "2", "--gemini-usage", u("short")], { env: { ...GEMINI_KEYS, L136_GEMINI_MODE: "continue" }, usage: u("short") }),
    run(S, [...M, "--gemini-api-primary", "1", "--gemini-usage", u("seeded")], { env: GEMINI_KEYS, usage: u("seeded") }),
  ]);
  await t.test(OFF_KEYS, () => refusedOff(keyed, { model: "gemini-4-carbon", purpose: "live-check" }));
  await t.test(OFF_PROXY, () => refusedOff(proxy, { model: "gemini-4-carbon", purpose: "live-check" }));
  await t.test(FAILOVER, () => {
    refusedOff(failover, { model: "gemini-4-carbon", purpose: "live-check" });
    assert.equal(failover.record.policy.metered_gemini_failover.enabled, true, "the failover switch was on, and it authorized nothing");
    assert.equal(existsSync(u("failover")), false, "nothing was charged on the usage record");
  });
  await t.test(`${STARTUP} (enabled without --gemini-usage)`, () => invalidAtStartup(unrecorded));
  // Turn one is two requests (a CONTINUATION hop), turn two a third: each is charged before it is sent.
  await t.test(`${DECLARED} (a hop and the second turn: three requests)`, () => {
    assert.equal(declared.billed.length, 3, declared.said);
    chargedBefore(declared);
    const src = "flag --gemini-api-primary 3";
    assert.deepEqual(rowsOf(u("declared")), [0, 1, 2].map(n => ["primary", "agy_google", "gemini-4-carbon", "live-check", src, n]), declared.said);
    assert.deepEqual(declared.record.rows.map(x => [x.kind, x.model, x.purpose, x.source, x.request]), [1, 2, 3].map(n => ["primary", "gemini-4-carbon", "live-check", src, n]));
    assert.deepEqual(declared.record.refusals, []);
    assert.deepEqual(declared.record.used, { failover: 0, primary: 3 });
  });
  // A budget of two: the hop is admitted, turn two's request is refused before it is sent; the two rows stay.
  await t.test(SHORT, () => {
    assert.equal(short.billed.length, 2, short.said);
    chargedBefore(short);
    assert.deepEqual(refusalsOf(short), [[METERED_GEMINI_BUDGET_EXHAUSTED, "primary", "agy_google", "gemini-4-carbon", "live-check", "flag --gemini-api-primary 2", 0]], short.said);
    assert.equal(jsonl(u("short")).length, 2, "the record of what was spent is kept");
    assert.notEqual(short.status, 0);
  });
  // Spent by an earlier invocation that used the same file: refused before the client is made.
  await t.test(SPENT, () => {
    assert.deepEqual(seeded.billed, [], seeded.said);
    assert.deepEqual(refusalsOf(seeded), [[METERED_GEMINI_BUDGET_EXHAUSTED, "primary", "agy_google", "gemini-4-carbon", "live-check", "flag --gemini-api-primary 1", 0]], seeded.said);
    assert.equal(jsonl(u("seeded")).length, 1);
  });
});

// ---- scripts/stream-check.mjs: one streamed turn ----------------------------------------------------------------------
test("stream-check (agy_google): one streamed turn", { timeout: 180_000 }, async t => {
  const S = "scripts/stream-check.mjs", M = ["agy_google", "gemini-4-carbon"];
  const u = name => join(ROOT, `stream-check-${name}.jsonl`);
  seed(u("seeded"));
  const [keyed, proxy, failover, unrecorded, declared, short, seeded] = await Promise.all([
    run(S, M, { env: KEYED }),
    run(S, M, { env: OTHER_KEYS }),
    run(S, [...M, "--metered-gemini-failover", "5", "--gemini-usage", u("failover")], { env: KEYED, usage: u("failover") }),
    run(S, [...M, "--gemini-api-primary", "3"], { env: KEYED }),
    run(S, [...M, "--gemini-api-primary", "3", "--gemini-usage", u("declared")], { env: { ...GEMINI_KEYS, L136_GEMINI_MODE: "continue" }, usage: u("declared") }),
    run(S, [...M, "--gemini-api-primary", "1", "--gemini-usage", u("short")], { env: { ...GEMINI_KEYS, L136_GEMINI_MODE: "continue" }, usage: u("short") }),
    run(S, [...M, "--gemini-api-primary", "1", "--gemini-usage", u("seeded")], { env: GEMINI_KEYS, usage: u("seeded") }),
  ]);
  await t.test(OFF_KEYS, () => refusedOff(keyed, { model: "gemini-4-carbon", purpose: "stream-check" }));
  await t.test(OFF_PROXY, () => refusedOff(proxy, { model: "gemini-4-carbon", purpose: "stream-check" }));
  await t.test(FAILOVER, () => {
    refusedOff(failover, { model: "gemini-4-carbon", purpose: "stream-check" });
    assert.equal(existsSync(u("failover")), false);
  });
  await t.test(`${STARTUP} (enabled without --gemini-usage)`, () => invalidAtStartup(unrecorded));
  await t.test(`${DECLARED} (the streamed request and its continuation hop)`, () => {
    assert.equal(declared.status, 0, declared.said);
    assert.equal(declared.billed.length, 2, declared.said);
    chargedBefore(declared);
    assert.deepEqual(rowsOf(u("declared")), [0, 1].map(n => ["primary", "agy_google", "gemini-4-carbon", "stream-check", "flag --gemini-api-primary 3", n]));
  });
  await t.test(`${SHORT} (the hop)`, () => {
    assert.equal(short.billed.length, 1, short.said);
    chargedBefore(short);
    assert.deepEqual(refusalsOf(short), [[METERED_GEMINI_BUDGET_EXHAUSTED, "primary", "agy_google", "gemini-4-carbon", "stream-check", "flag --gemini-api-primary 1", 0]], short.said);
    assert.equal(jsonl(u("short")).length, 1);
  });
  await t.test(SPENT, () => {
    assert.deepEqual(seeded.billed, [], seeded.said);
    assert.deepEqual(refusalsOf(seeded), [[METERED_GEMINI_BUDGET_EXHAUSTED, "primary", "agy_google", "gemini-4-carbon", "stream-check", "flag --gemini-api-primary 1", 0]], seeded.said);
  });
});

// ---- scripts/view-check.mjs: a multi-seat turn through the view server ------------------------------------------------
test("view-check (openai,agy_google): a multi-seat turn through the view server", { timeout: 180_000 }, async t => {
  const S = "scripts/view-check.mjs", seats = ["openai,agy_google"];
  const u = name => join(ROOT, `view-check-${name}.jsonl`);
  seed(u("seeded"));
  const [keyed, proxy, failover, unrecorded, declared, seeded] = await Promise.all([
    run(S, seats, { env: KEYED }),
    run(S, seats, { env: OTHER_KEYS }),
    run(S, [...seats, "--metered-gemini-failover", "5", "--gemini-usage", u("failover")], { env: KEYED, usage: u("failover") }),
    run(S, [...seats, "--gemini-api-primary", "3"], { env: KEYED }),
    run(S, [...seats, "--gemini-api-primary", "3", "--gemini-usage", u("declared")], { env: { ...GEMINI_KEYS, ...OTHER_KEYS }, usage: u("declared") }),
    run(S, [...seats, "--gemini-api-primary", "1", "--gemini-usage", u("seeded")], { env: { ...GEMINI_KEYS, ...OTHER_KEYS }, usage: u("seeded") }),
  ]);
  const offSeat = r => {
    refusedOff(r, { model: "gemini-3.6-flash", purpose: "view-check" });
    assert.ok(r.others.some(e => /api\.openai\.com/.test(e.url)), `the other seat's turn still ran\n${r.said}`);
  };
  await t.test(OFF_KEYS, () => offSeat(keyed));
  await t.test(OFF_PROXY, () => offSeat(proxy));
  await t.test(FAILOVER, () => { offSeat(failover); assert.equal(existsSync(u("failover")), false); });
  await t.test(`${STARTUP} (enabled without --gemini-usage)`, () => invalidAtStartup(unrecorded));
  await t.test(`${DECLARED} (only the Gemini seat is charged)`, () => {
    assert.equal(declared.billed.length, 1, declared.said);
    chargedBefore(declared);
    assert.deepEqual(rowsOf(u("declared")), [["primary", "agy_google", "gemini-3.6-flash", "view-check", "flag --gemini-api-primary 3", 0]], declared.said);
    assert.ok(declared.others.some(e => /api\.openai\.com/.test(e.url)), "the other seat ran");
  });
  await t.test(SPENT, () => {
    assert.deepEqual(seeded.billed, [], seeded.said);
    assert.deepEqual(refusalsOf(seeded), [[METERED_GEMINI_BUDGET_EXHAUSTED, "primary", "agy_google", "gemini-3.6-flash", "view-check", "flag --gemini-api-primary 1", 0]], seeded.said);
  });
});

// ---- scripts/live-ship.mjs: the seats the seating falls through to ----------------------------------------------------
// The edge refuses anthropic and openai for quota (429, no retry-after), so the planner and the implementer walk their
// seating to the appended agy_google seat (gemini-4-carbon-high), which this script sends to the metered Gemini API.
const SHIP_EDGE = { L146_EDGE: JSON.stringify({ "api.x.ai": "ok", "api.openai.com": "429", "api.anthropic.com": "429" }), L136_GEMINI_TEXT: "TITLE: a generation token the stale holder cannot forge" };
test("live-ship: the planner and implementer seats that fall through to agy_google", { timeout: 180_000 }, async t => {
  const S = "scripts/live-ship.mjs";
  const d = name => join(ROOT, `ship-${name}`), usage = name => join(d(name), "gemini-billing.jsonl");
  seed(usage("seeded"));
  const [keyed, proxy, failover, unbudgeted, otherFile, retried, short, seeded] = await Promise.all([
    run(S, ["--dir", d("keyed")], { env: { ...KEYED, ...SHIP_EDGE }, usage: usage("keyed") }),
    run(S, ["--dir", d("proxy")], { env: { ...OTHER_KEYS, ...SHIP_EDGE }, usage: usage("proxy") }),
    run(S, ["--dir", d("failover"), "--metered-gemini-failover", "5"], { env: { ...KEYED, ...SHIP_EDGE }, usage: usage("failover") }),
    run(S, ["--dir", d("unbudgeted"), "--gemini-api-primary", "0"], { env: { ...KEYED, ...SHIP_EDGE } }),
    run(S, ["--dir", d("other-file"), "--gemini-api-primary", "3", "--gemini-usage", join(ROOT, "ship-elsewhere.jsonl")], { env: { ...KEYED, ...SHIP_EDGE } }),
    run(S, ["--dir", d("retried"), "--gemini-api-primary", "3"], { env: { ...GEMINI_KEYS, ...OTHER_KEYS, ...SHIP_EDGE, L146_GEMINI_FAIL_FIRST: "503" }, usage: usage("retried") }),
    run(S, ["--dir", d("short"), "--gemini-api-primary", "1"], { env: { ...GEMINI_KEYS, ...OTHER_KEYS, ...SHIP_EDGE }, usage: usage("short") }),
    run(S, ["--dir", d("seeded"), "--gemini-api-primary", "1"], { env: { ...GEMINI_KEYS, ...OTHER_KEYS, ...SHIP_EDGE }, usage: usage("seeded") }),
  ]);
  const offShip = (name, r) => {
    refusedOff(r, { model: "gemini-4-carbon-high", purpose: "plan" });
    assert.ok(r.others.some(e => /api\.x\.ai/.test(e.url)), "the run reached the planner (its scout answered)");
    assert.deepEqual(jsonl(join(d(name), "gemini-billing-runs.jsonl")).map(x => x.refusals.map(y => y.code)), [[GEMINI_PRIMARY_DISABLED]], "the refusal is kept in the board directory");
    assert.ok(existsSync(join(d(name), "refs")), "and so is the board");
    assert.equal(existsSync(usage(name)), false, "nothing was charged");
  };
  await t.test(OFF_KEYS, () => offShip("keyed", keyed));
  await t.test(OFF_PROXY, () => offShip("proxy", proxy));
  await t.test(FAILOVER, () => offShip("failover", failover));
  await t.test(`${STARTUP} (a zero budget; --gemini-usage beside the board's own record)`, () => {
    invalidAtStartup(unbudgeted);
    assert.equal(existsSync(d("unbudgeted")), false, "nothing was created");
    invalidAtStartup(otherFile);
  });
  // The planner's first request is answered 503: the script's one same-seat retry is a further billed request, charged
  // too; then the implementer falls through to the same seat (the run then stops: it will not relabel the maker).
  await t.test(`${DECLARED} (the planner, its retry after a 5xx, the implementer)`, () => {
    assert.equal(retried.billed.length, 3, retried.said);
    chargedBefore(retried);
    assert.deepEqual(rowsOf(usage("retried")), [["plan", 0], ["plan", 1], ["work", 2]].map(([p, n]) => ["primary", "agy_google", "gemini-4-carbon-high", p, "flag --gemini-api-primary 3", n]), retried.said);
  });
  await t.test(`${SHORT} (the implementer)`, () => {
    assert.equal(short.billed.length, 1, short.said);
    chargedBefore(short);
    assert.deepEqual(refusalsOf(short), [[METERED_GEMINI_BUDGET_EXHAUSTED, "primary", "agy_google", "gemini-4-carbon-high", "work", "flag --gemini-api-primary 1", 0]], short.said);
    assert.equal(jsonl(usage("short")).length, 1);
  });
  await t.test(`${SPENT} (on this board)`, () => {
    assert.deepEqual(seeded.billed, [], seeded.said);
    assert.deepEqual(refusalsOf(seeded), [[METERED_GEMINI_BUDGET_EXHAUSTED, "primary", "agy_google", "gemini-4-carbon-high", "plan", "flag --gemini-api-primary 1", 0]], seeded.said);
  });
});

// ---- bin/cross-lab-review.mjs ----------------------------------------------------------------------------------------
const CROSS_EDGE = { L146_EDGE: JSON.stringify({ "api.x.ai": "ok", "api.openai.com": "ok" }) };
const reviewDir = name => { const d = join(ROOT, `cross-${name}`); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "PROMPT.md"), "Review the packet.\n"); writeFileSync(join(d, "PACKET.md"), "A one-line change.\n"); return d; };
const refusedFile = (d, v = "agy_google") => (existsSync(join(d, `review-${v}.refused.json`)) ? JSON.parse(readFileSync(join(d, `review-${v}.refused.json`), "utf8")) : null);
test("cross-lab-review: one review per lab, the Google seat through the HTTPS module", { timeout: 180_000 }, async t => {
  const S = "bin/cross-lab-review.mjs", LANE = "agy_google/gemini-4-hydrogen-xhigh";
  const a = reviewDir("lane"), b = reviewDir("proxy"), c = reviewDir("failover"), e = reviewDir("invalid");
  const [lane, proxy, failover, invalid, otherFile] = await Promise.all([
    run(S, [a, "openai/gpt-6.1-sol", LANE], { env: { ...KEYED, ...CROSS_EDGE }, usage: join(a, "gemini-billing.jsonl") }),
    run(S, [b], { env: CROSS_EDGE, usage: join(b, "gemini-billing.jsonl") }),
    run(S, [c, "agy_google/gemini-4-carbon", "--metered-gemini-failover", "5"], { env: { ...KEYED, ...CROSS_EDGE }, usage: join(c, "gemini-billing.jsonl") }),
    run(S, [e, LANE, "--gemini-api-primary", "yes"], { env: { ...KEYED, ...CROSS_EDGE } }),
    run(S, [e, LANE, "--gemini-api-primary", "2", "--gemini-usage", join(ROOT, "cross-elsewhere.jsonl")], { env: { ...KEYED, ...CROSS_EDGE } }),
  ]);
  // THE LANE-NAMED SEAT (the coordinator's finding): the module sends every agy_google seat to the metered API, so a
  // lane name is billed like an API id; it is refused here, and the other lab's review is unaffected.
  await t.test(`${OFF_KEYS} (a lane-named seat; the other lab unaffected; a refusal, never a review)`, () => {
    refusedOff(lane, { model: "gemini-4-hydrogen-xhigh", purpose: "cross-lab review" });
    assert.deepEqual(lane.others.map(x => x.url), ["https://api.openai.com/v1/responses"], "the other lab's review ran");
    assert.ok(existsSync(join(a, "review-openai.md")));
    assert.equal(existsSync(join(a, "review-agy_google.md")), false, "a refusal is never written as a review");
    const rf = refusedFile(a);
    assert.deepEqual([rf?.code, rf?.provider_requests, rf?.requested, rf?.billing?.setting], [GEMINI_PRIMARY_DISABLED, 0, "gemini-4-hydrogen-xhigh", "gemini_api_primary"], lane.said);
  });
  // No key in the environment: the module would send the proxy placeholder, which a proxy-held credential pays for.
  await t.test(`${OFF_PROXY} (the default seats)`, () => {
    refusedOff(proxy, { model: "gemini-4-carbon", purpose: "cross-lab review" });
    assert.deepEqual(["openai", "xai"].map(v => existsSync(join(b, `review-${v}.md`))), [true, true], "the other labs' reviews ran");
    assert.equal(refusedFile(b)?.code, GEMINI_PRIMARY_DISABLED);
  });
  await t.test(FAILOVER, () => {
    refusedOff(failover, { model: "gemini-4-carbon", purpose: "cross-lab review" });
    assert.equal(refusedFile(c)?.code, GEMINI_PRIMARY_DISABLED);
  });
  await t.test(`${STARTUP} (an unbudgeted flag; --gemini-usage beside the directory's own record)`, () => {
    for (const r of [invalid, otherFile]) invalidAtStartup(r);
    assert.deepEqual(["review-agy_google.md", "review-agy_google.refused.json", "gemini-billing.jsonl", "gemini-billing-runs.jsonl"].map(f => existsSync(join(e, f))), [false, false, false, false], "nothing was written");
  });
  // RECOVERY: only the refused seat, with the policy declared, on the same directory.
  const usage = join(a, "gemini-billing.jsonl");
  const again = await run(S, [a, LANE, "--gemini-api-primary", "2"], { env: { ...GEMINI_KEYS, ...CROSS_EDGE }, usage });
  await t.test(`${DECLARED} (the recovery run of the refused seat completes it)`, () => {
    assert.equal(again.status, 0, again.said);
    assert.equal(again.billed.length, 1, again.said);
    chargedBefore(again);
    assert.match(again.billed[0].url, /generativelanguage\.googleapis\.com\/v1beta\/openai\/chat\/completions/);
    assert.deepEqual(rowsOf(usage), [["primary", "agy_google", "gemini-4-hydrogen-xhigh", "cross-lab review", "flag --gemini-api-primary 2", 0]], again.said);
    assert.match(readFileSync(join(a, "review-agy_google.md"), "utf8"), /requested=gemini-4-hydrogen-xhigh/);
    assert.equal(refusedFile(a), null, "the seat is reviewed now");
  });
  // The directory's budget is the record: a re-run declaring a budget of one finds it spent and sends nothing.
  const spent = await run(S, [a, LANE, "--gemini-api-primary", "1"], { env: { ...GEMINI_KEYS, ...CROSS_EDGE }, usage });
  await t.test(`${SPENT} (by the recovery run, in this directory)`, () => {
    assert.notEqual(spent.status, 0, spent.said);
    assert.deepEqual(spent.billed, [], spent.said);
    assert.equal(refusedFile(a)?.code, METERED_GEMINI_BUDGET_EXHAUSTED);
    assert.equal(jsonl(usage).length, 1);
    assert.deepEqual(jsonl(join(a, "gemini-billing-runs.jsonl")).map(x => [x.refusals.map(y => y.code), x.rows.length]),
      [[[GEMINI_PRIMARY_DISABLED], 0], [[], 1], [[METERED_GEMINI_BUDGET_EXHAUSTED], 0]], "every invocation's record is kept");
  });
});

// ---- pantheon-review-cycle --turn bin/cycle-review-http-turn.mjs (the same module, the shared wrapper) -----------------
test("pantheon-review-cycle --turn cycle-review-http-turn.mjs: its default Google seat is lane-named (gemini-3.8-flash-high)", { timeout: 180_000 }, async t => {
  const repo = join(ROOT, "cycle-repo"), ledger = join(ROOT, "cycle-ledger"), usage = join(ledger, "gemini-billing.jsonl");
  mkdirSync(repo, { recursive: true });
  const git = (...g) => execFileSync("git", ["-C", repo, ...g], { encoding: "utf8" });
  git("init", "-q", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "f@example.invalid");
  writeFileSync(join(repo, "a.mjs"), "export const a = 1;\n"); git("add", "-A"); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").trim();
  writeFileSync(join(repo, "a.mjs"), "export const a = 2;\n"); git("commit", "-qam", "change");
  const cycle = (verb, flags = []) => run("bin/pantheon-review-cycle.mjs", [verb, ...(verb === "review" ? ["--base", base] : []), "--repo", repo, "--ledger", ledger,
    "--turn", P("bin/cycle-review-http-turn.mjs"), ...flags], { env: { ...GEMINI_KEYS, ...OTHER_KEYS, ...CROSS_EDGE }, usage });
  const google = r => { let j = null; try { j = JSON.parse(r.stdout); } catch { j = null; }
    return { reviewed: (j?.reviews ?? []).some(x => x.lab === "google"), why: (j?.attempts ?? []).filter(x => x.vendor === "agy_google").map(x => `${x.model}: ${x.why ?? ""}`).join(" | ") }; };
  const off = await cycle("review");
  await t.test(`${OFF_KEYS} (the cycle stays open)`, () => {
    assert.deepEqual(off.billed, [], `the lane-named Google seat must not reach the metered API\n${off.said}`);
    assert.equal(google(off).reviewed, false, off.said);
    assert.match(google(off).why, /gemini-3\.8-flash-high: .*GEMINI_PRIMARY_DISABLED/, off.said);
    assert.equal(existsSync(usage), false);
  });
  const on = await cycle("resume", ["--gemini-api-primary", "1"]);
  await t.test(`${DECLARED} (the resume)`, () => {
    assert.equal(google(on).reviewed, true, on.said);
    assert.equal(on.billed.length, 1, on.said);
    chargedBefore(on);
    assert.deepEqual(rowsOf(usage), [["primary", "agy_google", "gemini-3.8-flash-high", "injected turn module", "flag --gemini-api-primary 1", 0]], on.said);
  });
});
