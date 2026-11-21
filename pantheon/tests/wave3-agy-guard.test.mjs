// L-504 INVARIANT 3, THE ANTIGRAVITY MODEL GUARD, ACROSS EVERY ENTRY POINT (wave 3, sub-wave 3B-1). Every entry point that
// launches an Antigravity model turn checks that the model the CLI (its stream's `init`) or the python SDK seat (its
// envelope) reports equals the model asked for, BEFORE it acts on any result of the turn: its answer, its failure
// classification, its quota refusal (the metered failover, the quota probe, the lane's quota cooldown), a retry on another
// model, or a stamped "served = requested" record. A mismatch fails closed with code AGY_MODEL_MISMATCH and both
// identities.
//
// THE ENTRY POINTS (enumerated from the code; each is driven through its production function here):
//   A1  runAgyCliTurn <- sdk/agy-turn.mjs agySingleTurn <- laneFirstTurn <- sdk/live.mjs liveTurn: the single-turn seats
//       (planner, plan and cycle reviewers, validator), and pipeline/turns.mjs dispatcher / reviewer / subagent on it
//   A2  runAgyCliTurn <- board/run-item.mjs agyTurn (transport cli): the board's critique, plan, work and scout seats
//   B1  runAgyWorkerTurn <- pipeline/turns.mjs implementer (and the pipeline's lane ladder around it)
//   B2  runAgyWorkerTurn <- review-runner/subscription.mjs runAgy (`--via subscription`, assignment 1)
//   C   the python SDK seat <- board/run-item.mjs agyTurn (transport sdk)
// (scripts/agy-worker-probe.mjs also calls runAgyWorkerTurn; it is not driven here: it inherits B1's check.)
//
// THE FAKES, at the provider edge only: a fake `agy` script (a real child process, inside the REAL bwrap jail) that starts
// on the model written in its state dir's `served` file and ends as its `mode` file says (answer | failure | quota |
// timeout); a fake python seat (PANTHEON_AGY_PYTHON) that reports a model the same way; and globalThis.fetch replaced by a
// recorder under the REAL @google/genai client (sdk/live.mjs liveClients / liveTurn), with a synthetic GEMINI_API_KEY in
// the environment so that no path is protected by a missing key. The jail is real: these tests need bwrap.
// THE BILLING POLICY (register L-136): "failover on" rows declare metered_gemini_failover with a budget (the policy is OFF
// by default now); the python SDK seat (C) is asked for with PANTHEON_AGY_TRANSPORT=sdk (the board's reviewer defaults to
// the CLI lane) and declares gemini_api_primary, the setting that seat is billed under.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgyCliTurn } from "../src/board/agy-cli.mjs";
import { liveClients, liveTurn } from "../src/sdk/live.mjs";
import { pipelineTurns } from "../src/pipeline/turns.mjs";
import { laneFailureOf } from "../src/pipeline/implement.mjs";
import { runPipeline } from "../src/pipeline/index.mjs";
import { runOpenItem } from "../src/board/run-item.mjs";
import { classifyFailure, openCooldownStore } from "../../packages/model-client/index.mjs";
import { scriptedClients, fakeAgy } from "./fixtures/dispatch.mjs";
import { tempRepo, seats, unit, RUBRIC, approve, PLANNER } from "./fixtures/pipeline-stages.mjs";
import { main, EXIT } from "../src/review-runner/index.mjs";
import { fixtureRepo, fakeFetch, capture, deps, mkdtemp as rrTemp, cleanup as rrCleanup } from "./review-runner-helper.mjs";
// THE BILLING POLICY (register L-136): both kinds default OFF. A row with the failover (or primary execution) ON declares
// it explicitly, with a budget, over a usage record of its own; a row with it OFF declares nothing (the default).
import { optIn } from "./fixtures/billing.mjs";
import { sandboxAvailable } from "../src/agy/sandbox.mjs";
const have = await sandboxAvailable("bwrap");
// THE SDK SEAT RUNS IN ITS JAIL (knowledge graphs, Slice C2): a cell that spawns it is a real-bwrap cell.
const jailed = { skip: have.ok ? false : `bwrap unavailable: ${have.why}` };
const failoverOn = () => optIn({ failover: 100 });

// The distinct refusal code (board/agy-cli.mjs AGY_MODEL_MISMATCH), spelled out so this file also loads on a tree without it.
const AGY_MODEL_MISMATCH = "AGY_MODEL_MISMATCH";
const LANE = "gemini-4-carbon-high", API_ID = "gemini-4-carbon", OTHER = "gemini-4-argon-high";
const MODES = ["answer", "failure", "quota"];
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
// THE FAKE python SDK seat: it is spawned as `<python> scripts/agy-seat.py --role R ... --model M ... --out D ...`. It makes
// ONE Gemini request through the controller's model gateway with the capability it was given (register L-150: the seat
// holds no key, and each request is charged at the gateway before it is forwarded -- here to this file's provider edge, the
// replaced fetch), so the seat's one provider request is one the gateway admitted, not a charge for the launch.
function writeFakePython(bin, state) {
  const py = join(bin, "python");
  writeFileSync(py, `#!/bin/sh
S=${sh1(state)}
role=none; model=none; out=/nonexistent
for a in "$@"; do case "$prev" in --role) role="$a" ;; --model) model="$a" ;; --out) out="$a" ;; esac; prev="$a"; done
printf '%s\\n' "$*" >> "$out/python.log"
MODEL="$model" ${sh1(process.execPath)} -e 'fetch(process.env.PANTHEON_AGY_GATEWAY_URL + "/v1beta/models/" + process.env.MODEL + ":streamGenerateContent?alt=sse", { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": process.env.PANTHEON_AGY_GATEWAY_TOKEN ?? "" }, body: "{}" }).then(r => r.text()).catch(() => null)'
served="\${FAKE_SDK_SERVED:-$model}"
mode="\${FAKE_SDK_MODE:-answer}"
if [ "$mode" = failure ]; then printf '{"ok": false, "role": "%s", "model": "%s", "error": "vendor error"}\\n' "$role" "$served"; exit 3; fi
printf 'VERDICT: approve\\n' > "$out/response.md"
# mode noinit: an envelope that names no model at all.
if [ "$mode" = noinit ]; then printf '{"ok": true, "role": "%s", "conversation_id": "fake-sdk", "tool_calls": 0, "subagent_calls": 0}\\n' "$role"; exit 0; fi
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wave3-agy-guard-")));
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
  await rrCleanup();
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
  const d = join(fx.root, `board-${b}`, "outputs", "open-items", `wave3-guard-${b}`, "agy_google");
  return existsSync(d) ? readdirSync(d).flatMap(n => (existsSync(join(d, n, "python.log")) ? readFileSync(join(d, n, "python.log"), "utf8").split("\n").filter(Boolean) : [])) : [];
});
const lines = f => (f === "python" ? sdkLaunches() : existsSync(join(fx.state, f)) ? readFileSync(join(fx.state, f), "utf8").split("\n").filter(Boolean) : []);
const launches = () => lines("launches").map(l => l.split(" "));
const identity = (agent, model, reported = OTHER) => ({ requested: { agent, model }, reported: { agent, model: reported } });
/** What a turn in `mode` reports: another model, or (noinit) no identity at all. */
const wantFor = (agent, model, mode) => (mode === "noinit" ? { requested: { agent, model }, reported: { agent: null, model: null } } : identity(agent, model));
/** The refusal of a mismatch: the distinct code, both identities, no quota or failover marking, never retryable. */
function isMismatch(e, want, at) {
  assert.ok(e, `${at}: the turn must be refused`);
  assert.equal(e.code, AGY_MODEL_MISMATCH, `${at}: ${e?.code} ${e?.message}`);
  assert.deepEqual(e.identity, want, at);
  assert.equal(e.quota_failover, undefined, `${at}: no failover was considered`);
  assert.deepEqual(classifyFailure(e), { retryable: false, retryMs: null, quota: false }, `${at}: no router may move on from it`);
}
// Each row is its own subtest, so a tree that violates the invariant on one path fails on exactly that row. In every row
// the BEHAVIOUR is asserted first (what was called, launched, probed, cooled down or stamped), the refusal after it.

test("A1 the single-turn seats (liveTurn -> laneFirstTurn -> agySingleTurn -> runAgyCliTurn): another model in init is refused before its answer, failure or quota refusal is used; the metered failover is never asked, with it on or off", async t => {
  for (const meteredFailover of [true, false]) {
    const turn = await liveTurn({ label: "wave3-guard", billing: meteredFailover ? failoverOn() : null });
    // A lane seat (its quota failover is the API id of its base model), and a Gemini API id served by its lane first.
    for (const [model, role, card] of [[LANE, "cycle-reviewer", "pantheon-reviewer"], [API_ID, "planner", "pantheon-planner"], [LANE, "validator", "pantheon-reviewer"]]) {
      for (const mode of MODES) {
        const at = `failover ${meteredFailover}, ${model} as ${role}, ${mode}`;
        await t.test(at, async () => {
          arm(mode);
          const e = await turn({ vendor: "agy_google", model, prompt: "review this", seat: { role } }).then(() => null, err => err);
          assert.deepEqual(fetched, [], "the metered Gemini API was never asked");
          assert.deepEqual(launches(), [[card, LANE]], "one launch, on the lane asked for");
          isMismatch(e, identity(card, LANE), at);
          assert.equal(e.provider_requests, 1, "the one CLI turn was made");
        });
      }
    }
  }
  await t.test("control: the CLI reports the model asked for, and the same seat answers", async () => {
    arm("answer", null);
    const r = await (await liveTurn({ label: "wave3-guard" }))({ vendor: "agy_google", model: LANE, prompt: "review this", seat: { role: "cycle-reviewer" } });
    assert.deepEqual([r.text, r.served_model, r.served_model_source, r.transport], ["VERDICT: approve", LANE, "input", "agy-cli"]);
  });
});

test("A1 the pipeline's single-turn seats (dispatcher, reviewer, subagent) on a lane through liveTurn: the mismatch is refused, the quota refusal of another model reaches no failover", async t => {
  const turns = pipelineTurns({ turn: await liveTurn({ label: "wave3-guard", billing: failoverOn() }) });
  for (const role of ["dispatcher", "reviewer", "subagent"]) {
    for (const mode of MODES) {
      await t.test(`${role}, ${mode}`, async () => {
        arm(mode);
        const e = await turns[role]({ vendor: "agy_google", model: LANE, prompt: "judge this" }).then(() => null, err => err);
        assert.deepEqual(fetched, [], "no metered request");
        isMismatch(e, identity("pantheon-reviewer", LANE), `${role}, ${mode}`);
      });
    }
  }
});

test("A1 runAgyCliTurn itself, in each terminal mode and a print timeout: the mismatch is thrown first, with the turn's evidence", async t => {
  const wt = join(fx.root, "wt-a1"); mkdirSync(wt, { recursive: true });
  for (const mode of [...MODES, "timeout", "noinit"]) {
    await t.test(mode, async () => {
      arm(mode);
      const e = await runAgyCliTurn({ cli: fx.cli, repo: join(import.meta.dirname, ".."), worktree: wt, role: "scout", model: LANE, prompt: "p", timeoutS: 30 }).then(() => null, err => err);
      assert.equal(e?.status, undefined, "no status (a 429 would be read as quota)");
      isMismatch(e, wantFor("pantheon-scout", LANE, mode), mode);
      assert.equal(e.provider_requests, 1);
      assert.ok(e.launch && Array.isArray(e.jail_log) && e.sandbox?.kind === "bwrap", "the jailed turn's evidence travels with the refusal");
    });
  }
});

// ---- A2 / C: the board ---------------------------------------------------------------------------------------------
let boards = 0;
async function board({ seatOverrides = {}, billing = failoverOn(), scouts = ["xai"], planTitle = "ticket", spec = {} } = {}) {
  const dir = join(fx.root, `board-${++boards}`); mkdirSync(dir);
  const calls = [], scripted = scriptedClients(calls), google = await liveClients();
  // The board's Google seats get the REAL client (its fetch is the recorder); every other vendor is scripted.
  const makeClientFor = Object.assign((v, o) => (v === "agy_google" ? google(v, o) : scripted(v, o)), { providers: { kind: "fake" } });
  const cooldown = openCooldownStore(join(dir, "cooldowns"));
  const progress = [];
  const result = await runOpenItem({ key: `wave3-guard-${boards}`, repo_root: dir, title: "fixture", goal: "fixture goal", question: "q", copy: [], acceptance_cmd: "true", slot: "code", path: "code.mjs", ...spec },
    { dir: join(dir, "board"), makeClientFor, scouts, planTitle, seatOverrides, billing, cooldown, ledger: false, progress: ev => progress.push(ev) });
  const run = JSON.parse(readFileSync(join(dir, "board", "run.json"), "utf8"));
  return { result, run, calls, cooldown, progress };
}
const seat = (vendor, model) => ({ vendor, model, rank: 0, pool: vendor, band: null, basis: "OPERATOR", why: "wave3 guard fixture" });
const XAI_WORKER = { implementer: seat("xai", "grok-4.6") };

test("A2 the board's critique on [Antigravity lane, its metered quota failover]: another model is refused in every mode, failover on or off -- no failover, no quota cooldown, no stamped turn", async t => {
  for (const meteredFailover of [true, false]) {
    for (const mode of MODES) {
      await t.test(`failover ${meteredFailover}, ${mode}`, async () => {
        arm(mode);
        const { result, run, cooldown, progress } = await board({ seatOverrides: XAI_WORKER, billing: meteredFailover ? failoverOn() : null });
        assert.deepEqual(fetched, [], "the metered Gemini API was never asked");
        assert.deepEqual(progress.filter(p => p.event === "quota_failover"), [], "no quota failover was taken");
        assert.equal(await cooldown.get(`agy_cli_oauth:${API_ID}`), null, "the lane's quota authority was not put in cooldown on another model's refusal");
        assert.deepEqual(run.turns.filter(t => t.purpose === "critique"), [], "no turn stamps the lane as served");
        assert.deepEqual(launches(), [["pantheon-reviewer", LANE]]);
        assert.equal(result.shipped, false);
        const critique = run.attempts.filter(a => a.purpose === "critique");
        assert.deepEqual(critique.map(a => [a.vendor, a.model, a.transport, a.code, a.provider_requests]), [["agy_google", LANE, "agy-cli", AGY_MODEL_MISMATCH, 1]], "one lane attempt, no API attempt");
        assert.deepEqual(critique[0].identity, identity("pantheon-reviewer", LANE), "both identities on the attempt");
        assert.deepEqual([run.error?.code, run.error?.identity], [AGY_MODEL_MISMATCH, identity("pantheon-reviewer", LANE)], JSON.stringify(run.error));
      });
    }
  }
});

test("A2 the board's plan, work and scout seats on an Antigravity lane (operator seats): another model is refused before its answer or quota refusal is used", async t => {
  const rows = [
    ["plan", { planner: seat("agy_google", LANE), ...XAI_WORKER }, { planTitle: "model" }, "pantheon-planner"],
    ["work", { implementer: seat("agy_google", LANE) }, {}, "pantheon-implementer"],
    ["scout", { scout: seat("agy_google", LANE), ...XAI_WORKER }, { scouts: ["agy_google"] }, "pantheon-scout"],
  ];
  for (const [purpose, seatOverrides, extra, card] of rows) {
    for (const mode of ["answer", "quota"]) {
      await t.test(`${purpose}, ${mode}`, async () => {
        arm(mode);
        const { result, run, cooldown } = await board({ seatOverrides, ...extra });
        assert.deepEqual(fetched, []);
        assert.equal(await cooldown.get(`agy_cli_oauth:${API_ID}`), null, "no quota cooldown");
        assert.deepEqual(run.turns.filter(t => t.purpose === purpose), [], "not stamped");
        assert.equal(result.shipped, false);
        assert.deepEqual(run.attempts.filter(a => a.purpose === purpose).map(a => [a.model, a.code, a.identity?.reported?.model]), [[LANE, AGY_MODEL_MISMATCH, OTHER]]);
        assert.deepEqual([run.error?.code, run.error?.identity], [AGY_MODEL_MISMATCH, identity(card, LANE)], JSON.stringify(run.error));
      });
    }
  }
});

test("C the python SDK seat (board reviewer, transport sdk): a reported model other than the one asked for is refused before its answer or failure is used, and nothing is stamped", jailed, async t => {
  const sdkSeat = { ...XAI_WORKER, reviewer: seat("agy_google", "gemini-3.8-flash") };
  // The board's reviewer defaults to the CLI lane now (owner decision 2026-11-19, L-136): the SDK seat is asked for, and
  // it is primary Gemini execution, so this row declares gemini_api_primary with a budget.
  process.env.PANTHEON_AGY_TRANSPORT = "sdk";
  t.after(() => { delete process.env.PANTHEON_AGY_TRANSPORT; });
  for (const mode of ["answer", "failure", "noinit"]) {
    await t.test(mode, async () => {
      arm(mode, "gemini-3.6-flash");
      const { result, run } = await board({ seatOverrides: sdkSeat, billing: optIn({ primary: 100 }) });
      assert.deepEqual(run.turns.filter(t => t.purpose === "critique"), [], "the request is not stamped as served");
      assert.equal(lines("python").length, 1, "the seat was spawned once, never re-asked");
      assert.equal(result.shipped, false);
      const want = { requested: { agent: "pantheon-reviewer", model: "gemini-3.8-flash" }, reported: { agent: "pantheon-reviewer", model: mode === "noinit" ? null : "gemini-3.6-flash" } };
      assert.deepEqual(run.attempts.filter(a => a.purpose === "critique").map(a => [a.transport, a.code, a.provider_requests]), [["agy-sdk", AGY_MODEL_MISMATCH, 1]]);
      assert.deepEqual([run.error?.code, run.error?.identity], [AGY_MODEL_MISMATCH, want], JSON.stringify(run.error));
    });
  }
  await t.test("control: a seat reporting the model asked for answers, stamped as the input model (the owner's format rule)", async () => {
    arm("answer", null);
    const { result, run } = await board({ seatOverrides: sdkSeat, billing: optIn({ primary: 100 }) });
    assert.equal(result.error, null, JSON.stringify(result.error));
    assert.deepEqual(run.turns.filter(t => t.purpose === "critique").map(t => [t.model, t.served_model, t.served_model_source]), [["gemini-3.8-flash", "gemini-3.8-flash", "input"]]);
  });
});

// ---- L-504 INVARIANT 2 on the board's contributor rows (patch 3b-identity-1, routed to this branch) -------------------
// A slot's contributors carry the model ASKED and the model that SERVED each turn whose text reached its bytes: the work
// rows, and the critique rows of a reviewer whose findings reached a revision. A turn whose provider NAMED NO serving model
// is carried as unknown (served_model null, served_model_source "unnamed"), never as served by the model asked; a named one
// is kept. Driven through runOpenItem as the lifecycle drives it (escalation protocol v2): an API implementer, an API
// reviewer that requests changes on the passing work, and the RESUME that runs the revision with its findings.
test("invariant 2: the board's work and critique contributor rows carry an unnamed serving model as unknown, and keep a named one", async t => {
  const overrides = { implementer: seat("openai", "gpt-6-astra"), reviewer: seat("xai", "grok-4.7") };
  /** Run the item, then resume it for the revision the review asked for; returns the slot's contributor rows. */
  async function reviewedRevision(served) {
    const dir = join(fx.root, `board-${++boards}`); mkdirSync(dir);
    let reviews = 0;
    // The in-run reviewer (grok-4.7) asks for changes on its first review; every other verdict keeps the fixture's default.
    const review = ({ model }) => (model === "grok-4.7" && ++reviews === 1 ? "the export must be frozen\nVERDICT: request_changes" : null);
    const makeClientFor = scriptedClients([], undefined, undefined, review, served);
    const spec = { key: `wave3-inv2-${boards}`, repo_root: dir, title: "fixture", goal: "fixture goal", question: "q", copy: [], acceptance_cmd: "true", slot: "code", path: "code.mjs" };
    const opts = { makeClientFor, scouts: ["xai"], planTitle: "ticket", seatOverrides: overrides, cooldown: openCooldownStore(join(dir, "cooldowns")), ledger: false, escalation: "pantheon.escalation/v2" };
    await runOpenItem(spec, { ...opts, dir: join(dir, "board") });
    await runOpenItem(spec, { ...opts, resume: join(dir, "board") });
    const run = JSON.parse(readFileSync(join(dir, "board", "run.json"), "utf8"));
    return (run.files ?? []).flatMap(f => f.contributors ?? []).map(({ purpose, vendor, model, served_model, served_model_source }) => ({ purpose, vendor, model, served_model, served_model_source }));
  }
  await t.test("no serving model named: the work and critique rows say unknown (null, \"unnamed\")", async () => {
    const got = await reviewedRevision(() => null);
    assert.deepEqual(got.filter(r => r.purpose === "work"), [{ purpose: "work", vendor: "openai", model: "gpt-6-astra", served_model: null, served_model_source: "unnamed" }], JSON.stringify(got));
    assert.deepEqual(got.filter(r => r.purpose === "critique"), [{ purpose: "critique", vendor: "xai", model: "grok-4.7", served_model: null, served_model_source: "unnamed" }], JSON.stringify(got));
  });
  await t.test("a serving model named by the provider is kept on both rows", async () => {
    const snapshot = model => `${model}-20261101`;
    const got = await reviewedRevision((vendor, model) => snapshot(model));
    assert.deepEqual(got.filter(r => r.purpose === "work").map(r => [r.model, r.served_model, r.served_model_source]), [["gpt-6-astra", snapshot("gpt-6-astra"), undefined]], JSON.stringify(got));
    assert.deepEqual(got.filter(r => r.purpose === "critique").map(r => [r.model, r.served_model, r.served_model_source]), [["grok-4.7", snapshot("grok-4.7"), undefined]], JSON.stringify(got));
  });
});

// ---- B1: the pipeline's implementer --------------------------------------------------------------------------------
const H0 = { vendor: "agy_google", model: "gemini-4-hydrogen-medium" }, ARGON = { vendor: "agy_google", model: "gemini-4-argon-high" };
function scriptedSingle() {
  return async ({ model, prompt }) => {
    if (prompt.startsWith("ROLE: dispatcher")) {
      const u = JSON.parse(/THE UNIT\n([\s\S]*?)\n(?:THE OTHER UNITS|DECIDE)/.exec(prompt)[1]);
      return { text: JSON.stringify({ unit_id: u.unit_id, cohesive: true, specialist_role: u.specialist_role, difficulty: u.difficulty, rubric: RUBRIC, notes: "" }), served_model: model };
    }
    if (prompt.startsWith("ROLE: acceptance reviewer")) return { text: JSON.stringify(approve(RUBRIC)), served_model: model };
    return { text: "42", served_model: model };
  };
}

test("B1 the pipeline implementer (pipelineTurns.implementer -> runAgyWorkerTurn, real bwrap): another model is refused before its failure, timeout, quota refusal or answer is used -- no quota probe, no metered failover, not a lane failure", async t => {
  const env = await tempRepo();
  t.after(env.cleanup);
  for (const meteredFailover of [true, false]) {
    const turns = pipelineTurns({ turn: scriptedSingle(), makeClientFor: await liveClients(), agy: { billing: meteredFailover ? failoverOn() : null } });
    for (const mode of [...MODES, "timeout", "noinit"]) {
      const at = `failover ${meteredFailover}, ${mode}`;
      await t.test(at, async () => {
        arm(mode);
        const ctl = mkdtempSync(join(fx.root, "ctl-"));
        const e = await turns.implementer({ vendor: H0.vendor, model: H0.model, prompt: "ROLE: implementer of work unit a", cwd: env.repo, control_dir: ctl, owned_paths: ["src/a/**"], verify_cmd: "true", unit_id: "a" })
          .then(() => null, err => err);
        assert.deepEqual(fetched, [], "the metered Gemini API was never asked");
        assert.deepEqual(lines("probes"), [], "the quota probe was not run on another model's refusal");
        assert.deepEqual(launches(), [["pantheon-unit-worker", H0.model]]);
        assert.equal(laneFailureOf(e), null, "not a lane failure, so no ladder step to another model");
        isMismatch(e, wantFor("pantheon-unit-worker", H0.model, mode), at);
      });
    }
  }
});

test("B1 runPipeline around it: a unit whose lane reports another model is never retried on another rung, never failed over to the metered API, and its attempt names no served model", async t => {
  for (const meteredFailover of [true, false]) {
    for (const mode of ["failure", "quota", "answer", "noinit"]) {
      await t.test(`failover ${meteredFailover}, ${mode}`, async () => {
        arm(mode);
        const env = await tempRepo();
        try {
          const s = seats({ implementer: () => ({ seat: { ...H0 }, ladder: [{ ...H0 }, { ...ARGON }] }) });
          const out = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: [unit("a")] }, seats: s, limits: { max_revisions: 0 }, dir: env.dir, planner: PLANNER,
            turns: pipelineTurns({ turn: scriptedSingle(), makeClientFor: await liveClients(), agy: { billing: meteredFailover ? failoverOn() : null } }) });
          const u = out.units.a;
          assert.deepEqual(fetched, [], "no metered request");
          assert.deepEqual(lines("probes"), [], "no quota probe");
          assert.deepEqual(launches(), [["pantheon-unit-worker", H0.model]], "the requested lane only, once: no same-lane retry and no other rung");
          assert.deepEqual(u.escalations.filter(x => x.kind === "lane_failover"), []);
          const a = u.attempts[0];
          assert.equal(a.lane_failure, undefined);
          assert.equal(a.served_model, null, "nothing stamped as served");
          assert.equal(u.status, "blocked", u.reason);
          assert.match(a.why, new RegExp(`expected pantheon-unit-worker/${H0.model}, got ${mode === "noinit" ? "none/none" : `pantheon-unit-worker/${OTHER}`}`), "both identities on the record");
        } finally { await env.cleanup(); }
      });
    }
  }
});

// ---- B2: the review runner's agy transport -------------------------------------------------------------------------
test("B2 the review runner (--via subscription, assignment 1): another model in the reviewer's init is a REFUSED run with both identities; the lane is never stamped as served and the run cannot be continued", async t => {
  const repo = await fixtureRepo();
  for (const mode of MODES) {
    await t.test(mode, async () => {
      const base = await rrTemp(join(tmpdir(), "wave3-rr-"));
      const fxd = join(base, "fx"), home = join(base, "home"), outDir = join(base, "out");
      for (const d of [fxd, outDir, join(home, ".gemini", "antigravity-cli", "log"), join(home, ".gemini", "config", "projects")]) mkdirSync(d, { recursive: true });
      writeFileSync(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "fake-token");
      const cli = fakeAgy(fxd);
      writeFileSync(join(fxd, "quota-report.txt"), EXHAUSTED.replace('"remaining_fraction":0', '"remaining_fraction":0.8')); writeFileSync(join(fxd, "quota-exit"), "0");
      // The reviewer's session (sourced by the fixture's fake agy): it starts on another model.
      const worker = join(fxd, "review-worker.sh");
      writeFileSync(worker, mode === "answer" ? `agy_read "$dir/hello.txt" >/dev/null || true\nexport FAKE_AGY_MODEL=${OTHER}\nreply="# Findings (another model)"\n`
        : `printf '{"event":"init","conversation_id":"c-other","init":{"model":"${OTHER}","agent":"%s"}}\\n' "$agent"\n` +
          `printf '{"event":"result","result":{"status":"ERROR","error":"${mode === "quota" ? "429 RESOURCE_EXHAUSTED: quota exceeded" : "internal error"}"}}\\n'\nexit 1\n`);
      chmodSync(worker, 0o755);
      const out = capture();
      const d = await deps({ root: repo.root, out, fetch: fakeFetch([]), env: { PATH: process.env.PATH, HOME: home, FAKE_AGY_LOG: join(fxd, "agy.log"), PANTHEON_AGY_STATE_DIRS: fxd, FAKE_AGY_WORKER: worker,
        GEMINI_API_KEY: process.env.GEMINI_API_KEY } });
      const code = await main(["--via", "subscription", "--assignment", "1", "--commit", repo.commit, "--out", outDir, "--max-wall-s", "120", "--agy-cli", cli], d);
      const t2 = JSON.parse(await readFile(join(outDir, "findings-1-google.transcript.json"), "utf8"));
      const md = await readFile(join(outDir, "findings-1-google.md"), "utf8");
      assert.ok(!md.includes(`- served_model: \`${LANE}\``), "the lane is not stamped as served");
      assert.deepEqual([t2.cli.own, t2.agy_state], [[], undefined], "nothing of the other model's session is kept to be replayed or resumed");
      assert.equal((await readdir(outDir)).filter(f => f.endsWith(".agy-state")).length, 0);
      assert.equal(t2.status, "refused");
      assert.equal(code, EXIT.refused, out.err.slice(-800));
      assert.deepEqual(t2.identity_mismatch, identity("pantheon-reviewer-agent", LANE));
      assert.match(t2.stop_reason, new RegExp(`^${AGY_MODEL_MISMATCH}: `));
      assert.match(md, new RegExp(`- served_model: none \\(${AGY_MODEL_MISMATCH}: the CLI reported \`pantheon-reviewer-agent/${OTHER}\``));
    });
  }
});
