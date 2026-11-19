// THE PIPELINE'S TURN ADAPTER: the `turns` object runPipeline() is given, built from INJECTED transports.
//
//   pipelineTurns({ makeClientFor, turn, agy }) -> { dispatcher, implementer, subagent, reviewer }
//
//   dispatcher, reviewer   single-turn OpenAI seats, through the injected single-turn `turn({vendor, model, prompt,
//                          seat, extra})` (live: sdk/live.mjs liveTurn). `extra` ({reasoning: {context}}) is passed
//                          through as given; this module sets no provider option itself.
//   subagent               a single-turn Grok seat through the same `turn`.
//   implementer            a MULTI-TURN, TOOL-ENABLED worker. Which transport runs it is the SEAT's:
//                          - an ANTIGRAVITY SDK seat ({transport: "antigravity-sdk"}; owner direction 2026-11-19, the
//                            Google implementation transport): one session of the official google-antigravity SDK on
//                            the Gemini API (antigravity/turn.mjs runAntigravitySdkTurn). See THE SDK SEAT below. The
//                            agy CLI is not started, no subscription login is read and no A2A relay is offered.
//                          - an Antigravity LANE (config/lanes.json), the earlier transport, kept until the SDK path's
//                            live evidence is in (docs/OPEN-LIMITATIONS.md): through the `agy` CLI
//                          (board/agy-cli.mjs runAgyWorkerTurn, an async spawn) as the pantheon-unit-worker role card.
//                          The controller's per-unit control dir becomes the CLI's project root (agy/workspace.mjs
//                          writes the card, hooks.json, mcp_config.json and jail.json there); the unit's worktree is
//                          added with --add-dir; the CLI runs inside the bwrap jail (agy/sandbox.mjs) and every write
//                          and command first passes the PRE-MUTATION jail hook (agy/jail-hook.mjs). The worker reaches
//                          its subagents through the stdio MCP relay (tool ask_subagent) over the unit's A2A socket.
//                          No bwrap -> the turn is refused (SANDBOX_UNAVAILABLE) unless agy.allowUnsandboxed is true.
//
// THE SDK SEAT. The session runs in the unit's worktree behind the controller's own tool decisions, model gateway and
// subagent governor (antigravity/turn.mjs). This adapter adds what the PIPELINE needs around it:
//   - THE CHARGE, PER REQUEST AND BY CLASS. The gateway admits every billed request before it is forwarded; each is
//     passed to the pipeline's admitRequest: the session's first request as the implementer's own call (kind
//     "session"), its later ones as continuations, and every request of a native Hydrogen subagent as kind "subagent"
//     (run.provider_calls.by_role.native_subagent). A refused charge is a request that is not made.
//   - THE EVIDENCE. What the session recorded is returned as `session` (and thrown as `e.session` when it failed):
//     {stop_reason, conversation_id, duration_s, timeout_s, usage, subagents, gateway, availability, runtime, jail,
//     tool_decisions}. The tool decisions are SUMMARISED ({total, allowed, denied, dropped, by_code, by_who}); the rows
//     go to <control_dir>/sessions/<n>.tools.json, and the summary carries that file's path and sha256.
//   - THE SERVED MODEL is the provider's own statement as the gateway saw it (served_model_source "provider"). The
//     transport's model guard refuses a session in which any answered request was not named as the model it asked for
//     (AGY_MODEL_MISMATCH, with both identities): the model asked is never recorded in a missing name's place.
//   - NO METERED GEMINI SPEND WITH THE SWITCH OFF (L-504 invariant 4). The seat refuses itself before the transport is
//     entered (METERED_GEMINI_DISABLED) when agy.meteredFailover is false, unless antigravity.geminiApi authorizes this
//     transport's own Gemini API billing by name; antigravity.geminiApi false refuses it whatever the switch says.
// The session's failures are thrown as they are (antigravity/turn.mjs FAILURES): the pipeline steps its ladder on
// quota_exhausted, model_unavailable and lane_failure, and blocks the unit on a fault no rung can cure and on the
// model guard's refusal.
//
// THE IMPLEMENTER'S SERVED MODEL ON A LANE. Antigravity names no serving model. The lane model is a required input, and
// runAgyCliTurn fails when the model the CLI reports at start is not the one asked for; the answer therefore carries
// that input, marked `served_model_source: "input"` (owner decision 2026-11-17): the pinned model, not a statement
// by the provider about this answer.
//
// LANE FIRST; THE METERED API ONLY AFTER A PROVEN QUOTA REFUSAL. A lane attempt that fails with quota evidence
// (agy/quota.mjs isQuotaFailure) is followed by ONE quota probe (`agy -p /quota`, probeQuota). The metered Gemini API
// id of the lane's base model (route/fit-matrix.mjs quotaFailoverFor) is asked ONLY when the failure itself said 429 /
// RESOURCE_EXHAUSTED, or the probe reads `exhausted`. A soft quota phrase with a probe that reads `available` or
// `unknown` is NOT a quota refusal: it is thrown as `lane_failure` (kind `exit`) so the pipeline steps its ladder, and
// the metered API is not called. If the metered API also cannot answer, the turn throws `quota_exhausted`. A failover
// is recorded on the returned object: quota_failover {used, base, lanes, rule, after, probe}. This adapter never
// retries a lane itself (the pipeline retries once and steps the ladder).
// `agy.meteredFailover: false` (a run whose budget does not allow metered Gemini spend; ophanim/operate/live-run.mjs
// passes it from its manifest) DISABLES that failover: a proven quota refusal is thrown as `quota_exhausted` with
// quota_failover {used: false, disabled: true, ...} and the metered API is never called. The pipeline then treats it
// as any quota refusal of a lane (index.mjs: the next subscription rung, and the unit BLOCKED when the ladder is spent).
//
// THE API FALLBACK CANNOT WRITE FILES, so its contract is the minimal honest one: the API is shown the unit prompt
// and the current contents of the unit's owned files, and its WHOLE reply must be one strict JSON object
//   {"files": [{"path": "<repo-relative path>", "content": "<the complete new file>"}]}
// which THIS ADAPTER writes into the worktree. A path that is absolute, contains "..", is a pattern, is outside the
// unit's owned paths, or would be written through a symlink is refused and nothing is written. Before any file is
// written, every file passes the SAME pre-mutation owned-path check the jail hook applies to the worker (decideWrite). Anything else than
// that object is a failed attempt (the turn throws; the controller discards the worktree's changes). What was
// written is then judged by the controller's write jail like any other attempt: this adapter is not the jail.
//
// Inputs: the injected `turn` and `makeClientFor(vendor)` (the lifecycle's own), and `agy` options {cli?, timeoutS?,
// sandbox?, agy_state_dirs?, allowUnsandboxed?, bwrap?, run?, api?, probe?, meteredFailover? (default true)} — `run` replaces runAgyWorkerTurn, `api`
// the metered-API call and `probe` the quota probe, for tests; and `antigravity` options {run?, geminiApi?, python?,
// bridge?, upstream?, apiKey?, sandbox? {enabled, allowUnsandboxed, bwrap, home}, timeoutS?, graceS?, budget?,
// fetchImpl?, checkAvailability?, allowSdkVersion?} — `run` replaces runAntigravitySdkTurn, for tests; `geminiApi`
// (true | false) is the by-name authorization above; the rest are the transport's options.
// Outputs: for every role, {text, served_model, served_model_source} (+ transport, quota_failover on the implementer).
//
// Must never: block the event loop on a child process (async spawn only); send a Google API key to the CLI; run the
// worker unjailed unless told to; reach the metered API after a lane failure that is not a proven quota refusal; write a path the API named outside the unit;
// invent a served model for a judging seat (a missing one is passed on as missing and refused by the controller).
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { runAgyWorkerTurn, workerEnv } from "../board/agy-cli.mjs";
import { prepareWorkerWorkspace } from "../agy/workspace.mjs";
import { probeQuota } from "../agy/quota.mjs";
import { decideWrite } from "../agy/jail-hook.mjs";
import { quotaFailoverFor, laneParts } from "../route/fit-matrix.mjs";
import { QUOTA_FAILOVER_RULE } from "../route/frontier.mjs";
import { isMeteredGemini, meteredGeminiRefusal } from "../route/quota-failover.mjs";
import { isSdkSeat, SDK_TRANSPORT } from "../antigravity/config.mjs";
import { runAntigravitySdkTurn } from "../antigravity/turn.mjs";
import { keysRefusal, sha256, str, strictJson } from "./util.mjs";
import { matchesOwned, pathRefusal } from "./paths.mjs";
import { git } from "./git.mjs";

export const API_FILES_KEYS = Object.freeze(["files"]);
const MAX_SHOWN_BYTES = 200000;   // owned files shown to the API fallback, in total

const fail = (code, message) => Object.assign(new Error(message), { code });
const inside = (root, p) => p === root || p.startsWith(root + sep);

/** What the API fallback is told on top of the unit prompt: it cannot act, so it answers with the files themselves. */
export function API_FALLBACK_PROMPT({ prompt, shown, truncated }) {
  return [prompt, "",
    "TRANSPORT NOTE (this overrides any instruction above to use tools, run commands or edit files): you have NO tools and NO file access in this turn. You cannot run the command above.",
    "The current contents of the files you own are below. Answer with the COMPLETE new contents of every file you create or change.",
    "",
    shown.length ? shown.map(f => `<<<FILE ${f.path}\n${f.content}\nFILE`).join("\n") : "(none of the paths you own exists yet)",
    truncated ? "(more owned files exist than are shown; the listing was cut at its bound)" : "",
    "",
    "OUTPUT: exactly one JSON object and nothing else (no prose, no code fence):",
    '{"files":[{"path":"repo-relative/path","content":"the complete new file contents"}]}',
    "Every path must be one of the paths you own. Any other key, or text outside the object, is refused and nothing is written.",
  ].filter(l => l !== "").join("\n");
}

/** Why an API fallback answer is not {files: [{path, content}]} for `owned`, or null. */
export function apiFilesRefusal(value, owned = null) {
  const keys = keysRefusal(value, [...API_FILES_KEYS]);
  if (keys) return `the answer is ${keys}; it is {"files": [{path, content}]}`;
  if (!Array.isArray(value.files) || !value.files.length) return "files is a non-empty array";
  const seen = new Set();
  for (const f of value.files) {
    const k = keysRefusal(f, ["path", "content"]);
    if (k) return `a files entry has ${k}`;
    if (!str(f.path) || typeof f.content !== "string") return "a files entry is {path: non-empty string, content: string}";
    const why = pathRefusal(f.path);
    if (why) return why;
    if (/[*?]/.test(f.path)) return `"${f.path}" is a pattern, not a file path`;
    if (seen.has(f.path)) return `"${f.path}" is named twice`;
    seen.add(f.path);
    if (owned && !matchesOwned(f.path, owned)) return `"${f.path}" is not one of the unit's owned paths`;
  }
  return null;
}

/**
 * Write the API's files into `cwd`. Refuses (writing nothing) a path that would land outside `cwd` or through a
 * symlink, and — given `owned` — any file the pre-mutation jail check (agy/jail-hook.mjs decideWrite) denies.
 */
export async function writeApiFiles({ cwd, files, owned = null }) {
  const root = await realpath(cwd);
  const plan = [];
  for (const f of files) {
    const abs = join(root, f.path);
    if (owned) {
      const d = decideWrite({ worktree: root, owned_paths: owned, unit_id: null }, { TargetFile: abs });
      if (d.decision !== "auto_approve") throw fail("API_FILES_REFUSED", `"${f.path}" is refused by the pre-mutation jail (${d.reason}); nothing was written`);
    }
    // The deepest ancestor that exists must resolve inside the worktree: a write through a symlinked directory
    // would land where git — and so the write jail — cannot see it.
    let at = dirname(abs);
    while (!existsSync(at) && at !== dirname(at)) at = dirname(at);
    const real = await realpath(at);
    if (!inside(root, real)) throw fail("API_FILES_REFUSED", `"${f.path}" resolves through ${at} to ${real}, outside the worktree; nothing was written`);
    const st = await lstat(abs).catch(() => null);
    if (st?.isSymbolicLink()) throw fail("API_FILES_REFUSED", `"${f.path}" is a symlink; the adapter does not write through it; nothing was written`);
    if (st?.isDirectory()) throw fail("API_FILES_REFUSED", `"${f.path}" is a directory; nothing was written`);
    plan.push({ abs, content: f.content });
  }
  for (const p of plan) { await mkdir(dirname(p.abs), { recursive: true }); await writeFile(p.abs, p.content); }
  return files.map(f => f.path);
}

/** The tracked files of `cwd` matched by `owned`, with their contents, up to a byte bound: {shown, truncated}. */
async function ownedFiles(cwd, owned) {
  const listed = (await git(cwd, ["ls-files", "-z"])).split("\0").filter(Boolean).filter(p => matchesOwned(p, owned)).sort();
  const shown = [];
  let bytes = 0, truncated = false;
  for (const p of listed) {
    const st = await lstat(join(cwd, p)).catch(() => null);
    if (!st?.isFile()) continue;
    if (bytes + st.size > MAX_SHOWN_BYTES) { truncated = true; continue; }
    shown.push({ path: p, content: await readFile(join(cwd, p), "utf8") });
    bytes += st.size;
  }
  return { shown, truncated };
}

const laneFailure = (kind, message, more = {}) => Object.assign(new Error(message), { code: "lane_failure", kind, transport: "agy-cli", ...more });

/**
 * The turns of a pipeline run.
 *   turn           async ({vendor, model, prompt, seat, extra?, signal?}) -> {text, served_model, ...}: every single-turn seat
 *   makeClientFor  (vendor) -> an SDK client: the metered Gemini API, used only as a lane's quota failover
 *   agy            {cli = $PANTHEON_AGY_CLI or ~/.local/bin/agy, timeoutS = 1800, sandbox = true (or {enabled, ...}),
 *                   agy_state_dirs (default agy/sandbox.mjs defaultAgyStateDirs), allowUnsandboxed = false, bwrap,
 *                   run = runAgyWorkerTurn, api = null, probe = probeQuota, probeTimeoutS = 30}
 */
/**
 * The worker's --print-timeout in seconds: `timeoutS` (the caller's), capped by `deadline` (epoch ms) minus `graceS` (the
 * kill grace runAgyWorkerTurn adds after it) when one is given; null when that leaves less than 1 s.
 */
export function printTimeoutOf({ timeoutS, graceS = 15, deadline = null, now = Date.now() }) {
  const asked = Math.max(1, Math.floor(timeoutS));
  if (!Number.isFinite(deadline)) return asked;
  const left = Math.floor((deadline - now) / 1000) - graceS;
  return left < 1 ? null : Math.min(asked, left);
}

/** What a session's tool decisions amount to: {total, allowed, denied, dropped, by_code, by_who}. The rows are not in it. */
export function toolDecisionSummary(tool_log = [], dropped = 0) {
  const rows = Array.isArray(tool_log) ? tool_log : [], by_code = {}, by_who = {};
  for (const r of rows) {
    const who = (by_who[r.who ?? "unknown"] ??= { allowed: 0, denied: 0 });
    if (r.allow === true) who.allowed += 1; else { who.denied += 1; by_code[r.code ?? "DENIED"] = (by_code[r.code ?? "DENIED"] ?? 0) + 1; }
  }
  const sort = o => Object.fromEntries(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : 1)));
  return { total: rows.length, allowed: rows.filter(r => r.allow === true).length, denied: rows.filter(r => r.allow !== true).length, dropped: Number.isInteger(dropped) ? dropped : 0, by_code: sort(by_code), by_who: sort(by_who) };
}

/**
 * The evidence of one SDK session for the pipeline's record, from what runAntigravitySdkTurn returned or threw (`x`).
 * The tool log is written to <control_dir>/sessions/<n>.tools.json; a write that fails is recorded (log_error), and
 * the summary is still returned.
 */
async function sessionEvidence(x, { control_dir, seat, unit_id, attempt, timeout_s }) {
  const rows = Array.isArray(x?.tool_log) ? x.tool_log : [];
  const tool_decisions = toolDecisionSummary(rows, x?.tool_log_dropped ?? 0);
  if (str(control_dir)) {
    try {
      const dir = join(control_dir, "sessions");
      await mkdir(dir, { recursive: true });
      const n = (await readdir(dir)).filter(f => /^\d+\.tools\.json$/.test(f)).length + 1;
      const file = join(dir, `${String(n).padStart(3, "0")}.tools.json`);
      const bytes = JSON.stringify({ schema: "pantheon.antigravity-sdk-tool-log/v1", unit_id: unit_id ?? null, attempt: attempt ?? null, vendor: seat.vendor, model: seat.model, effort: seat.effort ?? null, tool_log: rows }, null, 2) + "\n";
      await writeFile(file, bytes);
      Object.assign(tool_decisions, { log_file: file, log_digest: sha256(bytes) });
    } catch (e) { Object.assign(tool_decisions, { log_file: null, log_error: String(e?.message ?? e).slice(0, 300) }); }
  }
  const jail = x?.sandbox ? { enabled: x.sandbox.enabled === true, ...(x.sandbox.why ? { why: x.sandbox.why } : {}), ...(x.sandbox.home_dirs_hidden ? { home_dirs_hidden: x.sandbox.home_dirs_hidden.length } : {}) } : null;
  return { stop_reason: x?.stop_reason ?? null, conversation_id: x?.conversation_id ?? null, duration_s: x?.duration_s ?? null, timeout_s, usage: x?.usage ?? null, subagents: x?.subagents ?? null,
    gateway: x?.gateway ?? null, availability: x?.availability ?? [], runtime: x?.runtime ?? null, jail, tool_decisions,
  };
}

export function pipelineTurns({ makeClientFor = null, turn, agy = {}, antigravity = {} } = {}) {
  if (typeof turn !== "function") throw new Error("pipelineTurns: pass turn({vendor, model, prompt, seat, extra}) for the single-turn seats");
  if (antigravity.geminiApi !== undefined && typeof antigravity.geminiApi !== "boolean") throw new Error("pipelineTurns: antigravity.geminiApi is true or false (the by-name authorization of the SDK implementer's Gemini API billing)");
  const lane = agy.run ?? runAgyWorkerTurn;
  const probe = agy.probe ?? probeQuota;
  const timeoutS = agy.timeoutS ?? 1800;
  const graceS = agy.graceS ?? 15;
  const box = agy.sandbox === false ? {} : (agy.sandbox && typeof agy.sandbox === "object" ? agy.sandbox : {});
  const sandbox = { enabled: agy.sandbox === false ? false : box.enabled !== false, allowUnsandboxed: agy.allowUnsandboxed ?? box.allowUnsandboxed ?? false,
    ...(agy.agy_state_dirs ?? box.agy_state_dirs ? { agy_state_dirs: agy.agy_state_dirs ?? box.agy_state_dirs } : {}), ...(agy.bwrap ?? box.bwrap ? { bwrap: agy.bwrap ?? box.bwrap } : {}),
    ...(box.extra_ro ? { extra_ro: box.extra_ro } : {}) };

  // `charge` (the pipeline's admit for a second provider call inside the turn: a lane's metered failover) is passed on.
  // `admitRequest` (optional; the second charge contract of sdk/live.mjs: nothing charged before the turn, every provider
  // call admitted at its point of spend) is passed on as given (self-audit round 3, assignment 3 (sealed bb1287a), L-301).
  const single = seatRole => async ({ vendor, model, prompt, seat = null, extra = undefined, signal = undefined, charge = null, admitRequest = null }) => {
    // A seat of the SDK transport runs as a session on a work unit, never as one turn: handed on, it would be served
    // lane-first by the agy CLI or by the metered API (the single-turn Gemini rule). Refused before anything is sent.
    if (isSdkSeat(seat)) throw fail("SDK_SEAT_NOT_SINGLE_TURN", `${vendor}/${model} is a seat of the Antigravity SDK transport: it runs as a session on a work unit, and is not asked as a single ${seatRole} turn`);
    const r = await turn({ vendor, model, prompt, seat: { ...(seat ?? { vendor, model }), role: seatRole }, ...(extra && Object.keys(extra).length ? { extra } : {}), ...(signal ? { signal } : {}),
      ...(typeof admitRequest === "function" ? { admitRequest } : typeof charge === "function" ? { charge } : {}) });
    // The served model is passed on exactly as the transport named it; a judging seat with none is refused upstream.
    // Its SOURCE is the transport's own report, passed on as given: "provider" only when the transport said the provider
    // named it (sdk/live.mjs liveTurn does, from the response), "input" when the transport substituted the model it was
    // asked for. A served name that arrives with no source is not labelled a provider statement: it is "unknown" (the
    // caller may have substituted it) (independent review round 2, assignment 2 (xAI grok-4.7, 77480d6), question 9).
    const named = typeof r?.served_model === "string" && r.served_model.trim() !== "";
    return { text: r?.text ?? "", served_model: r?.served_model ?? null, served_model_source: r?.served_model_source ?? (named ? "unknown" : null), response_id: r?.response_id ?? null };
  };

  /** The metered Gemini API of a lane's base model: one unary answer, by default through makeClientFor + sendTurn. */
  // `admitRequest` (optional): every request of this call, the first included, is admitted before it is sent (sendTurn's
  // chargeFirstRequest); else `charge` admits the requests after the first, which the caller charged (L-301).
  const api = agy.api ?? (async ({ vendor, model, prompt, effort, signal, charge = null, admitRequest = null }) => {
    if (typeof makeClientFor !== "function") throw fail("NO_API_CLIENT", "the metered Gemini API was needed as a quota failover, and no makeClientFor was given");
    const { sendTurn } = await import("../sdk/adapter.mjs");
    const r = await sendTurn({ client: makeClientFor(vendor), vendor, model, prompt, label: "pipeline-implementer-quota-failover", onEvent: () => {},   // streamed: whole files can be long
      ...(effort ? { effort } : {}), ...(signal ? { signal } : {}),
      ...(typeof admitRequest === "function" ? { onRequest: ({ request }) => admitRequest({ kind: request === 1 ? "request" : "continuation" }), chargeFirstRequest: true }
        : typeof charge === "function" ? { onRequest: () => charge("continuation") } : {}) });   // every further billed request (finding 1.1)
    if (r.complete === false) throw new Error(`${vendor}/${model}: the reply did not complete (${r.terminal_state ?? "unknown"})`);
    // sendTurn's served_model is the model the provider's response named.
    return { text: r.text ?? "", served_model: r.served_model ?? null, served_model_source: str(r.served_model) ? "provider" : null, response_id: r.response_id ?? null };
  });

  /**
   * THE SDK SEAT's implementer turn (see the header). Inputs as the lane's, plus `allowed_subagents` (the unit's
   * specialist type names); `a2a`, `env` and `mcp_server` are not used: this transport has no relay.
   */
  const sdk = antigravity.run ?? runAntigravitySdkTurn;
  const sdkImplementer = async ({ vendor, model, seat = null, prompt, cwd, control_dir = null, owned_paths = null, verify_cmd = null, unit_id = null, allowed_subagents = [], sandbox: cap = null,
    attempt = 1, signal = undefined, charge = null, admitRequest = null, verify_hide = [], deadline = null, timeoutS: askedS = null }) => {
    if (!str(cwd)) throw fail("NO_WORKTREE", "the implementer turn needs the unit's worktree (cwd)");
    // NO METERED GEMINI SPEND WITH THE SWITCH OFF (L-504 invariant 4; route/quota-failover.mjs). An SDK session is a
    // metered Google call from its first request. The seat refuses itself HERE, before the transport is entered (no
    // gateway, no bridge, no admission, no charge), when the caller disabled metered Gemini spend (agy.meteredFailover
    // false) without authorizing this transport's own billing by name (antigravity.geminiApi true), or refused it by
    // name (false). Whatever key the environment holds.
    const billed = { vendor: seat?.vendor ?? vendor, model: seat?.model ?? model };
    if (!(antigravity.geminiApi ?? (agy.meteredFailover !== false)) && isMeteredGemini({ vendor: billed.vendor, transport: SDK_TRANSPORT })) {
      throw meteredGeminiRefusal({ ...billed, purpose: "implementer", transport: SDK_TRANSPORT });
    }
    const owned = Array.isArray(owned_paths) ? owned_paths : Array.isArray(cap?.owned_paths) ? cap.owned_paths : [];
    const grace = antigravity.graceS ?? graceS;
    const turnS = printTimeoutOf({ timeoutS: Number.isFinite(askedS) && askedS > 0 ? askedS : antigravity.timeoutS ?? timeoutS, graceS: grace, deadline });
    if (turnS === null) throw fail("DEADLINE", `the stage's deadline leaves no time for an implementer session (${grace} s of kill grace needed beyond a 1 s turn)`);
    const s = { vendor: seat?.vendor ?? vendor, model: seat?.model ?? model, effort: seat?.effort ?? null };
    // EVERY BILLED REQUEST, admitted by the pipeline before the gateway forwards it. The session's first request is the
    // implementer's own call; an older caller's `charge` contract charged that one up front and admits the others.
    let own = 0;
    const admit = ({ class: cls } = {}) => {
      const kind = cls === "subagent" ? "subagent" : own++ === 0 ? "session" : "continuation";
      if (typeof admitRequest === "function") return admitRequest({ kind });
      if (typeof charge === "function" && kind !== "session") return charge("continuation");
    };
    let made = null;
    const ctl = control_dir ?? (made = await mkdtemp(join(tmpdir(), "pantheon-sdk-control-")));
    const about = { control_dir: made ? null : ctl, seat: s, unit_id, attempt, timeout_s: turnS };
    try {
      const r = await sdk({ seat: s, prompt, worktree: cwd, control_dir: ctl, unit: { unit_id, owned_paths: [...owned], verify_cmd, allowed_subagents: [...(allowed_subagents ?? [])] }, admit, signal: signal ?? null,
        timeoutS: turnS, graceS: grace, verify_hide: Array.isArray(verify_hide) ? verify_hide : [],
        ...Object.fromEntries(["python", "bridge", "upstream", "apiKey", "sandbox", "budget", "fetchImpl", "checkAvailability", "allowSdkVersion", "base_env"].filter(k => antigravity[k] !== undefined).map(k => [k, antigravity[k]])) });
      return { text: r?.text ?? "", served_model: str(r?.served_model) ? r.served_model : null, served_model_source: r?.served_model_source ?? (str(r?.served_model) ? "unknown" : null),
        transport: SDK_TRANSPORT, requested_model: s.model, effort: s.effort, response_id: r?.conversation_id ?? null, tool_calls: r?.tool_calls ?? null, session: await sessionEvidence(r, about) };
    } catch (e) {
      // What the session recorded up to its failure goes with the error (antigravity/turn.mjs carries it).
      if (e && typeof e === "object" && e.transport === SDK_TRANSPORT) e.session = await sessionEvidence(e, about).catch(() => null);
      throw e;
    } finally {
      if (made) await rm(made, { recursive: true, force: true }).catch(() => {});
    }
  };

  /**
   * The implementer turn. Inputs (from the pipeline): {vendor, model, seat, prompt, cwd (the worktree), control_dir,
   * a2a {socket, token, roles}, env {PANTHEON_A2A_SOCKET, PANTHEON_A2A_TOKEN, PANTHEON_A2A_ROLES, PANTHEON_UNIT_ID},
   * owned_paths, verify_cmd, unit_id, mcp_server, attempt, signal}. An older caller's {sandbox: {owned_paths}} and
   * {a2a: {url, token}} are still read; without a control_dir a temporary one (outside the worktree) is used and removed.
   */
  const implementer = async args => (isSdkSeat(args?.seat) ? sdkImplementer(args) : laneImplementer(args));
  const laneImplementer = async ({ vendor, model, prompt, cwd, control_dir = null, a2a = null, env = {}, owned_paths = null, verify_cmd = null, unit_id = null,
    mcp_server = null, sandbox: cap = null, attempt = 1, signal = undefined, charge = null, verify_hide = [], deadline = null, timeoutS: askedS = null,
    // `admitRequest` (optional; L-301): the pipeline charged nothing before this turn. The lane's worker session is admitted
    // inside runAgyWorkerTurn between its jail build and its spawn (kind "lane"); a quota failover is admitted before the
    // metered API is asked (kind "failover"), and that API's further requests as continuations.
    admitRequest = null }) => {
    if (!str(cwd)) throw fail("NO_WORKTREE", "the implementer turn needs the unit's worktree (cwd)");
    if (!laneParts(model)) throw fail("NOT_A_LANE", `the pipeline implementer runs on an Antigravity lane, and ${vendor}/${model} is not one (config/lanes.json)`);
    const cli = agy.cli ?? process.env.PANTHEON_AGY_CLI ?? join(homedir(), ".local", "bin", "agy");
    if (!agy.run && cli.includes("/") && !existsSync(cli)) throw laneFailure("spawn", `agy seat: CLI absent at ${cli} (set PANTHEON_AGY_CLI)`);
    const owned = Array.isArray(owned_paths) ? owned_paths : Array.isArray(cap?.owned_paths) ? cap.owned_paths : null;
    const roles = Array.isArray(a2a?.roles) ? a2a.roles : str(env?.PANTHEON_A2A_ROLES) ? env.PANTHEON_A2A_ROLES.split(",").map(x => x.trim()).filter(Boolean) : [];
    const a2a_env = Object.fromEntries(Object.entries({
      PANTHEON_A2A_SOCKET: env?.PANTHEON_A2A_SOCKET ?? a2a?.socket, PANTHEON_A2A_TOKEN: env?.PANTHEON_A2A_TOKEN ?? a2a?.token,
      PANTHEON_A2A_ROLES: env?.PANTHEON_A2A_ROLES ?? (roles.length ? roles.join(",") : undefined), PANTHEON_UNIT_ID: env?.PANTHEON_UNIT_ID ?? unit_id ?? undefined,
    }).filter(([, v]) => v !== undefined && v !== null));
    // The CLI's env carries the A2A endpoint's non-secret part only: the token goes to the relay's token file
    // (prepareWorkerWorkspace), never into agy's environment (CREDENTIAL ISOLATION, src/agy/verify-jail.mjs).
    const { PANTHEON_A2A_TOKEN: _token, ...childEnv } = { ...env, ...a2a_env, ...(a2a?.url ? { PANTHEON_A2A_URL: a2a.url } : {}) };

    // THE PRINT TIMEOUT IS DERIVED (independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6),
    // finding 9): the caller's timeout (this call's `timeoutS`, else agy.timeoutS, else 1800 s), capped by what is left of
    // the stage's `deadline` (epoch ms) minus the kill grace, so the CLI's own print timeout fires before the stage's end
    // and the process is killed by it at the latest. No time left: the turn is not started.
    const printS = printTimeoutOf({ timeoutS: Number.isFinite(askedS) && askedS > 0 ? askedS : timeoutS, graceS, deadline });
    if (printS === null) throw fail("DEADLINE", `the stage's deadline leaves no time for an implementer turn (${graceS} s of kill grace needed beyond a 1 s turn)`);
    let made = null;
    try {
      const ctl = control_dir ?? (made = await mkdtemp(join(tmpdir(), "pantheon-agy-control-")));
      await prepareWorkerWorkspace({ control_dir: ctl, worktree: cwd, unit_id: unit_id ?? a2a_env.PANTHEON_UNIT_ID ?? null, owned_paths: owned ?? [], verify_cmd, roles, mcp_server, a2a_env,
        verify_hide: Array.isArray(verify_hide) ? verify_hide : [] });
      // base_env: the ALLOWLISTED controller env, never process.env whole (independent review round 2, assignment 4,
      // question 7); childEnv (the unit's non-secret A2A env) is an explicit extra; no key or token ever passes.
      const r = await lane({ cli, control_dir: ctl, worktree: cwd, model, prompt, timeoutS: printS, graceS, env: childEnv, base_env: workerEnv(), sandbox, a2a_socket: a2a_env.PANTHEON_A2A_SOCKET ?? null, ...(signal ? { signal } : {}),
        ...(typeof admitRequest === "function" ? { charge: () => admitRequest({ kind: "lane" }) } : {}) });
      return { text: r.text ?? "", served_model: model, served_model_source: "input", transport: "agy-cli", requested_model: model,
        response_id: r.response_id ?? null, tool_calls: r.tool_calls ?? null, subagent_calls: r.subagent_calls ?? null, summary: r.summary ?? null,
        jail_log: r.jail_log ?? [], cleanup_env: r.cleanup_env ?? null, sandbox: r.sandbox ?? null, print_timeout_s: printS };
    } catch (e) {
      if (e?.code !== "quota_exhausted") throw e;   // lane_failure, SANDBOX_UNAVAILABLE, ABORTED, ...: as they are
      // QUOTA EVIDENCE. Probe once; then decide (see the header).
      const explicit = e.quota?.explicit === true || e.status === 429 && e.quota === undefined;
      const seen = await probe({ cli, model, env: agy.probeEnv ?? {}, timeoutS: agy.probeTimeoutS ?? 30, ...(signal ? { signal } : {}) })
        .catch(err => ({ state: "unknown", buckets: [], raw_digest: null, exit_code: null, error: String(err?.message ?? err) }));
      const after = [{ lane: model, outcome: "quota", source: "attempt", status: e?.status ?? null, code: e?.code ?? null, explicit, matched: e.quota?.matched ?? null, why: String(e?.message ?? e).slice(0, 200) }];
      if (!explicit && seen.state !== "exhausted") {
        throw laneFailure("exit", `${String(e?.message ?? e)}; a soft quota phrase ("${e.quota?.matched ?? "?"}") and the quota probe reads "${seen.state}": not a proven quota refusal, so the metered API is not used`,
          { quota_probe: seen, quota_failover: { used: false, lanes: [model], after, probe: seen }, jail_log: e.jail_log ?? [] });
      }
      if (agy.meteredFailover === false) {
        throw Object.assign(fail("quota_exhausted", `${model} was refused for quota, and the metered Gemini API failover is DISABLED for this run (meteredFailover: false): the API is not called`),
          { status: 429, quota_probe: seen, quota_failover: { used: false, disabled: true, lanes: [model], rule: "metered Gemini API failover disabled by the caller", after, probe: seen }, jail_log: e.jail_log ?? [] });
      }
      const spare = quotaFailoverFor(model);
      if (!spare) throw Object.assign(fail("quota_exhausted", `${model} was refused for quota and has no metered API failover`), { status: 429, quota_probe: seen });
      const quota_failover = { used: true, base: spare.model, lanes: [model], rule: QUOTA_FAILOVER_RULE, after, probe: seen };
      const { shown, truncated } = owned ? await ownedFiles(cwd, owned) : { shown: [], truncated: false };
      // The metered API call is a provider call of its own: the pipeline's `charge` admits it against max_provider_calls
      // (and the caller's ledger charge) BEFORE it is made; a refusal (PROVIDER_LIMIT) means it is not made.
      const admits = typeof admitRequest === "function";
      if (admits) admitRequest({ kind: "failover" });
      else if (typeof charge === "function") charge();
      const further = admits ? () => admitRequest({ kind: "continuation" }) : charge;
      let r;
      try { r = await api({ vendor: spare.vendor, model: spare.model, effort: spare.effort, prompt: API_FALLBACK_PROMPT({ prompt, shown, truncated }), signal, charge: further }); }
      catch (err) {
        if (err?.code === "PROVIDER_LIMIT") throw Object.assign(err, { quota_failover });   // a further request refused at the bound (finding 1.1)
        throw Object.assign(fail("quota_exhausted", `${model} was refused for quota and the metered API ${spare.model} could not answer either: ${String(err?.message ?? err).slice(0, 300)}`),
          { status: 429, quota_failover: { ...quota_failover, api_error: String(err?.message ?? err).slice(0, 300) }, cause: err });
      }
      const parsed = strictJson(r?.text);
      const why = parsed.ok ? apiFilesRefusal(parsed.value, owned) : parsed.why;
      if (why) throw Object.assign(fail("API_FILES_REFUSED", `the metered API answered the quota failover of ${model}, and its answer is refused: ${why}; nothing was written`), { quota_failover });
      let written;
      try { written = await writeApiFiles({ cwd, files: parsed.value.files, owned }); } catch (err) { throw Object.assign(err, { quota_failover }); }
      return { text: `the adapter wrote ${written.length} file(s) from the API answer: ${written.join(", ")}`, served_model: str(r?.served_model) ? r.served_model : null,
        served_model_source: r?.served_model_source ?? (str(r?.served_model) ? "unknown" : null), transport: "api", requested_model: model, response_id: r?.response_id ?? null, quota_failover, written };
    } finally {
      if (made) await rm(made, { recursive: true, force: true }).catch(() => {});
    }
  };

  return { dispatcher: single("dispatcher"), reviewer: single("reviewer"), subagent: single("subagent"), implementer };
}
