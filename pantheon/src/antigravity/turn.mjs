// ONE IMPLEMENTER SESSION ON THE ANTIGRAVITY SDK TRANSPORT (owner direction 2026-11-19): the official google-antigravity
// Python SDK on the Gemini API with GEMINI_API_KEY. No agy CLI, no subscription OAuth, no CLI wrapper.
//
//   runAntigravitySdkTurn({seat, prompt, worktree, control_dir, unit, apiKey, admit, signal, ...}) -> the turn's result
//
// WHO DOES WHAT.
//   the bridge      scripts/antigravity-bridge.py, a thin Python process that runs the SDK's Agent. It decides nothing
//                   and holds no credential. It runs in the worker's bwrap jail profile (agy/sandbox.mjs bwrapArgs: the
//                   host read-only, the unit's worktree and the control dir's run/ writable, its own PID namespace,
//                   other units' control dirs hidden) with an allowlisted environment that carries no key and no proxy.
//   this module     the CONTROLLER's side. It decides every tool call the SDK is about to run (toolDecision), admits
//                   every subagent (subagents.mjs), owns the model gateway (gateway.mjs: the key, the per-request
//                   charge, the model allow-list, the ceiling on the wire) and stops the session.
//
// TOOL DECISIONS (fail closed: a tool this table does not name is denied, and the denial is on the record).
//   EVERY CALL, FIRST           it carries exactly the argument names its tool declares (config.mjs undeclaredArg). The
//                                runtime also reads other spellings of a declared name, so any other key refuses the
//                                whole call (ARGS_UNDECLARED): nothing is decided on a name the runtime may not act on.
//   finish                       allowed (the SDK's structured-output tool)
//   view_file, list_directory,   every path argument resolves inside the unit's WORKTREE and outside the control dir
//   search_directory, find_file  (agy/jail-hook.mjs decideRead: the same rule the CLI worker had)
//   create_file, edit_file       every path argument is one of the unit's OWNED PATHS (decideWrite: the same pre-mutation
//                                rule; no .git, no symlink out, no traversal). A read-only subagent type, and a child the
//                                controller cannot attribute to an admitted subagent, may not write at all.
//   run_command                  the implementer only, and only the unit's VERIFY LAUNCHER (decideCommand): the unit's
//                                verify_cmd in the verify jail, where no credential, host file or network is reachable.
//                                Once: not in a persistent terminal, nor in the terminal of an earlier command.
//   invoke_subagent              the governor's admission (type pinned to Hydrogen, ceiling, assignment, no override).
// The post-turn write jail of the pipeline (implement.mjs inspectWrites) still judges the worktree from disk.
// NOT DECIDED HERE: the runtime runs manage_task, manage_subagents and send_message with no pre-tool hook (observed on
// SDK 0.1.24; config tools.unhooked, register L-715). The controller is not asked about them and records nothing.
//
// WHAT THE RESULT CARRIES: {text, structured_output, stop_reason, served_model, served_model_source: "provider",
// transport: "antigravity-sdk", requested_model, effort, subagents (the governor's record),
// usage, gateway (requests by class, sessions, served models, availability), tool_log, runtime, sandbox, launch}.
// served_model is the PROVIDER's statement (the response's modelVersion, seen by the gateway), and a result exists
// only when that statement is the model asked for.
//
// THE MODEL GUARD (register L-504 invariant 3, which board/agy-cli.mjs states for the CLI; this is the same rule at this
// transport's entry point). Every request the provider ANSWERED -- the implementer's, and each subagent's -- is checked
// on the name it was answered under, BEFORE any result of the session is acted on: its answer, its failure
// classification, its quota refusal (the ladder step it would cause). The name must resolve, under the identity policy,
// to the model that request asked for. An answer under another declared model, under a name the policy does not declare
// (it cannot be shown to be the model asked), or under no name at all refuses the session with code AGY_MODEL_MISMATCH
// and BOTH identities (`identity: {requested, reported}`). The code carries no status: it is neither a quota refusal nor a
// lane failure, so no ladder steps to another model on it and the unit blocks (pipeline/implement.mjs, index.mjs). The
// model asked is never recorded in the place of a name the provider did not give. A session in which the provider
// answered nothing keeps its own classification: there is no identity to compare.
//
// FAILURES (thrown; each carries what was recorded up to it: .subagents, .gateway, .tool_log, .usage):
//   code "quota_exhausted"     the provider refused for quota (HTTP 429): the pipeline steps the ladder
//   code "model_unavailable"   the provider does not serve the model (HTTP 404, at the availability check or mid-turn):
//                              the pipeline steps the ladder with that cause on the record; nothing is substituted here
//   code "lane_failure"        kind timeout | exit | stream | spawn: retried once on the same rung, then the ladder
//   code "PROVIDER_LIMIT"      the run's own provider-call bound refused a request (the gateway's admission)
//   code "CREDENTIAL_REFUSED"  the provider rejected the key (401/403): no rung can answer; the unit blocks
//   code "ABORTED"             the caller's signal
//   code "SANDBOX_UNAVAILABLE" / "SDK_UNAVAILABLE" / "SDK_VERSION" / "NO_API_KEY"
//
// Must never: start the bridge unjailed unless told to; put the key or any provider credential in the bridge's
// environment, argv or files; let a tool call run without a decision; forward a request the caller did not admit; treat
// the model asked for as evidence of the model that answered; invoke the agy CLI.
import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SDK_CONFIG, SDK_TRANSPORT, SDK_VENDOR, SDK_THINKING, undeclaredArg } from "./config.mjs";
import { subagentGovernor, SUBAGENT_MODEL, SUBAGENT_TYPES, SUBAGENT_MAX_DEPTH, ceilingFor } from "./subagents.mjs";
import { startModelGateway, keyRefusal } from "./gateway.mjs";
import { bwrapArgs, sandboxAvailable } from "../agy/sandbox.mjs";
import { decideWrite, decideRead, decideCommand, writePathArgsOf, workerVerifyCommand, VERIFY_LAUNCHER_NAME } from "../agy/jail-hook.mjs";
import { writeVerifyLauncher, HOME_SECRET_DIRS } from "../agy/verify-jail.mjs";
import { resolveModel } from "../review/identity.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const BRIDGE_SCRIPT = resolve(HERE, "..", "..", "scripts", "antigravity-bridge.py");
export const SDK_POLICY_SCHEMA = "pantheon.antigravity-sdk-jail/v1";
export const READ_TOOLS = Object.freeze(["view_file", "list_directory", "search_directory", "find_file"]);
export const WRITE_TOOLS = Object.freeze(["create_file", "edit_file"]);
/** The built-in tools the implementer is given (the SDK's names). Everything else the SDK offers is left off. */
export const IMPLEMENTER_TOOLS = Object.freeze([...READ_TOOLS, ...WRITE_TOOLS, "run_command", "finish"]);
const TOOL_LOG_CAP = 400;
const STDERR_CAP = 64 * 1024;
const str = v => typeof v === "string" && v.trim() !== "";
const real = p => { try { return realpathSync(p); } catch { return resolve(p); } };
const inside = (root, p) => p === root || p.startsWith(root + sep);
const fail = (code, message, more = {}) => Object.assign(new Error(message), { code, transport: SDK_TRANSPORT, ...more });
const laneFailure = (kind, message, more = {}) => fail("lane_failure", message, { kind, ...more });

/** Where the SDK's python is: PANTHEON_ANTIGRAVITY_PYTHON, else PANTHEON_AGY_PYTHON, else the documented venv under the user's home. */
export function sdkPython(env = process.env) {
  return env.PANTHEON_ANTIGRAVITY_PYTHON ?? env.PANTHEON_AGY_PYTHON ?? join(homedir(), ".local", "share", "pantheon", "venv-antigravity", "bin", "python");
}

/**
 * The directories the SDK's python is read from, for the jail: its VENV (the directory holding pyvenv.cfg: bin/python
 * and the SDK under lib/), else its own directory; and, when it is a link (a venv's python is one), the prefix of the
 * interpreter it resolves to (<prefix>/bin, <prefix>/lib). [] for a bare command name, which PATH resolves.
 */
export function pythonRoots(python) {
  if (!str(python) || !python.includes("/")) return [];
  const at = resolve(python), bin = dirname(at), venv = dirname(bin);
  const roots = [existsSync(join(venv, "pyvenv.cfg")) ? venv : bin];
  const target = real(at);
  if (target !== join(real(bin), at.slice(bin.length + 1))) { const prefix = dirname(dirname(target)); roots.push(existsSync(join(prefix, "lib")) ? prefix : dirname(target)); }
  return [...new Set(roots.map(real))];
}

/** The bridge's environment: a short allowlist. No key, no token, no proxy, no PANTHEON_ or provider variable. */
export const BRIDGE_ENV_ALLOW = Object.freeze(["PATH", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "TZ"]);
export function bridgeEnvOf({ base = process.env, home } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(base ?? {})) if (v !== undefined && (BRIDGE_ENV_ALLOW.includes(k) || k.startsWith("LC_"))) env[k] = v;
  // The runtime talks to the controller's loopback gateway only: no proxy is configured, and none is inherited.
  return { ...env, HOME: home, TMPDIR: "/tmp", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" };
}

/**
 * The unit's control directory for an SDK session: <control_dir>/run/{sdk-save, sdk-app, home} (the only writable part),
 * the unit's verify launcher <control_dir>/pantheon-verify, and the tool policy <control_dir>/sdk-jail.json (the record
 * of what the controller decides against; the controller holds the object, the file is evidence). Returns {policy, paths}.
 */
export async function prepareSdkWorkspace({ control_dir, worktree, unit_id = null, owned_paths, verify_cmd = null, verify_hide = [], node = process.execPath }) {
  if (!str(control_dir) || !str(worktree)) throw fail("NO_WORKSPACE", "prepareSdkWorkspace: pass control_dir and worktree");
  if (!Array.isArray(owned_paths) || !owned_paths.length) throw fail("NO_OWNED_PATHS", "prepareSdkWorkspace: the unit owns no paths");
  await mkdir(control_dir, { recursive: true });
  const ctl = real(control_dir), wt = real(worktree);
  if (inside(wt, ctl) || inside(ctl, wt)) throw fail("CONTROL_IN_WORKTREE", `the control dir ${ctl} and the worktree ${wt} must be disjoint`);
  const run = join(ctl, "run"), paths = { control_dir: ctl, worktree: wt, run, save_dir: join(run, "sdk-save"), app_data_dir: join(run, "sdk-app"), home: join(run, "home"), policy_file: join(ctl, "sdk-jail.json") };
  for (const d of [paths.save_dir, paths.app_data_dir, paths.home]) await mkdir(d, { recursive: true });
  const verify = str(verify_cmd) ? verify_cmd.trim() : null;
  const script = verify ? workerVerifyCommand(wt, verify) : null;
  const launcher = verify ? writeVerifyLauncher({ control_dir: ctl, worktree: wt, script, node, hide: verify_hide.filter(p => str(p) && isAbsolute(p)) }).command : null;
  const policy = { schema: SDK_POLICY_SCHEMA, unit_id, worktree: wt, worktree_given: resolve(worktree), control_dir: ctl, owned_paths: [...owned_paths], verify_cmd: verify, worker_verify_cmd: launcher, worker_verify_script: script,
    read_tools: [...READ_TOOLS], write_tools: [...WRITE_TOOLS] };
  await writeFile(paths.policy_file, JSON.stringify(policy, null, 2) + "\n");
  return { policy, paths: { ...paths, verify_launcher: launcher } };
}

const dec = (allow, code, reason, more = {}) => ({ allow, code, reason: String(reason).slice(0, 600), ...more });
/**
 * The controller's decision for one tool call the SDK is about to run (see TOOL DECISIONS in the header).
 *   policy     the unit's tool policy (prepareSdkWorkspace)
 *   governor   the session's subagent governor
 * Never throws: an exception is a denial.
 */
export function toolDecision({ policy, governor }, { tool, args, trajectory_id = null, call_id = null, server_name = null }) {
  try {
    const name = String(tool ?? "");
    const child = governor.isChild(trajectory_id);
    const sub = child ? governor.subagentOf(trajectory_id) : null;
    const who = child ? (sub ? sub.id : "unattributed-child") : "implementer";
    const a = args !== null && typeof args === "object" && !Array.isArray(args) ? args : {};
    if (server_name) return dec(false, "TOOL_NOT_ALLOWED", `MCP tool ${server_name}/${name} is not served to this session`, { who });
    if (name === "finish") return dec(true, null, "the structured-output tool", { who });
    // EXACTLY THE DECLARED NAMES, before any decision reads one (config.mjs undeclaredArg): the runtime also reads other
    // spellings of a declared name, so a call carrying any other key is refused whole.
    const undeclared = undeclaredArg(name, a);
    if (undeclared) return dec(false, "ARGS_UNDECLARED", undeclared, { who });
    if (name === "invoke_subagent") {
      const r = governor.admit({ call_id, trajectory_id, args: a });
      return dec(r.allow, r.code, r.reason, { who, ...(r.allow ? { admitted: r.admitted } : {}) });
    }
    if (READ_TOOLS.includes(name)) {
      // Every path-like argument is judged (a tool's own key names differ between SDK versions): each as a read path.
      const paths = writePathArgsOf(a);
      if (!paths.length) return dec(false, "READ_NO_PATH", `${name} names no path the controller can check`, { who });
      for (const { key, value } of paths) {
        const d = decideRead(policy, { AbsolutePath: value });
        if (d.decision !== "auto_approve") return dec(false, "READ_OUTSIDE", `${key}: ${d.reason}`, { who });
      }
      return dec(true, null, "a read inside the worktree", { who });
    }
    if (WRITE_TOOLS.includes(name)) {
      if (child && !sub) return dec(false, "SUBAGENT_SCOPE", "a child the controller cannot attribute to an admitted subagent may not write", { who });
      if (sub && !sub.write) return dec(false, "SUBAGENT_SCOPE", `a ${sub.type} subagent reads only: it may not write`, { who });
      const d = decideWrite(policy, a);
      return dec(d.decision === "auto_approve", d.decision === "auto_approve" ? null : "WRITE_REFUSED", d.reason, { who });
    }
    if (name === "run_command") {
      if (child) return dec(false, "SUBAGENT_SCOPE", "a subagent runs no command: the implementer runs the unit's verify command", { who });
      // ONE SHOT. A persistent terminal, or the terminal of an earlier command, outlives the launcher, and the runtime
      // has tools the controller is given no hook for (config tools.unhooked: manage_task takes an Input).
      if (a.RunPersistent === true || (a.RequestedTerminalID !== undefined && a.RequestedTerminalID !== null && a.RequestedTerminalID !== "")) {
        return dec(false, "COMMAND_REFUSED", "the unit's verify launcher runs once: not in a persistent terminal, and not in the terminal of an earlier command", { who });
      }
      const d = decideCommand(policy, a);
      return dec(d.decision === "auto_approve", d.decision === "auto_approve" ? null : "COMMAND_REFUSED", d.reason, { who });
    }
    return dec(false, "TOOL_NOT_ALLOWED", `tool ${name} is not allowed in an implementer session`, { who });
  } catch (e) { return dec(false, "DECISION_EXCEPTION", `the decision failed: ${String(e?.message ?? e)}`); }
}

/** The implementer's standing instructions on this transport (its system instructions; the unit prompt is the user turn). */
export function sdkWorkerInstructions({ marker, ceiling, types = [] }) {
  return [
    "You are the single implementer of one work unit in a supervised build pipeline. You work in one git worktree and you own a fixed list of paths in it.",
    "Every tool call you make is decided by a controller before it runs. A write outside the paths you own, a read outside the worktree, and any command other than the unit's verify command are refused before they happen; a refusal tells you why. Do not work around a refusal.",
    "Do not commit, do not move HEAD, and do not create symlinks. Finish with a short plain-text note of what you changed.",
    ceiling > 0 && types.length
      ? `You may delegate to specialist subagents with invoke_subagent: at most ${ceiling} live in this session (a ceiling, not a target; an idle subagent keeps its slot, so give it its next task with send_message rather than starting another). Only these types exist: ${types.join(", ")}. Give each one a specific assignment. A type you define yourself, a model or tier you name, or a branched workspace is refused.`
      : "You have no subagents in this session: do the work yourself.",
    marker,
  ].join("\n");
}
const subagentSystem = (t, marker) => `${t.instructions}\n${marker}`;

/** Why the identity the bridge reported is not the SDK this transport was qualified on, or null. */
export function sdkVersionRefusal(runtime, { allow = null } = {}) {
  const want = SDK_CONFIG.sdk, got = runtime?.sdk ?? {};
  if (got.status !== "installed") return `google-antigravity is not installed for ${runtime?.executable ?? "the bridge's python"}: ${got.error ?? "the module did not import"}`;
  if (got.distribution && got.distribution !== want.distribution) return `the bridge loaded ${got.distribution}, not ${want.distribution}`;
  const ok = [want.version, ...(Array.isArray(allow) ? allow : str(allow) ? [allow] : [])];
  return ok.includes(got.version) ? null : `google-antigravity ${got.version ?? "(unknown version)"} is installed; this transport was qualified on ${want.version}. Run pantheon/tests/antigravity-sdk-contract.test.mjs against it before allowing it (PANTHEON_ANTIGRAVITY_SDK_ALLOW)`;
}

/**
 * Run one implementer session. See the header.
 *   seat            {vendor, model, effort?}: the implementer seat (an SDK transport model)
 *   unit            {unit_id, owned_paths, verify_cmd, allowed_subagents}: allowed_subagents are specialist TYPE names
 *   apiKey          the Gemini API key, held by the controller only (default: GEMINI_API_KEY of this process)
 *   admit           ({class, type, model, n}) => void | throws: the caller's charge for EVERY billed request
 *   timeoutS/graceS the turn's bound and the kill grace after it
 *   sandbox         {enabled = true, allowUnsandboxed = false, bwrap = "bwrap"}
 *   upstream        the provider base URL (tests pass a scripted endpoint)
 *   python/bridge   the SDK's python and the bridge script (tests pass a scripted bridge)
 */
export async function runAntigravitySdkTurn({ seat, prompt, worktree, control_dir, unit = {}, apiKey = process.env[SDK_CONFIG.api.key_env] ?? null, admit = () => {}, signal = null,
  timeoutS = 1800, graceS = 15, sandbox = {}, upstream = SDK_CONFIG.api.base_url, python = sdkPython(), bridge = BRIDGE_SCRIPT, verify_hide = [], schema = null, budget = {},
  base_env = process.env, fetchImpl = fetch, allowSdkVersion = process.env.PANTHEON_ANTIGRAVITY_SDK_ALLOW ?? null, checkAvailability = true, now = () => new Date().toISOString() } = {}) {
  const model = seat?.model, effort = seat?.effort ?? null;
  if (!str(model)) throw fail("BAD_SEAT", "runAntigravitySdkTurn: pass the implementer seat {vendor, model}");
  if (effort !== null && !SDK_THINKING.includes(effort)) throw fail("BAD_SEAT", `effort "${effort}" is not a thinking level the SDK accepts (${SDK_THINKING.join(", ")})`);
  if (!str(prompt)) throw fail("BAD_INPUT", "runAntigravitySdkTurn: pass the unit prompt");
  // No key, or one that cannot be a header value: ONE check (keyRefusal covers both), here, before anything is prepared.
  { const bad = keyRefusal(apiKey); if (bad) throw fail("NO_API_KEY", str(apiKey) ? `${SDK_CONFIG.api.key_env} is not usable as a key (${bad}); it was not sent anywhere`
    : `the Antigravity SDK transport needs ${SDK_CONFIG.api.key_env} (the Gemini API; no subscription login is used)`); }
  if (signal?.aborted) throw fail("ABORTED", "the run was aborted before the implementer session started");
  if (python.includes("/") && !existsSync(python)) throw laneFailure("spawn", `the Antigravity SDK's python is absent at ${python} (set PANTHEON_ANTIGRAVITY_PYTHON to the venv that has google-antigravity ${SDK_CONFIG.sdk.version})`, { sdk_unavailable: true });
  if (!existsSync(bridge)) throw laneFailure("spawn", `the bridge script is absent at ${bridge}`, { sdk_unavailable: true });

  const { policy, paths } = await prepareSdkWorkspace({ control_dir, worktree, unit_id: unit.unit_id ?? null, owned_paths: unit.owned_paths ?? [], verify_cmd: unit.verify_cmd ?? null, verify_hide });
  const box = { enabled: sandbox.enabled !== false, allowUnsandboxed: sandbox.allowUnsandboxed === true, bwrap: sandbox.bwrap ?? "bwrap", home: sandbox.home ?? null };
  const nonce = randomBytes(6).toString("hex");
  const rootMarker = `[pantheon-agent:${nonce}:implementer]`;
  let ceiling = ceilingFor(model);
  let types = ceiling > 0 ? (unit.allowed_subagents ?? []).filter(n => Object.hasOwn(SUBAGENT_TYPES, n)) : [];
  const markers = Object.fromEntries(Object.keys(SUBAGENT_TYPES).map(t => [t, `[pantheon-agent:${nonce}:subagent:${t}]`]));
  const tool_log = [];
  let dropped_decisions = 0;
  const record = { transport: SDK_TRANSPORT, requested_model: model, effort, subagents: null, gateway: null, tool_log, usage: null, runtime: null, sandbox: null, launch: null, availability: [] };
  const carry = e => Object.assign(e, { subagents: record.subagents, gateway: record.gateway, tool_log: record.tool_log, usage: record.usage, runtime: record.runtime, availability: record.availability, transport: SDK_TRANSPORT });

  // ---- the jail, before anything is spent
  let argvPrefix = [], sandboxRecord = { enabled: false, why: "disabled by the caller" };
  if (box.enabled) {
    const probe = await sandboxAvailable(box.bwrap);
    if (!probe.ok) {
      if (!box.allowUnsandboxed) throw fail("SANDBOX_UNAVAILABLE", `the implementer session is not started unjailed: bwrap is not usable here (${probe.why})`);
      sandboxRecord = { enabled: false, why: `bwrap is not usable (${probe.why}); the caller allowed an unsandboxed session` };
    } else {
      const keep = [process.execPath, resolve(HERE, ".."), ...pythonRoots(python), real(dirname(bridge))];
      // The jail gives the session a fresh /tmp. A path it runs from that lives under /tmp (a python, the bridge) is
      // bound back read-only, alone; the rest of the host's /tmp stays hidden.
      const underTmp = [...new Set(keep.map(real).filter(p => p !== "/tmp" && inside("/tmp", p)))];
      const jail = bwrapArgs({ worktree: paths.worktree, control_dir: paths.control_dir, bwrap: box.bwrap, keep_visible: keep, extra_ro: underTmp });
      // THE USER'S HOME. The bridge needs no credential from it (the key is the gateway's), so every credential-bearing
      // directory of the home (verify-jail.mjs HOME_SECRET_DIRS: .ssh, .gemini, .codex, .config, .local/share, ...) is
      // covered with an empty tmpfs; a path the session itself runs from that lies inside one (the SDK's venv under
      // ~/.local/share, whole: pythonRoots) is bound back read-only, alone. These go BEFORE the jail's own binds, which
      // then override them.
      const home = real(box.home ?? homedir()), hidden = [], kept = [], extra = [];
      const needed = [...new Set([...keep, paths.worktree, paths.control_dir].map(real))];
      for (const d of HOME_SECRET_DIRS) {
        const p = join(home, d);
        if (!existsSync(p) || inside("/tmp", p)) continue;   // under /tmp the jail already has a fresh tmpfs
        let rp, st; try { rp = realpathSync(p); st = statSync(p); } catch { continue; }
        if (rp !== p) { kept.push({ path: p, why: "a symlink: not covered" }); continue; }
        if (needed.some(n => inside(n, p))) { kept.push({ path: p, why: "inside a path the session runs from" }); continue; }
        if (st.isDirectory()) {
          extra.push("--tmpfs", p);
          for (const n of needed.filter(x => inside(p, x))) { extra.push("--ro-bind", n, n); kept.push({ path: n, why: `bound back read-only inside ${p}` }); }
        } else extra.push("--ro-bind", "/dev/null", p);
        hidden.push(p);
      }
      const at = jail.argv.indexOf("/tmp", jail.argv.indexOf("--tmpfs")) + 1;   // right after the base: --ro-bind / / --dev --proc --tmpfs /tmp
      argvPrefix = [...jail.argv.slice(0, at), ...extra, ...jail.argv.slice(at)];
      sandboxRecord = { enabled: true, bwrap: box.bwrap, binds: jail.binds, hidden_control_dirs: jail.hidden, home_dirs_hidden: hidden, ...(kept.length ? { home_paths_kept: kept } : {}), network: "shared with the host: the runtime reaches the controller's loopback gateway; it holds no credential" };
    }
  } else if (!box.allowUnsandboxed) throw fail("SANDBOX_UNAVAILABLE", "the implementer session is not started unjailed (sandbox.enabled is false and allowUnsandboxed is not set)");
  record.sandbox = sandboxRecord;

  // ---- the gateway: the key stays here
  let governor = subagentGovernor({ implementer: { vendor: seat.vendor ?? SDK_VENDOR, model }, unit_id: unit.unit_id ?? null, allowed_types: types, now });
  const makeGateway = () => startModelGateway({ upstream, apiKey, root: { model, marker: rootMarker }, subagents: { model: SUBAGENT_MODEL, ceiling: types.length ? ceiling : 0, markers }, admit, signal, fetchImpl });
  let gw = await makeGateway();
  const snapshot = () => { record.subagents = { ...governor.record(), blocked: record.subagents?.blocked ?? null }; record.gateway = summarise(gw.record()); record.availability = gw.record().availability; };
  let child = null;
  try {
    // ---- availability: asked of the provider, recorded, never assumed
    if (checkAvailability) {
      const a = await gw.availability(model);
      if (!a.available) {
        snapshot();
        if (a.kind === "auth") throw carry(fail("CREDENTIAL_REFUSED", `the provider refused the key for ${model} (HTTP ${a.status}): ${a.why}`, { status: a.status }));
        if (a.kind === "model_unavailable") throw carry(fail("model_unavailable", `the provider does not serve ${model} (HTTP ${a.status}): ${a.why}; nothing is substituted here`, { status: a.status, model }));
        if (a.kind === "quota") throw carry(fail("quota_exhausted", `the provider refused the availability check of ${model} for quota (HTTP ${a.status}): ${a.why}`, { status: 429 }));
        throw carry(laneFailure("exit", `the provider could not be asked about ${model}: ${a.why ?? `HTTP ${a.status}`}`, { status: a.status }));
      }
      if (types.length && ceiling > 0) {
        const s = await gw.availability(SUBAGENT_MODEL);
        if (!s.available) {
          // A COMPATIBILITY BLOCKER, reported: without the subagent model there are no subagents. Nothing runs in its place.
          const blocked = { code: "SUBAGENT_MODEL_UNAVAILABLE", why: `${SUBAGENT_MODEL} is not available (${s.kind ?? "unknown"}, HTTP ${s.status}): ${s.why ?? ""}`.slice(0, 400), ceiling_was: ceiling };
          const before = gw.record().availability;
          await gw.close();
          ceiling = 0; types = [];
          governor = subagentGovernor({ implementer: { vendor: seat.vendor ?? SDK_VENDOR, model }, unit_id: unit.unit_id ?? null, allowed_types: [], now });
          gw = await makeGateway();
          record.subagents = { blocked };
          record.availability_before = before;
        }
      }
    }
    const subagents = types.map(t => ({ name: t, description: SUBAGENT_TYPES[t].description, system: subagentSystem(SUBAGENT_TYPES[t], markers[t]), model: SUBAGENT_MODEL, tools: [...SUBAGENT_TYPES[t].tools] }));
    const start = { type: "start", model, thinking: effort, gateway: { url: gw.url, token: gw.token }, workspace: paths.worktree, save_dir: paths.save_dir, app_data_dir: paths.app_data_dir,
      system: sdkWorkerInstructions({ marker: rootMarker, ceiling: types.length ? ceiling : 0, types }), prompt, schema: schema ?? null,
      enabled_tools: [...IMPLEMENTER_TOOLS, ...(subagents.length ? ["invoke_subagent"] : [])], subagents, max_subagent_depth: SUBAGENT_MAX_DEPTH,
      budget: { max_model_calls: budget.max_model_calls ?? 80, max_tool_calls: budget.max_tool_calls ?? 200, ...(budget.max_output_tokens ? { max_output_tokens: budget.max_output_tokens } : {}) },
      hook_timeout_s: 30, turn_timeout_s: Math.max(1, Math.floor(timeoutS)), command_timeout_s: Math.max(1, Math.min(600, Math.floor(timeoutS))), disable_define_subagent: true };
    const argv = [...argvPrefix, python, bridge];
    const env = bridgeEnvOf({ base: base_env, home: paths.home });
    record.launch = { argv: argv.map(a => (a === gw.token ? "<token>" : a)), env_names: Object.keys(env).sort(), cwd: paths.control_dir, gateway: gw.url, at: now() };

    const result = await new Promise((resolveTurn, rejectTurn) => {
      let settled = false, stderr = "", final = null, exited = null, killTimer = null, hardTimer = null, identityRefusal = null, timedOut = false;
      const settle = (fn, v) => { if (settled) return; settled = true; clearTimeout(hardTimer); clearTimeout(killTimer); signal?.removeEventListener("abort", onAbort); fn(v); };
      try { child = spawn(argv[0], argv.slice(1), { cwd: paths.control_dir, env, stdio: ["pipe", "pipe", "pipe"], detached: true }); }
      catch (e) { return settle(rejectTurn, laneFailure("spawn", `the bridge could not be started: ${String(e?.message ?? e)}`)); }
      const killTree = sig => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
      const send = obj => { try { if (child.stdin.writable) child.stdin.write(JSON.stringify(obj) + "\n"); } catch { /* the bridge is gone */ } };
      const stop = why => { send({ type: "cancel", reason: why }); gw.abort(why); killTimer ??= setTimeout(() => killTree("SIGKILL"), Math.max(1, graceS) * 1000); };
      const onAbort = () => stop(signal?.reason?.message ?? "the run was aborted");
      if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
      // The bridge ends its own turn at timeoutS; this is the controller's bound behind it, for a bridge that does not.
      hardTimer = setTimeout(() => { timedOut = true; stop("the turn's timeout"); }, (timeoutS + graceS) * 1000);
      child.on("error", e => settle(rejectTurn, laneFailure("spawn", `the bridge could not be started (${python}): ${e?.code ?? e?.message ?? e}`, { sdk_unavailable: e?.code === "ENOENT" })));
      child.stderr.on("data", d => { if (stderr.length < STDERR_CAP) stderr += d.toString("utf8"); });
      child.stdin.on("error", () => { /* EPIPE when the bridge exits first */ });
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on("line", line => {
        let m; try { m = JSON.parse(line); } catch { return; }
        if (m?.type === "identity") {
          record.runtime = m.runtime ?? null;
          identityRefusal = sdkVersionRefusal(m.runtime, { allow: allowSdkVersion ? String(allowSdkVersion).split(",").map(s => s.trim()) : null });
          if (identityRefusal) stop(`SDK_VERSION: ${identityRefusal}`);
        } else if (m?.type === "ready") { record.capabilities = m.capabilities ?? null; record.conversation_id = m.conversation_id ?? null; }
        else if (m?.type === "hook") {
          const d = toolDecision({ policy, governor }, m);
          if (tool_log.length < TOOL_LOG_CAP) tool_log.push({ n: m.id, at: now(), tool: m.tool, who: d.who ?? null, allow: d.allow, code: d.code ?? null, reason: d.reason.slice(0, 240) });
          else dropped_decisions += 1;
          send({ type: "decision", id: m.id, allow: d.allow, message: d.allow ? undefined : `${d.code}: ${d.reason}` });
        } else if (m?.type === "event") governor.observe(m);
        else if (m?.type === "result") final = m;
      });
      child.on("close", (code, sig) => {
        exited = { code, signal: sig };
        if (identityRefusal) return settle(rejectTurn, fail("SDK_VERSION", identityRefusal));
        settle(resolveTurn, { final: timedOut ? { ok: false, error: { kind: "timeout", message: `no result within ${timeoutS} s (+${graceS} s grace)` } } : final, exited, stderr: stderr.slice(-4000) });
      });
      send(start);
    });
    snapshot();
    if (dropped_decisions) record.tool_log_dropped = dropped_decisions;
    return finish(result);
  } catch (e) {
    try { snapshot(); } catch { /* the record is what it is */ }
    throw carry(e);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }
    await gw.close().catch(() => {});
  }

  // ---- the model guard (the header): {agent, asked, reported, why} -> the refusal, with both identities
  function mismatch({ agent, asked, reported, why }) {
    return fail("AGY_MODEL_MISMATCH", `Antigravity SDK identity mismatch: expected ${agent}/${asked}, got ${agent}/${reported ?? "none"} (${why}); no result of this session is acted on (answer, failure, quota refusal)`,
      { identity: { requested: { agent, model: asked }, reported: { agent, model: reported } } });
  }
  /** The refusal for the first answered request whose name is not the model it asked for, or null. */
  function guardRefusal(g) {
    const check = (agent, asked) => {
      const want = resolveModel(SDK_VENDOR, asked);
      const wrong = (g?.served_models?.[asked] ?? []).map(n => ({ name: n, id: resolveModel(SDK_VENDOR, n) })).find(r => !(r.id?.known && want?.known && r.id.id === want.id));
      if (wrong) return mismatch({ agent, asked, reported: wrong.name, why: wrong.id?.known ? "the provider answered as another model" : "the provider answered under a name the identity policy does not declare, which cannot be shown to be the model asked" });
      return (g?.unnamed?.[asked] ?? 0) > 0 ? mismatch({ agent, asked, reported: null, why: "the provider answered without naming a model" }) : null;
    };
    return check("implementer", model) ?? (model !== SUBAGENT_MODEL ? check("subagent", SUBAGENT_MODEL) : null);
  }

  // ---- the result, judged against what the controller itself saw
  function finish({ final, exited, stderr }) {
    const g = record.gateway, stopped = g?.stop ?? null;
    const redact = s => String(s ?? "").split(gw.token).join("<token>").split(apiKey).join("<key>");
    const tail = redact(stderr).trim().split("\n").slice(-6).join(" | ").slice(0, 800);
    if (signal?.aborted) throw fail("ABORTED", `the implementer session was stopped: ${signal.reason?.message ?? "aborted"}`);
    // THE MODEL GUARD, first (the header): nothing below acts on a session another model answered in.
    const refused = guardRefusal(g);
    if (refused) throw refused;
    const ok = final?.ok === true;
    // The gateway's own record decides what kind of stop this was: it saw the provider's status, not a sentence about it.
    if (!ok || stopped) {
      const why = redact(final?.error?.message ?? (final ? "the session reported no text" : `the bridge exited ${exited?.code ?? exited?.signal} without a result`));
      if (stopped?.kind === "budget") throw fail("PROVIDER_LIMIT", `the run's provider-call bound refused a request of the implementer session: ${stopped.message}`);
      if (stopped?.kind === "quota") throw fail("quota_exhausted", `${model} was refused for quota by the provider (HTTP 429${stopped.provider_status ? ` ${stopped.provider_status}` : ""}): ${stopped.message}`, { status: 429, quota: { explicit: true, matched: stopped.provider_status ?? "429" } });
      if (stopped?.kind === "model_unavailable") throw fail("model_unavailable", `the provider does not serve ${model} (HTTP ${stopped.status}): ${stopped.message}; nothing is substituted here`, { status: stopped.status, model });
      if (stopped?.kind === "auth") throw fail("CREDENTIAL_REFUSED", `the provider refused the key (HTTP ${stopped.status}): ${stopped.message}`, { status: stopped.status });
      if (!ok) {
        const kind = final?.error?.kind === "timeout" ? "timeout" : !final ? "exit" : final.error?.kind === "cancelled" ? "exit" : stopped ? "exit" : "stream";
        throw laneFailure(kind, `the Antigravity SDK session on ${model} failed (${final?.error?.kind ?? "no result"}): ${why}${tail ? `; stderr: ${tail}` : ""}`.slice(0, 1500), { exit: exited, ...(stopped ? { status: stopped.status } : {}) });
      }
    }
    // WHO ANSWERED. The guard above passed every name the provider gave. A session that ended with an answer and for
    // which the provider named no model at all is refused the same way: there is no statement to record as served.
    const names = g?.served_models?.[model] ?? [];
    if (!names.length) throw mismatch({ agent: "implementer", asked: model, reported: null, why: "the session ended with an answer and the provider named no model for any request of it" });
    record.usage = final.usage ?? null;
    return { text: typeof final.text === "string" ? final.text : "", structured_output: final.structured_output ?? null, stop_reason: final.stop_reason ?? "UNSPECIFIED",
      served_model: names[0], served_model_source: "provider",
      transport: SDK_TRANSPORT, requested_model: model, effort, conversation_id: final.conversation_id ?? record.conversation_id ?? null, tool_calls: final.tool_calls ?? tool_log.length,
      subagents: record.subagents, usage: record.usage, trajectory_usages: final.trajectory_usages ?? null, gateway: g, availability: record.availability, tool_log, ...(record.tool_log_dropped ? { tool_log_dropped: record.tool_log_dropped } : {}),
      capabilities: final.capabilities ?? record.capabilities ?? null, runtime: record.runtime, sandbox: record.sandbox, launch: record.launch, duration_s: final.duration_s ?? null };
  }
}

/** The gateway's record without the per-request rows a pipeline record does not need twice: totals, sessions, stops. */
function summarise(g) {
  return { root: g.root, subagents: g.subagents, totals: g.totals, sessions: g.sessions, subagent_sessions: g.subagent_sessions, served_models: g.served_models, served_by_type: g.served_by_type ?? {}, unnamed: g.unnamed ?? {}, budget_refusals: g.budget_refusals, stop: g.stop, aborted: g.aborted,
    refusals: g.requests.filter(r => r.refusal).map(r => ({ seq: r.seq, at: r.at, class: r.class, type: r.type, model: r.model, status: r.status, refusal: r.refusal })) };
}
