#!/usr/bin/env node
// MUTATION RUNNER for the prompt intake and the Antigravity SDK migration (owner direction 2026-11-19): the subagent
// governor, the model gateway, the session's tool decisions and jail, the pipeline's SDK seat, the fit routing, the
// lifecycle stage, the live-run launcher and the prompt intake; and (owner direction 2026-11-20, ids RS*) the research
// team: its routing, read-only session, controller, ledger records, runner and place in the lifecycle. Built like reliability-wave2b.mutate.mjs: every mutation
// is made on a DISPOSABLE COPY of this tree (never on the tree itself), its suites run there, and it is undone.
//
//   node ophanim/operate/sdk-intake.mutate.mjs [--only G1,W3] [--log DIR] [--copy-root DIR] [--run-bound-ms N] [--check]
//
// Each mutation names its file, the EXACT text it replaces, the replacement, and the suites that must catch it. The
// runner EXITS NON-ZERO when a target does not occur exactly once, when the unmutated suites are not green, when any
// mutation SURVIVES (its suites still green), or when a run of the suites does not END within its bound (HUNG: a test
// that fails and leaves a listener or a child behind; such a run is killed and reported, never waited for). Every mutation is recorded in the log directory (one log per mutation,
// plus summary.json). The suites that run a session in the real jail need bubblewrap: without it they skip, a
// mutation they alone would catch survives, and the runner says so by exiting non-zero.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const T = {
  gov: ['pantheon/tests/antigravity-subagents.test.mjs'], gw: ['pantheon/tests/antigravity-gateway.test.mjs'], turn: ['pantheon/tests/antigravity-turn.test.mjs'],
  pipe: ['pantheon/tests/pipeline-antigravity-sdk.test.mjs'], route: ['pantheon/tests/fit-sdk-routing.test.mjs', 'pantheon/tests/fit-matrix.test.mjs'],
  board: ['pantheon/tests/quota-failover.test.mjs', 'pantheon/tests/route-task-profile.test.mjs'], fit: ['ophanim/operate/fit-lifecycle.test.mjs'],
  wave: ['ophanim/operate/reliability-wave2b.test.mjs'], live: ['ophanim/operate/live-run.test.mjs'], rel: ['ophanim/operate/reliability-r2-a3.test.mjs'],
  prompt: ['ophanim/operate/prompt-intake.test.mjs'],
  // The installed SDK in the real jail against a scripted provider: needs bubblewrap and the SDK's venv (it skips without them).
  contract: ['pantheon/tests/antigravity-sdk-contract.test.mjs'],
  // The bridge without a session (quick; the config half needs the SDK's python for its types).
  bridge: ['pantheon/tests/antigravity-bridge.test.mjs'],
  // The research team (owner direction 2026-11-20): routing, the team controller, the runner and ledger kind, the lifecycle.
  rroute: ['pantheon/tests/research-routing.test.mjs'], rteam: ['pantheon/tests/research-team.test.mjs'], rrun: ['ophanim/operate/research.test.mjs'],
  rlife: ['ophanim/operate/research-lifecycle.test.mjs'], cli: ['ophanim/operate/cli.test.mjs'], rest: ['ophanim/operate/reliability-r2-a3-rest.test.mjs'],
};
const SUITES = [...new Set(Object.values(T).flat())];
const BR = 'pantheon/scripts/antigravity-bridge.py';
const GOV = 'pantheon/src/antigravity/subagents.mjs', GW = 'pantheon/src/antigravity/gateway.mjs', TURN = 'pantheon/src/antigravity/turn.mjs', CFG = 'pantheon/src/config/antigravity-sdk.json';
const PT = 'pantheon/src/pipeline/turns.mjs', IMP = 'pantheon/src/pipeline/implement.mjs', IDX = 'pantheon/src/pipeline/index.mjs', REC = 'pantheon/src/pipeline/record.mjs';
const FM = 'pantheon/src/route/fit-matrix.mjs', FR = 'pantheon/src/route/frontier.mjs', RI = 'pantheon/src/board/run-item.mjs';
const ACFG = 'pantheon/src/antigravity/config.mjs', RT = 'pantheon/src/antigravity/research.mjs', WL = 'ophanim/operate/work-ledger.mjs', OR = 'ophanim/operate/research.mjs';
const GT = 'ophanim/operate/gates.mjs', CTX = 'ophanim/operate/context.mjs';
const STG = 'ophanim/operate/stages.mjs', LR = 'ophanim/operate/live-run.mjs', PI = 'ophanim/operate/prompt-intake.mjs', RC = 'ophanim/operate/reconcile.mjs', SCH = 'ophanim/operate/scheduler.mjs', CLI = 'ophanim/operate/cli.mjs';

export const MUTATIONS = [
  // ---- the subagent governor: the ceilings and the pin
  {id: 'G1', what: 'the ceiling is not enforced (a ninth Carbon subagent is admitted)', file: GOV, tests: [...T.gov, ...T.pipe],
    from: '    if (have + list.length > ceiling) return reject("SUBAGENT_LIMIT",', to: '    if (false) return reject("SUBAGENT_LIMIT",'},
  {id: 'G2', what: 'a type the controller did not pin is admitted (it would run on the implementer\'s own model)', file: GOV, tests: T.gov,
    from: '      if (!Object.hasOwn(SUBAGENT_TYPES, e.TypeName)) return reject("SUBAGENT_TYPE_NOT_PINNED",', to: '      if (false) return reject("SUBAGENT_TYPE_NOT_PINNED",'},
  {id: 'G3', what: 'the invocation may name a model for the child', file: GOV, tests: [...T.gov, ...T.pipe],
    from: '      if (e.Model !== undefined && e.Model !== null && e.Model !== "inherit") return reject("SUBAGENT_MODEL_OVERRIDE",', to: '      if (false) return reject("SUBAGENT_MODEL_OVERRIDE",'},
  {id: 'G4', what: 'a subagent may delegate (recursion)', file: GOV, tests: T.gov,
    from: '    if (trajectory_id && root && trajectory_id !== root) return reject("SUBAGENT_RECURSION",', to: '    if (false) return reject("SUBAGENT_RECURSION",'},
  {id: 'G5', what: 'an idle subagent frees its slot (it can be woken again without a checkpoint)', file: GOV, tests: T.gov,
    from: '  const live = () => instances.length;', to: '  const live = () => instances.filter(i => i.status !== "idle").length;'},
  {id: 'G13', what: 'a cancelled subagent frees its slot (the wire\'s count of child sessions does not shrink with it)', file: GOV, tests: T.gov,
    from: '  const live = () => instances.length;', to: '  const live = () => instances.filter(i => i.status !== "cancelled").length;'},
  {id: 'G6', what: 'a rejection is not recorded', file: GOV, tests: T.gov,
    from: '    rejections.push({ at: now(), code, why: reason, asked: ctx.asked ?? 0, live: live(), ceiling, call_id: ctx.call_id ?? null, trajectory_id: ctx.trajectory_id ?? null });', to: ''},
  {id: 'G7', what: 'a unit\'s allowed specialist types are ignored', file: GOV, tests: T.gov,
    from: '      if (!allowed.includes(e.TypeName)) return reject("SUBAGENT_TYPE_NOT_ALLOWED",', to: '      if (false) return reject("SUBAGENT_TYPE_NOT_ALLOWED",'},
  {id: 'G8', what: 'a child may ask for a workspace of its own', file: GOV, tests: T.gov,
    from: '      if (e.Workspace !== undefined && e.Workspace !== null && e.Workspace !== "inherit") return reject("SUBAGENT_WORKSPACE",', to: '      if (false) return reject("SUBAGENT_WORKSPACE",'},
  {id: 'G9', what: 'an implementer model with no declared ceiling may delegate to eight', file: GOV, tests: [...T.gov, ...T.route],
    from: 'export const ceilingFor = model => (Object.hasOwn(SUB.ceilings, String(model)) ? SUB.ceilings[model] : SUB.default_ceiling);', to: 'export const ceilingFor = model => (Object.hasOwn(SUB.ceilings, String(model)) ? SUB.ceilings[model] : 8);'},
  {id: 'G10', what: 'the Carbon ceiling is nine', file: CFG, tests: [...T.gov, ...T.route],
    from: '"ceilings": { "gemini-4-carbon": 8, "gemini-4-neon": 4, "gemini-4-hydrogen": 0 },', to: '"ceilings": { "gemini-4-carbon": 9, "gemini-4-neon": 4, "gemini-4-hydrogen": 0 },'},
  {id: 'G11', what: 'the Neon ceiling is eight', file: CFG, tests: [...T.gov, ...T.route],
    from: '"ceilings": { "gemini-4-carbon": 8, "gemini-4-neon": 4, "gemini-4-hydrogen": 0 },', to: '"ceilings": { "gemini-4-carbon": 8, "gemini-4-neon": 8, "gemini-4-hydrogen": 0 },'},
  {id: 'G12', what: 'a Hydrogen implementer may delegate', file: CFG, tests: [...T.gov, ...T.route],
    from: '"ceilings": { "gemini-4-carbon": 8, "gemini-4-neon": 4, "gemini-4-hydrogen": 0 },', to: '"ceilings": { "gemini-4-carbon": 8, "gemini-4-neon": 4, "gemini-4-hydrogen": 2 },'},
  // ---- the model gateway: the key, the charge, the identity on the wire
  {id: 'W1', what: 'the runtime\'s own token is forwarded to the provider, not the controller\'s key', file: GW, tests: T.gw,
    from: '      headers[keyHeader] = apiKey;', to: '      headers[keyHeader] = req.headers[keyHeader];'},
  {id: 'W2', what: 'any caller is served (the session token is not checked)', file: GW, tests: T.gw,
    from: '    if (got.length !== want.length || !timingSafeEqual(got, want)) {', to: '    if (false) {'},
  {id: 'W3', what: 'a request is forwarded without being admitted (charged)', file: GW, tests: [...T.gw, ...T.pipe],
    from: '    try { await admit({ class: rec.class, type, model, session: rec.session, n: counts[rec.class] + 1, seq: rec.seq, verb: rec.verb }); }', to: '    try { }'},
  {id: 'W4', what: 'a subagent may ask for the implementer\'s model (a clone)', file: GW, tests: T.gw,
    from: '    if (type && model !== sub.model) {', to: '    if (false) {'},
  {id: 'W5', what: 'any model is served', file: GW, tests: T.gw,
    from: '  const allowedModel = m => m === root.model || (sub.ceiling > 0 && str(sub.model) && m === sub.model);', to: '  const allowedModel = () => true;'},
  {id: 'W6', what: 'no ceiling on the wire (the second line behind the governor)', file: GW, tests: T.gw,
    from: '      if (liveSubs >= sub.ceiling) {', to: '      if (false) {'},
  // (The stop is read three times: on arrival, with the body, after the charge. W7, W20 and W10.)
  {id: 'W7', what: 'a stopped gateway waits for the body of a request before it answers (a stalled upload is held and never answered)', file: GW, tests: T.gw,
    from: '    if (stopped()) { req.resume(); refuse(res, rec, 503, GATEWAY_REFUSALS.ABORTED,', to: '    if (false) { req.resume(); refuse(res, rec, 503, GATEWAY_REFUSALS.ABORTED,'},
  {id: 'W20', what: 'a request whose body was still arriving at the stop is charged', file: GW, tests: T.gw,
    from: '    // 2. With the body in hand: a request whose body was still arriving at the stop is not charged.\n    if (stopped()) {', to: '    // 2. With the body in hand: a request whose body was still arriving at the stop is not charged.\n    if (false) {'},
  {id: 'W21', what: 'an abort with an empty reason is not a stop: the next request is charged and forwarded', file: GW, tests: T.gw,
    from: '    aborted = (String(why ?? "").trim() || "aborted, no reason given").slice(0, 300);', to: '    aborted = String(why ?? "aborted").slice(0, 300);'},
  {id: 'W8', what: 'the provider\'s own statement of the model that answered is not recorded', file: GW, tests: [...T.gw, ...T.turn],
    from: 'if (str(j.modelVersion)) rec.served_model = j.modelVersion; const u = usageOf(j.usageMetadata); if (u) rec.usage = u; }', to: 'const u = usageOf(j.usageMetadata); if (u) rec.usage = u; }'},
  {id: 'W9', what: 'an answer that names no model is not counted (the model guard cannot see it)', file: GW, tests: T.turn,
    from: '        else if (r.answered) unnamed[r.model] = (unnamed[r.model] ?? 0) + 1;', to: ''},
  // ---- the session: its environment, its jail, its tool decisions, who answered
  {id: 'S1', what: 'the bridge inherits the controller\'s whole environment (the key included)', file: TURN, tests: T.turn,
    from: 'if (v !== undefined && (BRIDGE_ENV_ALLOW.includes(k) || k.startsWith("LC_"))) env[k] = v;', to: 'if (v !== undefined) env[k] = v;'},
  {id: 'S2', what: 'a session starts unjailed when it was not told it may', file: TURN, tests: T.turn,
    from: '  } else if (!box.allowUnsandboxed) throw fail("SANDBOX_UNAVAILABLE",', to: '  } else if (false) throw fail("SANDBOX_UNAVAILABLE",'},
  {id: 'S3', what: 'a tool the table does not name is allowed', file: TURN, tests: T.turn,
    from: '    return dec(false, "TOOL_NOT_ALLOWED", `tool ${name} is not allowed in an implementer session`, { who });', to: '    return dec(true, null, "allowed", { who });'},
  {id: 'S4', what: 'a subagent may run a command', file: TURN, tests: T.turn,
    from: '      if (child) return dec(false, "SUBAGENT_SCOPE", "a subagent runs no command: the implementer runs the unit\'s verify command", { who });', to: ''},
  {id: 'S5', what: 'a read-only specialist may write', file: TURN, tests: [...T.turn, ...T.pipe],
    from: '      if (sub && !sub.write) return dec(false, "SUBAGENT_SCOPE", `a ${sub.type} subagent reads only: it may not write`, { who });', to: ''},
  {id: 'S6', what: 'a child the controller cannot attribute may write', file: TURN, tests: T.turn,
    from: '      if (child && !sub) return dec(false, "SUBAGENT_SCOPE", "a child the controller cannot attribute to an admitted subagent may not write", { who });', to: ''},
  {id: 'S7', what: 'the model guard does not check the implementer\'s own answers', file: TURN, tests: T.turn,
    from: '    return check("implementer", model) ?? (model !== SUBAGENT_MODEL ? check("subagent", SUBAGENT_MODEL) : null);', to: '    return model !== SUBAGENT_MODEL ? check("subagent", SUBAGENT_MODEL) : null;'},
  {id: 'S8', what: 'the model guard does not check the subagents\' answers (a child answered as another model is taken as Hydrogen\'s)', file: TURN, tests: T.turn,
    from: '    return check("implementer", model) ?? (model !== SUBAGENT_MODEL ? check("subagent", SUBAGENT_MODEL) : null);', to: '    return check("implementer", model);'},
  {id: 'S14', what: 'a name the identity policy does not declare passes the model guard', file: TURN, tests: T.turn,
    from: '.find(r => !(r.id?.known && want?.known && r.id.id === want.id));', to: '.find(r => r.id?.known && want?.known && r.id.id !== want.id);'},
  {id: 'S15', what: 'an answer under no name at all passes the model guard', file: TURN, tests: T.turn,
    from: '      return (g?.unnamed?.[asked] ?? 0) > 0 ? mismatch(', to: '      return false ? mismatch('},
  {id: 'S16', what: 'the model guard is not first: a quota refusal or a failure after another model\'s answer is acted on', file: TURN, tests: T.turn,
    from: '    if (refused) throw refused;', to: ''},
  {id: 'S17', what: 'a session that answers although the provider answered nothing is accepted, with the model asked as served', file: TURN, tests: T.turn,
    from: '    if (!names.length) throw mismatch(', to: '    if (false) throw mismatch('},
  {id: 'S9', what: 'the home\'s credential-bearing directories are not hidden from the bridge', file: TURN, tests: T.turn,
    from: '          extra.push("--tmpfs", p);', to: ''},
  {id: 'S10', what: 'the provider is not asked whether it serves the model', file: TURN, tests: T.turn,
    from: '    if (checkAvailability) {', to: '    if (false) {'},
  {id: 'S11', what: 'an unavailable subagent model is ignored (subagents are offered anyway)', file: TURN, tests: T.turn,
    from: '        if (!s.available) {', to: '        if (false) {'},
  {id: 'S12', what: 'an unqualified SDK version runs', file: TURN, tests: T.turn,
    from: '  return ok.includes(got.version) ? null :', to: '  return true ? null :'},
  {id: 'S13', what: 'a python or bridge under /tmp is not bound back into the jail', file: TURN, tests: T.turn,
    from: 'keep_visible: keep, extra_ro: underTmp });', to: 'keep_visible: keep });'},
  // ---- the pipeline's SDK seat
  {id: 'P1', what: 'a native subagent\'s requests are charged as the implementer\'s continuations', file: PT, tests: T.pipe,
    from: '      const kind = info.class === "subagent" ? "subagent" : own++ === 0 ? "session" : "continuation";', to: '      const kind = own++ === 0 ? "session" : "continuation";'},
  {id: 'P2', what: 'the native subagent bucket is the implementer\'s', file: IDX, tests: T.pipe,
    from: 'kind === "failover" ? "metered_failover" : kind === "subagent" ? "native_subagent" : role);', to: 'kind === "failover" ? "metered_failover" : role);'},
  {id: 'P3', what: 'an SDK seat is handed to the agy CLI worker', file: PT, tests: T.pipe,
    from: '  const implementer = async args => (isSdkSeat(args?.seat) ? sdkImplementer(args) : laneImplementer(args));', to: '  const implementer = async args => laneImplementer(args);'},
  {id: 'P4', what: 'a fault no rung can cure walks the ladder instead of blocking the unit', file: IMP, tests: T.pipe,
    from: '    if (blocker) return Object.assign(rec, { code: blocker, transport_blocker: true,', to: '    if (false) return Object.assign(rec, { code: blocker, transport_blocker: true,'},
  {id: 'P5', what: 'an unavailable model is retried on the same rung like a transport failure', file: IDX, tests: T.pipe,
    from: 'a.lane_failure.cause === "model_unavailable" ? "model_unavailable" : "lane";', to: '"lane";'},
  {id: 'P6', what: 'a quota refusal or an unavailable model does not skip the model\'s other thinking levels', file: IDX, tests: T.pipe,
    from: '          if (wholeModel) while (nextLevel < iLadder.length && baseOf(iLadder[nextLevel]) === baseOf(seat)) nextLevel++;', to: ''},
  {id: 'P7', what: 'the A2A relay is opened for a unit whose every rung is an SDK seat', file: IDX, tests: T.pipe,
    from: '      if (iLadder.some(s => !isSdkSeat(s))) {', to: '      if (true) {'},
  {id: 'P8', what: 'native subagents are not contributors (they could review their own work)', file: REC, tests: [...T.pipe, ...T.fit],
    from: '    for (const n of native.values()) out.push({ kind: "subtask",', to: '    for (const n of []) out.push({ kind: "subtask",'},
  {id: 'P9', what: 'two thinking levels of one model are one rung', file: IMP, tests: T.pipe,
    from: ' && (a.effort ?? null) === (b.effort ?? null) && (a.transport ?? null) === (b.transport ?? null);', to: ' && (a.transport ?? null) === (b.transport ?? null);'},
  {id: 'P10', what: 'an SDK seat is asked as a single turn (lane first, by the agy CLI)', file: PT, tests: T.pipe,
    from: '    if (isSdkSeat(seat)) throw fail("SDK_SEAT_NOT_SINGLE_TURN",', to: '    if (false) throw fail("SDK_SEAT_NOT_SINGLE_TURN",'},
  {id: 'P11', what: 'a resumed unit drops its native subagent receipts', file: IDX, tests: [...T.pipe, ...T.rel],
    from: '          native_subagents: (got.record.native_subagents ?? []).map(x => ({ ...clone(x), from_checkpoint: true })) } });', to: '          native_subagents: [] } });'},
  {id: 'P12', what: 'what a failed session recorded is dropped', file: IMP, tests: T.pipe,
    from: '    if (e?.session) rec.session = clone(e.session);   // what an SDK session recorded up to its failure', to: ''},
  {id: 'P13', what: 'the implementer prompt offers every allowed name, pinned or not', file: IMP, tests: T.pipe,
    from: '  const types = native ? subs.filter(n => Object.hasOwn(SUBAGENT_TYPES, n)) : [], ceiling = native ? ceilingFor(seat.model) : 0;', to: '  const types = native ? subs : [], ceiling = native ? ceilingFor(seat.model) : 0;'},
  {id: 'P15', what: 'a subagent answered under two names is recorded under neither', file: REC, tests: T.pipe,
    from: '        for (const served of named.length ? named : [null]) {', to: '        for (const served of named.length === 1 ? named : [null]) {'},
  {id: 'P16', what: 'a subagent that was never answered is recorded without the "unnamed" marker', file: REC, tests: [...T.pipe, 'ophanim/operate/wave3-identity.test.mjs'],
    from: 'served_model: n.served, served_model_source: n.served ? "provider" : "unnamed" });', to: 'served_model: n.served, ...(n.served ? { served_model_source: "provider" } : {}) });'},
  // primary Gemini API execution: its own setting, default off (owner decision 2026-11-19, L-136)
  {id: 'P17', what: 'the billing policy is not asked before the session is started: with gemini_api_primary off the transport is entered', file: PT, tests: [...T.pipe, ...T.fit],
    from: '    try { geminiAdmission(billing, billed(null, 1)); } catch (e) { throw Object.assign(e, { transport: SDK_TRANSPORT }); }\n', to: ''},
  {id: 'P18', what: 'a session is billed as a failover: the failover setting stands for the primary one (one authorization for two kinds of spend)', file: PT, tests: T.pipe,
    from: 'const billed = (info, request) => ({ kind: "primary",', to: 'const billed = (info, request) => ({ kind: "failover",'},
  {id: 'P19', what: 'the billing policy\'s refusal of the seat is not a blocker: the unit spends rungs and revisions on it', file: IMP, tests: T.pipe,
    from: '"SDK_VERSION", "SDK_UNAVAILABLE", "GEMINI_PRIMARY_DISABLED", "METERED_GEMINI_BUDGET_EXHAUSTED"]);', to: '"SDK_VERSION", "SDK_UNAVAILABLE"]);'},
  {id: 'P20', what: 'a session\'s billed requests are not put to the billing policy one by one: none is recorded, and the budget cannot run out inside a session', file: PT, tests: T.pipe,
    from: '        spendGemini(billing, billed(info, ++requests), () => {', to: '        ((ctx, row, own) => own(row))(billing, billed(info, ++requests), () => {'},
  {id: 'P21', what: 'a request the billing policy refused inside a session is reported as the run\'s own call bound', file: PT, tests: T.pipe,
    from: '      if (refusedByBilling && e?.code === "PROVIDER_LIMIT") throw', to: '      if (false) throw'},
  // ---- routing
  {id: 'R1', what: 'the Google implementer is moved behind an Antigravity lane again ("Antigravity first")', file: FR, tests: [...T.route, ...T.board],
    from: '    if(isSdkSeat(c)||c.direct_api){out.push(c);continue;}', to: ''},
  {id: 'R2', what: 'the per-file board runs a seat that names the SDK transport (through the agy CLI)', file: RI, tests: T.board,
    from: '    if (transport === SDK_TRANSPORT) {', to: '    if (false) {'},
  {id: 'R3', what: 'a rejection does not raise the thinking level before the next model', file: FM, tests: T.route,
    from: '    for (const effort of at === -1 ? [r.effort] : levels.slice(at)) if', to: '    for (const effort of [r.effort]) if'},
  {id: 'R4', what: 'the selector hands the board an SDK seat it cannot run', file: FR, tests: [...T.route, ...T.board],
    from: "const boardSeat=c=>({transport:'api',direct_api:true,session_transport:c.transport,matrixEffort:c.effort??null});", to: 'const boardSeat=c=>({transport:c.transport,matrixEffort:c.effort??null});'},
  // ---- the lifecycle stage and the launcher
  {id: 'L1', what: 'a native subagent is predicted as a contributor for every unit', file: STG, tests: T.fit,
    from: "export const mayDelegate = unit => ceilingFor(IMPLEMENTER_LADDERS[unit.difficulty][0].model) > 0 && (unit.allowed_subagents ?? []).some(n => Object.hasOwn(SUBAGENT_TYPES, n));", to: 'export const mayDelegate = unit => true;'},
  {id: 'L2', what: 'a transport that cannot run is reported as unresolved units, not by name', file: STG, tests: T.wave,
    from: '      if (noTransport.length && noTransport.length === stuck.length) {', to: '      if (false) {'},
  {id: 'L3', what: 'a manifest that does not enable primary Gemini API execution is accepted (the run would plan and not implement)', file: LR, tests: T.live,
    from: "    if (m.billing.gemini_api_primary !== true) why.push(", to: '    if (false) why.push('},
  {id: 'L4', what: 'a required subagent that was admitted but never started is counted', file: LR, tests: T.rel,
    from: 'c.type === req.type && c.model === req.model && c.started && c.served_model && sameModel(c.served_model, req.model));', to: 'c.type === req.type && c.model === req.model);'},
  {id: 'L5', what: 'a missing SDK does not fail the launcher\'s preflight by name', file: LR, tests: T.live,
    from: "  if (out.python.includes('/') && !fs.existsSync(out.python)) fail('sdk',", to: "  if (false) fail('sdk',"},
  {id: 'L6', what: 'the launcher does not require GEMINI_API_KEY', file: LR, tests: T.live,
    from: "  if (!creds.gemini.present) add('credential GEMINI_API_KEY is not present:", to: "  if (false) add('credential GEMINI_API_KEY is not present:"},
  {id: 'L7', what: 'the launcher does not declare the manifest\'s primary setting to the billing policy: an enabled run cannot implement', file: LR, tests: T.live,
    from: '  gemini_api_primary: {enabled: m.billing.gemini_api_primary, ...(m.billing.gemini_primary_budget !== undefined ? {budget: m.billing.gemini_primary_budget} : {})}}, \'live-run manifest billing\');', to: '}, \'live-run manifest billing\');'},
  // ---- the prompt intake
  {id: 'I1', what: 'the prompt is trimmed before it is kept', file: PI, tests: T.prompt,
    from: "    const body = JSON.stringify({schema: PROMPT_SCHEMA, item, prompt, prompt_sha256, bytes, provenance, recorded_at: now()}, null, 2) + '\\n';", to: "    const body = JSON.stringify({schema: PROMPT_SCHEMA, item, prompt: prompt.trim(), prompt_sha256, bytes, provenance, recorded_at: now()}, null, 2) + '\\n';"},
  {id: 'I2', what: 'the identity ignores the provenance (two submissions of the same words are one item)', file: PI, tests: T.prompt,
    from: "  return {item: 'prompt-' + digest({schema: PROMPT_SCHEMA, prompt_sha256, provenance}).slice(0, 32), prompt_sha256};", to: "  return {item: 'prompt-' + digest({schema: PROMPT_SCHEMA, prompt_sha256}).slice(0, 32), prompt_sha256};"},
  {id: 'I3', what: 'a prompt registered without the owner\'s keys is reported as authorized', file: PI, tests: T.prompt,
    from: '    return {...out, authorized: false, status_entry: null, why:', to: '    return {...out, authorized: true, status_entry: null, why:'},
  {id: 'I4', what: 'a record that is not the text the owner signed is the requirement', file: PI, tests: T.prompt,
    from: '  if (rec.prompt_sha256 !== bound.sha256) return {why:', to: '  if (false) return {why:'},
  {id: 'I5', what: 'a record whose text does not hash to its stated digest is accepted', file: PI, tests: T.prompt,
    from: "  if (rec.prompt_sha256 !== sha256(rec.prompt)) return 'the record\\'s text does not hash to the digest it states';", to: ''},
  {id: 'I6', what: 'an oversized prompt is kept', file: PI, tests: T.prompt,
    from: '  if (bytes > PROMPT_MAX_BYTES) refuse(', to: '  if (false) refuse('},
  {id: 'I7', what: 'the item is not blocked while its prompt record is not the signed text', file: RC, tests: T.prompt,
    from: '    if (promptNow?.why && STAGES.includes(gate.gate)) {', to: '    if (false) {'},
  {id: 'I8', what: 'the plan stage does not check the prompt record again before asking the planner', file: STG, tests: T.prompt,
    from: '    if (bound?.why) {', to: '    if (false) {'},
  {id: 'I9', what: 'the planner is not shown the owner\'s exact words', file: STG, tests: T.prompt,
    from: "    ...(requirement?.prompt ? ['', promptSection(requirement.prompt)] : []),", to: ''},
  {id: 'I10', what: 'a prompt candidate is not recorded at intake', file: SCH, tests: T.prompt,
    from: "  for (const c of rec.prompt_candidates ?? []) intake({source: 'prompt', ref: `prompt:${c.prompt}`, item: null, classification: 'candidate', why: c.why});", to: ''},
  {id: 'I11', what: 'an item\'s prompt is not recorded at intake', file: SCH, tests: T.prompt,
    from: "    if (i.prompt) intake({source: 'prompt',", to: "    if (false) intake({source: 'prompt',"},
  {id: 'I12', what: 'a dropped record is not reported as a candidate', file: RC, tests: T.prompt,
    from: '  const prompt_candidates = promptRecords(repo).filter(r => boundTo.get(r.item) !== r.record).map(', to: '  const prompt_candidates = promptRecords(repo).filter(r => false).map('},
  {id: 'I13', what: 'the plan document does not carry the prompt to the later judges', file: STG, tests: T.prompt,
    from: '    const requirement = bound ? {...gate.requirement, prompt: bound.prompt} : gate.requirement;', to: '    const requirement = gate.requirement;'},
  {id: 'I15', what: 'text or provenance given beside --authorize is accepted (the record\'s own would be ignored or replaced)', file: CLI, tests: T.prompt,
    from: '          if (opts[k] !== undefined) usage(`prompt --authorize ITEM takes', to: '          if (false) usage(`prompt --authorize ITEM takes'},
  {id: 'I14', what: 'a record whose provenance was rewritten after the signature (or that was filed under another name) is read as the signed one', file: PI, tests: T.prompt,
    from: '  return made === item ? null :', to: '  return true ? null :'},
  {id: 'I16', what: 'authorizing reads no record: a prompt item is signed for a name with nothing recorded under it', file: PI, tests: T.prompt,
    from: '  if (rec.why) refuse(rec.why);\n  return registerPrompt(', to: '  return registerPrompt('},
  {id: 'I17', what: 'the identity is 64 bits again (a colliding record takes about 2^32 tries)', file: PI, tests: T.prompt,
    from: 'provenance}).slice(0, 32), prompt_sha256};', to: 'provenance}).slice(0, 16), prompt_sha256};'},
  {id: 'I18', what: 'a plan may propose a basis in the prompt intake\'s form', file: STG, tests: T.prompt,
    from: '  else if (j.proposes.basis.trimStart().startsWith(PROMPT_BASIS_PREFIX)) why.push(', to: '  else if (false) why.push('},
  // ---- exactly the declared argument names (independent review 2026-11-19)
  {id: 'A1', what: 'a call carrying another spelling of a declared argument is decided on the declared one alone', file: TURN, tests: T.turn,
    from: '    if (undeclared) return dec(false, "ARGS_UNDECLARED", undeclared, { who });', to: ''},
  {id: 'A2', what: 'another spelling INSIDE a declared object or list (a subagent entry\'s workspace or model) is not seen', file: 'pantheon/src/antigravity/config.mjs', tests: T.turn,
    from: '    if (!Array.isArray(nested)) continue;', to: '    continue;'},
  {id: 'A3', what: 'the verify launcher may be started in a persistent terminal, or in the terminal of an earlier command', file: TURN, tests: T.turn,
    from: '      if (a.RunPersistent === true || (a.RequestedTerminalID !== undefined', to: '      if (false && (a.RequestedTerminalID !== undefined'},
  // ---- refusals a sweep found no mutation for (2026-11-19: each was disabled in turn; these had no test that noticed, or no mutation)
  {id: 'G14', what: 'a governor is built without the implementer\'s seat (no model, so no ceiling of its own)', file: GOV, tests: T.gov,
    from: '  if (!isObj(implementer) || !str(implementer.model)) throw new Error("subagentGovernor: pass the implementer seat {vendor, model}");', to: ''},
  {id: 'W13', what: 'a path or verb outside the two models\' generation calls is served', file: GW, tests: T.gw,
    from: '    if (req.method !== "POST" || !m || !verbs.has(m[2])) {', to: '    if (false) {'},
  {id: 'W14', what: 'the implementer\'s own request is served on the subagents\' model', file: GW, tests: T.gw,
    from: '    if (!type && model !== root.model) {', to: '    if (false) {'},
  {id: 'W15', what: 'a refused charge is answered as refused and the request is forwarded anyway', file: GW, tests: T.gw,
    from: '      refuse(res, rec, 403, GATEWAY_REFUSALS.BUDGET, String(e?.message ?? e).slice(0, 900), "PERMISSION_DENIED");\n      return done();', to: ''},
  {id: 'W16', what: 'a request of any size is read whole into the controller\'s memory', file: GW, tests: T.gw,
    from: 'if (size > maxBodyBytes) {', to: 'if (false) {'},
  {id: 'W17', what: 'a gateway starts without the implementer\'s model or marker (its requests would be nobody\'s)', file: GW, tests: T.gw,
    from: '  if (!str(root?.model) || !str(root?.marker)) throw new Error("startModelGateway: pass root {model, marker}");', to: ''},
  {id: 'W18', what: 'a size bound that is not a positive whole number is accepted', file: GW, tests: T.gw,
    from: '  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) throw', to: '  if (false) throw'},
  {id: 'I19', what: 'a record that is no longer the submission is signed for when the original words are submitted again', file: PI, tests: T.prompt,
    from: "    if (have.why || have.prompt !== prompt || digest(have.provenance) !== digest(provenance)) refuse(", to: "    if (false) refuse("},
  {id: 'I20', what: 'any refusal of the status ledger is reported as a candidate awaiting the owner\'s keys', file: PI, tests: T.prompt,
    from: "    if (!/no operator or orderer key is held here/.test(String(e?.message ?? e))) throw e;", to: ''},
  {id: 'I21', what: 'authorization reads whatever path it is given in place of an item id', file: PI, tests: T.prompt,
    from: "  if (!ID.test(item ?? '')) refuse('authorize names a prompt item id", to: "  if (false) refuse('authorize names a prompt item id"},
  {id: 'I22', what: 'a prompt is registered with no repository or no status ledger named', file: PI, tests: T.prompt,
    from: "  if (!str(repo) || !str(statusRoot)) refuse('registerPrompt: pass the repository and the status ledger');", to: ''},
  {id: 'I23', what: 'a prompt is authorized with no repository or no status ledger named', file: PI, tests: T.prompt,
    from: "  if (!str(repo) || !str(statusRoot)) refuse('authorizePrompt: pass the repository and the status ledger');", to: ''},
  {id: 'I24', what: 'a prompt is registered with a provenance that does not say who, when and through what', file: PI, tests: T.prompt,
    from: '  if (pw) refuse(pw);', to: ''},
  {id: 'I25', what: 'an empty prompt is registered', file: PI, tests: T.prompt,
    from: "  if (!str(prompt)) refuse('prompt is the user\\'s text: a non-empty string');", to: ''},
  {id: 'S18', what: 'a session is started for a seat that names no model', file: TURN, tests: T.turn,
    from: '  if (!str(model)) throw fail("BAD_SEAT", "runAntigravitySdkTurn: pass the implementer seat {vendor, model}");', to: ''},
  {id: 'S19', what: 'an effort the SDK does not accept is passed to the session', file: TURN, tests: T.turn,
    from: '  if (effort !== null && !SDK_THINKING.includes(effort)) throw fail("BAD_SEAT",', to: '  if (false) throw fail("BAD_SEAT",'},
  {id: 'S20', what: 'a session is started with no prompt', file: TURN, tests: T.turn,
    from: '  if (!str(prompt)) throw fail("BAD_INPUT", "runAntigravitySdkTurn: pass the unit prompt");', to: ''},
  {id: 'S21', what: 'a missing or unusable key is not refused before the workspace is prepared (the gateway refuses it later)', file: TURN, tests: T.turn,
    from: '  { const bad = keyRefusal(apiKey); if (bad) throw fail("NO_API_KEY", str(apiKey) ?', to: '  { const bad = null; if (bad) throw fail("NO_API_KEY", str(apiKey) ?'},
  {id: 'S22', what: 'a run that was already stopped prepares a workspace and starts a bridge', file: TURN, tests: T.turn,
    from: '  if (signal?.aborted) throw fail("ABORTED", "the run was aborted before the implementer session started");', to: ''},
  {id: 'S23', what: 'a missing python is reported without what to set, after the workspace was prepared', file: TURN, tests: T.turn,
    from: '  if (python.includes("/") && !existsSync(python)) throw laneFailure("spawn",', to: '  if (false) throw laneFailure("spawn",'},
  {id: 'S24', what: 'a missing bridge is run anyway: an ordinary failure of the model\'s lane, not "the SDK is not here"', file: TURN, tests: T.turn,
    from: '  if (!existsSync(bridge)) throw laneFailure("spawn",', to: '  if (false) throw laneFailure("spawn",'},
  {id: 'S25', what: 'a workspace is prepared without its control directory or its worktree', file: TURN, tests: T.turn,
    from: '  if (!str(control_dir) || !str(worktree)) throw fail("NO_WORKSPACE",', to: '  if (false) throw fail("NO_WORKSPACE",'},
  {id: 'S26', what: 'a workspace is prepared for a unit that owns no path', file: TURN, tests: T.turn,
    from: '  else if (!Array.isArray(owned_paths) || !owned_paths.length) throw fail("NO_OWNED_PATHS",', to: '  else if (false) throw fail("NO_OWNED_PATHS",'},
  {id: 'S27', what: 'a read that names no path is allowed', file: TURN, tests: T.turn,
    from: '      if (!paths.length) return dec(false, "READ_NO_PATH",', to: '      if (false) return dec(false, "READ_NO_PATH",'},
  {id: 'S28', what: 'a decision that throws allows the call', file: TURN, tests: T.turn,
    from: '  } catch (e) { return dec(false, "DECISION_EXCEPTION",', to: '  } catch (e) { return dec(true, "DECISION_EXCEPTION",'},
  {id: 'S29', what: 'a quota refusal of the availability check is an ordinary transport failure', file: TURN, tests: T.turn,
    from: '        if (a.kind === "quota") throw carry(fail("quota_exhausted",', to: '        if (false) throw carry(fail("quota_exhausted",'},
  {id: 'S30', what: 'a session is started although the provider could not be asked whether it serves the model', file: TURN, tests: T.turn,
    from: '        throw carry(laneFailure("exit", `the provider could not be asked about', to: '        if (false) throw carry(laneFailure("exit", `the provider could not be asked about'},
  {id: 'S31', what: 'a key the provider refuses during the session is an ordinary failure of the lane (a ladder step)', file: TURN, tests: T.turn,
    from: '      if (stopped?.kind === "auth") throw fail("CREDENTIAL_REFUSED",', to: '      if (false) throw fail("CREDENTIAL_REFUSED",'},
  // (these the sweep found KILLED already; they are listed so that they stay so)
  {id: 'S32', what: 'the control directory may lie inside the worktree (the session could read and write the controller\'s files)', file: TURN, tests: T.turn,
    from: '  if (inside(wt, ctl) || inside(ctl, wt)) throw fail("CONTROL_IN_WORKTREE",', to: '  if (false) throw fail("CONTROL_IN_WORKTREE",'},
  {id: 'S33', what: 'an MCP tool is decided like a built-in one of the same name', file: TURN, tests: T.turn,
    from: '    if (server_name) return dec(false, "TOOL_NOT_ALLOWED",', to: '    if (false) return dec(false, "TOOL_NOT_ALLOWED",'},
  {id: 'S34', what: 'a read outside the worktree is allowed', file: TURN, tests: T.turn,
    from: '        if (d.decision !== "auto_approve") return dec(false, "READ_OUTSIDE",', to: '        if (false) return dec(false, "READ_OUTSIDE",'},
  {id: 'S35', what: 'a session starts unjailed where bwrap cannot be used', file: TURN, tests: T.turn,
    from: '      if (!box.allowUnsandboxed) throw fail("SANDBOX_UNAVAILABLE", `the implementer session is not started unjailed: bwrap is not usable', to: '      if (false) throw fail("SANDBOX_UNAVAILABLE", `the implementer session is not started unjailed: bwrap is not usable'},
  {id: 'S36', what: 'a key the provider refuses at the availability check starts a session anyway', file: TURN, tests: T.turn,
    from: '        if (a.kind === "auth") throw carry(fail("CREDENTIAL_REFUSED",', to: '        if (false) throw carry(fail("CREDENTIAL_REFUSED",'},
  {id: 'S37', what: 'a model the provider does not serve is not reported as unavailable', file: TURN, tests: T.turn,
    from: '        if (a.kind === "model_unavailable") throw carry(fail("model_unavailable",', to: '        if (false) throw carry(fail("model_unavailable",'},
  {id: 'S38', what: 'a stopped session\'s result is acted on', file: TURN, tests: T.turn,
    from: '    if (signal?.aborted) throw fail("ABORTED", `the implementer session was stopped:', to: '    if (false) throw fail("ABORTED", `the implementer session was stopped:'},
  {id: 'S39', what: 'the run\'s own bound refusing a request is an ordinary failure of the lane', file: TURN, tests: T.turn,
    from: '      if (stopped?.kind === "budget") throw fail("PROVIDER_LIMIT",', to: '      if (false) throw fail("PROVIDER_LIMIT",'},
  {id: 'S40', what: 'a quota refusal during the session is an ordinary failure of the lane', file: TURN, tests: T.turn,
    from: '      if (stopped?.kind === "quota") throw fail("quota_exhausted",', to: '      if (false) throw fail("quota_exhausted",'},
  {id: 'S41', what: 'a model that becomes unavailable during the session is an ordinary failure of the lane', file: TURN, tests: T.turn,
    from: '      if (stopped?.kind === "model_unavailable") throw fail("model_unavailable",', to: '      if (false) throw fail("model_unavailable",'},
  {id: 'I26', what: 'the command line takes --text and --file together (one is dropped unsaid), or neither', file: CLI, tests: T.prompt,
    from: "        if ((opts.text === undefined) === (opts.file === undefined)) usage('prompt needs the text:", to: "        if (false) usage('prompt needs the text:"},
  {id: 'I27', what: 'a prompt is registered with no author (the provenance does not say who)', file: CLI, tests: T.prompt,
    from: "        if (!author) usage('prompt needs --author NAME (who submitted it)');", to: ''},
  // ---- the bridge: what the SDK process itself does with the controller's decisions. Run against the bridge alone
  // (T.bridge); only B6, which is about the tool list the RUNTIME then offers, needs a session (T.contract).
  {id: 'B1', what: 'the bridge runs a call the controller refused', file: BR, tests: T.bridge,
    from: '    if d.get("allow") is True:', to: '    if True:'},
  {id: 'B2', what: 'a call the controller did not decide in time is run', file: BR, tests: T.bridge,
    from: '      return types.HookResult(allow=False, message="PANTHEON_NO_DECISION:', to: '      return types.HookResult(allow=True, message="PANTHEON_NO_DECISION:'},
  {id: 'B3', what: 'a call made while the session is stopping is run', file: BR, tests: T.bridge,
    from: '        return types.HookResult(allow=False, message="PANTHEON_NO_CONTROLLER:', to: '        return types.HookResult(allow=True, message="PANTHEON_NO_CONTROLLER:'},
  {id: 'B4', what: 'a subagent type is configured without its pinned model', file: BR, tests: T.bridge,
    from: 'system_instructions=s["system"], model=s["model"],', to: 'system_instructions=s["system"],'},
  {id: 'B5', what: 'the runtime retries a refused request itself, before the controller judges it', file: BR, tests: T.bridge,
    from: 'api_retry=types.ModelAPIRetryConfig(max_retries=0)', to: 'api_retry=types.ModelAPIRetryConfig(max_retries=3)'},
  {id: 'B6', what: 'the runtime\'s define_subagent tool is offered to the model', file: BR, tests: T.contract,
    from: '        cfg.harness_side_tools.subagents.disable_define_subagent_tool = True\n        for ca', to: '        cfg.harness_side_tools.subagents.disable_define_subagent_tool = False\n        for ca'},
  {id: 'B7', what: 'the runtime is told any subagent type may be invoked', file: BR, tests: T.bridge,
    from: '        allowed_subagents=[s.name for s in subs] if subs else None,', to: '        allowed_subagents=None,'},
  {id: 'B8', what: 'the runtime is told subagents may delegate three levels deep', file: BR, tests: T.bridge,
    from: '        max_subagent_depth=int(c.get("max_subagent_depth") or 1) if subs else None,', to: '        max_subagent_depth=3 if subs else None,'},
  {id: 'B9', what: 'the runtime\'s own containment of file tools to the workspace is off', file: BR, tests: T.bridge,
    from: '        policies=[policy.allow_all(), *policy.workspace_only([c["workspace"]])],', to: '        policies=[policy.allow_all()],'},
  {id: 'B10', what: 'commands may be started as daemons that outlive the call', file: BR, tests: T.bridge,
    from: 'run_command_config=types.RunCommandConfig(enable_daemons=False,', to: 'run_command_config=types.RunCommandConfig(enable_daemons=True,'},
  {id: 'B11', what: 'the runtime\'s image model goes to the provider directly, around the gateway', file: BR, tests: T.bridge,
    from: 'types.ModelTarget(name=c["model"], types=[types.ModelType.IMAGE], endpoint=types.GeminiAPIEndpoint(api_key=gw["token"], base_url=gw["url"]))]', to: 'types.ModelTarget(name=c["model"], types=[types.ModelType.IMAGE], endpoint=types.GeminiAPIEndpoint(api_key=gw["token"]))]'},
  {id: 'B12', what: 'the session budget (model calls, tool calls) is not given to the runtime', file: BR, tests: T.bridge,
    from: '    budget = types.BudgetConfig(**{k: int(v) for k, v in b.items() if v})', to: '    budget = types.BudgetConfig()'},
  {id: 'B14', what: 'a call still waiting for its decision when the session is cancelled is run', file: BR, tests: T.bridge,
    from: '        fut.set_result({"allow": False, "message": f"PANTHEON_CANCELLED: {self.cancelled}"})', to: '        fut.set_result({"allow": True, "message": f"PANTHEON_CANCELLED: {self.cancelled}"})'},
  {id: 'B13', what: 'the pre-tool hook is not installed: no call is put to the controller at all', file: BR, tests: T.bridge,
    from: '        hooks=[pre_tool, post_tool, on_error],', to: '        hooks=[post_tool, on_error],'},
  {id: 'P22', what: 'an SDK implementer turn is entered with no worktree', file: PT, tests: T.pipe,
    from: '    if (!str(cwd)) throw fail("NO_WORKTREE", "the implementer turn needs the unit\'s worktree (cwd)");\n    const s = { vendor: seat?.vendor ?? vendor,', to: '    const s = { vendor: seat?.vendor ?? vendor,'},
  {id: 'P23', what: 'a session is started when the stage\'s deadline leaves no time for one', file: PT, tests: T.pipe,
    from: '    if (turnS === null) throw fail("DEADLINE", `the stage\'s deadline leaves no time for an implementer session', to: '    if (false) throw fail("DEADLINE", `the stage\'s deadline leaves no time for an implementer session'},
  {id: 'L8', what: 'the executors ignore the removed option without a word (a caller that still passes it runs with primary off)', file: STG, tests: T.fit,
    from: '  if (Object.hasOwn(rest, \'geminiApiPrimary\')) throw new Error(', to: '  if (false) throw new Error('},
  {id: 'L9', what: 'the manifest\'s failover switch may be something other than true or false', file: LR, tests: T.live,
    from: "  if (typeof m.billing.metered_gemini_failover !== 'boolean') why.push(", to: "  if (false) why.push("},
  {id: 'L10', what: 'the manifest may require a credential the launcher does not know (it would never be checked)', file: LR, tests: T.live,
    from: "    for (const x of r) if (![...ANTHROPIC_CREDENTIALS, ...OTHER_CREDENTIALS, ...OPTIONAL_CREDENTIALS].includes(x)) why.push(", to: "    for (const x of r) if (false) why.push("},
  {id: 'R5', what: 'a pick or a ladder rung may name a model the config does not declare', file: FM, tests: T.route,
    from: '      if (!Object.hasOwn(cfg.models, model)) return', to: '      if (false) return'},
  {id: 'R6', what: 'a pick or a ladder rung may name a thinking level nobody recorded for its model', file: FM, tests: T.route,
    from: '      if (effort !== null && !(Array.isArray(levels) && levels.includes(effort))) return', to: '      if (false) return'},
  {id: 'R8', what: 'thinking levels written as one string pass as a list that contains the level', file: FM, tests: T.route,
    from: '!(Array.isArray(levels) && levels.includes(effort))', to: '!(levels ?? []).includes(effort)'},
  {id: 'R7', what: 'a ladder may start somewhere other than its own difficulty\'s pick', file: FM, tests: T.route,
    from: '    if (ladder[0].model !== pick.model || (ladder[0].effort ?? null) !== (pick.effort ?? null)) return', to: '    if (false) return'},
  {id: 'W19', what: 'a subagent\'s failed request stops the implementer\'s session', file: GW, tests: T.turn,
    from: '        if (rec.class !== "subagent") stop = failure;', to: '        stop = failure;'},
  // ---- the gateway after a stop, and what it records
  {id: 'W10', what: 'a request admitted while the session was being stopped is still forwarded', file: GW, tests: T.gw,
    from: '    // request is still not sent.\n    if (stopped()) {', to: '    // request is still not sent.\n    if (false) {'},
  {id: 'W11', what: 'callers without the token grow the record without bound', file: GW, tests: T.gw,
    from: '      if (++unauthorized > MAX_UNAUTHORIZED_ROWS) { requests.splice(', to: '      if (++unauthorized > Infinity) { requests.splice('},
  {id: 'W12', what: 'a key that is not a clean header value is put in a header (the HTTP layer quotes it in its error)', file: GW, tests: T.gw,
    from: '  { const bad = keyRefusal(apiKey); if (bad) throw Object.assign(new Error(`the gateway was given', to: '  { const bad = null; if (bad) throw Object.assign(new Error(`the gateway was given'},
  // ---- the independent review of the billing merge (2026-11-20): what the documented outcome rested on
  {id: 'P24', what: 'a request the billing policy refused inside a session is forgotten when the session ends well: the unit takes its result', file: PT, tests: T.pipe,
    from: '      if (refusedByBilling) throw Object.assign(refusedByBilling, { session, transport: SDK_TRANSPORT });', to: '      if (false) throw Object.assign(refusedByBilling, { session, transport: SDK_TRANSPORT });'},
  {id: 'L11', what: 'the launcher\'s plan reads only the plain gate: a stage the policy refused stays "nothing to dispatch" after the manifest declares another budget', file: LR, tests: T.live,
    from: 'runnable: STAGES.includes(g.gate) || wake !== null,', to: 'runnable: STAGES.includes(g.gate),'},
  {id: 'L12', what: 'the launcher\'s run does not tick on a billing wake (the plan says runnable, and nothing is dispatched)', file: LR, tests: T.live,
    from: '(STAGES.includes(gate.gate) || billingWakeOf(gate, billing) !== null)', to: '(STAGES.includes(gate.gate))'},
  {id: 'L13', what: 'the launcher takes any stage pending on a billing refusal as runnable, whether or not the policy changed', file: LR, tests: T.live,
    from: '&& policy && billingChanged(gate.blocker, policy)', to: '&& policy'},
  {id: 'L14', what: 'a stage that billed before it was refused says nothing billed was sent', file: SCH, tests: T.live,
    from: '    const sent = ctx.rows.length;', to: '    const sent = 0;'},
  // ---- THE RESEARCH TEAM (owner direction 2026-11-20): routing, the read-only session, the controller, the ledger, the lifecycle
  {id: 'RS1', what: 'a research depth over 10 is accepted from configuration', file: ACFG, tests: T.rroute,
    from: ' || r.max_depth > RESEARCH_DEPTH_LIMIT) return', to: ') return'},
  {id: 'RS2', what: 'a research session may be configured with a tool that is not a read tool', file: ACFG, tests: T.rroute,
    from: '  for (const t of r.tools ?? []) if (!SDK_READ_TOOLS.includes(t)) return', to: '  for (const t of r.tools ?? []) if (false) return'},
  {id: 'RS3', what: 'the research subordinate may be another model than the subagent model (a second Hydrogen policy)', file: ACFG, tests: T.rroute,
    from: '  if (r.subordinate?.model !== cfg.subagents?.model) return', to: '  if (false) return'},
  {id: 'RS4', what: 'a candidate that does not qualify is seated all the same', file: FM, tests: T.rroute,
    from: '    if (why) { rejected.push({ model: c.model, why: String(why) }); continue; }', to: '    if (false) { rejected.push({ model: c.model, why: String(why) }); continue; }'},
  {id: 'RS5', what: 'every research coordinator gets eight subordinates, whatever its model\'s ceiling', file: FM, tests: T.rroute,
    from: 'max_active: ceilingFor(model), ...config.research.bounds', to: 'max_active: 8, ...config.research.bounds'},
  {id: 'RS6', what: 'the scout is configured on another model than Carbon', file: CFG, tests: T.rroute,
    from: '"scout": { "candidates": [{ "model": "gemini-4-carbon", "effort": "high" }]', to: '"scout": { "candidates": [{ "model": "gemini-4-neon", "effort": null }]'},
  {id: 'RS7', what: 'a research session is served a write, a command or a native delegation', file: TURN, tests: T.turn,
    from: '    if (policy?.read_only && !READ_TOOLS.includes(name)) {', to: '    if (false) {'},
  {id: 'RS8', what: 'a research session\'s repository bind is writable', file: TURN, tests: [...T.turn, ...T.contract],
    from: 'if (jail.argv[i] === "--bind" && jail.argv[i + 2] === paths.worktree) jail.argv[i] = "--ro-bind";', to: 'if (false) jail.argv[i] = "--ro-bind";'},
  {id: 'RS9', what: 'a research session has the implementer\'s native subagent ceiling', file: TURN, tests: T.turn,
    from: '  let ceiling = research ? 0 : ceilingFor(model);', to: '  let ceiling = ceilingFor(model);'},
  {id: 'RS10', what: 'a research session\'s read is not recorded with what it examined', file: TURN, tests: T.turn,
    from: '{ who, sources: sourcesOf(policy, paths) })', to: '{ who, sources: [] })'},
  {id: 'RS11', what: 'a research session is offered the implementer\'s tools', file: TURN, tests: T.turn,
    from: '      enabled_tools: research ? (research.tools ?', to: '      enabled_tools: false ? (research.tools ?'},
  {id: 'RS12', what: 'level 11 is admitted', file: RT, tests: T.rteam,
    from: '    if (depth > limits.max_depth) return no("RESEARCH_DEPTH_EXCEEDED",', to: '    if (false) return no("RESEARCH_DEPTH_EXCEEDED",'},
  {id: 'RS13', what: 'depth is not nested: every delegation counts as level 2', file: RT, tests: T.rteam,
    from: '    const depth = parent.depth + 1;', to: '    const depth = 2;'},
  {id: 'RS14', what: 'a delegation that names no open question of its parent is admitted', file: RT, tests: T.rteam,
    from: '    const gap = list(parent.report?.unresolved).find(u => u.id === d.addresses);', to: '    const gap = list(parent.report?.unresolved).find(u => u.id === d.addresses) ?? { id: String(d.addresses ?? "none"), question: "(none)" };'},
  {id: 'RS15', what: 'a coordinator on a model whose ceiling is 0 delegates', file: RT, tests: T.rteam,
    from: '    if (limits.max_active < 1) return no("RESEARCH_NO_SUBORDINATES",', to: '    if (false) return no("RESEARCH_NO_SUBORDINATES",'},
  {id: 'RS16', what: 'a delegation may leave the team\'s scope', file: RT, tests: T.rteam,
    from: '      if (!team.scope.some(s => s === "." || p === s || p.startsWith(s.endsWith("/") ? s : s + "/"))) return', to: '      if (false) return'},
  {id: 'RS17', what: 'a delegation may be given a tool that is not a read tool', file: RT, tests: T.rteam,
    from: '    if (badTool) return no("RESEARCH_TOOLS",', to: '    if (false) return no("RESEARCH_TOOLS",'},
  {id: 'RS18', what: 'a delegation may raise its own bounds over the node bounds', file: RT, tests: T.rteam,
    from: '      if (!Number.isInteger(d.bounds[k]) || d.bounds[k] < 1 || d.bounds[k] > nodeBounds[k]) return', to: '      if (false) return'},
  {id: 'RS19', what: 'the same question is delegated twice for the same gap', file: RT, tests: T.rteam,
    from: '    if (byId.has(id)) return no("RESEARCH_DUPLICATE",', to: '    if (false) return no("RESEARCH_DUPLICATE",'},
  {id: 'RS20', what: 'the team may create specialists without limit', file: RT, tests: T.rteam,
    from: '    if (created >= limits.max_nodes) return no("RESEARCH_NODE_BUDGET",', to: '    if (false) return no("RESEARCH_NODE_BUDGET",'},
  {id: 'RS21', what: 'every admitted specialist runs at once (a ninth active Hydrogen)', file: RT, tests: T.rteam,
    from: 'Array.from({ length: Math.min(limits.max_active, toRun.length) }, worker)', to: 'Array.from({ length: toRun.length }, worker)'},
  {id: 'RS22', what: 'the team\'s shared request bound is not enforced', file: RT, tests: T.rteam,
    from: '    if (requests.total >= limits.max_requests) {', to: '    if (false) {'},
  {id: 'RS23', what: 'a report may cite a source its node never examined', file: RT, tests: T.rteam,
    from: '    if (!seen.has(ref)) { why.push(`the report cites ${ref}, which this node never examined`); continue; }', to: ''},
  {id: 'RS24', what: 'a finding with no source is accepted', file: RT, tests: T.rteam,
    from: '    if (!list(o.sources).length) why.push(', to: '    if (false) why.push('},
  {id: 'RS25', what: 'the team goes on delegating after the coordinator is satisfied', file: RT, tests: T.rteam,
    from: '    if (c.report.satisfied) { status = "satisfied"; stop_reason = "SATISFIED"; break; }', to: ''},
  {id: 'RS26', what: 'a finished specialist of an earlier run is run (and paid for) again', file: RT, tests: [...T.rteam, ...T.rrun],
    from: '    const done = prior.get(id);', to: '    const done = null;'},
  {id: 'RS27', what: 'a specialist is not recorded before its session starts', file: RT, tests: [...T.rteam, ...T.rrun],
    from: '    await emit({ event: "node", node: publicNode(node) });   // PERSISTENT BEFORE IT RUNS', to: ''},
  {id: 'RS28', what: 'a charge the caller refused does not stop the team', file: RT, tests: [...T.rteam, ...T.rrun],
    from: '    if (callerStop) { status = "stopped"; stop_reason = callerStop.code ?? "CHARGE_REFUSED"; break; }', to: ''},
  {id: 'RS29', what: 'a stopped team still starts the specialists that were waiting', file: RT, tests: T.rteam,
    from: '    if (aborted()) { node.state = "cancelled"; node.error = { code: "ABORTED", message: "the team was stopped before this node started" };', to: '    if (false) { node.state = "cancelled"; node.error = { code: "ABORTED", message: "the team was stopped before this node started" };'},
  {id: 'RS30', what: 'the same claim from the same source and version is kept once per member (not deduplicated)', file: RT, tests: T.rteam,
    from: '        const at = entry.evidence.find(e => e.ref === ref && e.version === v.get(ref));', to: '        const at = null;'},
  {id: 'RS31', what: 'the same claim from another source is merged into the first (corroboration is lost)', file: RT, tests: T.rteam,
    from: '        const at = entry.evidence.find(e => e.ref === ref && e.version === v.get(ref));', to: '        const at = entry.evidence[0];'},
  {id: 'RS32', what: 'the coordinator is handed a member\'s findings without a bound', file: RT, tests: T.rteam,
    from: 'const b = Buffer.byteLength(r, "utf8") + 1; if (used + b > bytes) break; lines.push(r);', to: 'const b = Buffer.byteLength(r, "utf8") + 1; lines.push(r);'},
  {id: 'RS33', what: 'the model asked for is reported as the model that answered', file: RT, tests: T.rteam,
    from: '      node.served_model = r?.served_model ?? null;', to: '      node.served_model = node.seat.model;'},
  {id: 'RS34', what: 'a specialist is seated on the coordinator\'s model', file: RT, tests: T.rteam,
    from: 'specialty: d.specialty, seat: { ...subordinate },', to: 'specialty: d.specialty, seat: { ...coordinator.seat },'},
  {id: 'RS35', what: 'a request the caller refused is counted as made', file: RT, tests: T.rteam,
    from: '    catch (e) { callerStop ??= e; node._refused = e?.code ?? "CHARGE_REFUSED"; throw e; }', to: '    catch (e) { callerStop ??= e; node._refused = e?.code ?? "CHARGE_REFUSED"; requests.total += 1; throw e; }'},
  {id: 'RS36', what: 'the work ledger takes a research node at level 11', file: WL, tests: T.rrun,
    from: ' && p.depth <= RESEARCH_DEPTH_MAX && RESEARCH_NODE_STATES.includes(p.state)', to: ' && RESEARCH_NODE_STATES.includes(p.state)'},
  {id: 'RS37', what: 'the work ledger takes a specialist whose parent is not a recorded node one level above it', file: WL, tests: T.rrun,
    from: "          return team.some(q => q.phase === 'node' && q.node === p.parent && q.depth === p.depth - 1) ? null :", to: '          return true ? null :'},
  {id: 'RS38', what: 'a research team concludes twice on the ledger', file: WL, tests: T.rrun,
    from: "        if (p.phase === 'conclusion') return team.some(q => q.phase === 'conclusion') ? 'this research team has already concluded' : null;", to: ''},
  {id: 'RS39', what: 'a research node is recorded for a team the ledger does not hold', file: WL, tests: T.rrun,
    from: "        if (!team.some(q => q.phase === 'team')) return 'its team is not recorded for this item';", to: ''},
  {id: 'RS40', what: 'a team is prepared before the billing policy is asked', file: OR, tests: [...T.rrun, ...T.rlife],
    from: '  try { geminiAdmission(billing, billed(coordinator.seat.model, 1)); }', to: '  try { }'},
  {id: 'RS41', what: 'a research request is not put to the billing policy (no usage row, no budget)', file: OR, tests: [...T.rrun, ...T.rlife],
    from: '  const admit = info => { spendGemini(billing, billed(info.model, ++n), () => admitRequest({vendor: coordinator.seat.vendor, model: info.model})); };',
    to: '  const admit = info => { admitRequest({vendor: coordinator.seat.vendor, model: info.model}); };'},
  {id: 'RS42', what: 'a research request is not charged to the stage\'s provider-call bound', file: OR, tests: [...T.rrun, ...T.rlife],
    from: '  const admit = info => { spendGemini(billing, billed(info.model, ++n), () => admitRequest({vendor: coordinator.seat.vendor, model: info.model})); };',
    to: '  const admit = info => { spendGemini(billing, billed(info.model, ++n), () => {}); };'},
  {id: 'RS43', what: 'a team that was stopped by a refused charge is recorded as concluded', file: OR, tests: [...T.rrun, ...T.rlife],
    from: '  const concluded = !RESUMABLE(result.status, result.stop_reason);', to: '  const concluded = true;'},
  {id: 'RS44', what: 'a member whose stored record no longer has the recorded digest is reused', file: OR, tests: T.rrun,
    from: '      if (sha(raw) !== n.evidence.sha256) continue;', to: ''},
  {id: 'RS45', what: 'an open research request does not put the plan in question', file: GT, tests: T.rlife,
    from: '      if (open.length) { v.valid = false;', to: '      if (false) { v.valid = false;'},
  {id: 'RS46', what: 'a material conclusion a plan was not given does not put it in question', file: GT, tests: T.rlife,
    from: '      if (unseen.length) { v.valid = false;', to: '      if (false) { v.valid = false;'},
  {id: 'RS47', what: 'the reconcile does not give the gates the item\'s research', file: RC, tests: T.rlife,
    from: '      research: workLedger?.research ? (r => ({open: r.open, conclusions: r.conclusions}))(researchOf(workLedger, s.item)) : null,', to: '      research: null,'},
  {id: 'RS48', what: 'the research members are not contributors to the plan (the panel may seat their model)', file: STG, tests: T.rlife,
    from: '    inherited.push(...researchRows(ctx.work, item));', to: ''},
  {id: 'RS49', what: 'the planner\'s gaps start a research request although primary execution is not declared', file: STG, tests: T.rlife,
    from: "    if ((ctx.billing ?? geminiBilling()).policy?.gemini_api_primary?.enabled !== true) return {ran: false,", to: '    if (false) return {ran: false,'},
  {id: 'RS50', what: 'the planner is asked although the requested research did not conclude', file: STG, tests: T.rlife,
    from: '    if (researched.stop) return {...researched.stop, team};', to: ''},
  {id: 'RS51', what: 'the findings are not in the dossier the plan is written from', file: CTX, tests: T.rlife,
    from: "  if (research) add('derived',", to: "  if (false) add('derived',"},
  {id: 'RS52', what: 'a read tool the assignment was not given is served', file: TURN, tests: T.turn,
    from: '    if (policy?.read_only && Array.isArray(policy.research_tools) && !policy.research_tools.includes(name)) {', to: '    if (false) {'},
  {id: 'RS53', what: 'a read outside the assignment\'s scope is served', file: TURN, tests: T.turn,
    from: '          if (!policy.research_scope.some(s => inScope(s, at))) return dec(false, "RESEARCH_SCOPE",', to: '          if (false) return dec(false, "RESEARCH_SCOPE",'},
  {id: 'RS54', what: 'a scope is a prefix of characters (src/u contains src/u1)', file: TURN, tests: T.turn,
    from: 'at === s || at.startsWith(s + "/"); };', to: 'at === s || at.startsWith(s); };'},
  {id: 'RS55', what: 'a research assignment that is not one is accepted', file: TURN, tests: T.turn,
    from: 'if (bad) throw fail("BAD_INPUT", `runAntigravitySdkTurn: ${bad}`); }', to: 'if (false) throw fail("BAD_INPUT", `runAntigravitySdkTurn: ${bad}`); }'},
  {id: 'RS56', what: 'the preflight passes a session with no usable key', file: TURN, tests: T.turn,
    from: '  if (bad) return { code: "NO_API_KEY", message: str(apiKey) ?', to: '  if (false) return { code: "NO_API_KEY", message: str(apiKey) ?'},
  {id: 'RS57', what: 'a session is not given its assignment\'s tools and scope', file: OR, tests: T.rrun,
    from: ", tools: [...node.tools], scope: [...node.scope]},", to: '},'},
  {id: 'RS58', what: 'a session\'s own directory is made in the item\'s state (inside the repository it reads)', file: OR, tests: T.rlife,
    from: '    const control_dir = fs.mkdtempSync(path.join(controlRoot, ', to: '    const control_dir = fs.mkdtempSync(path.join(dir, '},
  {id: 'RS59', what: 'a session\'s own directory is left behind when it ends', file: OR, tests: T.rlife,
    from: '    } finally { fs.rmSync(control_dir, {recursive: true, force: true}); }', to: '    } finally { }'},
  {id: 'RS60', what: 'executors that were not given research run it all the same', file: STG, tests: T.rlife,
    from: '  const RES = {enabled: false, limits: {}, sdk: undefined, preflight: undefined, ...research};', to: '  const RES = {enabled: true, limits: {}, sdk: undefined, preflight: undefined, ...research};'},
  {id: 'RS61', what: 'the planner\'s gaps record a request although no session can start', file: STG, tests: T.rlife,
    from: '    if (no) return {ran: false, why: `the research transport cannot start a session here', to: '    if (false) return {ran: false, why: `the research transport cannot start a session here'},
  {id: 'RS62', what: 'executors that run no research plan around an open request', file: STG, tests: T.rlife,
    from: '    if (!RES.enabled) {', to: '    if (false) {'},
  {id: 'RS63', what: 'a team is prepared although the transport says no session can start', file: STG, tests: T.rlife,
    from: '    if (no) { out.stop = transportStop(open[0], [no.code], no.message); return out; }', to: ''},
  {id: 'RS64', what: 'a session that could not start is recorded as a failed investigation', file: STG, tests: T.rlife,
    from: '      if (isResearchTransportStop(run.stop_reason)) {', to: '      if (false) {'},
  {id: 'RS65', what: 'the CLI builds executors that run no research', file: CLI, tests: T.cli,
    from: 'progress, research: {enabled: true},', to: 'progress,'},
  {id: 'RS66', what: 'the live run builds executors that run no research', file: LR, tests: T.rest,
    from: '    research: {enabled: true}});', to: '    });'},
  // ---- THE PROTECTIONS TAKEN OVER FROM THE L-150 RELAY (owner decision 2026-11-20, register L-724): the gateway's own tests
  {id: 'GP1', what: 'the real key may be forwarded to any upstream', file: GW, tests: T.gw,
    from: '  { const notHere = upstreamRefusal(upstream); if (notHere) throw', to: '  { const notHere = null; if (notHere) throw'},
  {id: 'GP2', what: 'the availability question is asked of an upstream the key may not go to', file: GW, tests: T.gw,
    from: '  if (notHere) return { ...out, kind: "bad_request",', to: '  if (false) return { ...out, kind: "bad_request",'},
  {id: 'GP3', what: 'the session\'s own maximum request count is not enforced', file: GW, tests: T.gw,
    from: '    if (maxRequests !== null && admitted >= maxRequests) {', to: '    if (false) {'},
  {id: 'GP4', what: 'the session cap counts requests the provider answered, not admissions', file: GW, tests: T.gw,
    from: '    if (maxRequests !== null && admitted >= maxRequests) {', to: '    if (maxRequests !== null && requests.filter(r => r.answered).length >= maxRequests) {'},
  {id: 'GP5', what: 'the bound on requests in flight is not enforced', file: GW, tests: T.gw,
    from: '    if (maxConcurrent !== null && active >= maxConcurrent) {', to: '    if (false) {'},
  {id: 'GP6', what: 'a request in flight is never released from the bound', file: GW, tests: T.gw,
    from: '    res.once("close", () => { active -= 1; });', to: ''},
  {id: 'GP7', what: 'an idle session never expires', file: GW, tests: T.gw,
    from: '    else if (idleMs !== null && now - last > idleMs) expired =', to: '    else if (false) expired ='},
  {id: 'GP8', what: 'a session past its lifetime still admits', file: GW, tests: T.gw,
    from: '    if (lifetimeMs !== null && now - opened > lifetimeMs) expired =', to: '    if (false) expired ='},
  {id: 'GP9', what: 'a call may carry any query to the provider', file: GW, tests: T.gw,
    from: 'if (!(q.length === 0 || (stream && q.length === 1 && q[0][0] === "alt" && q[0][1] === "sse"))) {', to: 'if (false) {'},
  {id: 'GP10', what: 'a body that is not a JSON object is charged and sent', file: GW, tests: T.gw,
    from: '    if (body === null || typeof body !== "object" || Array.isArray(body)) {', to: '    if (false) {'},
  {id: 'GP11', what: 'no outcome is written when a request ends', file: GW, tests: T.gw,
    from: '    const done = () => { rec.ms = Date.now() - t0; settle(rec); };', to: '    const done = () => { rec.ms = Date.now() - t0; };'},
  {id: 'GP12', what: 'the session\'s account is served to a caller without the token', file: GW, tests: T.gw,
    from: '    if (got.length !== want.length || !timingSafeEqual(got, want)) {', to: '    if ((got.length !== want.length || !timingSafeEqual(got, want)) && url.pathname !== GATEWAY_STATUS_PATH) {'},
  {id: 'GP13', what: 'a refused charge is answered with a status the SDK\'s harness retries', file: GW, tests: T.gw,
    from: '      refuse(res, rec, 403, GATEWAY_REFUSALS.BUDGET,', to: '      refuse(res, rec, 429, GATEWAY_REFUSALS.BUDGET,'},
  {id: 'GP14', what: 'the session\'s unit is not given back when its charge is refused (a refused request counts against the cap)', file: GW, tests: T.gw,
    from: '      admitted -= 1;\n', to: ''},
  // ---- A LANE-PINNED IMPLEMENTER UNDER FIT (owner decision 2026-11-20, register L-721)
  {id: 'LP1', what: 'a lane-pinned fit implementer is followed by the matrix\'s primary Gemini API seats (an exhausted lane switches transport)', file: FR, tests: [...T.route, ...T.board],
    from: "const lanePin=profile==='fit'&&role==='implementer'&&!roleOverride?lanePinFallback(pin,fitLevel(base.task,role).value):null;", to: 'const lanePin=null;'},
  {id: 'LP2', what: 'the pinned lane\'s metered API id is seated as a plain Gemini API seat (primary), not as that lane\'s quota failover', file: FM, tests: [...T.route, ...T.board],
    from: '[{ ...spare, quota_failover: { base: spare.model, lanes: [pin] } }]', to: '[{ ...spare }]'},
  {id: 'LP3', what: 'an operator\'s fallback seat after a lane pin is dropped for the lane ladder', file: FR, tests: T.route,
    from: "const lanePin=profile==='fit'&&role==='implementer'&&!roleOverride?", to: "const lanePin=profile==='fit'&&role==='implementer'?"},
  {id: 'LP4', what: 'a lane-pin ladder may name something that is not a live lane', file: FM, tests: T.route,
    from: '    for (const m of ladders[d]) if (!laneParts(m)) return', to: '    for (const m of ladders[d]) if (false) return'},
];

const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
function copyTree(dest) {
  const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard', '-z'], {encoding: 'utf8', maxBuffer: 1 << 28}).split('\0').filter(Boolean);
  for (const f of files) {
    const from = path.join(ROOT, f);
    if (!fs.existsSync(from) || fs.lstatSync(from).isDirectory()) continue;
    fs.mkdirSync(path.dirname(path.join(dest, f)), {recursive: true});
    if (fs.lstatSync(from).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), path.join(dest, f)); else fs.copyFileSync(from, path.join(dest, f));
  }
  for (const nm of ['node_modules', 'pantheon/node_modules', 'packages/model-client/node_modules', 'packages/ledger/node_modules']) {
    if (fs.existsSync(path.join(ROOT, nm))) fs.symlinkSync(path.join(ROOT, nm), path.join(dest, nm), 'dir');
  }
  // A repository of its own (some suites read the repository they run in); nothing here touches this tree's git.
  const g = (...a) => execFileSync('git', ['-C', dest, ...a], {stdio: 'ignore'});
  g('init', '-q', '-b', 'main'); g('-c', 'user.name=mutation', '-c', 'user.email=mutation@example.invalid', 'add', '-A');
  g('-c', 'user.name=mutation', '-c', 'user.email=mutation@example.invalid', 'commit', '-q', '-m', 'mutation copy');
}
/** The longest ONE run of the suites may take (--run-bound-ms). A run that does not end is not a result: it is HUNG. */
const RUN_BOUND_MS = 20 * 60_000;
/** After a run that was cut: kill what it left working in the copy (best effort; found through /proc, so on Linux). */
const reap = dir => {
  let n = 0;
  try {
    for (const p of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(p) || Number(p) === process.pid) continue;
      let cwd; try { cwd = fs.readlinkSync(`/proc/${p}/cwd`); } catch { continue; }
      if (cwd === dir || cwd.startsWith(dir + path.sep)) { try { process.kill(Number(p), 'SIGKILL'); n += 1; } catch { /* gone */ } }
    }
  } catch { /* no /proc here */ }
  return n;
};
const runSuites = (dir, tests, logFile, boundMs = RUN_BOUND_MS) => {
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=4', '--test-timeout=120000', ...tests], {cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, env: {...process.env}, timeout: boundMs, killSignal: 'SIGKILL'});
  // A test that fails and leaves a listener or a child behind keeps `node --test` from ending. That is a defect of the
  // TEST (the same hang would hold up CI on a real regression), and it is reported as one, not waited for forever.
  const hung = r.error?.code === 'ETIMEDOUT';
  const reaped = hung ? reap(dir) : 0;
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}${hung ? `\n[runner] the run did not end within ${boundMs} ms and was killed; ${reaped} process(es) left in the copy were killed too\n` : ''}`;
  fs.writeFileSync(logFile, out);
  const count = k => Number(new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
  return {status: r.status, hung, tests: count('tests'), pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'), skipped: count('skipped'),
    failed: [...new Set(out.split('\n').filter(l => /^✖ /.test(l) && !/failing tests/.test(l)).map(l => l.replace(/ \(\d+(\.\d+)?ms\)$/, '')))]};
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const only = arg('--only')?.split(',') ?? null;
  const logDir = path.resolve(arg('--log', path.join(os.tmpdir(), `sdk-intake-mutations-${Date.now()}`)));
  fs.mkdirSync(logDir, {recursive: true});
  const chosen = MUTATIONS.filter(m => !only || only.includes(m.id));
  // Every target must apply EXACTLY ONCE on this tree, before anything is run.
  const bad = chosen.map(m => ({m, n: fs.readFileSync(path.join(ROOT, m.file), 'utf8').split(m.from).length - 1})).filter(x => x.n !== 1);
  if (bad.length) {
    for (const {m, n} of bad) console.error(`${m.id}: the target occurs ${n} time(s) in ${m.file}; a mutation applies exactly once`);
    process.exit(2);
  }
  if (only && chosen.length !== only.length) { console.error(`unknown mutation id(s): ${only.filter(id => !MUTATIONS.some(m => m.id === id)).join(', ')}`); process.exit(2); }
  if (new Set(MUTATIONS.map(m => m.id)).size !== MUTATIONS.length) { console.error('two mutations share an id'); process.exit(2); }
  const bound = Number(arg('--run-bound-ms', RUN_BOUND_MS));
  if (!Number.isInteger(bound) || bound < 1) { console.error('--run-bound-ms is a positive whole number of milliseconds'); process.exit(2); }
  if (process.argv.includes('--check')) { console.log(`${chosen.length} mutation target(s), each occurring exactly once`); process.exit(0); }
  // NOT under /tmp: a session's jail mounts a fresh tmpfs there, so a tree copied under /tmp could not be read from inside it.
  const copyRoot = path.resolve(arg('--copy-root', os.homedir()));
  const copy = fs.mkdtempSync(path.join(copyRoot, 'sdk-intake-mutate-'));
  let exit = 0;
  const summary = [];
  try {
    copyTree(copy);
    const suites = [...new Set([...SUITES, ...chosen.flatMap(m => m.tests ?? [])])];
    const baseline = runSuites(copy, suites, path.join(logDir, 'baseline.log'), bound);
    console.log(`baseline: ${baseline.pass}/${baseline.tests} pass, ${baseline.fail} fail, ${baseline.cancelled} cancelled, ${baseline.skipped} skipped${baseline.hung ? `; DID NOT END within ${bound} ms` : ''}`);
    if (baseline.hung || baseline.status !== 0 || baseline.fail || baseline.cancelled) { console.error('the unmutated suites are not green: no mutation result would mean anything'); process.exit(3); }
    for (const m of chosen) {
      const file = path.join(copy, m.file), orig = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, orig.replace(m.from, () => m.to));
      if (fs.readFileSync(file, 'utf8') === orig) { console.error(`${m.id}: MUTATION DID NOT APPLY`); exit = 2; continue; }
      const r = runSuites(copy, m.tests ?? SUITES, path.join(logDir, `${m.id}.log`), bound);
      fs.writeFileSync(file, orig);
      // KILLED means a test FAILED on an assertion. A run that only timed a test out, or ended without a count, went red
      // too, and says so; a run that did not end is not a result at all.
      const red = !r.hung && r.status !== 0 && (r.fail > 0 || r.cancelled > 0 || !Number.isFinite(r.tests));
      const outcome = r.hung ? 'hung' : !red ? 'survived' : r.fail > 0 ? 'killed' : r.cancelled > 0 ? 'killed-by-timeout' : 'killed-no-count';
      summary.push({id: m.id, what: m.what, file: m.file, killed: red, outcome, tests: r.tests, pass: r.pass, fail: r.fail, cancelled: r.cancelled, failed: r.failed.slice(0, 12)});
      const label = {killed: 'KILLED  ', survived: 'SURVIVED', hung: 'HUNG    ', 'killed-by-timeout': 'KILLED (a test timed out; none failed)', 'killed-no-count': 'KILLED (the run ended without a count)'}[outcome];
      console.log(`${m.id} ${label} ${r.pass}/${r.tests} pass, ${r.fail} fail  (${m.what})`);
      for (const f of r.failed.slice(0, 3)) console.log(`    ${f.slice(0, 200)}`);
      if (r.hung) { console.log(`    the suites did not end within ${bound} ms: a test that fails here leaves something running (a listener, a child); fix the test`); exit = Math.max(exit, 4); }
      else if (!red) exit = Math.max(exit, 1);
    }
  } finally {
    fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify({root: ROOT, mutations: summary}, null, 2) + '\n');
    fs.rmSync(copy, {recursive: true, force: true});
  }
  const n = k => summary.filter(x => x.outcome === k).length;
  console.log(`${summary.filter(x => x.killed).length}/${summary.length} killed${n('killed-by-timeout') + n('killed-no-count') ? ` (${n('killed-by-timeout')} by a timeout only, ${n('killed-no-count')} without a count)` : ''}${n('hung') ? `, ${n('hung')} HUNG` : ''}; logs in ${logDir}`);
  process.exit(exit);
}
