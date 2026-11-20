// Self-audit round 3, assignment 3 (sealed bb1287a): execution reliability, the Pantheon side. Register ids L-301
// (per-request charging), L-306 (the stop reaches the board's Antigravity seat), L-407 (the board's Antigravity reviewer
// runs the acceptance command, in the verify jail) and L-410 (the python SDK seat's environment).
//
// Every test runs a PRODUCTION ENTRY POINT (runOpenItem, liveTurn, pipelineTurns, runAgyCliTurn, sendModelTurn) against
// fakes that stand where a provider or the agy CLI stands: the scripted SDK clients of fixtures/dispatch.mjs, the fake
// agy CLI (a real child process in the REAL bwrap jail), and, for L-407, a fake CLI written here that does what the real
// one does with a command: it asks the PreToolUse jail hook (the real jail-hook.mjs, from the control dir's hooks.json)
// and runs only what the hook approves. Every credential and secret here is SYNTHETIC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOpenItem, providerCallsOf } from "../src/board/run-item.mjs";
import { runAgyCliTurn, agySdkEnvOf } from "../src/board/agy-cli.mjs";
import { liveTurn } from "../src/sdk/live.mjs";
import { pipelineTurns } from "../src/pipeline/turns.mjs";
import { sendModelTurn } from "../../packages/model-client/index.mjs";
import { sandboxAvailable } from "../src/agy/sandbox.mjs";
import { withDispatch, withFakeAgy, seat } from "./fixtures/dispatch.mjs";
// Primary Gemini API execution is OFF by default (register L-136): the rows that exercise it opt in explicitly, with a budget.
import { optIn } from "./fixtures/billing.mjs";

const REPO = join(import.meta.dirname, "..");
const box = await sandboxAvailable("bwrap");
// Real bwrap is REQUIRED here (the jail is the boundary these tests are about): a host without it fails, never skips.
const real = { timeout: 180_000 };
const readRun = r => JSON.parse(readFileSync(join(r.board, "run.json"), "utf8"));
const lines = f => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
const pgrep = pattern => { try { return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" }).trim(); } catch { return ""; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const withEnv = async (vars, fn) => {
  const before = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

test("the bwrap jail is available on this host (these tests run the real boundary, they are never skipped)", async () => {
  assert.equal(box.ok, true, `bwrap: ${box.why}`);
});

// ---- L-301: every billed request is charged before it is sent -------------------------------------------------------

// A Google long-decode implementer turn that answers in 3 hops (CONTINUATION, CONTINUATION, STOP): 3 billed requests.
const hopping = (log, hops = 3) => ({ models: { countTokens: async () => ({ totalTokens: 100 }), generateContentStream: async req => {
  const tok = req.config?.continuationToken ?? null, hop = tok === null ? 1 : Number(tok.slice(1)) + 1;
  log.push(hop);
  return (async function* () {
    yield { modelVersion: req.model, candidates: [{ finishReason: hop < hops ? "CONTINUATION" : "STOP", continuationToken: hop < hops ? `c${hop}` : undefined,
      content: { parts: [{ text: hop === 1 ? "export const " : hop < hops ? "ok = " : "true;\n" }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } };
  })();
} } });

test("L-301 (self-audit round 3, assignment 3 (sealed bb1287a)): runOpenItem charges a 3-request Google turn as 3 provider calls, each on the caller's meter before it is sent", async () => {
  await withDispatch(async ({ spec, opts, makeClientFor, calls }) => {
    const google = [];
    const mk = (vendor, o) => vendor === "agy_google" ? hopping(google) : makeClientFor(vendor, o);
    mk.providers = makeClientFor.providers;
    const charges = [];
    const r = await runOpenItem(spec("hops"), { ...opts(), makeClientFor: mk, maxProviderCalls: 50, billing: optIn({ primary: 100 }), onCharge: c => { charges.push({ ...c, sent_before: google.length + calls.length }); },
      seatOverrides: { implementer: seat("agy_google", "gemini-4-hydrogen", { transport: "api" }) } });
    const run = readRun(r);
    const billed = google.length + calls.length;   // every generation request any fake provider received
    assert.deepEqual(google, [1, 2, 3], "the implementer's turn made 3 billed requests");
    assert.equal(charges.length, billed, "one charge per billed request, not per turn");
    assert.deepEqual(charges.map(c => c.sent_before), charges.map((_, i) => i), "each charge was made before its request was sent");
    assert.equal(charges.filter(c => c.purpose === "work").length, 3);
    assert.equal(run.provider_calls.made, billed, "the run's own bound counted every request");
    assert.equal(providerCallsOf(run.attempts), billed, "the stage usage (providerCallsOf) counts requests");
  });
});

test("L-301: a further request past the caller's bound is refused and NOT sent (the 3rd hop of the turn)", async () => {
  await withDispatch(async ({ spec, opts, makeClientFor }) => {
    const google = [];
    const mk = (vendor, o) => vendor === "agy_google" ? hopping(google) : makeClientFor(vendor, o);
    mk.providers = makeClientFor.providers;
    let work = 0;
    const r = await runOpenItem(spec("hopBound"), { ...opts(), makeClientFor: mk, maxProviderCalls: 50, billing: optIn({ primary: 100 }),
      onCharge: ({ purpose }) => { if (purpose === "work" && ++work === 3) throw new Error("fixture bound: the stage budget is spent"); },
      seatOverrides: { implementer: seat("agy_google", "gemini-4-hydrogen", { transport: "api" }) } });
    const run = readRun(r);
    assert.deepEqual(google, [1, 2], "the refused 3rd request was never sent");
    assert.equal(run.provider_calls.refused.code, "PROVIDER_CALL_LIMIT");
    assert.equal(run.provider_calls.refused.purpose, "work");
    const work2 = run.attempts.filter(a => a.purpose === "work");
    assert.deepEqual(work2.map(a => a.provider_requests), [2], "the attempt records the 2 requests that were sent");
  });
});

test("L-301: runOpenItem charges its Antigravity lane turn once, at the spawn: after the jail, before the CLI runs", real, async () => {
  await withDispatch(async ({ spec, opts, agy }) => {
    const charges = [];
    const r = await runOpenItem(spec("laneCharged"), { ...opts(), maxProviderCalls: 50, onCharge: c => charges.push({ ...c, launched: agy().length }),
      seatOverrides: { planner: seat("agy_google", "gemini-4-carbon-high", { transport: "agy-cli" }) } });
    const run = readRun(r);
    assert.deepEqual(charges.filter(c => c.vendor === "agy_google").map(c => [c.purpose, c.launched]), [["plan", 0]], "one charge for the lane turn, before its CLI was launched");
    assert.equal(agy().length, 1, "the CLI ran once");
    assert.deepEqual(run.attempts.filter(a => a.vendor === "agy_google").map(a => a.provider_requests), [1]);
    assert.equal(run.provider_calls.made, charges.length);
  });
});

test("L-301: a lane turn that fails before its CLI is spawned is not a provider call (no charge, provider_requests 0)", async () => {
  await withDispatch(async ({ spec, opts }) => {
    const charges = [];
    await withEnv({ PANTHEON_AGY_CLI: "/nonexistent/agy-is-absent" }, async () => {
      const o = opts();
      await runOpenItem(spec("laneAbsent"), { ...o, maxProviderCalls: 50, onCharge: c => charges.push(c),
        seatOverrides: { planner: seat("agy_google", "gemini-4-carbon-high", { transport: "agy-cli" }) } }).catch(() => null);
      const run = JSON.parse(readFileSync(join(o.dir, "run.json"), "utf8"));
      const lane = run.attempts.filter(a => a.vendor === "agy_google");
      assert.notEqual(lane.length, 0, JSON.stringify(run.attempts));
      assert.deepEqual(lane.map(a => [a.provider_requests, a.why]), lane.map(a => [0, a.why]), "the CLI was absent: nothing was spawned, nothing counted");
      assert.match(lane[0].why, /CLI absent/);
      assert.equal(charges.filter(c => c.vendor === "agy_google").length, 0, "the caller was charged nothing for it");
      assert.equal(run.provider_calls.made, charges.length, "the run's bound and the caller's charge count the same calls");
    });
  });
});

test("L-301: runAgyCliTurn charges between its jail build and its spawn; a refused charge spawns nothing; a failure before the jail charges nothing", real, async () => {
  const dir = mkdtempSync(join(tmpdir(), "r3a3-lane-"));
  try {
    await withFakeAgy(dir, async ({ agy }) => {
      const wt = mkdtempSync(join(tmpdir(), "r3a3-wt-"));
      try {
        const at = [];
        const r = await runAgyCliTurn({ cli: process.env.PANTHEON_AGY_CLI, repo: REPO, worktree: wt, role: "reviewer", model: "gemini-4-carbon-high", prompt: "VERDICT please", timeoutS: 30,
          charge: () => { at.push({ launched: agy().length, jailed: readdirSync(tmpdir()).some(n => n.startsWith("pantheon-agy-turn-")) }); } });
        assert.deepEqual(at, [{ launched: 0, jailed: true }], "charged once, after the control dir and jail exist, before the CLI ran");
        assert.equal(agy().length, 1, "then the CLI ran once");
        assert.equal(r.provider_requests, 1);
        const refusal = Object.assign(new Error("fixture: the stage's budget is spent"), { code: "PROVIDER_CALL_LIMIT" });
        const e = await runAgyCliTurn({ cli: process.env.PANTHEON_AGY_CLI, repo: REPO, worktree: wt, role: "reviewer", model: "gemini-4-carbon-high", prompt: "again", timeoutS: 30,
          charge: () => { throw refusal; } }).then(() => null, x => x);
        assert.equal(e, refusal, "the charge's own refusal is thrown");
        assert.equal(e.provider_requests, 0);
        assert.equal(agy().length, 1, "nothing was spawned for the refused call");
        let charged = 0;
        const bad = await runAgyCliTurn({ cli: process.env.PANTHEON_AGY_CLI, repo: REPO, worktree: wt, role: "no-such-card", model: "gemini-4-carbon-high", prompt: "x", timeoutS: 30,
          charge: () => { charged++; } }).then(() => null, x => x);
        assert.match(bad.message, /role card .* missing/);
        assert.deepEqual([charged, bad.provider_requests, agy().length], [0, 0, 1], "a turn that fails before the spawn is charged nothing");
      } finally { rmSync(wt, { recursive: true, force: true }); }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("L-301: liveTurn's second contract (admitRequest) charges a lane turn once at its spawn, and pipelineTurns' implementer the same", real, async () => {
  const dir = mkdtempSync(join(tmpdir(), "r3a3-live-"));
  try {
    await withFakeAgy(dir, async ({ agy }) => {
      const kinds = [];
      const turn = await liveTurn({ label: "r3a3" });
      const r = await turn({ vendor: "agy_google", model: "gemini-4-carbon-high", prompt: "VERDICT please", seat: { role: "reviewer" }, admitRequest: ({ kind }) => { kinds.push([kind, agy().length]); } });
      assert.equal(r.transport, "agy-cli");
      assert.deepEqual(kinds, [["lane", 0]], "one lane call, charged before the CLI was launched");
      assert.equal(agy().length, 1);
      // The pipeline's implementer (runAgyWorkerTurn): charged after its jail is built, before its spawn; refused -> no spawn.
      const wt = mkdtempSync(join(tmpdir(), "r3a3-unit-")), ctl = mkdtempSync(join(tmpdir(), "r3a3-ctl-"));
      try {
        const turns = pipelineTurns({ turn: async () => ({ text: "", served_model: null }) });
        const unitKinds = [];
        await turns.implementer({ vendor: "agy_google", model: "gemini-4-hydrogen-medium", prompt: "the single implementer of work unit \"u\"\nPATHS YOU OWN\n- u.mjs\nDo not commit", cwd: wt, control_dir: ctl,
          owned_paths: ["u.mjs"], unit_id: "u", admitRequest: ({ kind }) => { unitKinds.push([kind, agy().length]); } });
        assert.deepEqual(unitKinds, [["lane", 1]], "the worker session charged once, before its launch");
        assert.equal(agy().length, 2);
        const refusal = Object.assign(new Error("fixture: refused"), { code: "PROVIDER_LIMIT" });
        const e = await turns.implementer({ vendor: "agy_google", model: "gemini-4-hydrogen-medium", prompt: "the single implementer of work unit \"u\"", cwd: wt, control_dir: ctl,
          owned_paths: ["u.mjs"], unit_id: "u", admitRequest: () => { throw refusal; } }).then(() => null, x => x);
        assert.equal(e, refusal);
        assert.deepEqual([e.provider_requests, agy().length], [0, 2], "refused: nothing was spawned");
      } finally { rmSync(wt, { recursive: true, force: true }); rmSync(ctl, { recursive: true, force: true }); }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("L-301: the model client's sendModelTurn charges EVERY generation request (each continuation hop), the first included, and a refused hop is not sent", async () => {
  const sent = [];
  const client = { models: { countTokens: async () => ({ totalTokens: 10 }), generateContent: async req => {
    const tok = req.config?.continuationToken ?? null, hop = tok === null ? 1 : Number(tok.slice(1)) + 1;
    sent.push(hop);
    return { candidates: [{ finishReason: hop < 3 ? "CONTINUATION" : "STOP", continuationToken: hop < 3 ? `c${hop}` : undefined, content: { parts: [{ text: `h${hop} ` }] } }] };
  } } };
  const charged = [];
  const r = await sendModelTurn({ client, vendor: "agy_google", model: "gemini-4-hydrogen", prompt: "x", onRequest: ({ request, kind }) => { charged.push([request, kind, sent.length]); } });
  assert.equal(r.complete, true);
  assert.deepEqual(sent, [1, 2, 3]);
  assert.deepEqual(charged, [[1, "generation", 0], [2, "generation", 1], [3, "generation", 2]], "each charged before it was sent");
  sent.length = 0;
  const e = await sendModelTurn({ client, vendor: "agy_google", model: "gemini-4-hydrogen", prompt: "x", onRequest: ({ request }) => { if (request === 2) throw new Error("fixture bound"); } }).then(() => null, x => x);
  assert.match(e.message, /fixture bound/);
  assert.deepEqual(sent, [1], "the refused hop was not sent");
});

// ---- L-306: the stop reaches the board's Antigravity seat (CLI and SDK transports) ----------------------------------

test("L-306 (self-audit round 3, assignment 3 (sealed bb1287a)): an aborted runOpenItem kills its agy lane process group; it does not run on to the CLI's timeout", real, async () => {
  await withDispatch(async ({ dir, spec, opts }) => {
    // This fixture's own fake CLI, by its path: another run's agy processes on the host are not counted.
    const mine = `${dir}/fake-agy.*gemini-4-carbon-high`;
    await withEnv({ FAKE_AGY_HANG: "gemini-4-carbon-high", PANTHEON_AGY_TIMEOUT: "30" }, async () => {
      const ac = new AbortController();
      let started = 0, aliveAtAbort = "";
      const progress = ev => {
        if (ev.event === "turn.start" && ev.seat === "agy_google" && !started) {
          started = Date.now();
          setTimeout(() => { aliveAtAbort = pgrep(mine); ac.abort(Object.assign(new Error("STAGE_ELAPSED: the caller stopped the run"), { code: "STAGE_ELAPSED" })); }, 1500);
        }
      };
      await runOpenItem(spec("laneHang"), { ...opts(), maxProviderCalls: 20, signal: ac.signal, progress,
        seatOverrides: { planner: seat("agy_google", "gemini-4-carbon-high", { transport: "agy-cli" }) } }).catch(() => null);
      assert.ok(started > 0, "the lane turn started");
      assert.ok(aliveAtAbort.length > 0, "the lane's agy process was running when the stop came");
      await sleep(3000);
      assert.equal(pgrep(mine), "", "3 s after the stop no agy process of the lane is left");
    });
  });
});

/** A fake python for the agy SDK seat: records its environment, then answers (or hangs for FAKE_SDK_HANG). */
function fakePython(dir) {
  const file = join(dir, "fake-python");
  writeFileSync(file, `#!/bin/sh
env > "${join(dir, "sdk-env.txt")}"
out=""; model=""; prev=""
for a in "$@"; do [ "$prev" = "--out" ] && out="$a"; [ "$prev" = "--model" ] && model="$a"; prev="$a"; done
if [ -n "$FAKE_SDK_HANG" ]; then sleep 60; fi
printf 'VERDICT: approve\\n' > "$out/response.md"
# The envelope names the model the seat ran, as scripts/agy-seat.py's does ("model": its --model); the board compares it
# with the model asked for before it reads the answer (L-504 invariant 3).
printf '{"ok":true,"model":"%s","conversation_id":"fake-sdk","usage":{"input_tokens":1,"output_tokens":1}}\\n' "$model"
`, { mode: 0o755 });
  return file;
}
const SYNTHETIC = { OPENAI_API_KEY: "sk-SYNTHETIC-openai-r3a3", ANTHROPIC_API_KEY: "sk-ant-SYNTHETIC-r3a3", XAI_API_KEY: "xai-SYNTHETIC-r3a3",
  CONTROLLER_SECRET_TOKEN: "SYNTHETIC-controller-token-r3a3", GEMINI_API_KEY: "gk-SYNTHETIC-gemini-r3a3" };

test("L-410 (self-audit round 3, assignment 3 (sealed bb1287a)): the python SDK seat gets the allowlist plus the Gemini credential only, never the other provider keys", async () => {
  await withDispatch(async ({ dir, spec, opts }) => {
    const python = fakePython(dir);
    await withEnv({ ...SYNTHETIC, PANTHEON_AGY_TRANSPORT: "sdk", PANTHEON_AGY_PYTHON: python }, async () => {
      const r = await runOpenItem(spec("sdkEnv"), { ...opts(), maxProviderCalls: 50, billing: optIn({ primary: 100 }), seatOverrides: { reviewer: seat("agy_google", "gemini-3.8-flash", { transport: "agy" }) } });
      const run = readRun(r);
      assert.ok(run.turns.some(t => t.vendor === "agy_google" && t.purpose === "critique"), JSON.stringify(run.turns.map(t => [t.purpose, t.vendor])));
      const env = Object.fromEntries(lines(join(dir, "sdk-env.txt")).map(l => /^([^=]*)=(.*)$/s.exec(l)).filter(Boolean).map(m => [m[1], m[2]]));
      assert.equal(env.GEMINI_API_KEY, SYNTHETIC.GEMINI_API_KEY, "the credential this seat is billed with is passed");
      for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "CONTROLLER_SECRET_TOKEN"]) assert.equal(env[k], undefined, `${k} never reaches the SDK seat`);
      const text = readFileSync(join(dir, "sdk-env.txt"), "utf8");
      for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "CONTROLLER_SECRET_TOKEN"]) assert.equal(text.includes(SYNTHETIC[k]), false, `no value of ${k} anywhere in its env`);
      assert.deepEqual(agySdkEnvOf({ ...SYNTHETIC, PATH: "/bin" }).credentials, ["GEMINI_API_KEY"]);
    });
  });
});

test("L-306: an aborted runOpenItem kills its python SDK seat too", async () => {
  await withDispatch(async ({ dir, spec, opts }) => {
    const python = fakePython(dir);
    await withEnv({ ...SYNTHETIC, PANTHEON_AGY_TRANSPORT: "sdk", PANTHEON_AGY_PYTHON: python, FAKE_SDK_HANG: "1" }, async () => {
      const ac = new AbortController();
      let started = 0, aliveAtAbort = "";
      const progress = ev => {
        if (ev.event === "seat.env" && !started) {
          started = Date.now();
          setTimeout(() => { aliveAtAbort = pgrep(`${python}`); ac.abort(Object.assign(new Error("STAGE_ELAPSED: stopped"), { code: "STAGE_ELAPSED" })); }, 1500);
        }
      };
      await runOpenItem(spec("sdkHang"), { ...opts(), maxProviderCalls: 50, billing: optIn({ primary: 100 }), signal: ac.signal, progress,
        seatOverrides: { reviewer: seat("agy_google", "gemini-3.8-flash", { transport: "agy" }) } }).catch(() => null);
      assert.ok(started > 0, "the SDK seat started");
      assert.ok(aliveAtAbort.length > 0, "its process was running when the stop came");
      await sleep(2000);
      assert.equal(pgrep(`${python}`), "", "no SDK seat process is left after the stop");
    });
  });
});

// ---- L-407: the board's Antigravity reviewer runs the acceptance command, in the verify jail -------------------------

/**
 * A fake agy CLI for a SINGLE-TURN seat that uses its command the way the real CLI does: every run_command goes first
 * through the PreToolUse hooks of ./.agents/hooks.json (the real jail hook), and only an auto_approve runs. It tries the
 * acceptance launcher named in its prompt AND a direct `cat` of a synthetic secret, and answers with what happened.
 */
function fakeCommandCli(dir, secretPath) {
  const file = join(dir, "fake-agy-cmd.mjs");
  writeFileSync(file, `#!${process.execPath}
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2), at = k => argv[argv.indexOf(k) + 1];
const agent = at("--agent"), model = at("--model"), prompt = at("--print") ?? "";
const conf = JSON.parse(readFileSync(join(process.cwd(), ".agents", "hooks.json"), "utf8"));
const hook = Object.values(conf).flatMap(v => v?.PreToolUse ?? []).flatMap(g => g.hooks ?? [])[0];
const ask = cmd => {
  const h = spawnSync("sh", ["-c", hook.command], { cwd: join(process.cwd(), ".agents"), input: JSON.stringify({ stepIdx: 1, modelName: model, toolCall: { name: "run_command", id: "c1", args: { CommandLine: cmd } } }), encoding: "utf8" });
  return JSON.parse(h.stdout.trim().split("\\n").pop()).decision;
};
const launcher = (/ACCEPTANCE COMMAND[^\\n]*\\n\\s+(\\S+)/.exec(prompt) ?? [])[1] ?? null;
const out = [];
if (launcher) {
  const d = ask(launcher);
  out.push("LAUNCHER:" + d);
  if (d === "auto_approve") { const r = spawnSync("sh", ["-c", launcher], { encoding: "utf8" }); out.push("EXIT:" + r.status, r.stdout.trim()); }
} else out.push("LAUNCHER:none");
const direct = "cat ${secretPath}";
out.push("DIRECT:" + ask(direct));
const reply = out.join("\\n") + "\\nVERDICT: approve";
process.stdout.write(JSON.stringify({ event: "init", conversation_id: "fake-cmd", init: { model, agent } }) + "\\n");
process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", conversation_id: "fake-cmd", num_turns: 1, response: reply, usage: { input_tokens: 1, output_tokens: 1 } } }) + "\\n");
`, { mode: 0o755 });
  return file;
}

test("L-407 (self-audit round 3, assignment 3 (sealed bb1287a)): the board's Antigravity reviewer runs the acceptance command through the verify launcher, and the command cannot reach a synthetic credential", real, async () => {
  await withDispatch(async ({ dir, spec, opts }) => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "r3a3-home-")));
    try {
      mkdirSync(join(home, ".ssh"), { recursive: true });
      mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
      const sshSecret = join(home, ".ssh", "id_synthetic");
      writeFileSync(sshSecret, "SYNTHETIC-SSH-SECRET-r3a3");
      const o = opts();
      mkdirSync(o.dir, { recursive: true });
      const boardSecret = join(o.dir, "board-secret.txt");
      writeFileSync(boardSecret, "SYNTHETIC-BOARD-SECRET-r3a3");
      // The acceptance command's code: it reports what it can reach, never fails on it.
      writeFileSync(join(dir, "probe.mjs"), `import fs from "node:fs";
console.log("PROBE-RAN");
console.log("ENV-SYNTHETIC:" + /SYNTHETIC/.test(JSON.stringify(process.env)));
for (const [k, p] of Object.entries(${JSON.stringify({ ssh: sshSecret, board: boardSecret })})) {
  try { console.log("LEAK:" + k + ":" + fs.readFileSync(p, "utf8")); } catch (e) { console.log("UNREACHABLE:" + k + ":" + e.code); }
}
`);
      const cli = fakeCommandCli(dir, sshSecret);
      await withEnv({ ...SYNTHETIC, HOME: home, PANTHEON_AGY_CLI: cli }, async () => {
        const r = await runOpenItem(spec("l407", { copy: ["probe.mjs"], acceptance_cmd: "node probe.mjs" }), { ...o, maxProviderCalls: 50,
          seatOverrides: { reviewer: seat("agy_google", "gemini-4-carbon-high", { transport: "agy-cli" }) } });
        const run = readRun(r);
        const critique = run.turns.find(t => t.vendor === "agy_google" && t.purpose === "critique");
        assert.ok(critique, JSON.stringify(run.turns.map(t => [t.purpose, t.vendor, t.model])));
        const dirs = readdirSync(join(r.outDir, "agy_google")).filter(n => n.startsWith("critique-"));
        const reply = readFileSync(join(r.outDir, "agy_google", dirs.at(-1), "response.md"), "utf8");
        assert.match(reply, /^LAUNCHER:auto_approve$/m, "the jail hook approved the acceptance launcher");
        assert.match(reply, /^EXIT:0$/m);
        assert.match(reply, /^PROBE-RAN$/m, "the acceptance command ran");
        assert.match(reply, /^ENV-SYNTHETIC:false$/m, "no synthetic credential is in its environment");
        assert.match(reply, /^UNREACHABLE:ssh:ENOENT$/m, "the home's secret dir does not exist in the verify jail");
        assert.match(reply, /^UNREACHABLE:board:ENOENT$/m, "the run dir around the worktree does not exist in the verify jail");
        assert.match(reply, /^DIRECT:deny$/m, "any other command is denied by the hook");
        assert.equal(/SYNTHETIC-|sk-SYNTHETIC|xai-SYNTHETIC/.test(reply), false, "no synthetic secret value reached the seat's answer");
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
