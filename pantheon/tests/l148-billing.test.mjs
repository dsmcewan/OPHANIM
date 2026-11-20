// REGISTER L-148: THE VIEW SERVER AND ITS LAUNCHERS UNDER THE ONE L-136/L-146 GEMINI BILLING CONTRACT (owner decisions
// 2026-11-20, "Owner decisions, 2026-11-20 (L-148)"; docs/billing-policy.md, "The view server"). bin/pantheon-view.mjs is
// SPAWNED as the operator runs it (real argv, an ephemeral loopback port) with the provider edge preloaded
// (fixtures/l148-fetch-preload.mjs over the L-146 and L-136 recorders): every provider request is recorded with the
// number of usage rows persisted when it was sent, so "charged, then sent" is read at the edge, and none leaves the
// machine. It is driven over HTTP, as the view page and scripts/swarm-run.mjs and discuss-run.mjs drive it; those two are
// spawned against it. Credentials are synthetic; the environment also carries look-alikes of an authorization and of an
// authenticated Google session (ADC, Vertex): none of them may admit a billed request.
//
//   view off            default off at the server: keys present, no key (the proxy path), only the failover flag; the
//                       other lab's seat in the same server still answers; startup refusals
//   view declared       --gemini-api-primary N: each request charged before it is sent; the budget spent
//   view one process    concurrent turns on distinct Gemini seats competing for the remaining budget
//   view two processes  two servers on one seat home racing for the last request of one record
//   view stale lock     a dead (or pid-reused) holder of the record's lock does not block a restart
//   view restart        the budget is cumulative over the record: 6 charged, restart with 10 admits exactly 4 more;
//                       no flag is off whatever the record and the history show; the same declaration resets nothing
//   view client fields  a billing field or header in POST /turn is not authorization
//   launchers           swarm-run and discuss-run: a billing flag is refused at startup; the server refuses their Gemini
//                       seat with its recovery condition while the other seats run, or charges it when declared
//
// This file imports nothing the change added, so it runs unchanged against the base commit (the base evidence of L-148).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const GEMINI_PRIMARY_DISABLED = "GEMINI_PRIMARY_DISABLED", METERED_GEMINI_BUDGET_EXHAUSTED = "METERED_GEMINI_BUDGET_EXHAUSTED", GEMINI_BILLING_INVALID = "GEMINI_BILLING_INVALID";
const OFF = "default: absent, off";
const HERE = dirname(fileURLToPath(import.meta.url));
const P = (...p) => resolve(HERE, "..", ...p);
const PRELOAD = pathToFileURL(join(HERE, "fixtures", "l148-fetch-preload.mjs")).href;
const ROOT = mkdtempSync(join(tmpdir(), "l148-billing-"));
const live = new Set();
test.after(() => { for (const c of live) { try { c.kill("SIGKILL"); } catch { /* gone */ } } rmSync(ROOT, { recursive: true, force: true }); });

// Synthetic credentials (owner item 8: environment keys, an authenticated Google session, names that look like a grant).
const ADC_FILE = join(ROOT, "adc.json");
writeFileSync(ADC_FILE, JSON.stringify({ type: "authorized_user", client_id: "l148-synthetic", client_secret: "l148-synthetic", refresh_token: "l148-synthetic" }));
const GEMINI_KEYS = { GEMINI_API_KEY: "AIza-l148-synthetic-not-a-key-0000000000", GOOGLE_API_KEY: "AIza-l148-synthetic-not-a-key-1111111111" };
const SESSION = { GOOGLE_APPLICATION_CREDENTIALS: ADC_FILE, GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_CLOUD_PROJECT: "l148-synthetic", GOOGLE_CLOUD_LOCATION: "us-central1",
  METERED_GEMINI_FAILOVER: "true", GEMINI_API_PRIMARY: "100" };
const OTHER_KEYS = { OPENAI_API_KEY: "sk-l148-synthetic", XAI_API_KEY: "xai-l148-synthetic", ANTHROPIC_API_KEY: "sk-ant-l148-synthetic", PANTHEON_CREDENTIAL_PREFER: "key" };
const KEYED = { ...GEMINI_KEYS, ...SESSION, ...OTHER_KEYS };
const EDGE = { L146_EDGE: JSON.stringify({ "api.x.ai": "ok", "api.openai.com": "ok", "api.anthropic.com": "ok" }), L136_GEMINI_TEXT: "POSITION: one word.\nBECAUSE: the fixture says so." };

const jsonl = f => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);
const google = e => /googleapis\.com/.test(e.url);
const billedOf = edge => edge.filter(e => google(e) && !e.google_count);
const usageOf = home => join(home, "view", "gemini-billing.jsonl");
const historyOf = home => join(home, "view", "gemini-billing-runs.jsonl");
const rowsOf = home => jsonl(usageOf(home)).map(u => [u.kind, u.vendor, u.model, u.purpose, u.source, u.used_before]);
const seed = (home, n) => { mkdirSync(join(home, "view"), { recursive: true }); for (let i = 0; i < n; i++) appendFileSync(usageOf(home), JSON.stringify({ schema: "ophanim.gemini-billing/v1",
  kind: "primary", setting: "gemini_api_primary", vendor: "agy_google", model: "gemini-3.6-flash", purpose: "an earlier server", source: "test seed", budget: n, used_before: i,
  at: new Date().toISOString() }) + "\n"); };
let homes = 0;
const newHome = name => { const h = join(ROOT, `home-${++homes}-${name}`); mkdirSync(h, { recursive: true }); return h; };

/** One view server, as the operator starts it: `pantheon-view 0 ...args`, an environment built from nothing but what is named. */
async function startView(home, args = [], { env = {} } = {}) {
  const dir = mkdtempSync(join(ROOT, "proc-")), log = join(dir, "edge.jsonl");
  const child = spawn(process.execPath, [P("bin/pantheon-view.mjs"), "0", ...args], { cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, PANTHEON_HOME: home, NODE_OPTIONS: `--import ${PRELOAD}`, L136_FETCH_LOG: log, L136_USAGE_FILE: usageOf(home), ...EDGE, ...env } });
  live.add(child);
  let stdout = "", stderr = "";
  child.stderr.on("data", d => { stderr += d; });
  const closed = new Promise(r => child.on("close", (status, signal) => { live.delete(child); r({ status, signal }); }));
  const port = await new Promise(done => {
    child.stdout.on("data", d => { stdout += d; const m = /pantheon view {2}http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout); if (m) done(Number(m[1])); });
    closed.then(() => done(null));
  });
  const said = () => `pantheon-view ${args.join(" ")}\n${stdout.slice(-2500)}\n${stderr.slice(-1500)}`;
  return { home, log, port, base: port ? `http://127.0.0.1:${port}` : null, edge: () => jsonl(log), billed: () => billedOf(jsonl(log)), said,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const c = await closed, line = stdout.split("\n").filter(l => l.startsWith("gemini_billing ")).at(-1);
      let record = null;
      try { record = line ? JSON.parse(line.slice("gemini_billing ".length)) : null; } catch { record = null; }
      return { ...c, stdout, stderr, record, said: said() };
    } };
}
/** POST /turn exactly as a client sends it. */
async function turn(view, body, headers = {}) {
  const r = await fetch(`${view.base}/turn`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ prompt: "Say one word.", ...body }) });
  const j = await r.json();
  return { status: r.status, ...j, by: Object.fromEntries((j.results ?? []).map(x => [x.vendor, x])) };
}
/** The bus as a browser sees it: GET /events from the start, for a moment. */
async function events(view, ms = 600) {
  const ac = new AbortController(), out = [];
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(`${view.base}/events?from=0`, { signal: ac.signal });
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const line = buf.slice(0, i).split("\n").find(l => l.startsWith("data: ")); buf = buf.slice(i + 2);
        if (line) out.push(JSON.parse(line.slice(6)));
      }
    }
  } catch { /* the moment ended */ } finally { clearTimeout(timer); }
  return out;
}
/** Each billed request at the edge was sent with exactly the rows before it plus its own persisted: charged, then sent. */
const chargedBefore = (view, seeded = 0) => assert.deepEqual(view.billed().map(e => e.usage_rows), view.billed().map((_, i) => seeded + i + 1),
  `each billed request must be sent only after its own usage row was persisted\n${view.said()}`);
const recoveryFor = home => new RegExp(`restart pantheon-view with --gemini-api-primary N: N is the cumulative budget of billed Gemini requests, counted against the usage already recorded at ${usageOf(home).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
const spentFor = (home, used, budget) => new RegExp(`budget of ${budget} is spent \\(${used} of ${budget} recorded at ${usageOf(home).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\); restart pantheon-view with a larger --gemini-api-primary N`);
const history = home => jsonl(historyOf(home));

// The cells of each group are SUBTESTS with the same names, so a run (the base run included) reports every cell on its own.
const OFF_KEYS = "off: keys and a Google session present", OFF_PROXY = "off: no key, the proxy path", FAILOVER = "failover-only: still refused";

// ---- default off at the provider-call boundary (owner items 1, 3, 4, 5, 8, 9, 10) ---------------------------------------
test("view off: a Gemini seat refused at the server, with its code and recovery condition; the other lab's seat answers", { timeout: 180_000 }, async t => {
  const [hk, hp, hf] = [newHome("off-keyed"), newHome("off-proxy"), newHome("off-failover")];
  const [keyed, proxy, failover] = await Promise.all([
    startView(hk, [], { env: KEYED }),
    startView(hp, [], { env: OTHER_KEYS }),
    startView(hf, ["--metered-gemini-failover", "5"], { env: KEYED }),
  ]);
  const both = v => (v.base ? turn(v, { seats: ["agy_google", "xai"] }) : { by: {} });
  const [rk, rp, rf] = await Promise.all([both(keyed), both(proxy), both(failover)]);
  const [ek, ep, ef] = await Promise.all([keyed, proxy, failover].map(v => (v.base ? events(v) : [])));
  const running = [hk, hp, hf].map(history);
  const [sk, sp, sf] = await Promise.all([keyed.stop(), proxy.stop(), failover.stop()]);
  const refusedOff = (view, r, ev, journal, stopped, { home, source = OFF }) => {
    const g = r.by.agy_google;
    assert.deepEqual(view.edge().filter(google), [], `no Google request of any kind may reach the edge\n${view.said()}`);
    assert.deepEqual([g?.ok, g?.code], [false, GEMINI_PRIMARY_DISABLED], view.said());
    assert.match(g.recovery ?? "", recoveryFor(home), "the /turn result carries the recovery condition");
    assert.doesNotMatch(g.why ?? "", /needs GEMINI_API_KEY/, "the policy refused it, not a missing credential");
    // NON-GEMINI FUNCTIONALITY (owner item 9): the other lab's seat in the same request answered.
    assert.equal(r.by.xai?.ok, true, `the xai seat still answers\n${view.said()}`);
    assert.ok(view.edge().some(e => /api\.x\.ai/.test(e.url)), "the xai request reached its edge");
    // The pane: the bus error event names the code and the recovery condition.
    const err = ev.find(e => e.type === "error" && e.seat === "agy_google");
    assert.deepEqual([err?.code, recoveryFor(home).test(err?.recovery ?? "")], [GEMINI_PRIMARY_DISABLED, true], JSON.stringify(ev.filter(e => e.type === "error")));
    // The server's billing record (owner item 10): its start with the policy and its source, the refusal journaled when it
    // was made (with model, purpose, authorization basis and recovery), and the exit record; nothing charged.
    assert.deepEqual(journal.map(x => x.event), ["start", "refusal"], JSON.stringify(journal));
    assert.deepEqual([journal[0].policy?.gemini_api_primary?.enabled, journal[0].policy?.gemini_api_primary?.source, journal[0].where], [false, OFF, usageOf(home)]);
    const j = journal[1];
    assert.deepEqual([j.code, j.kind, j.vendor, j.model, j.purpose, j.source, j.provider_requests], [GEMINI_PRIMARY_DISABLED, "primary", "agy_google", "gemini-3.6-flash", "pantheon-view view", source, 0]);
    assert.match(j.recovery ?? "", recoveryFor(home));
    assert.deepEqual(stopped.record?.refusals?.map(x => x.code), [GEMINI_PRIMARY_DISABLED], stopped.said);
    assert.deepEqual(history(home).map(x => x.event), ["start", "refusal", "exit"], "the exit record is kept too");
    assert.equal(existsSync(usageOf(home)), false, "nothing was charged");
  };
  await t.test(OFF_KEYS, () => refusedOff(keyed, rk, ek, running[0], sk, { home: hk }));
  await t.test(OFF_PROXY, () => refusedOff(proxy, rp, ep, running[1], sp, { home: hp }));
  await t.test(FAILOVER, () => {
    refusedOff(failover, rf, ef, running[2], sf, { home: hf });
    assert.match(rf.by.agy_google.recovery, /^--metered-gemini-failover authorizes no primary request here; /);
    assert.deepEqual(running[2][0].policy.metered_gemini_failover, { enabled: true, budget: 5, source: "flag --metered-gemini-failover 5" }, "the failover switch was on, and it authorized nothing");
  });
  // A malformed or unbudgeted flag, or --gemini-usage beside the server's own record: refused at startup, nothing served.
  const startup = await Promise.all([["--gemini-api-primary", "0"], ["--gemini-api-primary", "yes"], ["--gemini-api-primary", "2", "--gemini-usage", join(ROOT, "elsewhere.jsonl")]]
    .map(async args => { const h = newHome("startup"), v = await startView(h, args, { env: KEYED }); return { h, v, s: await v.stop() }; }));
  await t.test("startup refusal: nothing is served", () => {
    for (const { h, v, s } of startup) {
      assert.equal(v.port, null, `the server must not listen\n${s.said}`);
      assert.equal(s.status, 2, s.said);
      assert.match(s.stderr, new RegExp(GEMINI_BILLING_INVALID), s.said);
      assert.deepEqual([v.edge(), existsSync(join(h, "view"))], [[], false], "nothing ran and nothing was written");
    }
  });
});

// ---- declared: charged before sent, and the budget spent (owner items 3, 5, 10) ---------------------------------------
test("view declared: --gemini-api-primary N charges each request before it is sent and refuses the next once N are spent", { timeout: 180_000 }, async t => {
  const [hb, hc] = [newHome("declared"), newHome("short")];
  const [b, c] = await Promise.all([startView(hb, ["--gemini-api-primary", "3"], { env: { ...GEMINI_KEYS, ...OTHER_KEYS } }),
    startView(hc, ["--gemini-api-primary=1"], { env: { ...GEMINI_KEYS, ...OTHER_KEYS } })]);
  const rb = [];
  for (const label of ["gem", "gem"]) rb.push(b.base ? await turn(b, { vendor: "agy_google", label }) : { by: {} });
  const rbx = b.base ? await turn(b, { vendor: "xai" }) : { by: {} };
  const rc = [];
  for (let i = 0; i < 2; i++) rc.push(c.base ? await turn(c, { vendor: "agy_google" }) : { by: {} });
  const journal = history(hc);
  const [sb, sc] = await Promise.all([b.stop(), c.stop()]);
  await t.test("primary declared: every request charged before it is sent, and recorded with model, purpose and source", () => {
    assert.deepEqual(rb.map(r => r.by.agy_google?.ok), [true, true], b.said());
    assert.equal(rbx.by.xai?.ok, true);
    assert.equal(b.billed().length, 2, b.said());
    chargedBefore(b);
    const src = "flag --gemini-api-primary 3";
    assert.deepEqual(rowsOf(hb), [0, 1].map(n => ["primary", "agy_google", "gemini-3.6-flash", "pantheon-view view", src, n]), b.said());
    assert.deepEqual(jsonl(usageOf(hb)).map(u => [u.role, u.budget, u.remaining_after]), [["gem", 3, 2], ["gem", 3, 1]]);
    assert.deepEqual([sb.record?.used, sb.record?.refusals, sb.record?.rows?.length], [{ failover: 0, primary: 2 }, [], 2], sb.said);
  });
  await t.test("budget spent: the next request is refused before it is sent, with the recovery condition", () => {
    assert.deepEqual(rc.map(r => [r.by.agy_google?.ok, r.by.agy_google?.code ?? null]), [[true, null], [false, METERED_GEMINI_BUDGET_EXHAUSTED]], c.said());
    assert.match(rc[1].by.agy_google.recovery ?? "", spentFor(hc, 1, 1));
    assert.equal(c.billed().length, 1, c.said());
    chargedBefore(c);
    assert.equal(jsonl(usageOf(hc)).length, 1, "the record of what was spent is kept");
    const refused = journal.filter(x => x.event === "refusal");
    assert.deepEqual(refused.map(x => [x.code, x.budget, x.used, x.source, x.provider_requests]), [[METERED_GEMINI_BUDGET_EXHAUSTED, 1, 1, "flag --gemini-api-primary 1", 0]], JSON.stringify(journal));
    assert.match(refused[0].recovery, spentFor(hc, 1, 1));
    assert.deepEqual(sc.record?.refusals?.map(x => x.code), [METERED_GEMINI_BUDGET_EXHAUSTED], sc.said);
  });
});

// ---- concurrency, one process (owner item 6; design D4(a)) ------------------------------------------------------------
test("view one process: concurrent turns on distinct Gemini seats share one budget; exactly the remaining k are sent", { timeout: 180_000 }, async t => {
  const h = newHome("concurrent");
  seed(h, 2);                                         // 2 of a budget of 4 already spent: k = 2 remain for N = 6 turns
  const v = await startView(h, ["--gemini-api-primary", "4"], { env: { ...GEMINI_KEYS, ...OTHER_KEYS } });
  const N = 6;
  const rs = v.base ? await Promise.all(Array.from({ length: N }, (_, i) => turn(v, { vendor: "agy_google", purpose: `race-${i}` }))) : [];
  const s = await v.stop();
  await t.test("k remaining requests admit exactly k; the rest are refused before they are sent", () => {
    const by = rs.map(r => r.by.agy_google);
    assert.deepEqual([by.filter(x => x?.ok).length, by.filter(x => x?.code === METERED_GEMINI_BUDGET_EXHAUSTED).length], [2, N - 2], `${JSON.stringify(by.map(x => [x?.ok, x?.code]))}\n${v.said()}`);
    assert.ok(by.filter(x => !x?.ok).every(x => spentFor(h, 4, 4).test(x.recovery ?? "")), "each refusal carries its recovery condition");
    assert.equal(v.billed().length, 2, `only the admitted requests reach the edge\n${v.said()}`);
    const rows = jsonl(usageOf(h));
    assert.deepEqual(rows.map(r => r.used_before), [0, 1, 2, 3], "two more rows, each counted on the shared record");
    // Charged before sent: the k-th billed request left with at least the seeded rows plus k persisted.
    assert.ok(v.billed().map(e => e.usage_rows).sort((a, b) => a - b).every((n, i) => n >= 2 + i + 1), JSON.stringify(v.billed()));
    assert.deepEqual(s.record?.used, { failover: 0, primary: 4 }, s.said);
  });
});

// ---- concurrency, two processes sharing one record (owner item 6; design D4(b)) ---------------------------------------
test("view two processes: two servers on one seat home race for the last request; exactly one is sent", { timeout: 180_000 }, async t => {
  const h = newHome("two-servers");
  seed(h, 2);                                         // 2 of a budget of 3 spent: one request remains for the two servers
  const [a, b] = await Promise.all([0, 1].map(() => startView(h, ["--gemini-api-primary", "3"], { env: { ...GEMINI_KEYS, ...OTHER_KEYS } })));
  // The test holds the record's lock as a live process would, so both servers are admitted (2 < 3) and reach the
  // record's count-and-append before either can append; then it lets go, and they race for the lock.
  const lock = `${usageOf(h)}.lock`;
  writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: "l148-test-holder", at: Date.now() }), { flag: "wx" });
  let settled = 0;
  const turns = [a, b].map((v, i) => (v.base ? turn(v, { vendor: "agy_google", purpose: `last-${i}` }) : Promise.resolve({ by: {} })).finally(() => { settled++; }));
  const intents = () => (existsSync(join(h, "intents")) ? readdirSync(join(h, "intents")).length : 0);
  const blocked = async v => { try { await fetch(`${v.base}/seats`, { signal: AbortSignal.timeout(1000) }); return false; } catch { return true; } };
  let raced = false;
  for (const deadline = Date.now() + 25_000; settled < 2 && Date.now() < deadline;) {
    if (intents() === 2 && (await Promise.all([a, b].map(blocked))).every(Boolean)) { raced = true; break; }
    await new Promise(r => setTimeout(r, 100));
  }
  rmSync(lock, { force: true });
  const rs = await Promise.all(turns);
  await Promise.all([a.stop(), b.stop()]);
  await t.test("both were admitted and waiting at the record's lock; after it, exactly one was sent", () => {
    assert.equal(raced, true, `both servers must be waiting at the shared record when the lock is released\n${a.said()}\n${b.said()}`);
    const by = rs.map(r => r.by.agy_google);
    assert.deepEqual(by.map(x => x?.ok).sort(), [false, true], JSON.stringify(by));
    const lost = by.find(x => !x?.ok);
    assert.equal(lost.code, METERED_GEMINI_BUDGET_EXHAUSTED, JSON.stringify(lost));
    assert.match(lost.why, /counted under its lock just before the append/, "refused by the count re-derived under the lock");
    assert.match(lost.recovery ?? "", spentFor(h, 3, 3));
    assert.equal(a.billed().length + b.billed().length, 1, `exactly one request may reach the edge\n${a.said()}\n${b.said()}`);
    assert.deepEqual(jsonl(usageOf(h)).map(r => r.used_before), [0, 1, 2], "one row was appended, counted after the other server's turn");
    assert.equal(existsSync(lock), false, "the lock is released");
  });
});

// ---- a stale lock (design D4(b): a crashed holder cannot block a restart) ---------------------------------------------
test("view stale lock: a record lock left by a dead holder, or by a pid now reused, is reclaimed and the turn is charged", { timeout: 180_000 }, async t => {
  const dead = await new Promise(r => { const c = spawn(process.execPath, ["-e", ""]); c.on("exit", () => r(c.pid)); });
  const cells = [["dead holder", { pid: dead, nonce: "l148-dead", at: Date.now() - 1000 }],
    ["pid reused by a live process (another start time)", { pid: process.pid, start: 1, nonce: "l148-reused", at: Date.now() - 1000 }]];
  const runs = await Promise.all(cells.map(async ([, holder]) => {
    const h = newHome("stale");
    mkdirSync(join(h, "view"), { recursive: true });
    writeFileSync(`${usageOf(h)}.lock`, JSON.stringify(holder));
    const v = await startView(h, ["--gemini-api-primary", "1"], { env: { ...GEMINI_KEYS, ...OTHER_KEYS } });
    const r = v.base ? await turn(v, { vendor: "agy_google" }) : { by: {} };
    await v.stop();
    return { h, v, r };
  }));
  for (const [i, [name]] of cells.entries()) {
    await t.test(name, () => {
      const { h, v, r } = runs[i];
      assert.equal(r.by.agy_google?.ok, true, `${JSON.stringify(r.by.agy_google)}\n${v.said()}`);
      assert.equal(v.billed().length, 1);
      chargedBefore(v);
      assert.equal(existsSync(`${usageOf(h)}.lock`), false, "the stale lock is gone and the new holder released its own");
    });
  }
});

// ---- restart: usage and authorization across restarts (owner item 7; design D3; the owner's exact case) ----------------
test("view restart: the budget is cumulative over the record; each start declares its own policy", { timeout: 180_000 }, async t => {
  const h = newHome("restart"), env = { ...GEMINI_KEYS, ...OTHER_KEYS };
  const serve = async (args, turns) => {
    const v = await startView(h, args, { env });
    const rs = [];
    for (let i = 0; i < turns; i++) rs.push(v.base ? (await turn(v, { vendor: "agy_google" })).by.agy_google : null);
    return { v, rs, s: await v.stop() };
  };
  const first = await serve(["--gemini-api-primary", "6"], 6);
  const raised = await serve(["--gemini-api-primary", "10"], 5);
  const off = await serve([], 1);
  const same = await serve(["--gemini-api-primary", "10"], 1);
  await t.test("6 charged under a budget of 6", () => {
    assert.deepEqual(first.rs.map(x => x?.ok), Array(6).fill(true), first.v.said());
    chargedBefore(first.v);
  });
  await t.test("restart with --gemini-api-primary 10: exactly 4 more are admitted, the 5th refused before it is sent", () => {
    assert.deepEqual(raised.rs.map(x => [x?.ok, x?.code ?? null]), [...Array(4).fill([true, null]), [false, METERED_GEMINI_BUDGET_EXHAUSTED]], raised.v.said());
    assert.match(raised.rs[4].recovery ?? "", spentFor(h, 10, 10));
    assert.equal(raised.v.billed().length, 4, raised.v.said());
    chargedBefore(raised.v, 6);
    assert.deepEqual(jsonl(usageOf(h)).map(r => [r.source, r.used_before]), [...[0, 1, 2, 3, 4, 5].map(n => ["flag --gemini-api-primary 6", n]),
      ...[6, 7, 8, 9].map(n => ["flag --gemini-api-primary 10", n])], "historical usage is never erased: the restart counted it");
  });
  await t.test("restart with no flag: off, though the record and the history show earlier authorization", () => {
    assert.ok(history(h).some(x => x.event === "start" && x.policy?.gemini_api_primary?.enabled), "the history shows an earlier authorization");
    assert.deepEqual([off.rs[0]?.ok, off.rs[0]?.code], [false, GEMINI_PRIMARY_DISABLED], off.v.said());
    assert.match(off.rs[0].recovery ?? "", recoveryFor(h));
    assert.deepEqual(off.v.edge().filter(google), [], "no Google request of any kind");
  });
  await t.test("restart with the same declaration: nothing is reset", () => {
    assert.deepEqual([same.rs[0]?.ok, same.rs[0]?.code], [false, METERED_GEMINI_BUDGET_EXHAUSTED], same.v.said());
    assert.deepEqual(same.v.edge().filter(google), []);
    assert.equal(jsonl(usageOf(h)).length, 10);
  });
  await t.test("the authorization history: every start's policy and source, every refusal, every exit", () => {
    const starts = history(h).filter(x => x.event === "start").map(x => [x.policy.gemini_api_primary.enabled, x.policy.gemini_api_primary.budget, x.policy.gemini_api_primary.source, x.used.primary]);
    assert.deepEqual(starts, [[true, 6, "flag --gemini-api-primary 6", 0], [true, 10, "flag --gemini-api-primary 10", 6], [false, null, OFF, 10], [true, 10, "flag --gemini-api-primary 10", 10]]);
    assert.deepEqual(history(h).filter(x => x.event === "refusal").map(x => x.code), [METERED_GEMINI_BUDGET_EXHAUSTED, GEMINI_PRIMARY_DISABLED, METERED_GEMINI_BUDGET_EXHAUSTED]);
    assert.deepEqual(history(h).filter(x => x.event === "exit").map(x => [x.rows.length, x.used.primary]), [[6, 6], [4, 10], [0, 10], [0, 10]]);
  });
});

// ---- a client-supplied billing field is not authorization (owner item 8; design D6) -----------------------------------
test("view client fields: a billing field or header in POST /turn neither enables nor widens billing", { timeout: 180_000 }, async t => {
  const [hoff, hon] = [newHome("client-off"), newHome("client-on")];
  const [off, on] = await Promise.all([startView(hoff, [], { env: KEYED }), startView(hon, ["--gemini-api-primary", "1"], { env: { ...GEMINI_KEYS, ...OTHER_KEYS } })]);
  const forged = { vendor: "agy_google", gemini_api_primary: { enabled: true, budget: 100 }, metered_gemini_failover: { enabled: true, budget: 100 }, budget: 100,
    "--gemini-api-primary": "100", billing: { gemini_api_primary: { enabled: true, budget: 100 } } };
  const headers = { "x-gemini-api-primary": "100", authorization: "Bearer l148-synthetic-session" };
  const roff = off.base ? await turn(off, forged, headers) : { by: {} };
  const ron = [];
  for (let i = 0; i < 2; i++) ron.push(on.base ? await turn(on, forged, headers) : { by: {} });
  await Promise.all([off.stop(), on.stop()]);
  await t.test("server off: refused, nothing sent", () => {
    assert.deepEqual([roff.by.agy_google?.ok, roff.by.agy_google?.code], [false, GEMINI_PRIMARY_DISABLED], off.said());
    assert.deepEqual(off.edge().filter(google), []);
  });
  await t.test("server on (budget 1): charged under the server's declaration, then refused; never widened to the client's 100", () => {
    assert.deepEqual(ron.map(r => [r.by.agy_google?.ok, r.by.agy_google?.code ?? null]), [[true, null], [false, METERED_GEMINI_BUDGET_EXHAUSTED]], on.said());
    assert.equal(on.billed().length, 1);
    assert.deepEqual(jsonl(usageOf(hon)).map(u => [u.source, u.budget]), [["flag --gemini-api-primary 1", 1]]);
  });
});

// ---- the launchers: HTTP clients of the server, with no billing authority (owner items 1, 5, 8, 9; design D1, D5) ------
/** One launcher invocation against `view`: its own preloaded edge, so a provider request from the launcher itself would show. */
function launch(script, args, view, env = {}) {
  const dir = mkdtempSync(join(ROOT, "launch-")), log = join(dir, "edge.jsonl");
  return new Promise(done => {
    const child = spawn(process.execPath, [P(script), ...args], { cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, NODE_OPTIONS: `--import ${PRELOAD}`, L136_FETCH_LOG: log, PANTHEON_VIEW: view?.base ?? "http://127.0.0.1:9", ...env } });
    live.add(child);
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    const kill = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", status => {
      clearTimeout(kill); live.delete(child);
      const refused = stdout.split("\n").filter(l => l.startsWith("gemini_refused ")).map(l => JSON.parse(l.slice("gemini_refused ".length)));
      done({ status, stdout, stderr, refused, edge: jsonl(log), said: `${script} ${args.join(" ")}: exit ${status}\n${stdout.slice(-2500)}\n${stderr.slice(-1500)}` });
    });
  });
}
test("launchers: swarm-run and discuss-run hold no billing authority; the server refuses or charges their Gemini seat", { timeout: 240_000 }, async t => {
  const [hoff, hswarm, hdiscuss] = [newHome("launch-off"), newHome("launch-swarm"), newHome("launch-discuss")];
  const [off, onSwarm, onDiscuss] = await Promise.all([startView(hoff, [], { env: KEYED }),
    startView(hswarm, ["--gemini-api-primary", "2"], { env: { ...GEMINI_KEYS, ...OTHER_KEYS } }),
    startView(hdiscuss, ["--gemini-api-primary", "1"], { env: { ...GEMINI_KEYS, ...OTHER_KEYS } })]);
  const [swarmOff, discussOff, swarmOn, discussOn, ...flagged] = await Promise.all([
    launch("scripts/swarm-run.mjs", ["Pick one word."], off),
    launch("scripts/discuss-run.mjs", ["Pick one word."], off, { ROUNDS: "1" }),
    launch("scripts/swarm-run.mjs", ["Pick one word."], onSwarm),
    launch("scripts/discuss-run.mjs", ["Pick one word."], onDiscuss, { ROUNDS: "1" }),
    launch("scripts/swarm-run.mjs", ["Pick one word.", "--gemini-api-primary", "5"], off),
    launch("scripts/discuss-run.mjs", ["--gemini-usage=elsewhere.jsonl", "Pick one word."], off),
    launch("scripts/discuss-run.mjs", ["Pick one word.", "--metered-gemini-failover", "1"], off, { ROUNDS: "1" }),
  ]);
  await Promise.all([off.stop(), onSwarm.stop(), onDiscuss.stop()]);
  const ran = host => off.edge().some(e => host.test(e.url));
  await t.test("a billing flag given to a launcher is refused at startup: authorization belongs to the view server", () => {
    for (const r of flagged) {
      assert.equal(r.status, 2, r.said);
      assert.match(r.stderr, new RegExp(`${GEMINI_BILLING_INVALID}: --(gemini-api-primary|gemini-usage|metered-gemini-failover) is not taken here`), r.said);
      assert.match(r.stderr, /Gemini billing is authorized only by that server \(start pantheon-view with --gemini-api-primary N\)/);
      assert.equal(r.stdout, "", "nothing ran");
    }
  });
  await t.test("server off: the Gemini seat is refused with its recovery condition and recorded; the other seats run", () => {
    assert.deepEqual(off.edge().filter(google), [], `no Google request of any kind\n${off.said()}`);
    for (const [r, where] of [[swarmOff, "layer"], [discussOff, "round"]]) {
      assert.equal(r.status, 0, r.said);
      assert.ok(r.refused.length >= 1 && r.refused.every(x => x.seat === "agy_google" && x.code === GEMINI_PRIMARY_DISABLED && recoveryFor(hoff).test(x.recovery) && x[where] !== undefined), r.said);
      assert.deepEqual(r.edge, [], "the launcher itself sent no provider request");
    }
    assert.match(swarmOff.stdout, /layer explore .* 3\/4 ok/, swarmOff.said);
    assert.match(swarmOff.stdout, /FAILED agy_google: GEMINI_PRIMARY_DISABLED: refused by the view server's Gemini billing policy; recovery: restart pantheon-view/);
    const failed = JSON.parse(/failed turns: (.*)/.exec(discussOff.stdout)?.[1] ?? "[]");
    assert.deepEqual(failed.map(f => [f.seat, /^GEMINI_PRIMARY_DISABLED: .*recovery: restart pantheon-view with --gemini-api-primary N/.test(f.error)]), [["agy_google", true]], discussOff.said);
    assert.equal(discussOff.stdout.split("\n").filter(l => / FAILED /.test(l) || /^\s+agy_google\s+FAILED/.test(l)).length, 1, discussOff.said);
    for (const host of [/api\.openai\.com\/v1\/responses$/, /api\.x\.ai\/v1\/responses$/, /api\.anthropic\.com\/v1\/messages$/]) assert.ok(ran(host), `${host} ran\n${off.said()}`);
  });
  await t.test("server declared: the launchers' Gemini requests are charged before they are sent", () => {
    for (const [r, v, h, rows] of [[swarmOn, onSwarm, hswarm, [["pantheon-view swarm-explore", 0], ["pantheon-view swarm-refute", 1]]], [discussOn, onDiscuss, hdiscuss, [["pantheon-view discuss", 0]]]]) {
      assert.equal(r.status, 0, r.said);
      assert.deepEqual(r.refused, [], r.said);
      chargedBefore(v);
      assert.deepEqual(jsonl(usageOf(h)).map(u => [u.purpose, u.used_before]), rows, v.said());
      assert.ok(jsonl(usageOf(h)).every(u => u.vendor === "agy_google" && u.model === "gemini-3.6-flash" && u.kind === "primary"));
    }
    assert.match(swarmOn.stdout, /layer explore .* 4\/4 ok/, swarmOn.said);
  });
});
