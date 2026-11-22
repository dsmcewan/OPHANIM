// THE ANTIGRAVITY SDK TRANSPORT INSIDE THE PIPELINE (owner direction 2026-11-19: the Google implementation transport is
// the official google-antigravity SDK on the Gemini API; an implementer's subagents are its own, on gemini-4-hydrogen,
// within a ceiling the controller enforces).
//
// What these tests pin, at the pipeline's own entries (runPipeline + the production pipelineTurns):
//   - an SDK seat runs on the SDK transport: the agy CLI is not started and no A2A shim (the Grok relay) is opened;
//   - every billed request of a session is charged at its point of spend, by class;
//   - the session's evidence (subagents, gateway, availability, tool decisions) is on the attempt record, also when
//     the session failed; the tool log is a file whose digest the record carries;
//   - the subagents of an attempt whose writes were kept are `subtask` contributors on gemini-4-hydrogen, and the
//     checkpoint of an approved unit carries them;
//   - the ladder: a model the provider does not serve and a quota refusal step past that model's other thinking levels
//     at once, with the cause recorded; a rejection raises the thinking level; a transport failure is retried once;
//   - a refused key, a missing key, a missing jail and a missing SDK block the unit at once.
// The session is SCRIPTED in all but the last test (`antigravity.run`, the stand-in for antigravity/turn.mjs
// runAntigravitySdkTurn, whose own behaviour is pinned by antigravity-turn.test.mjs and, on the installed SDK, by
// antigravity-sdk-contract.test.mjs). The last test runs the real runAntigravitySdkTurn (its gateway, governor and
// decisions) against a scripted bridge and a scripted provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPipeline } from "../src/pipeline/index.mjs";
import { readPartial, partialFile, partialRefusal, checkpointFile, sealOf, PARTIAL_SCHEMA } from "../src/pipeline/checkpoint.mjs";
import { pipelineTurns } from "../src/pipeline/turns.mjs";
import { IMPLEMENTER_PROMPT, laneFailureOf } from "../src/pipeline/implement.mjs";
import { subagentGovernor } from "../src/antigravity/subagents.mjs";
import { contributorKeys } from "../src/review/identity.mjs";
import { tempRepo, seats, unit, scripted, write, reject, approve, RUBRIC, PLANNER } from "./fixtures/pipeline-stages.mjs";
import { startFakeGemini, text } from "./fixtures/fake-gemini.mjs";
import { optIn } from "./fixtures/billing.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_BRIDGE = join(HERE, "fixtures", "fake-antigravity-bridge.mjs");
const sdkSeat = (model, effort = null) => ({ vendor: "agy_google", model, transport: "antigravity-sdk", effort });
const CARBON = sdkSeat("gemini-4-carbon", "high"), NEON = sdkSeat("gemini-4-neon"), ARGON = sdkSeat("gemini-4-argon", "high"), HYDROGEN = e => sdkSeat("gemini-4-hydrogen", e);
const HARD = [CARBON, HYDROGEN("xhigh"), ARGON];
const EASY = [HYDROGEN("medium"), HYDROGEN("high"), HYDROGEN("xhigh"), sdkSeat("gemini-3.8-flash", "high")];
const rung = s => `${s.model}@${s.effort ?? "-"}`;
const sha256 = b => "sha256:" + createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------------------------- the scripted session
const sdkError = (code, message, more = {}) => Object.assign(new Error(message), { code, transport: "antigravity-sdk", ...more });
const laneError = (kind, more = {}) => sdkError("lane_failure", `the Antigravity SDK session failed (${kind})`, { kind, ...more });
const RUNTIME = { python: "3.12.3", sdk: { status: "installed", distribution: "google-antigravity", version: "0.1.24" }, harness: { bytes: 1, sha256: "sha256:00" } };

/** The governor's record of a session that asked for `spawned` ([{type, prompt?, model?}]) subagents, one call each: what turn.mjs returns as `subagents`. */
function governed(args, spawned = []) {
  const g = subagentGovernor({ implementer: { vendor: args.seat.vendor, model: args.seat.model }, unit_id: args.unit.unit_id, allowed_types: args.unit.allowed_subagents });
  g.observe({ event: "trajectory_state", trajectory_id: "root", parent_trajectory_id: "", depth: 0, state: "RUNNING" });
  spawned.forEach((s, i) => {
    const prompt = s.prompt ?? `Assignment ${i + 1}: list every caller of the function this unit changes, with file paths.`;
    const d = g.admit({ call_id: `call-${i + 1}`, trajectory_id: "root", args: { Subagents: [{ TypeName: s.type, Role: s.role ?? s.type, Prompt: prompt, ...(s.model ? { Model: s.model } : {}) }] } });
    if (!d.allow) return;
    const id = `child-${i + 1}`;
    g.observe({ event: "child_started", trajectory_id: id, parent_trajectory_id: "root", prompt });
    for (const state of ["RUNNING", "FULLY_IDLE"]) g.observe({ event: "trajectory_state", trajectory_id: id, parent_trajectory_id: "root", depth: 1, state });
    g.observe({ event: "child_output", trajectory_id: id, text: `answer ${i + 1}` });
  });
  return { ...g.record(), blocked: null };
}
const gatewayOf = (args, { root = 0, subs = 0, served = args.seat.model, subServed = ["gemini-4-hydrogen"], stop = null } = {}) => ({ root: { model: args.seat.model }, subagents: { model: "gemini-4-hydrogen", ceiling: subs ? 8 : 0 },
  totals: { received: root + subs, forwarded: root + subs, refused: 0, by_class: { root, subagent: subs, aux: 0 } }, sessions: [], subagent_sessions: 0,
  served_models: { ...(root ? { [args.seat.model]: [served] } : {}), ...(subs ? { "gemini-4-hydrogen": [...subServed] } : {}) }, budget_refusals: 0, stop, aborted: null, refusals: [] });
const TOOL_LOG = [
  { n: 1, at: "t", tool: "view_file", who: "implementer", allow: true, code: null, reason: "a read inside the worktree" },
  { n: 2, at: "t", tool: "invoke_subagent", who: "implementer", allow: true, code: null, reason: "1 Hydrogen subagent(s) admitted (1 of 8 live)" },
  { n: 3, at: "t", tool: "create_file", who: "sa-1", allow: false, code: "SUBAGENT_SCOPE", reason: "a code-explorer subagent reads only: it may not write" },
  { n: 4, at: "t", tool: "create_file", who: "implementer", allow: true, code: null, reason: "inside the unit's owned paths" },
  { n: 5, at: "t", tool: "run_command", who: "implementer", allow: false, code: "COMMAND_REFUSED", reason: "only the unit's verify command runs" },
];

/**
 * A session that ended well, as runAntigravitySdkTurn runs one: every billed request is admitted before it is "sent"
 * (the gateway's `admit`; a refusal ends the session as PROVIDER_LIMIT), the files are written, the result returned.
 */
async function session(args, { root = 1, spawned = [], perSubagent = 1, files = null, served = args.seat.model, subServed = ["gemini-4-hydrogen"], source = "provider", tool_log = [], extra = {} } = {}) {
  const subagents = governed(args, spawned);
  let n = 0;
  const bill = async (cls, type = null) => {
    try { await args.admit({ class: cls, type, model: cls === "subagent" ? "gemini-4-hydrogen" : args.seat.model, n: ++n }); }
    catch (e) { throw sdkError("PROVIDER_LIMIT", `the run's provider-call bound refused a request of the implementer session: ${e.message}`, { subagents, gateway: gatewayOf(args, { stop: { kind: "budget", status: 429 } }), tool_log, usage: null, runtime: RUNTIME, availability: [] }); }
  };
  await bill("root");
  for (const inst of subagents.instances) for (let k = 0; k < perSubagent; k++) await bill("subagent", inst.type);
  for (let k = 1; k < root; k++) await bill("root");
  for (const [p, t] of Object.entries(files ?? { [`src/${args.unit.unit_id}/impl.mjs`]: "export const ok = true;\n" })) await write(args.worktree, p, t);
  const subs = subagents.instances.length * perSubagent;
  return { text: "done", structured_output: null, stop_reason: "UNSPECIFIED", served_model: served, served_model_source: source, transport: "antigravity-sdk", requested_model: args.seat.model, effort: args.seat.effort ?? null,
    conversation_id: "conv-1", tool_calls: tool_log.length, subagents, usage: { total_token_count: 100 * (root + subs) }, trajectory_usages: null, gateway: gatewayOf(args, { root, subs, served, subServed }),
    availability: [{ model: args.seat.model, at: "t", available: true, status: 200, kind: null, limits: { input_token_limit: 1048576, output_token_limit: 65536 }, name: `models/${args.seat.model}`, why: null }],
    tool_log, capabilities: { trajectory_events: true, define_subagent_disabled: true }, runtime: RUNTIME, sandbox: { enabled: false, why: "disabled by the caller" }, launch: null, duration_s: 1.5, ...extra };
}
/** A session the provider would not serve: thrown as turn.mjs throws it, with what was recorded up to it. */
const unavailable = args => sdkError("model_unavailable", `the provider does not serve ${args.seat.model} (HTTP 404): models/${args.seat.model} is not found; nothing is substituted here`,
  { status: 404, model: args.seat.model, subagents: governed(args), gateway: gatewayOf(args), tool_log: [], usage: null, runtime: null,
    availability: [{ model: args.seat.model, at: "t", available: false, status: 404, kind: "model_unavailable", limits: null, name: null, why: `models/${args.seat.model} is not found` }] });
const quota = args => sdkError("quota_exhausted", `${args.seat.model} was refused for quota by the provider (HTTP 429 RESOURCE_EXHAUSTED)`, { status: 429, quota: { explicit: true, matched: "RESOURCE_EXHAUSTED" },
  subagents: governed(args), gateway: gatewayOf(args, { root: 1, stop: { kind: "quota", status: 429 } }), tool_log: [], usage: null, runtime: RUNTIME, availability: [] });

// ---------------------------------------------------------------------------------- the pipeline around it
const PLAN = () => [unit("a", { difficulty: "hard", allowed_subagents: ["code-explorer", "test-constructor"] })];
async function pipeline(t, script, { plan = PLAN(), ladder = HARD, limits = {}, review = null, checkpoints = null, onCharge = null, env = null, antigravity = {}, agy = {} } = {}) {
  if (!env) { env = await tempRepo(); t.after(env.cleanup); }
  const calls = [], cli = [], subagentSeats = [];
  const turns = pipelineTurns({
    turn: async () => { throw new Error("no single-turn seat goes through pipelineTurns in this test"); },
    // The SDK implementer is a PRIMARY seat of the Gemini billing policy (register L-136; default off). It is declared
    // here, with a budget, since every other test in this file is about a session that runs; the policy's own test is below.
    agy: { run: async a => { cli.push(a); throw new Error("the agy CLI must not be started for an SDK seat"); }, billing: optIn({ primary: 1000 }), ...agy },
    antigravity: { run: async a => { calls.push(a); return script(a, calls.length); }, ...antigravity },
  });
  const s = scripted({ plan, ...(review ? { review } : {}) });
  const out = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, dir: env.dir, planner: PLANNER, limits, ...(checkpoints ? { checkpoints } : {}), ...(onCharge ? { onCharge } : {}),
    turns: { ...s.turns, implementer: turns.implementer },
    seats: seats({ implementer: () => ({ seat: { ...ladder[0] }, ladder: ladder.map(x => ({ ...x })) }), subagent: (u, role) => { subagentSeats.push(role); return { vendor: "xai", model: "grok-4.5" }; } }) });
  return { out, u: out.units[plan[0].unit_id], calls, cli, s, subagentSeats, env, disk: () => JSON.parse(readFileSync(join(env.dir, "pipeline.json"), "utf8")) };
}

test("an SDK implementer seat runs on the SDK transport: the agy CLI is not started and no A2A shim is opened", async t => {
  const r = await pipeline(t, args => session(args));
  assert.equal(r.u.status, "approved", r.u.reason);
  assert.equal(r.cli.length, 0, "the agy CLI was not asked");
  assert.equal(r.calls.length, 1);
  const c = r.calls[0];
  assert.deepEqual([c.seat.vendor, c.seat.model, c.seat.effort], ["agy_google", "gemini-4-carbon", "high"]);
  assert.deepEqual(c.unit, { unit_id: "a", owned_paths: ["src/a/**"], verify_cmd: "test -f src/a/impl.mjs", allowed_subagents: ["code-explorer", "test-constructor"] });
  assert.equal(c.worktree, join(r.env.dir, "worktrees", "a"));
  assert.equal(c.control_dir, join(r.env.dir, "control", "a"));
  assert.equal(typeof c.admit, "function");
  assert.ok(c.timeoutS > 0 && c.graceS > 0);
  const a = r.u.attempts[0];
  assert.deepEqual([a.vendor, a.model, a.transport, a.effort, a.level, a.status, a.served_model, a.served_model_source, a.requested_model],
    ["agy_google", "gemini-4-carbon", "antigravity-sdk", "high", 0, "written", "gemini-4-carbon", "provider", "gemini-4-carbon"]);
  // No Grok relay: the unit's subagents are the SDK's own.
  assert.equal(r.u.a2a.socket, null);
  assert.deepEqual(r.u.a2a.calls, []);
  assert.deepEqual(r.subagentSeats, [], "no A2A subagent seat was asked for");
  assert.equal(existsSync(join(r.env.dir, "control", "a", "a2a.sock")), false);
  assert.equal(r.out.status, "completed");
});

test("a seat that is neither an SDK seat nor an Antigravity lane is still refused by the implementer turn", async () => {
  const turns = pipelineTurns({ turn: async () => ({ text: "", served_model: null }), antigravity: { run: async () => { throw new Error("not reached"); } } });
  await assert.rejects(turns.implementer({ vendor: "agy_google", model: "gemini-4-carbon", seat: { vendor: "agy_google", model: "gemini-4-carbon" }, prompt: "p", cwd: "/tmp" }), e => e.code === "NOT_A_LANE");
});

test("the SDK implementer turn enters no session without a worktree, nor when the stage's deadline leaves no time for one; a session it does start is bounded by what the deadline leaves", async t => {
  const env = await tempRepo();
  t.after(env.cleanup);
  const entered = [];
  const turns = pipelineTurns({ turn: async () => ({ text: "", served_model: null }), agy: { billing: optIn({ primary: 10 }) }, antigravity: { graceS: 5, run: async a => { entered.push(a); return session(a); } } });
  const ask = over => turns.implementer({ vendor: CARBON.vendor, model: CARBON.model, seat: CARBON, prompt: "p", cwd: env.repo, unit_id: "a", owned_paths: ["src/a/**"], ...over });
  await assert.rejects(ask({ cwd: undefined }), { code: "NO_WORKTREE" });
  // 5 s of kill grace and a 1 s turn do not fit in the 3 s the stage has left.
  await assert.rejects(ask({ deadline: Date.now() + 3000 }), e => e.code === "DEADLINE" && /leaves no time for an implementer session/.test(e.message));
  assert.equal(entered.length, 0, "the transport was entered for neither");
  await ask({ deadline: Date.now() + 60_000, timeoutS: 600 });
  assert.deepEqual([entered.length, entered[0].graceS], [1, 5]);
  assert.ok(entered[0].timeoutS >= 50 && entered[0].timeoutS <= 55, `600 s asked, 60 s left, 5 s of grace: the session was given ${entered[0].timeoutS} s`);
});

test("a seat of the SDK transport is never asked as a single-turn seat: no relay reaches Hydrogen through a lane or the metered API", async () => {
  // The fit matrix's subagent row is the implementer's OWN subagents (native Hydrogen). Were that seat handed to the
  // A2A relay's single-turn path, it would be served lane-first by the agy CLI (sdk/agy-turn.mjs). It is refused instead.
  const asked = [];
  const turns = pipelineTurns({ turn: async a => { asked.push(a); return { text: "x", served_model: a.model }; } });
  const native = { vendor: "agy_google", model: "gemini-4-hydrogen", transport: "antigravity-sdk", native: true };
  for (const role of ["subagent", "dispatcher", "reviewer"]) {
    await assert.rejects(turns[role]({ vendor: native.vendor, model: native.model, seat: native, prompt: "q" }), e => e.code === "SDK_SEAT_NOT_SINGLE_TURN" && /runs as a session/.test(e.message), role);
  }
  assert.equal(asked.length, 0, "nothing was sent");
  // A seat that does not say it is an SDK seat is asked as before.
  await turns.subagent({ vendor: "xai", model: "grok-4.6", seat: { vendor: "xai", model: "grok-4.6" }, prompt: "q" });
  assert.equal(asked.length, 1);
});

test("every billed request of a session is charged at its point of spend, by class", async t => {
  const charged = [];
  const r = await pipeline(t, args => session(args, { root: 3, spawned: [{ type: "code-explorer" }, { type: "test-constructor" }], perSubagent: 2 }), { onCharge: ({ role }) => charged.push(role) });
  assert.equal(r.u.status, "approved", r.u.reason);
  assert.deepEqual(r.out.provider_calls.by_role, { dispatcher: 1, implementer: 1, subagent: 0, reviewer: 1, native_subagent: 4, continuation: 2 });
  assert.equal(r.out.provider_calls.total, 9);
  assert.deepEqual(charged, ["dispatcher", "implementer", "native_subagent", "native_subagent", "native_subagent", "native_subagent", "continuation", "continuation", "reviewer"],
    "the caller's ledger is charged each request, in the order they were made");
});

test("the run's provider-call bound refuses a request inside the session: it is not made, and the unit blocks", async t => {
  // dispatcher 1 + the session's first request 1 + one subagent request 1 = the bound; the next request is refused.
  const r = await pipeline(t, args => session(args, { spawned: [{ type: "code-explorer" }], perSubagent: 3 }), { limits: { max_provider_calls: 3 } });
  assert.equal(r.u.status, "blocked");
  assert.equal(r.u.attempts[0].code, "PROVIDER_LIMIT");
  assert.equal(r.out.provider_calls.total, 3, "nothing past the bound was charged");
  assert.equal(r.out.provider_calls.refused_at_limit, 1);
  assert.deepEqual(r.out.provider_calls.by_role, { dispatcher: 1, implementer: 1, subagent: 0, reviewer: 0, native_subagent: 1 });
  assert.equal(r.u.attempts[0].session.subagents.admitted_total, 1, "what the failed session recorded is kept");
});

test("the session's subagents are on the attempt record, and are subtask contributors on gemini-4-hydrogen", async t => {
  const r = await pipeline(t, args => session(args, { spawned: [{ type: "code-explorer" }, { type: "test-constructor" }, { type: "code-explorer" }, { type: "code-explorer", model: "pro" }] }));
  assert.equal(r.u.status, "approved", r.u.reason);
  const s = r.u.attempts[0].session.subagents;
  assert.deepEqual([s.model, s.ceiling, s.admitted_total, s.peak_live, s.implementer.model], ["gemini-4-hydrogen", 8, 3, 3, "gemini-4-carbon"]);
  assert.deepEqual(s.instances.map(i => [i.id, i.type, i.model, i.status, i.scope.write !== "none", i.tools.includes("create_file"), i.call_id, typeof i.prompt_digest, i.output.bytes]), [
    ["sa-1", "code-explorer", "gemini-4-hydrogen", "idle", false, false, "call-1", "string", 8],
    ["sa-2", "test-constructor", "gemini-4-hydrogen", "idle", true, true, "call-2", "string", 8],
    ["sa-3", "code-explorer", "gemini-4-hydrogen", "idle", false, false, "call-3", "string", 8]]);
  assert.deepEqual(s.rejections.map(x => x.code), ["SUBAGENT_MODEL_OVERRIDE"], "the attempt to name a model for a child is on the record");
  // Lineage: the work is Carbon's, with Hydrogen subagents. Both are excluded from every later review of it.
  // (One row per unit and model: contributions are de-duplicated by model. Each instance is on the attempt, above.)
  assert.deepEqual(r.out.contributions.filter(c => c.kind !== "plan").map(c => [c.kind, c.unit_id, c.role, c.vendor, c.model, c.served_model, c.served_model_source]), [
    ["subtask", "a", "subagent:code-explorer+test-constructor", "agy_google", "gemini-4-hydrogen", "gemini-4-hydrogen", "provider"],
    ["work", "a", "implementer", "agy_google", "gemini-4-carbon", "gemini-4-carbon", "provider"]]);
  assert.deepEqual(r.disk().contributions, r.out.contributions);
  assert.deepEqual(r.disk().units.a.attempts[0].session.subagents, s);
});

test("the subagents' contributor rows carry every name the provider answered them under; a subagent that was never answered is carried as unnamed, never as the model asked", async t => {
  const rows = r => r.out.contributions.filter(c => c.kind === "subtask").map(c => [c.role, c.model, c.served_model, c.served_model_source]);
  // Two declared names of one model (a dated snapshot beside the base name): two rows of one identity, and nothing blocks.
  const dated = await pipeline(t, args => session(args, { spawned: [{ type: "code-explorer" }], perSubagent: 2, subServed: ["gemini-4-hydrogen", "gemini-4-hydrogen-20261101"] }));
  assert.equal(dated.u.status, "approved", dated.u.reason);
  assert.deepEqual(rows(dated), [["subagent:code-explorer", "gemini-4-hydrogen", "gemini-4-hydrogen", "provider"], ["subagent:code-explorer", "gemini-4-hydrogen", "gemini-4-hydrogen-20261101", "provider"]]);
  // Admitted, and no request of it was answered: the pinned model is the contributor, its served model unknown (the
  // marker the identity rows use for that, review/identity.mjs SERVED_SOURCES), with no name invented for it.
  const unnamed = await pipeline(t, args => session(args, { spawned: [{ type: "code-explorer" }], subServed: [] }));
  assert.equal(unnamed.u.status, "approved", unnamed.u.reason);
  assert.deepEqual(rows(unnamed), [["subagent:code-explorer", "gemini-4-hydrogen", null, "unnamed"]]);
  assert.deepEqual(contributorKeys(unnamed.out.contributions).unresolved, []);
  assert.ok(contributorKeys(unnamed.out.contributions).models.includes("google/gemini-4-hydrogen"), "the pinned model is excluded from review all the same");
});

test("the session's evidence is on the attempt: gateway, availability, usage, runtime, jail, and the tool decisions with their log file", async t => {
  const r = await pipeline(t, args => session(args, { tool_log: TOOL_LOG, spawned: [{ type: "code-explorer" }], extra: { tool_log_dropped: 2 } }));
  const x = r.u.attempts[0].session;
  assert.deepEqual([x.stop_reason, x.conversation_id, x.duration_s, x.usage.total_token_count], ["UNSPECIFIED", "conv-1", 1.5, 200]);
  assert.deepEqual(x.gateway.totals.by_class, { root: 1, subagent: 1, aux: 0 });
  assert.deepEqual(x.availability.map(a => [a.model, a.available, a.status]), [["gemini-4-carbon", true, 200]]);
  assert.deepEqual(x.runtime.sdk, RUNTIME.sdk);
  assert.deepEqual(x.jail, { enabled: false, why: "disabled by the caller" });
  assert.deepEqual([x.gateway.served_models, x.gateway.unnamed ?? {}], [{ "gemini-4-carbon": ["gemini-4-carbon"], "gemini-4-hydrogen": ["gemini-4-hydrogen"] }, {}], "who answered, by the provider's own names");
  assert.ok(x.timeout_s > 0);
  const d = x.tool_decisions;
  assert.deepEqual([d.total, d.allowed, d.denied, d.dropped], [5, 3, 2, 2]);
  assert.deepEqual(d.by_code, { COMMAND_REFUSED: 1, SUBAGENT_SCOPE: 1 });
  assert.deepEqual(d.by_who, { implementer: { allowed: 3, denied: 1 }, "sa-1": { allowed: 0, denied: 1 } });
  // The whole log is a file in the unit's control dir; the record carries its digest, not its rows.
  assert.equal(dirname(d.log_file), join(r.env.dir, "control", "a", "sessions"));
  const bytes = readFileSync(d.log_file);
  assert.equal(d.log_digest, sha256(bytes));
  assert.deepEqual(JSON.parse(bytes.toString("utf8")).tool_log, TOOL_LOG);
  assert.equal(x.tool_log, undefined, "the rows are not copied into the run record");
});

test("the subagents of a discarded attempt are not contributors: only what reached the worktree counts", async t => {
  // Attempt 1 writes outside the unit (the write jail discards everything it wrote); attempt 2 writes the unit alone.
  const r = await pipeline(t, (args, n) => n === 1
    ? session(args, { spawned: [{ type: "test-constructor" }], files: { "src/a/impl.mjs": "x\n", "src/elsewhere.mjs": "x\n" } })
    : session(args), { ladder: [CARBON] });
  assert.equal(r.u.status, "approved", r.u.reason);
  assert.deepEqual(r.u.attempts.map(a => [a.status, a.code, a.session.subagents.admitted_total]), [["refused", "WRITE_JAIL", 1], ["written", null, 0]]);
  assert.deepEqual(r.out.contributions.filter(c => c.kind === "subtask"), []);
  assert.deepEqual(r.out.contributions.filter(c => c.kind === "work").map(c => c.model), ["gemini-4-carbon"]);
});

test("a model the provider does not serve steps the ladder at once, with the cause on the record: nothing is substituted silently", async t => {
  const r = await pipeline(t, (args, n) => { if (args.seat.model === "gemini-4-neon") throw unavailable(args); return session(args); },
    { plan: [unit("a", { difficulty: "medium" })], ladder: [NEON, ARGON], limits: { max_revisions: 0 } });
  assert.equal(r.u.status, "approved", r.u.reason);
  assert.deepEqual(r.calls.map(c => rung(c.seat)), ["gemini-4-neon@-", "gemini-4-argon@high"], "no second try on a model the provider does not serve");
  const a = r.u.attempts[0];
  assert.deepEqual(a.lane_failures.map(f => [f.model, f.kind, f.cause, f.retry, f.next]), [["gemini-4-neon", "model_unavailable", "model_unavailable", false, "next_rung"]]);
  assert.match(a.lane_failures[0].why, /does not serve gemini-4-neon/);
  assert.deepEqual(r.u.escalations.map(e => [e.kind, e.cause, e.from.model, e.to.model, e.to.effort, e.after_attempt]), [["lane_failover", "model_unavailable", "gemini-4-neon", "gemini-4-argon", "high", 1]]);
  assert.deepEqual([a.model, a.effort, a.status, a.level], ["gemini-4-argon", "high", "written", 1], "the work is recorded under the model that did it");
  assert.deepEqual(r.out.contributions.filter(c => c.kind === "work").map(c => c.model), ["gemini-4-argon"]);
  assert.equal(r.out.provider_calls.by_role.implementer, 1, "the availability check is not a billed request");
});

test("an unavailable model takes its other thinking levels with it; with no rung left the unit blocks, and says why", async t => {
  const r = await pipeline(t, args => { throw unavailable(args); }, { plan: [unit("a", { difficulty: "easy" })], ladder: EASY });
  assert.equal(r.u.status, "blocked"); assert.equal(r.u.code, "LANE_LADDER_EXHAUSTED");
  assert.deepEqual(r.calls.map(c => rung(c.seat)), ["gemini-4-hydrogen@medium", "gemini-3.8-flash@high"], "hydrogen@high and @xhigh are the same unavailable model");
  assert.deepEqual(r.u.escalations.map(e => [e.cause, rung(e.from), rung(e.to), e.skipped_same_base.map(rung)]), [["model_unavailable", "gemini-4-hydrogen@medium", "gemini-3.8-flash@high", ["gemini-4-hydrogen@high", "gemini-4-hydrogen@xhigh"]]]);
  assert.match(r.u.reason, /gemini-4-hydrogen: model_unavailable; gemini-3\.8-flash: model_unavailable/);
  assert.deepEqual(r.u.attempts[0].session.availability.map(x => [x.model, x.available, x.status]), [["gemini-3.8-flash", false, 404]], "what the provider answered is on the attempt");
  assert.equal(r.out.provider_calls.by_role.implementer, 0);
});

test("a quota refusal skips the same model's other thinking levels", async t => {
  const r = await pipeline(t, (args, n) => { if (n === 1) throw quota(args); return session(args); }, { plan: [unit("a", { difficulty: "easy" })], ladder: EASY, limits: { max_revisions: 0 } });
  assert.equal(r.u.status, "approved", r.u.reason);
  assert.deepEqual(r.calls.map(c => rung(c.seat)), ["gemini-4-hydrogen@medium", "gemini-3.8-flash@high"]);
  assert.deepEqual(r.u.escalations.map(e => [e.kind, e.cause, rung(e.to)]), [["lane_failover", "quota", "gemini-3.8-flash@high"]]);
  assert.equal(r.u.attempts[0].code, null);
});

test("a rejection raises the thinking level on the same model: two levels of one model are two rungs", async t => {
  const r = await pipeline(t, args => session(args), { plan: [unit("a", { difficulty: "easy" })], ladder: EASY, limits: { max_revisions: 2 },
    review: (args, n) => (n < 3 ? reject(RUBRIC, [`not yet (${n})`]) : approve(RUBRIC)) });
  assert.equal(r.u.status, "approved", r.u.reason);
  assert.deepEqual(r.calls.map(c => rung(c.seat)), ["gemini-4-hydrogen@medium", "gemini-4-hydrogen@high", "gemini-4-hydrogen@xhigh"]);
  assert.deepEqual(r.u.attempts.map(a => [a.model, a.effort, a.level]), [["gemini-4-hydrogen", "medium", 0], ["gemini-4-hydrogen", "high", 1], ["gemini-4-hydrogen", "xhigh", 2]]);
  assert.deepEqual(r.u.escalations.filter(e => e.kind === "implementer").map(e => [rung(e.from), rung(e.to)]), [["gemini-4-hydrogen@medium", "gemini-4-hydrogen@high"], ["gemini-4-hydrogen@high", "gemini-4-hydrogen@xhigh"]]);
  assert.deepEqual(r.u.implementer_ladder.map(rung), EASY.map(rung), "the ladder is recorded with every rung's thinking level");
});

test("a transport failure is retried once on the same rung, then the ladder steps; no revision is spent", async t => {
  const r = await pipeline(t, (args, n) => { if (n <= 2) throw laneError(n === 1 ? "timeout" : "stream"); return session(args); }, { limits: { max_revisions: 0 } });
  assert.equal(r.u.status, "approved", r.u.reason);
  assert.deepEqual(r.calls.map(c => rung(c.seat)), ["gemini-4-carbon@high", "gemini-4-carbon@high", "gemini-4-hydrogen@xhigh"]);
  assert.deepEqual(r.u.attempts[0].lane_failures.map(f => [f.model, f.kind, f.cause, f.retry, f.next]), [["gemini-4-carbon", "timeout", "lane", false, "same_lane"], ["gemini-4-carbon", "stream", "lane", true, "next_rung"]]);
  assert.deepEqual(r.u.escalations.map(e => [e.kind, e.cause, rung(e.from), rung(e.to)]), [["lane_failover", "lane", "gemini-4-carbon@high", "gemini-4-hydrogen@xhigh"]]);
});

test("the model guard blocks the unit: a session refused with AGY_MODEL_MISMATCH is not retried, steps no rung and spends no revision; both identities and the session's evidence are on the record", async t => {
  const identity = { requested: { agent: "implementer", model: "gemini-4-carbon" }, reported: { agent: "implementer", model: "gemini-4-argon" } };
  const r = await pipeline(t, args => { throw sdkError("AGY_MODEL_MISMATCH", "Antigravity SDK identity mismatch: expected implementer/gemini-4-carbon, got implementer/gemini-4-argon (the provider answered as another model); no result of this session is acted on (answer, failure, quota refusal)",
    { identity, subagents: governed(args, [{ type: "code-explorer" }]), gateway: gatewayOf(args, { root: 1, subs: 1, served: "gemini-4-argon" }), tool_log: [], usage: null, runtime: RUNTIME, availability: [] }); });
  assert.equal(r.u.status, "blocked");
  assert.match(r.u.reason, /refused by the model guard: Antigravity SDK identity mismatch: expected implementer\/gemini-4-carbon, got implementer\/gemini-4-argon/);
  assert.equal(r.calls.length, 1, "not retried on the same rung, and no other rung is asked: it would spend on a transport that just answered as another model");
  assert.deepEqual(r.u.attempts.map(a => [a.status, a.code, a.identity, a.lane_failures.length]), [["failed", "AGY_MODEL_MISMATCH", identity, 0]]);
  assert.deepEqual(r.u.escalations, []);
  assert.deepEqual(r.u.attempts[0].session.gateway.served_models["gemini-4-carbon"], ["gemini-4-argon"], "what the gateway saw is kept");
  assert.equal(r.u.attempts[0].session.subagents.admitted_total, 1);
  assert.deepEqual(r.out.contributions.filter(c => c.kind !== "plan"), [], "nothing of the refused session is a contribution");
  assert.equal(r.s.calls.filter(c => c.role === "reviewer").length, 0, "and nothing of it reached a reviewer");
});

test("THE SDK IMPLEMENTER IS A PRIMARY SEAT OF THE GEMINI BILLING POLICY (register L-136): with gemini_api_primary off it is refused before any request, spawn or charge, and the failover setting neither enables nor disables it; declared, every billed request of the session is recorded before it is sent, and a budget spent inside a session blocks the unit", async t => {
  const refused = (r, what) => {
    assert.equal(r.calls.length, 0, `${what}: the transport was not entered (no gateway, no bridge, no request)`);
    assert.deepEqual([r.u.status, r.u.code], ["blocked", "GEMINI_PRIMARY_DISABLED"], what);
    assert.deepEqual(r.u.attempts.map(a => [a.status, a.code, a.lane_failures.length]), [["failed", "GEMINI_PRIMARY_DISABLED", 0]], what);
    assert.deepEqual(r.u.escalations, [], `${what}: no other rung is tried, every rung of this ladder is the same primary seat`);
    assert.equal(r.out.provider_calls.by_role.implementer ?? 0, 0, `${what}: nothing was charged`);
    assert.equal(r.cli.length, 0, `${what}: no agy CLI lane stood in`);
  };
  // NOTHING DECLARED: both kinds off. Not declared, so not called.
  const dflt = await pipeline(t, args => session(args), { agy: { billing: undefined } });
  refused(dflt, "nothing declared");
  assert.match(dflt.u.reason, /GEMINI_PRIMARY_DISABLED: agy_google\/gemini-4-carbon \(implementer\) would be served by primary Gemini execution on the python Antigravity SDK seat .*, and gemini_api_primary is off/);
  // The FAILOVER declared does not enable it: the two authorizations are separate.
  const failoverOnly = optIn({ failover: 5 });
  refused(await pipeline(t, args => session(args), { agy: { billing: failoverOnly } }), "failover declared, primary not");
  assert.deepEqual([failoverOnly.rows.length, failoverOnly.refusals.map(x => [x.kind, x.code, x.transport])], [0, [["primary", "GEMINI_PRIMARY_DISABLED", "sdk"]]], "the refusal is on the run's billing record, and nothing was billed");
  // DECLARED: it runs, with the failover off as well as on, and each billed request has its usage row: the
  // implementer's own and each native subagent's, by the model it asked.
  for (const failover of [null, 5]) {
    const billing = optIn({ primary: 20, failover });
    const on = await pipeline(t, args => session(args, { root: 2, spawned: [{ type: "code-explorer" }], perSubagent: 2 }), { agy: { billing } });
    assert.deepEqual([on.u.status, on.calls.length], ["approved", 1], `primary declared, failover ${failover}: ${on.u.reason}`);
    assert.deepEqual(billing.ledger.rows().map(x => [x.kind, x.model, x.purpose, x.transport, x.request]),
      [["primary", "gemini-4-carbon", "implementer", "sdk", 1], ["primary", "gemini-4-hydrogen", "subagent", "sdk", 2], ["primary", "gemini-4-hydrogen", "subagent", "sdk", 3], ["primary", "gemini-4-carbon", "implementer", "sdk", 4]]);
    assert.deepEqual([billing.ledger.used("primary"), billing.ledger.used("failover"), billing.refusals.length], [4, 0, 0]);
  }
  // THE BUDGET IS SPENT INSIDE A SESSION: the request past it is refused by the policy before the pipeline charges it,
  // the session ends on it, and the unit blocks on the policy's own refusal with what the session recorded.
  const tight = optIn({ primary: 2 });
  const spent = await pipeline(t, args => session(args, { root: 3 }), { agy: { billing: tight } });
  assert.deepEqual([spent.u.status, spent.u.code, spent.calls.length], ["blocked", "METERED_GEMINI_BUDGET_EXHAUSTED", 1]);
  assert.deepEqual([tight.ledger.used("primary"), tight.refusals.map(x => [x.code, x.used, x.budget])], [2, [["METERED_GEMINI_BUDGET_EXHAUSTED", 2, 2]]], "two billed requests recorded; the third refused and not recorded");
  assert.equal(spent.out.provider_calls.by_role.implementer, 1, "the session's first request");
  assert.equal(spent.out.provider_calls.by_role.continuation, 1, "and its second; the refused third was never charged");
  assert.ok(spent.u.attempts[0].session, "what the session recorded up to the refusal is kept on the attempt");
  // A REQUEST THE POLICY REFUSED INSIDE A SESSION THAT STILL ENDS WELL (independent review of the billing merge): the
  // implementer's own request was admitted and in flight when a subagent's request was refused for the spent budget, and
  // the session returned its result without asking again. A session's good ending does not undo the policy's refusal: the
  // unit blocks on it all the same, and the session's result is not taken as the unit's work.
  const one = optIn({ primary: 1 });
  const overlapped = await pipeline(t, async args => {
    args.admit({ class: "root", type: null, model: args.seat.model });   // admitted: the budget's one request
    assert.throws(() => args.admit({ class: "subagent", type: "code-explorer", model: "gemini-4-hydrogen" }), /METERED_GEMINI_BUDGET_EXHAUSTED/);
    return session({ ...args, admit: () => {} });   // the session ends well; nothing more is asked of the policy
  }, { agy: { billing: one } });
  assert.deepEqual([overlapped.u.status, overlapped.u.code, overlapped.calls.length], ["blocked", "METERED_GEMINI_BUDGET_EXHAUSTED", 1], overlapped.u.reason);
  assert.deepEqual([one.ledger.used("primary"), one.refusals.map(x => [x.code, x.purpose, x.model])], [1, [["METERED_GEMINI_BUDGET_EXHAUSTED", "subagent", "gemini-4-hydrogen"]]], "one billed request; the subagent's was refused and not recorded");
  assert.ok(overlapped.u.attempts[0].session, "what the session recorded is kept on the attempt");
  assert.equal(overlapped.s.calls.filter(c => c.role === "reviewer").length, 0, "no reviewer was asked about a session the policy had refused");
  // The transport has no setting of its own: the old option is refused, not ignored.
  assert.throws(() => pipelineTurns({ turn: async () => ({}), antigravity: { geminiApiPrimary: true } }), /antigravity\.geminiApiPrimary is replaced by agy\.billing/);
});

for (const [code, more] of [["CREDENTIAL_REFUSED", { status: 403 }], ["NO_API_KEY", {}], ["SANDBOX_UNAVAILABLE", {}], ["SDK_VERSION", {}]]) {
  test(`${code} blocks the unit at once: no other rung is tried and no revision is spent`, async t => {
    const r = await pipeline(t, args => { throw sdkError(code, `${code}: the session could not run`, { ...more, availability: [], subagents: null, gateway: null, tool_log: [], usage: null, runtime: null }); });
    assert.equal(r.u.status, "blocked"); assert.equal(r.u.code, code);
    assert.equal(r.calls.length, 1, "a fault no rung can cure is not retried down the ladder");
    assert.deepEqual(r.u.attempts.map(a => [a.status, a.code, a.lane_failures.length]), [["failed", code, 0]]);
    assert.deepEqual(r.u.escalations, []);
    assert.equal(r.s.calls.filter(c => c.role === "reviewer").length, 0);
  });
}

test("a missing SDK (the bridge's python is absent) blocks the unit as SDK_UNAVAILABLE", async t => {
  const r = await pipeline(t, args => { throw laneError("spawn", { sdk_unavailable: true }); });
  assert.equal(r.u.status, "blocked"); assert.equal(r.u.code, "SDK_UNAVAILABLE");
  assert.equal(r.calls.length, 1);
});

test("the implementer prompt names the unit's specialists and the ceiling of the rung in use, and no A2A relay", () => {
  const u = { ...unit("a", { difficulty: "hard", allowed_subagents: ["code-explorer", "no-such-type", "test-constructor"] }), rubric: RUBRIC };
  const a2a = { socket: "/x/a2a.sock", token: "t", roles: ["code-explorer"] };
  const carbon = IMPLEMENTER_PROMPT({ unit: u, rubric: RUBRIC, a2a, seat: CARBON });
  assert.match(carbon, /SUBAGENTS: .*invoke_subagent/);
  assert.match(carbon, /code-explorer, test-constructor\b/);
  assert.doesNotMatch(carbon, /no-such-type/, "a name that is not a specialist type is not offered");
  assert.match(carbon, /at most 8 /i);
  assert.match(carbon, /gemini-4-hydrogen/);
  assert.doesNotMatch(carbon, /ask_subagent|pantheon-subagents/, "the Grok relay is not offered on this transport");
  assert.match(IMPLEMENTER_PROMPT({ unit: u, rubric: RUBRIC, seat: NEON }), /at most 4 /i);
  const hydrogen = IMPLEMENTER_PROMPT({ unit: u, rubric: RUBRIC, seat: HYDROGEN("medium") });
  assert.match(hydrogen, /SUBAGENTS: none/);
  assert.doesNotMatch(hydrogen, /invoke_subagent/);
  assert.match(IMPLEMENTER_PROMPT({ unit: { ...u, allowed_subagents: [] }, rubric: RUBRIC, seat: CARBON }), /SUBAGENTS: none are allowed for this unit/);
  // A lane seat (the CLI transport) keeps the relay wording it had.
  assert.match(IMPLEMENTER_PROMPT({ unit: u, rubric: RUBRIC, a2a }), /ask_subagent/);
});

test("laneFailureOf: an unavailable model is a ladder step of its own kind, never a quota refusal or a retry", () => {
  assert.deepEqual(laneFailureOf(sdkError("model_unavailable", "the provider does not serve gemini-4-neon", { status: 404 })), { kind: "model_unavailable", cause: "model_unavailable", why: "the provider does not serve gemini-4-neon", status: 404 });
});

test("an approved unit's checkpoint carries its subagent lineage, and a run resumed from it keeps those contributors", async t => {
  const env = await tempRepo(); t.after(env.cleanup);
  const checkpoints = { dir: join(env.root, "checkpoints"), key: "k".repeat(64) };
  const first = await pipeline(t, args => session(args, { spawned: [{ type: "test-constructor" }] }), { env, checkpoints });
  assert.equal(first.u.status, "approved", first.u.reason);
  assert.deepEqual(first.out.checkpoints.written, ["a"]);
  const second = await pipeline(t, () => { throw new Error("a resumed unit asks no session"); }, { env: { ...env, dir: join(env.root, "run2") }, checkpoints });
  assert.equal(second.u.status, "approved", second.u.reason);
  assert.equal(second.u.resumed, true);
  assert.equal(second.calls.length, 0);
  assert.deepEqual(second.out.contributions.filter(c => c.kind === "subtask").map(c => [c.role, c.vendor, c.model, c.from_checkpoint]), [["subagent:test-constructor", "agy_google", "gemini-4-hydrogen", true]]);
  // The receipts themselves are sealed with the approval and restored, marked: who the implementer was, which
  // specialists it was admitted, on which model, and what the provider answered under.
  const restored = second.u.checkpoint.native_subagents;
  assert.deepEqual(restored.map(x => [x.attempt, x.implementer.model, x.implementer.effort, x.from_checkpoint, x.served_models["gemini-4-hydrogen"]]), [[1, "gemini-4-carbon", "high", true, ["gemini-4-hydrogen"]]]);
  assert.deepEqual(restored[0].subagents.instances.map(i => [i.id, i.type, i.model, i.status]), [["sa-1", "test-constructor", "gemini-4-hydrogen", "idle"]]);
  assert.deepEqual(restored[0].subagents, first.u.attempts[0].session.subagents, "exactly what the approving run recorded");
  assert.deepEqual(second.u.attempts, [], "the resumed unit made no attempt of its own: nothing is counted twice");
});

test("the real session inside the pipeline: gateway, governor and decisions against a scripted bridge and provider", async t => {
  const calls = { carbon: 0, hydrogen: 0 };
  const gemini = await startFakeGemini({ decide: ({ model }) => { calls[model === "gemini-4-carbon" ? "carbon" : "hydrogen"] += 1; return { parts: [text("ok")] }; } });
  t.after(gemini.close);
  const env = await tempRepo(); t.after(env.cleanup);
  const ask = `Find every caller of the unit's exported function and list them with file paths.`;
  // The scripted bridge's steps: what an SDK session would do. {{WT}} is the unit's worktree.
  const steps = [
    { request: { model: "gemini-4-carbon", as: "root" } },
    { hook: { tool: "invoke_subagent", args: { Subagents: [{ TypeName: "code-explorer", Role: "caller finder", Prompt: ask }] } } },
    { event: { event: "child_started", trajectory_id: "c1", parent_trajectory_id: "root-traj", prompt: ask } },
    { event: { event: "trajectory_state", trajectory_id: "c1", parent_trajectory_id: "root-traj", depth: 1, state: "RUNNING" } },
    { request: { model: "gemini-4-hydrogen", as: "code-explorer", session: "s-c1" } },
    { hook: { tool: "create_file", args: { TargetFile: "{{WT}}/src/a/stolen.mjs" }, from: "c1" } },
    { event: { event: "trajectory_state", trajectory_id: "c1", parent_trajectory_id: "root-traj", depth: 1, state: "FULLY_IDLE" } },
    { hook: { tool: "create_file", args: { TargetFile: "{{WT}}/src/a/impl.mjs" } } },
    { write: { path: "{{WT}}/src/a/impl.mjs", content: "export const ok = true;\n" }, if: 3 },
    { hook: { tool: "create_file", args: { TargetFile: "{{WT}}/README.md" } } },
    { request: { model: "gemini-4-carbon", as: "root" } },
  ];
  const plan = [unit("a", { difficulty: "hard", allowed_subagents: ["code-explorer"], invariants: [`src/a/impl.mjs exists FAKE:${JSON.stringify(steps)}:ENDFAKE`] })];
  const turns = pipelineTurns({ turn: async () => { throw new Error("not used"); }, agy: { billing: optIn({ primary: 100 }) }, antigravity: { python: process.execPath, bridge: FAKE_BRIDGE, upstream: gemini.url, apiKey: "AIza-synthetic-key-for-the-test", sandbox: { enabled: false, allowUnsandboxed: true } } });
  const s = scripted({ plan });
  const out = await runPipeline({ repo: env.repo, base: "main", plan: { work_units: plan }, dir: env.dir, planner: PLANNER, turns: { ...s.turns, implementer: turns.implementer },
    seats: seats({ implementer: () => ({ seat: { ...CARBON }, ladder: [{ ...CARBON }] }) }) });
  const u = out.units.a;
  assert.equal(u.status, "approved", u.reason ?? JSON.stringify(u.attempts.at(-1)));
  const x = u.attempts[0].session;
  assert.deepEqual(out.provider_calls.by_role, { dispatcher: 1, implementer: 1, subagent: 0, reviewer: 1, native_subagent: 1, continuation: 1 });
  assert.deepEqual(calls, { carbon: 2, hydrogen: 1 }, "the provider saw exactly the requests that were charged");
  assert.deepEqual(x.gateway.totals.by_class, { root: 2, subagent: 1, aux: 0 });
  assert.deepEqual(x.subagents.instances.map(i => [i.id, i.type, i.model, i.status, i.trajectory_id]), [["sa-1", "code-explorer", "gemini-4-hydrogen", "idle", "c1"]]);
  assert.deepEqual(x.tool_decisions.by_code, { SUBAGENT_SCOPE: 1, WRITE_REFUSED: 1 }, "a read-only specialist's write and a write outside the unit were refused before they happened");
  assert.deepEqual(x.tool_decisions.by_who, { implementer: { allowed: 2, denied: 1 }, "sa-1": { allowed: 0, denied: 1 } });
  assert.deepEqual([u.attempts[0].served_model, u.attempts[0].served_model_source], ["gemini-4-carbon", "provider"]);
  assert.deepEqual(out.contributions.filter(c => c.kind === "subtask").map(c => [c.role, c.model]), [["subagent:code-explorer", "gemini-4-hydrogen"]]);
  // The key reached the provider from the controller's gateway and is in nothing the run wrote.
  assert.ok(gemini.requests.filter(q => q.verb).every(q => q.headers["x-goog-api-key"] === "AIza-synthetic-key-for-the-test"));
  assert.doesNotMatch(readFileSync(join(env.dir, "pipeline.json"), "utf8") + readFileSync(x.tool_decisions.log_file, "utf8"), /AIza-synthetic-key-for-the-test|pantheon-gw-/);
});

// ---- A BUDGET-EXHAUSTED SESSION KEEPS ITS WORK (owner decision 2026-11-20: requirement 8 of the L-150 decision applies to
// the SDK implementer; register L-736). Extends the unit checkpoints (pipeline/checkpoint.mjs): a session stopped by a
// refused charge leaves a sealed PARTIAL checkpoint (verdict "unverified") beside the approved ones; a later run restores
// it only when it re-verifies, and the restored work still has to pass the unit's verify command and Stage 5.
/** A session that makes `before` billed requests, writes `files`, and is then refused its next request (as turn.mjs ends such a session). */
const stoppedAfter = (files, before = 2, tool_log = TOOL_LOG) => async args => {
  const more = () => ({ subagents: governed(args), gateway: gatewayOf(args, { root: before, stop: { kind: "budget", status: 403 } }), tool_log, usage: { total_token_count: 100 * before }, runtime: RUNTIME, availability: [] });
  await args.admit({ class: "root", type: null, model: args.seat.model, n: 1 });
  for (const [p, t] of Object.entries(files)) await write(args.worktree, p, t);
  for (let k = 1; k < before; k++) await args.admit({ class: "root", type: null, model: args.seat.model, n: k + 1 });
  try { await args.admit({ class: "root", type: null, model: args.seat.model, n: before + 1 }); }
  catch (e) { throw sdkError("PROVIDER_LIMIT", `a request of the implementer session was refused: ${e.message}`, more()); }
  throw new Error("the script expected its last request to be refused");
};
const partialEnv = async t => { const env = await tempRepo(); t.after(env.cleanup); return { env, checkpoints: { dir: join(env.root, "checkpoints"), key: "k".repeat(64) }, usage: join(env.root, "usage.jsonl") }; };

test("A BUDGET THAT RUNS OUT INSIDE AN SDK SESSION KEEPS THE SESSION'S WORK: the candidate changes are a sealed, UNVERIFIED partial checkpoint; the point of refusal and the requests admitted before it are on the record; the unit is blocked and nothing is approved", async t => {
  const { env, checkpoints, usage } = await partialEnv(t);
  const tight = optIn({ primary: 2, file: usage });
  const r = await pipeline(t, stoppedAfter({ "src/a/part.mjs": "export const part = 1;\n" }), { env, checkpoints, agy: { billing: tight } });
  assert.deepEqual([r.u.status, r.u.code, r.calls.length], ["blocked", "METERED_GEMINI_BUDGET_EXHAUSTED", 1], r.u.reason);
  // THE ATTEMPT: failed, and its writes kept apart from an attempt that was "written".
  const a = r.u.attempts[0];
  assert.deepEqual([a.status, a.code, a.partial.kept, a.partial.changed, /^[0-9a-f]{40}$/.test(a.partial.commit), a.checkpoint === a.started_from], ["failed", "METERED_GEMINI_BUDGET_EXHAUSTED", true, ["src/a/part.mjs"], true, true],
    "the attempt is not a written attempt: its own checkpoint is where it started");
  // THE PARTIAL CHECKPOINT: sealed, unverified, with the candidate patch.
  const got = await readPartial({ dir: checkpoints.dir, unit_key: r.u.unit_key });
  assert.equal(got.found, true);
  assert.deepEqual([got.record.schema, got.record.verdict, got.record.unit_id, got.record.changed, got.record.patch_digest === sha256(got.patch), got.record.seal === sealOf(got.record, Buffer.from(checkpoints.key))],
    [PARTIAL_SCHEMA, "unverified", "a", ["src/a/part.mjs"], true, true]);
  assert.match(got.patch, /\+export const part = 1;/);
  // THE POINT OF REFUSAL, and what was admitted before it.
  assert.deepEqual([got.record.stopped.code, got.record.stopped.attempt, got.record.stopped.request, got.record.stopped.used, got.record.stopped.budget, got.record.admitted.requests],
    ["METERED_GEMINI_BUDGET_EXHAUSTED", 1, 3, 2, 2, 2], "refused at the session's third request, with two of a budget of two used; two requests were admitted before it");
  assert.deepEqual(got.record.admitted.rows.map(x => [x.request, x.model, x.purpose]), [[1, "gemini-4-carbon", "implementer"], [2, "gemini-4-carbon", "implementer"]], "each admitted request, as the billing record has it");
  assert.equal(got.record.session.tool_decisions.total, TOOL_LOG.length, "the session's evidence is kept with it");
  // ON THE UNIT AND THE RUN: said, and not an approval.
  assert.deepEqual([r.u.partial.written, r.u.partial.changed, r.u.partial.file === partialFile(checkpoints.dir, r.u.unit_key), r.out.checkpoints.written, r.out.checkpoints.partial, existsSync(checkpointFile(checkpoints.dir, r.u.unit_key))],
    [true, ["src/a/part.mjs"], true, [], ["a"], false]);
  assert.match(r.u.reason, /the session's candidate changes \(1 file\(s\), unverified\) are kept as a partial checkpoint/);
  assert.deepEqual([r.out.status === "approved", r.u.commit ?? null, r.s.calls.filter(c => c.role === "reviewer").length], [false, null, 0], "nothing was approved, merged or reviewed");
  assert.equal(r.disk().units.a.partial.written, true, "and it is on the run's record on disk");
});

test("THE NEXT RUN RESUMES FROM THE PARTIAL CHECKPOINT INSTEAD OF STARTING AGAIN: the candidate changes are restored after they re-verify, the session is told what it starts from, the work still has to pass verify and Stage 5, and the earlier session's model stays a contributor", async t => {
  const { env, checkpoints, usage } = await partialEnv(t);
  const first = await pipeline(t, stoppedAfter({ "src/a/part.mjs": "export const part = 1;\n" }), { env, checkpoints, agy: { billing: optIn({ primary: 2, file: usage }) } });
  assert.equal(first.u.partial.written, true, first.u.reason);
  // A LARGER BUDGET over the same usage record: the two requests already billed stay counted.
  const more = optIn({ primary: 10, file: usage });
  let seen = null;
  const second = await pipeline(t, async args => {
    seen = { part: existsSync(join(args.worktree, "src/a/part.mjs")) ? readFileSync(join(args.worktree, "src/a/part.mjs"), "utf8") : null, prompt: args.prompt };
    return session(args, { root: 1 });
    // Another model finishes the unit (the run's ladder starts on Argon): the unit key does not depend on the ladder.
  }, { env: { ...env, dir: join(env.root, "run2") }, checkpoints, ladder: [ARGON], agy: { billing: more } });
  assert.equal(second.u.status, "approved", second.u.reason);
  // RESTORED BEFORE THE SESSION STARTED, and the session was told.
  assert.equal(seen.part, "export const part = 1;\n", "the earlier session's file is in the worktree the new session starts in");
  assert.match(seen.prompt, /RESUMED FROM A PARTIAL CHECKPOINT[\s\S]*src\/a\/part\.mjs[\s\S]*unverified/);
  assert.deepEqual([second.u.partial_resume.resumed, second.u.partial_resume.changed, second.u.partial_resume.stopped.code, second.u.partial_resume.from === partialFile(checkpoints.dir, second.u.unit_key)], [true, ["src/a/part.mjs"], "METERED_GEMINI_BUDGET_EXHAUSTED", true]);
  // NOT AN APPROVAL: the unit's own verify command and Stage 5 decided, on the whole change.
  assert.equal(second.s.calls.filter(c => c.role === "reviewer").length, 1);
  assert.equal(second.u.resumed, false, "a partial checkpoint never resumes a unit as approved");
  const tree = second.u.tree;
  assert.ok(typeof tree === "string" && tree.length === 40);
  // ONE SESSION OF WORK WAS NOT PAID FOR TWICE: the second run billed its own request only, counted after the first two.
  assert.deepEqual(more.ledger.rows().map(x => [x.request, x.model]), [[1, "gemini-4-carbon"], [2, "gemini-4-carbon"], [1, "gemini-4-argon"]], "two requests of the stopped session, then one of the session that finished the unit");
  assert.equal(more.ledger.used("primary"), 3);
  // LINEAGE: the model that wrote the restored part is a contributor of the approved unit, beside the one that finished it.
  assert.deepEqual(second.out.contributions.filter(c => c.kind === "work").map(c => [c.model, c.served_model, c.from_partial ?? false]), [["gemini-4-argon", "gemini-4-argon", false], ["gemini-4-carbon", "gemini-4-carbon", true]]);
  assert.deepEqual(contributorKeys(second.out.contributions.filter(c => c.kind === "work")).models, ["google/gemini-4-argon", "google/gemini-4-carbon"], "so no reviewer on the earlier session's model may judge the change");
  // The approved checkpoint replaces the partial one.
  assert.deepEqual([existsSync(checkpointFile(checkpoints.dir, second.u.unit_key)), existsSync(partialFile(checkpoints.dir, second.u.unit_key)), second.out.checkpoints.written], [true, false, ["a"]]);
});

test("A PARTIAL CHECKPOINT IS EVIDENCE TO RE-CHECK, NEVER AN APPROVAL: one whose seal, patch or paths do not hold is not restored, the unit starts from its base, and the record says why; work that broke the write jail is not kept at all", async t => {
  const setup = async edit => {
    const { env, checkpoints, usage } = await partialEnv(t);
    const first = await pipeline(t, stoppedAfter({ "src/a/part.mjs": "export const part = 1;\n" }), { env, checkpoints, agy: { billing: optIn({ primary: 2, file: usage }) } });
    const file = partialFile(checkpoints.dir, first.u.unit_key);
    await edit({ file, record: JSON.parse(readFileSync(file, "utf8")), patch: join(checkpoints.dir, JSON.parse(readFileSync(file, "utf8")).patch_path), key: Buffer.from(checkpoints.key) });
    let part = "unseen";
    const second = await pipeline(t, async args => { part = existsSync(join(args.worktree, "src/a/part.mjs")); return session(args); }, { env: { ...env, dir: join(env.root, "run2") }, checkpoints, agy: { billing: optIn({ primary: 10, file: usage }) } });
    return { second, part };
  };
  const cases = [
    ["the patch was edited after it was sealed", ({ patch }) => { writeFileSync(patch, readFileSync(patch, "utf8").replace("part = 1", "part = 2")); }, /patch does not hash to the recorded digest/],
    ["the record was edited after it was sealed", ({ file, record }) => { writeFileSync(file, JSON.stringify({ ...record, changed: ["src/a/other.mjs"] })); }, /seal does not verify/],
    ["a record sealed by another key", ({ file, record }) => { const { seal, ...body } = record; writeFileSync(file, JSON.stringify({ ...body, seal: sealOf(body, Buffer.from("x".repeat(64))) })); }, /seal does not verify/],
    ["a path outside the unit's own, sealed with the controller's key", ({ file, record, patch, key }) => {
      const p = readFileSync(patch, "utf8").split("src/a/part.mjs").join("README.md"); writeFileSync(patch, p);
      const { seal, ...body } = { ...record, changed: ["README.md"], patch_digest: sha256(p) }; writeFileSync(file, JSON.stringify({ ...body, seal: sealOf(body, key) })); }, /README\.md is outside the unit's owned paths/],
    ["marked approved by hand", ({ file, record, key }) => { const { seal, ...body } = { ...record, verdict: "approve" }; writeFileSync(file, JSON.stringify({ ...body, seal: sealOf(body, key) })); }, /a partial checkpoint's verdict is "unverified"/],
    // The record says an owned path and the PATCH changes another: what is applied is what is judged, not what the record says.
    ["a patch that changes more than its record says, re-sealed with the controller's key", ({ file, record, patch, key }) => {
      const p = readFileSync(patch, "utf8").split("src/a/part.mjs").join("elsewhere/part.mjs"); writeFileSync(patch, p);
      const { seal, ...body } = { ...record, patch_digest: sha256(p) }; writeFileSync(file, JSON.stringify({ ...body, seal: sealOf(body, key) })); }, /patch changes elsewhere\/part\.mjs, outside the unit's owned paths/],
    // A patch whose content is not the recorded tree's, re-sealed: the tree the controller rebuilds decides.
    ["a patch that yields another tree than the recorded one, re-sealed with the controller's key", ({ file, record, patch, key }) => {
      const p = readFileSync(patch, "utf8").replace("part = 1", "part = 2"); writeFileSync(patch, p);
      const { seal, ...body } = { ...record, patch_digest: sha256(p) }; writeFileSync(file, JSON.stringify({ ...body, seal: sealOf(body, key) })); }, /applied on the unit's base yields tree [0-9a-f]{40}, not the recorded/],
  ];
  for (const [name, edit, why] of cases) {
    const { second, part } = await setup(edit);
    assert.deepEqual([part, second.u.partial_resume ?? null, second.u.status], [false, null, "approved"], `${name}: the unit ran from its base (${second.u.reason})`);
    assert.match(second.u.partial_rejected.why, why, name);
    assert.deepEqual(second.out.contributions.filter(c => c.from_partial), [], `${name}: no lineage is taken from a checkpoint that was not restored`);
  }
  // A stopped session that wrote outside its owned paths: the write jail discards it, as for any attempt.
  const { env, checkpoints, usage } = await partialEnv(t);
  const broke = await pipeline(t, stoppedAfter({ "src/a/part.mjs": "export const part = 1;\n", "README.md": "changed by the stopped session\n" }), { env, checkpoints, agy: { billing: optIn({ primary: 2, file: usage }) } });
  assert.deepEqual([broke.u.status, broke.u.attempts[0].partial.kept, broke.u.attempts[0].partial.violations.map(v => v.path), broke.u.partial ?? null, existsSync(partialFile(checkpoints.dir, broke.u.unit_key))],
    ["blocked", false, ["README.md"], null, false]);
});

test("ONLY A REFUSED CHARGE KEEPS A STOPPED SESSION'S WORK: a session that failed for another reason is discarded as before, and so is a stopped session of a run that keeps no checkpoints", async t => {
  // A transport fault with files on disk: discarded, no partial checkpoint (the work of a crashed session is not candidate work).
  const { env, checkpoints } = await partialEnv(t);
  const crashed = await pipeline(t, async args => { await write(args.worktree, "src/a/part.mjs", "export const part = 1;\n"); throw sdkError("SANDBOX_UNAVAILABLE", "the jail is gone", { subagents: null, gateway: null, tool_log: [], usage: null, runtime: null, availability: [] }); }, { env, checkpoints });
  assert.deepEqual([crashed.u.status, crashed.u.code, crashed.u.attempts[0].partial ?? null, crashed.u.partial ?? null, existsSync(partialFile(checkpoints.dir, crashed.u.unit_key))], ["blocked", "SANDBOX_UNAVAILABLE", null, null, false]);
  // No checkpoint directory: the writes are still inspected and committed in the worktree's record, and the run says no partial checkpoint could be kept.
  const none = await partialEnv(t);
  const bare = await pipeline(t, stoppedAfter({ "src/a/part.mjs": "export const part = 1;\n" }), { env: none.env, agy: { billing: optIn({ primary: 2, file: none.usage }) } });
  assert.deepEqual([bare.u.status, bare.u.attempts[0].partial.kept, bare.u.partial.written, /no checkpoint directory/.test(bare.u.partial.why)], ["blocked", true, false, true]);
  assert.match(bare.u.reason, /not kept beyond this run: no checkpoint directory/);
});

test("a partial checkpoint is restored only into the run it was recorded for: another unit, another base or another upstream is refused, each by name", async t => {
  const { env, checkpoints, usage } = await partialEnv(t);
  const r = await pipeline(t, stoppedAfter({ "src/a/part.mjs": "export const part = 1;\n" }), { env, checkpoints, agy: { billing: optIn({ primary: 2, file: usage }) } });
  const got = await readPartial({ dir: checkpoints.dir, unit_key: r.u.unit_key });
  const expect = { key: Buffer.from(checkpoints.key), unit_key: r.u.unit_key, unit_id: "a", base_commit: got.record.base_commit, upstream: [], owned_paths: ["src/a/**"] };
  assert.equal(partialRefusal(got, expect), null, "as recorded, it holds");
  assert.match(partialRefusal(got, { ...expect, unit_key: "sha256:" + "0".repeat(64) }), /for another unit key/);
  assert.match(partialRefusal(got, { ...expect, unit_id: "b" }), /is for unit a/);
  assert.match(partialRefusal(got, { ...expect, base_commit: "f".repeat(40) }), /was recorded on base [0-9a-f]{40}, not f{40}/);
  assert.match(partialRefusal(got, { ...expect, upstream: [{ unit_id: "z", unit_key: "k", tree: "t" }] }), /upstream units or their trees differ from this run's/);
  assert.match(partialRefusal({ record: got.record, patch: null }, expect), /patch is missing/);
  // THE SAME UPSTREAM UNIT ON ANOTHER TREE: a record made on top of unit z at tree t1 is not restored on top of z at t2
  // (same count, another content), and is restored on top of z at t1.
  const { seal, ...body } = { ...got.record, upstream: [{ unit_id: "z", unit_key: "k", tree: "t1" }] };
  const onZ = { record: { ...body, seal: sealOf(body, expect.key) }, patch: got.patch };
  assert.equal(partialRefusal(onZ, { ...expect, upstream: [{ unit_id: "z", unit_key: "k", tree: "t1" }] }), null);
  assert.match(partialRefusal(onZ, { ...expect, upstream: [{ unit_id: "z", unit_key: "k", tree: "t2" }] }), /upstream units or their trees differ from this run's/);
});

// ---- Findings of the independent review of af23623 (2026-11-20) ---------------------------------------------------------
test("A PARTIAL CHECKPOINT THE RUN CANNOT USE IS SAID SO, NOT PASSED OVER: after the base moved, the unit's earlier partial checkpoint is named in the record with the reason, and it is removed when the unit is approved", async t => {
  // Finding 1.1: the lookup is by unit key, and the key changes with the base or the plan. The earlier partial checkpoint was
  // then not found, nothing was recorded, a new billed session started from nothing, and the old files stayed for good.
  const { env, checkpoints, usage } = await partialEnv(t);
  const first = await pipeline(t, stoppedAfter({ "src/a/part.mjs": "export const part = 1;\n" }), { env, checkpoints, agy: { billing: optIn({ primary: 2, file: usage }) } });
  const old = partialFile(checkpoints.dir, first.u.unit_key);
  assert.equal(existsSync(old), true);
  await write(env.repo, "UNRELATED.md", "the base moves\n");
  for (const a of [["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "an unrelated commit"]]) execFileSync("git", ["-C", env.repo, ...a]);
  let part = "unseen";
  const second = await pipeline(t, async args => { part = existsSync(join(args.worktree, "src/a/part.mjs")); return session(args); }, { env: { ...env, dir: join(env.root, "run2") }, checkpoints, agy: { billing: optIn({ primary: 10, file: usage }) } });
  assert.notEqual(second.u.unit_key, first.u.unit_key, "the unit's key follows the base");
  assert.deepEqual([second.u.status, part, second.u.partial_resume ?? null], ["approved", false, null], "the unit ran from its base");
  assert.match(second.u.partial_rejected.why, /a partial checkpoint of unit a was recorded for another unit key \(the base or the plan changed since\): it is not restored/);
  assert.deepEqual([second.u.partial_rejected.unit_key, second.out.checkpoints.partial_rejected], [first.u.unit_key, ["a"]]);
  assert.equal(existsSync(old), false, "the unit is approved: its earlier partial checkpoint is removed with it");
});

// ---- #114: THE DURABLE FAILED ATTEMPT KEEPS THE ALLOWLISTED LAUNCH RECEIPT --------------------------------------------
test("a failed SDK attempt keeps the allowlisted launch receipt and the stage it reached, through the billing refusal's remap, on the attempt and in pipeline.json; nothing else of the launch is kept, and a prelaunch failure invents none", async t => {
  const LAUNCH = { argv: ["bwrap", "--ro-bind", "/", "/", "python3", "bridge.py"], env_names: ["HOME", "PATH"], cwd: "/control/u1", gateway: "http://127.0.0.1:4321", at: "t" };
  const one = optIn({ primary: 1 });
  const r = await pipeline(t, args => {
    args.admit({ class: "root", type: null, model: args.seat.model });
    try { args.admit({ class: "root", type: null, model: args.seat.model }); }
    catch (e) { throw Object.assign(e, { transport: "antigravity-sdk", subagents: governed(args), gateway: gatewayOf(args), tool_log: [], usage: null, runtime: null, availability: [],
      sandbox: { enabled: true, binds: [] }, launch: { ...LAUNCH, env: { GEMINI_API_KEY: "secret-value" }, prompt: "the unit's prompt text" }, evidence_phase: "spawn_attempted" }); }
    throw new Error("the second request was admitted");
  }, { agy: { billing: one } });
  assert.deepEqual([r.u.status, r.u.code], ["blocked", "METERED_GEMINI_BUDGET_EXHAUSTED"], r.u.reason);
  const session = r.u.attempts[0].session;
  assert.deepEqual([session.launch, session.evidence_phase, session.jail?.enabled], [LAUNCH, "spawn_attempted", true]);
  const disk = JSON.stringify(r.disk());
  assert.ok(disk.includes('"gateway":"http://127.0.0.1:4321"'), "the receipt is in pipeline.json");
  assert.ok(!disk.includes("secret-value") && !disk.includes("the unit's prompt text"), "no environment value and no prompt from the launch reaches the record");
  const pre = await pipeline(t, () => { throw sdkError("SANDBOX_UNAVAILABLE", "the implementer session is not started unjailed", { tool_log: [], sandbox: null, launch: null, evidence_phase: "none" }); });
  const ps = pre.u.attempts[0].session;
  assert.deepEqual([ps?.launch ?? null, ps?.evidence_phase ?? null], [null, "none"], "a prelaunch failure carries no launch receipt");
});

test("the recorded phase must agree with its own raw evidence, and an empty or malformed launch is no receipt: a claimed phase its evidence does not support is unknown (null), never repeated", async t => {
  const LAUNCH = { argv: ["python3", "bridge.py"], env_names: ["HOME"], cwd: "/c", gateway: "http://127.0.0.1:1", at: "t" };
  const blocked = (more) => pipeline(t, args => {
    args.admit({ class: "root", type: null, model: args.seat.model });
    try { args.admit({ class: "root", type: null, model: args.seat.model }); }
    catch (e) { throw Object.assign(e, { transport: "antigravity-sdk", subagents: governed(args), gateway: gatewayOf(args), tool_log: [], usage: null, availability: [], ...more }); }
    throw new Error("the second request was admitted");
  }, { agy: { billing: optIn({ primary: 1 }) } });
  const phase = async more => { const r = await blocked(more); const s = r.u.attempts[0].session; return [s.launch, s.evidence_phase, JSON.parse(JSON.stringify(r.disk())).units[Object.keys(r.disk().units)[0]].attempts[0].session.evidence_phase]; };
  // A claim the evidence does not support is not recorded.
  assert.deepEqual(await phase({ runtime: null, sandbox: { enabled: true }, launch: LAUNCH, evidence_phase: "runtime_observed" }), [LAUNCH, null, null], "runtime_observed with no runtime");
  assert.deepEqual(await phase({ runtime: null, sandbox: { enabled: true }, launch: {}, evidence_phase: "spawn_attempted" }), [null, null, null], "an empty launch object is no launch, and spawn_attempted without one is unknown");
  assert.deepEqual(await phase({ runtime: null, sandbox: { enabled: true }, launch: { argv: "python3 bridge.py", env_names: ["HOME"] }, evidence_phase: "spawn_attempted" }), [null, null, null], "a malformed launch is no launch");
  // A claim the evidence does support is kept, each state distinct.
  assert.deepEqual(await phase({ runtime: { python: "3" }, sandbox: { enabled: true }, launch: LAUNCH, evidence_phase: "runtime_observed" }), [LAUNCH, "runtime_observed", "runtime_observed"]);
  assert.deepEqual(await phase({ runtime: null, sandbox: { enabled: true }, launch: LAUNCH, evidence_phase: "spawn_attempted" }), [LAUNCH, "spawn_attempted", "spawn_attempted"]);
  assert.deepEqual(await phase({ runtime: null, sandbox: null, launch: null, evidence_phase: "none" }), [null, "none", "none"], "an explicit no-launch preflight stays none");
  assert.deepEqual(await phase({ runtime: null, sandbox: { enabled: true }, launch: LAUNCH, evidence_phase: "none" }), [LAUNCH, null, null], "none contradicted by a launch is unknown");
});
