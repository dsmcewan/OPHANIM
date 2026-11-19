#!/usr/bin/env node
// MUTATION RUNNER for the prompt intake and the Antigravity SDK migration (owner direction 2026-11-19): the subagent
// governor, the model gateway, the session's tool decisions and jail, the pipeline's SDK seat, the fit routing, the
// lifecycle stage, the live-run launcher and the prompt intake. Built like reliability-wave2b.mutate.mjs: every mutation
// is made on a DISPOSABLE COPY of this tree (never on the tree itself), its suites run there, and it is undone.
//
//   node ophanim/operate/sdk-intake.mutate.mjs [--only G1,W3] [--log DIR] [--copy-root DIR] [--check]
//
// Each mutation names its file, the EXACT text it replaces, the replacement, and the suites that must catch it. The
// runner EXITS NON-ZERO when a target does not occur exactly once, when the unmutated suites are not green, or when any
// mutation SURVIVES (its suites still green). Every mutation is recorded in the log directory (one log per mutation,
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
};
const SUITES = [...new Set(Object.values(T).flat())];
const GOV = 'pantheon/src/antigravity/subagents.mjs', GW = 'pantheon/src/antigravity/gateway.mjs', TURN = 'pantheon/src/antigravity/turn.mjs', CFG = 'pantheon/src/config/antigravity-sdk.json';
const PT = 'pantheon/src/pipeline/turns.mjs', IMP = 'pantheon/src/pipeline/implement.mjs', IDX = 'pantheon/src/pipeline/index.mjs', REC = 'pantheon/src/pipeline/record.mjs';
const FM = 'pantheon/src/route/fit-matrix.mjs', FR = 'pantheon/src/route/frontier.mjs', RI = 'pantheon/src/board/run-item.mjs';
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
    from: '    try { await admit({ class: rec.class, type, model, session: rec.session, n: counts[rec.class] + 1, seq: rec.seq }); }', to: '    try { }'},
  {id: 'W4', what: 'a subagent may ask for the implementer\'s model (a clone)', file: GW, tests: T.gw,
    from: '    if (type && model !== sub.model) {', to: '    if (false) {'},
  {id: 'W5', what: 'any model is served', file: GW, tests: T.gw,
    from: '  const allowedModel = m => m === root.model || (sub.ceiling > 0 && str(sub.model) && m === sub.model);', to: '  const allowedModel = () => true;'},
  {id: 'W6', what: 'no ceiling on the wire (the second line behind the governor)', file: GW, tests: T.gw,
    from: '      if (liveSubs >= sub.ceiling) {', to: '      if (false) {'},
  {id: 'W7', what: 'a stopped session still reaches the provider', file: GW, tests: T.gw,
    from: '    if (aborted) { req.resume(); refuse(res, rec, 503, GATEWAY_REFUSALS.ABORTED,', to: '    if (false) { req.resume(); refuse(res, rec, 503, GATEWAY_REFUSALS.ABORTED,'},
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
    from: '      const kind = cls === "subagent" ? "subagent" : own++ === 0 ? "session" : "continuation";', to: '      const kind = own++ === 0 ? "session" : "continuation";'},
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
  {id: 'P17', what: 'the SDK implementer runs although primary Gemini API execution was not enabled', file: PT, tests: [...T.pipe, ...T.fit],
    from: '    if (antigravity.geminiApiPrimary !== true) throw primaryGeminiRefusal(', to: '    if (false) throw primaryGeminiRefusal('},
  {id: 'P18', what: 'the failover switch stands for the primary setting (one authorization for two kinds of spend)', file: PT, tests: T.pipe,
    from: '    if (antigravity.geminiApiPrimary !== true) throw primaryGeminiRefusal(', to: '    if (antigravity.geminiApiPrimary !== true && agy.meteredFailover !== true) throw primaryGeminiRefusal('},
  {id: 'P19', what: 'the seat\'s refusal is not a blocker: the unit spends revisions on it', file: IMP, tests: T.pipe,
    from: '"SDK_VERSION", "SDK_UNAVAILABLE", "GEMINI_API_PRIMARY_DISABLED"]);', to: '"SDK_VERSION", "SDK_UNAVAILABLE"]);'},
  {id: 'P20', what: 'the lifecycle enables primary Gemini API execution by default', file: STG, tests: T.fit,
    from: 'meteredFailover = true, geminiApiPrimary = false, antigravity = {}} = {}) {', to: 'meteredFailover = true, geminiApiPrimary = true, antigravity = {}} = {}) {'},
  {id: 'P21', what: 'the lifecycle does not carry the setting to the seat (enabled runs are refused)', file: STG, tests: T.fit,
    from: 'antigravity: {...antigravity, geminiApiPrimary}}), dir, sameModel,', to: 'antigravity}), dir, sameModel,'},
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
  {id: 'L7', what: 'the launcher does not carry the manifest\'s setting to the lifecycle: an enabled run cannot implement', file: LR, tests: T.live,
    from: "    geminiApiPrimary: m.billing.gemini_api_primary === true, progress: note});", to: '    progress: note});'},
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
  // ---- the gateway after a stop, and what it records
  {id: 'W10', what: 'a request admitted while the session was being stopped is still forwarded', file: GW, tests: T.gw,
    from: '    // request is still not sent.\n    if (stopped()) {', to: '    // request is still not sent.\n    if (false) {'},
  {id: 'W11', what: 'callers without the token grow the record without bound', file: GW, tests: T.gw,
    from: '      if (++unauthorized > MAX_UNAUTHORIZED_ROWS) requests.splice(', to: '      if (++unauthorized > Infinity) requests.splice('},
  {id: 'W12', what: 'a key that is not a clean header value is put in a header (the HTTP layer quotes it in its error)', file: GW, tests: T.gw,
    from: '  { const bad = keyRefusal(apiKey); if (bad) throw Object.assign(new Error(`the gateway was given', to: '  { const bad = null; if (bad) throw Object.assign(new Error(`the gateway was given'},
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
const runSuites = (dir, tests, logFile) => {
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=4', '--test-timeout=120000', ...tests], {cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, env: {...process.env}});
  const out = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(logFile, out);
  const count = k => Number(new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
  return {status: r.status, tests: count('tests'), pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'), skipped: count('skipped'),
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
  if (process.argv.includes('--check')) { console.log(`${chosen.length} mutation target(s), each occurring exactly once`); process.exit(0); }
  // NOT under /tmp: a session's jail mounts a fresh tmpfs there, so a tree copied under /tmp could not be read from inside it.
  const copyRoot = path.resolve(arg('--copy-root', os.homedir()));
  const copy = fs.mkdtempSync(path.join(copyRoot, 'sdk-intake-mutate-'));
  let exit = 0;
  const summary = [];
  try {
    copyTree(copy);
    const suites = [...new Set([...SUITES, ...chosen.flatMap(m => m.tests ?? [])])];
    const baseline = runSuites(copy, suites, path.join(logDir, 'baseline.log'));
    console.log(`baseline: ${baseline.pass}/${baseline.tests} pass, ${baseline.fail} fail, ${baseline.cancelled} cancelled, ${baseline.skipped} skipped`);
    if (baseline.status !== 0 || baseline.fail || baseline.cancelled) { console.error('the unmutated suites are not green: no mutation result would mean anything'); process.exit(3); }
    for (const m of chosen) {
      const file = path.join(copy, m.file), orig = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, orig.replace(m.from, () => m.to));
      if (fs.readFileSync(file, 'utf8') === orig) { console.error(`${m.id}: MUTATION DID NOT APPLY`); exit = 2; continue; }
      const r = runSuites(copy, m.tests ?? SUITES, path.join(logDir, `${m.id}.log`));
      fs.writeFileSync(file, orig);
      const killed = r.status !== 0 && (r.fail > 0 || r.cancelled > 0 || !Number.isFinite(r.tests));
      summary.push({id: m.id, what: m.what, file: m.file, killed, tests: r.tests, pass: r.pass, fail: r.fail, cancelled: r.cancelled, failed: r.failed.slice(0, 12)});
      console.log(`${m.id} ${killed ? 'KILLED  ' : 'SURVIVED'} ${r.pass}/${r.tests} pass, ${r.fail} fail  (${m.what})`);
      for (const f of r.failed.slice(0, 3)) console.log(`    ${f.slice(0, 200)}`);
      if (!killed) exit = 1;
    }
  } finally {
    fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify({root: ROOT, mutations: summary}, null, 2) + '\n');
    fs.rmSync(copy, {recursive: true, force: true});
  }
  console.log(`${summary.filter(x => x.killed).length}/${summary.length} killed; logs in ${logDir}`);
  process.exit(exit);
}
