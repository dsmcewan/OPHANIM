// L-504 INVARIANT 4, L-124 AND L-136: NO METERED GEMINI SPEND UNLESS THE BILLING POLICY ADMITS IT, AT THE POINT OF SPEND, ON
// EVERY SEAT (wave 3, sub-wave 3B-1; split by L-136, owner decisions 2026-11-19). The policy (pantheon/src/route/
// gemini-billing.mjs) has two settings, both OFF by default: metered_gemini_failover (the metered Gemini API answering a
// lane's proven quota refusal) and gemini_api_primary (primary Gemini API or SDK execution: a Gemini API seat with no lane,
// an operator's or a ticket's Gemini API pin, the python Antigravity SDK seat billed to the key or to Vertex). They are
// independent: the failover switch never admits a primary seat. Every row below runs the REAL production function with a
// synthetic GEMINI_API_KEY / GOOGLE_API_KEY in the environment, so withholding the key (what ophanim/operate/live-run.mjs
// does for "not-used") is never what protects the path; the provider edge is a recorder.
//
// THE SEATS AND PATHS (enumerated from the code):
//   L   sdk/live.mjs liveTurn -> sdk/agy-turn.mjs laneFirstTurn: the planner, the plan and cycle reviewers and the validator
//       (ophanim/operate/stages.mjs, through its meter), on (a) a lane refused for quota, (b) a Gemini API id with a lane,
//       refused for quota [kind failover], (c) a Gemini model with no lane [kind primary: GEMINI_PRIMARY_DISABLED]
//   P   pipeline/turns.mjs dispatcher / reviewer / subagent: the injected single-turn `turn` (liveTurn), on a Gemini seat
//   I   pipeline/turns.mjs implementer: its lane's proven quota refusal and the metered `api` behind it [failover]
//   B   board/run-item.mjs runOpenItem: (spare) a lane's quota-failover candidate in the walk (route/quota-failover.mjs)
//       [failover]; (api) a Gemini API seat no walk filters -- an operator's seat (critique, plan, scout) or a ticket's pin
//       (work) -- through turn() -> sdkTurn [primary]; (sdk) the python Antigravity SDK seat (agyTurn, transport sdk, asked
//       for with PANTHEON_AGY_TRANSPORT=sdk: the board's reviewer and scout default to the CLI lane now) [primary]
//   O   the subscription (OAuth) lanes, which must keep working with both settings off
// Every refused row has a CONTROL with its own setting declared (with a budget) that reaches the recorder, so the recorder
// is shown to see the call; every primary row is ALSO refused with the failover switch on (the split).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as quotaFailover from "../src/route/quota-failover.mjs";
import { ADAPTERS } from "../src/sdk/adapter.mjs";
import { liveClients, liveTurn } from "../src/sdk/live.mjs";
import { pipelineTurns } from "../src/pipeline/turns.mjs";
import { runOpenItem } from "../src/board/run-item.mjs";
import { openCooldownStore } from "../../packages/model-client/index.mjs";
import { scriptedClients } from "./fixtures/dispatch.mjs";
import { tempRepo } from "./fixtures/pipeline-stages.mjs";
import { optIn } from "./fixtures/billing.mjs";
import { sandboxAvailable } from "../src/agy/sandbox.mjs";
const have = await sandboxAvailable("bwrap");
// THE SDK SEAT RUNS IN ITS JAIL (knowledge graphs, Slice C2): a cell that spawns it is a real-bwrap cell.
const jailed = { skip: have.ok ? false : `bwrap unavailable: ${have.why}` };

// The refusal codes, spelled out so this file also loads on a tree without the new exports.
const METERED_GEMINI_DISABLED = "METERED_GEMINI_DISABLED", GEMINI_PRIMARY_DISABLED = "GEMINI_PRIMARY_DISABLED";
const LANE = "gemini-4-carbon-high", API_ID = "gemini-4-carbon", NO_LANE = "gemini-3.6-flash", SDK_MODEL = "gemini-3.8-flash";
const OTHER = "gemini-4-argon-high";
// The policies of the rows: nothing declared; the failover only; primary execution only (each with a budget).
const OFF = () => null, FAILOVER = () => optIn({ failover: 100 }), PRIMARY = () => optIn({ primary: 100 });
const sh1 = s => `'${String(s).replace(/'/g, "'\\''")}'`;
// The /usage envelope the quota probe reads: the Gemini group spent (so a base that probes reads "exhausted").
const EXHAUSTED = JSON.stringify({ conversation_id: "", status: "SUCCESS", response: "", num_turns: 0, usage: { total_tokens: 0 }, command: { name: "usage", data: { groups: [
  { name: "Gemini Models", description: "Models within this group: Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Gemini 3.8 Flash", buckets: [{ id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0 }] }] } } });

// THE FAKE agy CLI. Its state dir is an agy state dir (PANTHEON_AGY_STATE_DIRS), the one place it may write inside the jail.
function writeFakeAgy(bin, state) {
  const cli = join(bin, "agy");
  writeFileSync(cli, `#!/bin/sh
S=${sh1(state)}
if { [ "$1" = "--print" ] || [ "$1" = "-p" ]; } && { [ "$2" = "/usage" ] || [ "$2" = "/quota" ]; }; then echo probe >> "$S/probes"; cat "$S/usage.json"; exit 0; fi
if [ "$1" = "--version" ]; then echo "fake-agy 0.0.0-wave3"; exit 0; fi
agent=none; model=none
for a in "$@"; do case "$prev" in --agent) agent="$a" ;; --model) model="$a" ;; esac; prev="$a"; done
printf '%s %s\\n' "$agent" "$model" >> "$S/launches"
served="$model"; [ -f "$S/served" ] && served=$(cat "$S/served")
mode=answer; [ -f "$S/mode" ] && mode=$(cat "$S/mode")
# mode noinit: a result with no init event (the CLI names no identity at all).
[ "$mode" = noinit ] || printf '{"event":"init","conversation_id":"fake-guard","init":{"model":"%s","agent":"%s"}}\\n' "$served" "$agent"
case "$mode" in
  failure) printf '{"event":"result","result":{"status":"ERROR","error":"internal error"}}\\n'; exit 1 ;;
  quota) printf '{"event":"result","result":{"status":"ERROR","error":"429 RESOURCE_EXHAUSTED: quota exceeded"}}\\n'; echo "HTTP 429 Too Many Requests" >&2; exit 1 ;;
  timeout) echo "Error: print timeout exceeded" >&2; exit 1 ;;
esac
case "$agent" in pantheon-planner) reply='TITLE: fixture change' ;; pantheon-implementer) reply='export const ok = true;' ;; pantheon-scout) reply='RAN: nothing' ;; *) reply='VERDICT: approve' ;; esac
printf '{"event":"result","result":{"status":"SUCCESS","conversation_id":"fake-guard","num_turns":1,"response":"%s","usage":{"input_tokens":1,"output_tokens":1}}}\\n' "$reply"
`, { mode: 0o755 });
  return cli;
}
// THE FAKE python SDK seat: it is spawned as `<python> scripts/agy-seat.py --role R ... --model M ... --out D ...`.
function writeFakePython(bin, state) {
  const py = join(bin, "python");
  writeFileSync(py, `#!/bin/sh
S=${sh1(state)}
role=none; model=none; out=/nonexistent
for a in "$@"; do case "$prev" in --role) role="$a" ;; --model) model="$a" ;; --out) out="$a" ;; esac; prev="$a"; done
printf '%s\\n' "$*" >> "$out/python.log"
served="\${FAKE_SDK_SERVED:-$model}"
mode="\${FAKE_SDK_MODE:-answer}"
if [ "$mode" = failure ]; then printf '{"ok": false, "role": "%s", "model": "%s", "error": "vendor error"}\\n' "$role" "$served"; exit 3; fi
printf 'VERDICT: approve\\n' > "$out/response.md"
printf '{"ok": true, "role": "%s", "model": "%s", "conversation_id": "fake-sdk", "tool_calls": 0, "subagent_calls": 0}\\n' "$role" "$served"
`, { mode: 0o755 });
  return py;
}

const SAVED = ["PANTHEON_AGY_CLI", "PANTHEON_AGY_PYTHON", "PANTHEON_AGY_STATE_DIRS", "PANTHEON_AGY_TRANSPORT", "PANTHEON_COOLDOWN_DIR", "HOME", "GEMINI_API_KEY", "GOOGLE_API_KEY",
  "OPHANIM_LEDGER", "PANTHEON_POOLS_FILE", "PANTHEON_AGY_VERTEX_PROJECT"];
let fx, savedEnv, savedFetch;
const fetched = [];
before(() => {
  savedEnv = Object.fromEntries(SAVED.map(k => [k, process.env[k]]));
  savedFetch = globalThis.fetch;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wave3-spend-")));
  const bin = join(root, "bin"), state = join(root, "state"), home = join(root, "home");
  for (const d of [bin, state, home]) mkdirSync(d);
  writeFileSync(join(state, "usage.json"), EXHAUSTED);
  fx = { root, bin, state, home, cli: writeFakeAgy(bin, state), python: writeFakePython(bin, state) };
  Object.assign(process.env, { PANTHEON_AGY_CLI: fx.cli, PANTHEON_AGY_PYTHON: fx.python, PANTHEON_AGY_STATE_DIRS: state, PANTHEON_COOLDOWN_DIR: join(root, "cooldowns"), HOME: home,
    // SYNTHETIC credentials, present on purpose: a path the guard does not stop would be billed, not refused for a missing key.
    GEMINI_API_KEY: "AIza-wave3-synthetic-not-a-key-0000000000", GOOGLE_API_KEY: "AIza-wave3-synthetic-not-a-key-1111111111" });
  for (const k of ["PANTHEON_AGY_TRANSPORT", "OPHANIM_LEDGER", "PANTHEON_POOLS_FILE", "PANTHEON_AGY_VERTEX_PROJECT"]) delete process.env[k];
  // THE PROVIDER EDGE: every request the real Google client would send is recorded and answered 500. None is expected.
  globalThis.fetch = async (url, init = {}) => {
    fetched.push({ url: String(url), method: init.method ?? "GET" });
    return new Response(JSON.stringify({ error: { code: 500, message: "fake provider edge: no metered request is expected" } }), { status: 500, headers: { "content-type": "application/json" } });
  };
});
after(async () => {
  globalThis.fetch = savedFetch;
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  delete process.env.FAKE_SDK_MODE; delete process.env.FAKE_SDK_SERVED;
  rmSync(fx.root, { recursive: true, force: true });
});

/** Reset the fakes' records and set how the next launch behaves: `served` (null: the model asked for) and `mode`. */
function arm(mode, served = OTHER) {
  for (const f of ["launches", "probes", "python", "served", "mode"]) rmSync(join(fx.state, f), { force: true });
  if (served !== null) writeFileSync(join(fx.state, "served"), served);
  writeFileSync(join(fx.state, "mode"), mode);
  // The python SDK seat runs in its jail (Slice C2): it reads how to behave from FAKE_SDK_* and logs into its out dir.
  if (served !== null) process.env.FAKE_SDK_SERVED = served; else delete process.env.FAKE_SDK_SERVED;
  process.env.FAKE_SDK_MODE = mode;
  armedAt = boards;
  fetched.length = 0;
}
let armedAt = 0;
/** The SDK seat's launches since arm(): each board's seat dirs' python.log. */
const sdkLaunches = () => Array.from({ length: boards - armedAt }, (_, i) => armedAt + i + 1).flatMap(b => {
  const d = join(fx.root, `board-${b}`, "outputs", "open-items", `wave3-spend-${b}`, "agy_google");
  return existsSync(d) ? readdirSync(d).flatMap(n => (existsSync(join(d, n, "python.log")) ? readFileSync(join(d, n, "python.log"), "utf8").split("\n").filter(Boolean) : [])) : [];
});
const lines = f => (f === "python" ? sdkLaunches() : existsSync(join(fx.state, f)) ? readFileSync(join(fx.state, f), "utf8").split("\n").filter(Boolean) : []);
const launches = () => lines("launches").map(l => l.split(" "));
/** A quota refusal of a lane, kept as one with the failover disabled: status 429, quota_failover {used: false, disabled: true}. */
function isDisabledQuota(e, at) {
  assert.ok(e, `${at}: refused`);
  assert.deepEqual([e.status, e.quota_failover?.used, e.quota_failover?.disabled], [429, false, true], `${at}: ${e?.code} ${e?.message}`);
}


test("the metered Gemini vendors are exactly the adapters billed to GEMINI_API_KEY (the point-of-spend guard's list cannot drift from the clients)", () => {
  assert.deepEqual([...(quotaFailover.METERED_GEMINI_VENDORS ?? [])].sort(), Object.entries(ADAPTERS).filter(([, a]) => a.key_env === "GEMINI_API_KEY").map(([v]) => v).sort());
});

test("L the single-turn seats (liveTurn): with the failover off a lane's quota refusal and an API id's lane quota refusal never reach the metered API; a Gemini model with no lane is primary execution, refused unless gemini_api_primary admits it -- the failover switch never does", async t => {
  for (const [policy, billing] of [["nothing declared", OFF], ["the failover switch on", FAILOVER]]) {
    const turn = await liveTurn({ label: "wave3-spend", billing: billing() });
    for (const role of ["planner", "plan-reviewer", "cycle-reviewer", "validator"]) {
      if (policy === "nothing declared") {
        await t.test(`${role}: a lane refused for quota (${policy})`, async () => {
          arm("quota", null);
          const e = await turn({ vendor: "agy_google", model: LANE, prompt: "p", seat: { role } }).then(() => null, err => err);
          assert.deepEqual(fetched, [], "no metered request");
          isDisabledQuota(e, role);
        });
        await t.test(`${role}: a Gemini API id served by its lane, the lane refused for quota (${policy})`, async () => {
          arm("quota", null);
          const e = await turn({ vendor: "agy_google", model: API_ID, prompt: "p", seat: { role } }).then(() => null, err => err);
          assert.deepEqual(fetched, [], "no metered request");
          assert.deepEqual(launches().map(l => l[1]), [LANE], "the lane was asked first");
          isDisabledQuota(e, role);
        });
      }
      await t.test(`${role}: a Gemini model with no Antigravity lane (${policy})`, async () => {
        arm("answer", null);
        const e = await turn({ vendor: "agy_google", model: NO_LANE, prompt: "p", seat: { role } }).then(() => null, err => err);
        assert.deepEqual(fetched, [], "no metered request");
        assert.deepEqual(launches(), [], "nothing launched either");
        assert.deepEqual([e?.code, e?.provider_requests], [GEMINI_PRIMARY_DISABLED, 0], e?.message);
      });
    }
  }
  await t.test("CONTROL (failover on): the same lane quota refusal reaches the metered API at the recorder", async () => {
    arm("quota", null);
    await (await liveTurn({ label: "wave3-spend", billing: FAILOVER() }))({ vendor: "agy_google", model: LANE, prompt: "p", seat: { role: "validator" } }).catch(() => null);
    assert.ok(fetched.length > 0, "the recorder sees the metered request when the failover is on");
  });
  await t.test("CONTROL (primary on): the Gemini model with no lane reaches the metered API at the recorder", async () => {
    arm("answer", null);
    await (await liveTurn({ label: "wave3-spend", billing: PRIMARY() }))({ vendor: "agy_google", model: NO_LANE, prompt: "p", seat: { role: "validator" } }).catch(() => null);
    assert.ok(fetched.length > 0, "the recorder sees the primary request when gemini_api_primary admits it");
  });
});

test("P the pipeline's single-turn seats (dispatcher, reviewer, subagent) on Gemini seats with nothing declared: no metered request", async t => {
  const turns = pipelineTurns({ turn: await liveTurn({ label: "wave3-spend" }) });
  for (const role of ["dispatcher", "reviewer", "subagent"]) {
    for (const [model, mode, code] of [[LANE, "quota", "quota_exhausted"], [NO_LANE, "answer", GEMINI_PRIMARY_DISABLED]]) {
      await t.test(`${role} on ${model}`, async () => {
        arm(mode, null);
        const e = await turns[role]({ vendor: "agy_google", model, prompt: "judge this" }).then(() => null, err => err);
        assert.deepEqual(fetched, [], "no metered request");
        assert.equal(e?.code, code, e?.message);
      });
    }
  }
});

test("I the pipeline implementer (failover off): its lane's proven quota refusal is thrown, the metered API behind it is never asked", async t => {
  const env = await tempRepo();
  t.after(env.cleanup);
  const go = async billing => {
    const turns = pipelineTurns({ turn: async () => { throw new Error("no single-turn seat in this row"); }, makeClientFor: await liveClients(), agy: { billing } });
    return turns.implementer({ vendor: "agy_google", model: LANE, prompt: "ROLE: implementer", cwd: env.repo, control_dir: mkdtempSync(join(fx.root, "ctl-")), owned_paths: ["src/a/**"], verify_cmd: "true", unit_id: "a" })
      .then(() => null, err => err);
  };
  for (const [policy, billing] of [["nothing declared", OFF], ["primary only: it never admits a failover", PRIMARY]]) {
    await t.test(`failover off (${policy})`, async () => {
      arm("quota", null);
      const e = await go(billing());
      assert.deepEqual(fetched, [], "no metered request");
      assert.equal(e?.code, "quota_exhausted", e?.message);
      isDisabledQuota(e, "implementer");
    });
  }
  await t.test("CONTROL (failover on): the metered API is asked at the recorder", async () => {
    arm("quota", null);
    await go(FAILOVER());
    assert.ok(fetched.length > 0);
  });
});

// ---- B: the board -------------------------------------------------------------------------------------------------
let boards = 0;
async function board({ seatOverrides = {}, billing = null, scouts = ["xai"], planTitle = "ticket", spec = {} } = {}) {
  const dir = join(fx.root, `board-${++boards}`); mkdirSync(dir);
  const calls = [], scripted = scriptedClients(calls), google = await liveClients();
  const makeClientFor = Object.assign((v, o) => (v === "agy_google" ? google(v, o) : scripted(v, o)), { providers: { kind: "fake" } });
  const progress = [];
  const result = await runOpenItem({ key: `wave3-spend-${boards}`, repo_root: dir, title: "fixture", goal: "fixture goal", question: "q", copy: [], acceptance_cmd: "true", slot: "code", path: "code.mjs", ...spec },
    { dir: join(dir, "board"), makeClientFor, scouts, planTitle, seatOverrides, billing, cooldown: openCooldownStore(join(dir, "cooldowns")), ledger: false, progress: ev => progress.push(ev) });
  const run = JSON.parse(readFileSync(join(dir, "board", "run.json"), "utf8"));
  return { result, run, calls, progress };
}
const seat = (vendor, model) => ({ vendor, model, rank: 0, pool: vendor, band: null, basis: "OPERATOR", why: "wave3 spend fixture" });
const XAI_WORKER = { implementer: seat("xai", "grok-4.6") };
/** The board refused a Google-billed seat at its point of spend: the code on the run, an attempt that made no request. */
function refusedAtSpend(run, purpose, model, transport, code) {
  assert.equal(run.error?.code, code, JSON.stringify(run.error));
  assert.deepEqual(run.attempts.filter(a => a.purpose === purpose && a.vendor === "agy_google").map(a => [a.model, a.transport, a.code, a.provider_requests]), [[model, transport, code, 0]]);
  assert.deepEqual(run.turns.filter(t => t.vendor === "agy_google"), [], "no Google turn answered");
  assert.ok(run.billing.refusals.some(r => r.code === code && r.model === model), "the refusal is on the run's billing record");
}

test("B(spare) the board's critique on [lane, its metered quota failover] with the failover off: the lane's quota refusal reaches no metered call", async t => {
  for (const [policy, billing] of [["nothing declared", OFF], ["primary only: it never admits a failover", PRIMARY]]) {
    await t.test(`failover off (${policy})`, async () => {
      arm("quota", null);
      const { result, run, progress } = await board({ seatOverrides: XAI_WORKER, billing: billing() });
      assert.deepEqual(fetched, [], "no metered request");
      assert.ok(progress.some(p => p.event === "quota_failover.skipped" && p.model === API_ID && /METERED_GEMINI_DISABLED/.test(p.detail)), "the failover candidate is recorded as not used, with its code");
      assert.deepEqual(run.attempts.filter(a => a.vendor === "agy_google" && a.transport === "api" && a.provider_requests !== 0), [], "no billed Google attempt");
      assert.equal(result.shipped, false);
    });
  }
  await t.test("CONTROL (failover on): the quota failover reaches the recorder", async () => {
    arm("quota", null);
    await board({ seatOverrides: XAI_WORKER, billing: FAILOVER() });
    assert.ok(fetched.length > 0);
  });
});

test("B(api) a Gemini API seat no walk filters (an operator's critique, plan or scout seat; a ticket's pin of the work) is primary execution: refused at its point of spend, before admission, with a key present -- whatever the failover switch says", async t => {
  const rows = [
    ["critique", { ...XAI_WORKER, reviewer: seat("agy_google", API_ID) }, {}],
    ["plan", { ...XAI_WORKER, planner: seat("agy_google", API_ID) }, { planTitle: "model" }],
    ["scout", { ...XAI_WORKER, scout: seat("agy_google", API_ID) }, { scouts: ["agy_google"] }],
    ["work", {}, { spec: { slots: [{ slot: "code", path: "code.mjs", model: API_ID }] } }],
  ];
  for (const [policy, billing] of [["nothing declared", OFF], ["the failover switch on", FAILOVER]]) {
    for (const [purpose, seatOverrides, extra] of rows) {
      await t.test(`${purpose} (${policy})`, async () => {
        arm("answer", null);
        const { result, run } = await board({ seatOverrides, billing: billing(), ...extra });
        assert.deepEqual(fetched, [], "no metered request");
        assert.equal(result.shipped, false);
        refusedAtSpend(run, purpose, API_ID, "api", GEMINI_PRIMARY_DISABLED);
      });
    }
  }
  await t.test("CONTROL (primary on): the operator's critique seat reaches the recorder", async () => {
    arm("answer", null);
    await board({ seatOverrides: rows[0][1], billing: PRIMARY() });
    assert.ok(fetched.length > 0);
  });
});

test("B(sdk) L-124: the python Antigravity SDK seat (critique, scout; asked for with PANTHEON_AGY_TRANSPORT=sdk) is primary execution: refused before admission and before its spawn, with a key present -- whatever the failover switch says", async t => {
  process.env.PANTHEON_AGY_TRANSPORT = "sdk";
  t.after(() => { delete process.env.PANTHEON_AGY_TRANSPORT; });
  const rows = [
    ["critique", { ...XAI_WORKER, reviewer: seat("agy_google", SDK_MODEL) }, {}, SDK_MODEL],
    ["scout", { ...XAI_WORKER, scout: seat("agy_google", NO_LANE) }, { scouts: ["agy_google"] }, NO_LANE],
  ];
  for (const [policy, billing] of [["nothing declared", OFF], ["the failover switch on", FAILOVER]]) {
    for (const [purpose, seatOverrides, extra, model] of rows) {
      await t.test(`${purpose} (${policy})`, async () => {
        arm("answer", null);
        const { result, run, progress } = await board({ seatOverrides, billing: billing(), ...extra });
        assert.deepEqual(lines("python"), [], "the SDK seat was never spawned");
        assert.deepEqual(fetched, []);
        assert.equal(result.shipped, false);
        refusedAtSpend(run, purpose, model, "agy-sdk", GEMINI_PRIMARY_DISABLED);
        assert.ok(progress.some(p => p.event === "turn.refused" && p.model === model), "the refusal is on the progress trail");
      });
    }
  }
  await t.test("CONTROL (primary on): the SDK seat is spawned", jailed, async () => {
    arm("answer", null);
    await board({ seatOverrides: rows[0][1], billing: PRIMARY() });
    assert.equal(lines("python").length, 1);
  });
});

test("O the subscription (OAuth) lanes keep working with nothing declared: the planner and the implementer forced onto the CLI, and a reviewer on a declared lane or by the default transport, answer through the agy CLI", async t => {
  const rows = [
    ["plan", { planner: seat("agy_google", SDK_MODEL), ...XAI_WORKER, reviewer: seat("openai", "gpt-6-astra") }, { planTitle: "model" }, "pantheon-planner", SDK_MODEL, "agy-cli"],
    ["work", { implementer: seat("agy_google", SDK_MODEL), reviewer: seat("xai", "grok-4.7") }, {}, "pantheon-implementer", SDK_MODEL, "agy-cli"],
    ["critique", { ...XAI_WORKER, reviewer: seat("agy_google", LANE) }, {}, "pantheon-reviewer", LANE, "agy-cli"],
    // The reviewer's DEFAULT transport (no PANTHEON_AGY_TRANSPORT) is the CLI lane now (owner decision, L-136).
    ["critique", { ...XAI_WORKER, reviewer: seat("agy_google", SDK_MODEL) }, {}, "pantheon-reviewer", SDK_MODEL, "agy-cli"],
  ];
  for (const [purpose, seatOverrides, extra, card, model, transport] of rows) {
    await t.test(`${purpose} on ${model}`, async () => {
      arm("answer", null);
      const { result, run } = await board({ seatOverrides, ...extra });
      assert.equal(result.error, null, JSON.stringify(result.error));
      assert.equal(result.shipped, true);
      assert.deepEqual(launches(), [[card, model]]);
      assert.deepEqual([fetched, lines("python")], [[], []]);
      assert.deepEqual(run.turns.filter(x => x.vendor === "agy_google").map(x => [x.purpose, x.model, x.transport, x.served_model_source]), [[purpose, model, transport, "input"]]);
    });
  }
});
