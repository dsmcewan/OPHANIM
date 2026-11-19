// Fakes for the review runner's subscription mode (src/review-runner/subscription.mjs). No network, no real CLI, no
// login. The fake `codex` and `grok` binaries append one JSON line per invocation to $FAKE_CLI_LOG: their argv (the
// prompt replaced by its length), the names of the key-like variables they received, and their cwd. Behaviour switches
// (names that scrubEnv passes through: no KEY/TOKEN/SECRET in them):
//   FAKE_CODEX_LOGIN   chatgpt (default) | apikey | none | weird        what `codex login status` prints
//   FAKE_CODEX_MODELS  json (default) | lines | missing | garbage       what `codex debug models` prints
//   FAKE_CODEX_PERMS   match (default) | legacy | none | fail          what `codex debug prompt-input` reports: the profile
//                      the --config overrides define (as the real 0.170.0 binary renders it), the legacy workspace-write
//                      profile (as if the overrides were ignored), no profile at all, or exit 1
//   FAKE_CLI_MODE      ok (default) | hang | fail | needkey             what a model run (`codex exec` / `grok -p`) does
//                      (grok also: chunks -- the answer as text_delta events; nofinal -- tool events only;
//                      native -- grok 1.0.44's observed text/tool_call/end shapes, end_turn; cancelled -- the same with
//                      the edit cancelled and stopReason "cancelled", exit 0)
//   FAKE_CLI_WRITE     a worktree-relative path the model run writes (a policy probe)
//   FAKE_CLI_PIDFILE   hang: the file the run writes its child's pid to (the timeout test checks it was killed)
//   FAKE_CODEX_MARKER  a path; `codex --version` says whether it is visible (the WSL outer runtime hides the host /tmp)
//   FAKE_GROK_INSPECT_LOADED  the count `grok inspect` reports (the shape of the owner's grok-permission-inspect.json; default 6)
// The fake `codex exec` speaks the SDK's protocol (`exec --experimental-json ... [resume <id>]`, the prompt on stdin):
// the one test that drives the REAL @openai/codex-sdk runs it. Every other codex run uses fakeCodexSdk below, an
// injected stand-in for the SDK's Codex class driven by the same switches in the env it is given, plus:
//   FAKE_CLI_MODE      also partial | throw | deaf                       (see fakeCodexSdk)
//   FAKE_CLI_PROMPT_FILE  the model run copies its prompt there (the --continue tests read the appendix)
//   FAKE_CLI_CHECK     a worktree-relative path; the final message says whether it existed when the run began
// The fake grok also PROBES its jail and reports what it could write in its final text: `PROBE {...}`.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The agy worker's env is an ALLOWLIST (src/board/agy-cli.mjs workerEnv; independent review round 2, assignment 4,
// question 7): the fake CLIs' own switches reach the fake agy only because the operator variable lists them.
process.env.PANTHEON_AGY_ENV_PASS ??= "FAKE_*";

const KEYS = "Object.keys(process.env).filter(k => /KEY|TOKEN|SECRET/.test(k)).sort()";
const COMMON = String.raw`
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const argv = process.argv.slice(2);
const log = o => { if (process.env.FAKE_CLI_LOG) try { fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify(o) + "\n"); } catch {} };
const mode = process.env.FAKE_CLI_MODE || "ok";
const hang = () => {
  const c = cp.spawn("sleep", ["1000"], { stdio: "ignore" });
  if (process.env.FAKE_CLI_PIDFILE) fs.writeFileSync(process.env.FAKE_CLI_PIDFILE, String(c.pid));
  setInterval(() => {}, 1000);
};
`;

const FAKE_CODEX = String.raw`
${COMMON}
log({ cli: "codex", argv, keys: ${KEYS}, cwd: process.cwd() });
// FAKE_CODEX_MARKER: a file the test made under the host /tmp; the version line says whether this process sees it (the WSL
// outer runtime gives codex a private /tmp, so there it is absent).
if (argv[0] === "--version") { console.log("codex-cli 9.9.9-fake" + (process.env.FAKE_CODEX_MARKER ? " marker=" + (fs.existsSync(process.env.FAKE_CODEX_MARKER) ? "visible" : "hidden") : "")); process.exit(0); }
if (argv[0] === "login" && argv[1] === "status") {
  const l = process.env.FAKE_CODEX_LOGIN || "chatgpt";
  if (l === "chatgpt") { console.log("Logged in using ChatGPT"); process.exit(0); }
  if (l === "apikey") { console.log("Logged in using an API key - sk-proj-***ABCDEFGHIJKLMNOPQRSTUVWX"); process.exit(0); }
  if (l === "none") { console.error("Not logged in"); process.exit(1); }
  console.log("status: ok?"); process.exit(0);
}
if (argv[0] === "debug" && argv[1] === "models") {
  const m = process.env.FAKE_CODEX_MODELS || "json";
  if (m === "json") console.log(JSON.stringify({ models: [{ slug: "gpt-6-astra", display_name: "GPT-6 Astra" }, { slug: "gpt-6.1-sol" }] }));
  else if (m === "lines") console.log("gpt-6-astra   GPT-6 Astra\ngpt-6.1-sol   GPT-6.1 Sol");
  else if (m === "missing") console.log(JSON.stringify({ models: [{ slug: "gpt-5.9-other" }] }));
  else console.log("~~~ ??? ~~~");
  process.exit(0);
}
if (argv[0] === "debug" && argv[1] === "prompt-input") {
  const m = process.env.FAKE_CODEX_PERMS || "match", cwd = process.cwd();
  if (m === "fail") { console.error("fake codex: prompt-input failed"); process.exit(1); }
  const cfg = argv.flatMap((a, i) => (a === "--config" ? [argv[i + 1]] : []));
  const val = k => { const c = cfg.find(x => x.startsWith(k + "=")); return c ? JSON.parse(c.slice(k.length + 1).replace(/"=/g, '":')) : undefined; };
  const name = val("default_permissions");
  const entry = (access, p) => '<entry access="' + access + '">' + (p.startsWith(":") ? "<special>" + p + "</special>" : "<path>" + p + "</path>") + "</entry>";
  let entries = [], net = "restricted";
  if (m === "legacy" || !name) { entries = [entry("read", ":root"), entry("write", cwd), entry("write", ":slash_tmp"), entry("write", ":tmpdir"), entry("read", cwd + "/.git")]; }
  else {
    for (const [k, v] of Object.entries(val("permissions." + name + ".filesystem") ?? {})) {
      if (k === ":workspace_roots") for (const [sub, a] of Object.entries(v)) entries.push(entry(a, sub === "." ? cwd : cwd + "/" + sub));
      else entries.push(entry(v, k));
    }
    entries.push(entry("read", (process.env.HOME || "/h") + "/.codex/tmp/arg0-linux/codex-arg0Fake12"));
    if (val("permissions." + name + ".network")?.enabled) net = "enabled";
  }
  const profile = m === "none" ? "" : '<permission_profile type="managed"><file_system type="restricted">' + entries.join("") + "</file_system></permission_profile>";
  console.log(JSON.stringify([{ type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>Network access is " + net + ".</permissions instructions>" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context><filesystem>" + profile + "</filesystem></environment_context>" }] }]));
  process.exit(0);
}
if (argv[0] === "exec" && argv[1] === "--experimental-json") {
  const val = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  const dir = val("--cd"), prompt = fs.readFileSync(0, "utf8");
  log({ cli: "codex", stdin_bytes: Buffer.byteLength(prompt), originator: process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? null });
  const ev = o => process.stdout.write(JSON.stringify(o) + "\n");
  ev({ type: "thread.started", thread_id: "01a1f0fe-0000-7000-8000-0000000000b1" });
  ev({ type: "turn.started" });
  if (mode === "fail") { ev({ type: "turn.failed", error: { message: "usage limit reached" } }); console.error("fatal: usage limit reached"); process.exit(1); }
  const text = "# Findings (fake codex binary)\n\nModel: " + val("--model") + " in " + dir + "\n";
  ev({ type: "item.completed", item: { id: "i2", type: "agent_message", text } });
  ev({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20 } });
  process.exit(0);
}
console.error("fake codex: unknown command " + argv.join(" ")); process.exit(2);
`;

const FAKE_GROK = String.raw`
${COMMON}
const pi = argv.indexOf("-p");
log({ cli: "grok", argv: argv.map((a, i) => (i === pi + 1 && pi >= 0 ? "<prompt " + a.length + ">" : a)), keys: ${KEYS}, cwd: process.cwd(), home: process.env.HOME });
if (argv[0] === "--version") { console.log("grok 0.0.1-fake"); process.exit(0); }
// The CLI's permission inspection in the shape the owner captured (grok-permission-inspect.json); FAKE_GROK_INSPECT_LOADED sets the count.
if (argv[0] === "inspect") { const cfg = path.join(process.env.HOME, ".grok", "config.toml"); console.log(JSON.stringify({ permissions: { sources: fs.existsSync(cfg) ? [cfg + " (config)"] : [], loaded: Number(process.env.FAKE_GROK_INSPECT_LOADED ?? 6), skipped: [] } })); process.exit(0); }
if (pi >= 0) {
  if (mode === "hang") return hang();
  if (mode === "needkey") { console.error("Error: not logged in. Set XAI_API_KEY or run grok to sign in."); process.exit(1); }
  const tryWrite = p => { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, "probe\n"); return "ok"; } catch (e) { return e.code; } };
  const wt = process.cwd();
  const probe = {
    cwd: wt,
    worktree_root: tryWrite(path.join(wt, "outside-review.txt")),
    review_tests: tryWrite(path.join(wt, ".review-tests", "probe.test.mjs")),
    state: tryWrite(path.join(process.env.HOME, ".grok", "written-in-run.txt")),
    state_login_visible: fs.existsSync(path.join(process.env.HOME, ".grok", "auth.json")),
    tmp: tryWrite("/tmp/fake-grok-probe-" + process.pid + ".txt"),   // inside the jail: its own /tmp tmpfs
    keys: ${KEYS},   // inside the jail the log (under the host /tmp) is hidden: the probe reports the env itself
    argv: argv.filter((a, i) => i !== pi + 1),
  };
  if (process.env.FAKE_CLI_WRITE) probe.extra = tryWrite(path.join(wt, process.env.FAKE_CLI_WRITE));
  const ev = o => process.stdout.write(JSON.stringify(o) + "\n");
  ev({ type: "start", model: argv[argv.indexOf("-m") + 1] });
  if (mode === "chunks" || mode === "nofinal") {
    // An incremental stream (ASSUMED shapes: the Grok CLI's schema is undocumented): tool activity, reasoning chunks,
    // then (chunks) the answer in pieces; nofinal ends on tool activity with no assistant text at all.
    ev({ type: "tool_call", name: "bash", input: { command: "cat README.md" } });
    ev({ type: "tool_result", output: "NOT THE ANSWER" });
    ev({ type: "thinking_delta", delta: "hmm" });
    if (mode === "chunks") for (const piece of ["# Findings (fake grok, ", "chunked)\n\nPROBE ", JSON.stringify(probe), "\n"]) ev({ type: "text_delta", delta: piece });
    ev({ type: "usage", usage: { prompt_tokens: 7, completion_tokens: 3 } });
    process.exit(0);
  }
  if (mode === "native" || mode === "cancelled") {
    // The shapes OBSERVED from grok 1.0.44 (2026-11-19; tests/fixtures/grok-1.0.44-observed-stream.json): narration text,
    // a tool call, then (native) the answer as {"type":"text","data"} chunks and end_turn, or (cancelled) the edit
    // cancelled by the permission profile and stopReason "cancelled" -- with exit 0 either way.
    ev({ type: "text", data: "Next I will write a test." });
    ev({ type: "thought", data: "NOT THE ANSWER" });
    ev({ type: "tool_call", toolCallId: "call-1", title: "search_replace", kind: "edit", status: "pending", toolName: "search_replace", rawInput: {}, content: [], locations: [] });
    if (mode === "cancelled") {
      ev({ type: "tool_call_update", toolCallId: "call-1", status: "failed", content: [{ type: "content", content: { type: "text", text: "User cancelled the execution for tool \`search_replace\`" } }], rawOutput: null, locations: [] });
      ev({ type: "end", stopReason: "cancelled", usage: { input_tokens: 5 }, num_turns: 3 });
      process.exit(0);
    }
    ev({ type: "tool_call_update", toolCallId: "call-1", status: "completed", content: [], rawOutput: null, locations: [] });
    for (const piece of ["# Findings (fake grok, ", "native)\n\nPROBE ", JSON.stringify(probe), "\n"]) ev({ type: "text", data: piece });
    ev({ type: "available_commands", tools: ["read_file"], commands: [] });
    ev({ type: "usage", usage: { input_tokens: 5, output_tokens: 2 } });
    ev({ type: "end", stopReason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 }, num_turns: 3 });
    process.exit(0);
  }
  process.stdout.write("this line is not json\n");
  ev({ type: "message", role: "assistant", content: "thinking..." });
  ev({ type: "result", result: "# Findings (fake grok)\n\nPROBE " + JSON.stringify(probe) + "\n", usage: { prompt_tokens: 7, completion_tokens: 3 } });
  process.exit(0);
}
console.error("fake grok: unknown command"); process.exit(2);
`;

const wrap = body => `#!${process.execPath}\n(() => {\n${body}\n})();\n`;
/** Write the fake CLIs into `dir` (as `codex` and `grok`). Returns their paths. */
export function fakeReviewClis(dir) {
  const codex = join(dir, "codex"), grok = join(dir, "grok");
  writeFileSync(codex, wrap(FAKE_CODEX), { mode: 0o755 });
  writeFileSync(grok, wrap(FAKE_GROK), { mode: 0o755 });
  return { codex, grok };
}

/**
 * A stand-in for @openai/codex-sdk's Codex class (injected as deps.CodexSDK), with the SDK's surface (index.d.ts):
 * new Codex(options), startThread(threadOptions), resumeThread(id, threadOptions), thread.id, thread.runStreamed(input,
 * {signal}) -> {events}. It records every construction and run in Codex.calls (option and env NAMES, never values),
 * and, like the real CLI, keeps a rollout file per thread under $HOME/.codex/sessions. FAKE_CLI_MODE (from options.env):
 *   ok      thread.started, a retry `error` event (non-fatal), a command, the final agent message, turn.completed
 *   partial an agent message and a command with output, then turn.failed and a thrown exit error (a failed run)
 *   fail    a command, then turn.failed "usage limit reached" and the SDK's thrown "Codex Exec exited with code 1"
 *   throw   no event at all: the SDK throws (as for a CLI that refuses an API key under forced_login_method)
 *   hang    waits for the abort signal, then throws its reason (as the SDK does when spawn's signal fires)
 *   deaf    ignores the abort signal and never ends (the runner's backstop)
 */
export function fakeCodexSdk() {
  const calls = [];
  let n = 0;
  class Thread {
    constructor(codex, threadOptions, id) { this._codex = codex; this._t = threadOptions; this._id = id; this._resumed = id; }
    get id() { return this._id; }
    async runStreamed(input, turnOptions = {}) {
      calls.push({ kind: "run", resume_id: this._resumed, thread_options: this._t, input, has_signal: turnOptions.signal instanceof AbortSignal });
      return { events: this._events(input, turnOptions.signal) };
    }
    async *_events(input, signal) {
      const env = this._codex.options.env ?? {}, t = this._t, mode = env.FAKE_CLI_MODE || "ok", dir = t.workingDirectory;
      if (env.FAKE_CLI_PROMPT_FILE) writeFileSync(env.FAKE_CLI_PROMPT_FILE, input);
      const check = env.FAKE_CLI_CHECK ? `CHECK ${env.FAKE_CLI_CHECK} ${existsSync(join(dir, env.FAKE_CLI_CHECK)) ? "present" : "absent"}\n` : "";
      if (mode === "throw") throw new Error("Codex Exec exited with code 1: ChatGPT login is required, but an API key is currently being used. Logging out.");
      this._id ??= `01a1f0fe-0000-7000-8000-${String(++n).padStart(12, "0")}`;
      if (env.HOME) { const d = join(env.HOME, ".codex", "sessions", "2026", "11", "18"); mkdirSync(d, { recursive: true }); writeFileSync(join(d, `rollout-2026-11-18T00-00-00-${this._id}.jsonl`), "{}\n"); }
      yield { type: "thread.started", thread_id: this._id };
      yield { type: "turn.started" };
      if (mode === "hang") { await new Promise((_, rej) => signal.addEventListener("abort", () => rej(signal.reason), { once: true })); return; }
      if (mode === "deaf") { await new Promise(() => {}); return; }
      if (env.FAKE_CLI_WRITE) { const p = join(dir, env.FAKE_CLI_WRITE); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, "x\n"); }
      if (mode === "ok") yield { type: "error", message: "Reconnecting... 1/5 (stream disconnected)" };
      yield { type: "item.completed", item: { id: "i1", type: "command_execution", command: "node --test pantheon/tests/other.test.mjs", aggregated_output: "ok 1", exit_code: 0, status: "completed" } };
      if (mode === "partial") {
        yield { type: "item.completed", item: { id: "i3", type: "agent_message", text: "EARLIER-OWN-MESSAGE: question 1 holds so far" } };
        yield { type: "item.completed", item: { id: "i4", type: "command_execution", command: "node --test .review-tests/mine.test.mjs", aggregated_output: "EARLIER-OWN-OUTPUT ok 1", exit_code: 0, status: "completed" } };
      }
      if (mode === "partial" || mode === "fail") {
        yield { type: "turn.failed", error: { message: "usage limit reached" } };
        throw new Error("Codex Exec exited with code 1: fatal: usage limit reached");
      }
      const text = `# Findings (fake codex)\n\n${check}1. holds\n\nModel: ${t.model}\n`;
      yield { type: "item.completed", item: { id: "i2", type: "agent_message", text } };
      yield { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20 } };
    }
  }
  class Codex {
    constructor(options = {}) {
      this.options = options;
      const envNames = Object.keys(options.env ?? {}).sort();
      calls.push({ kind: "new", option_names: Object.keys(options).sort(), env_names: envNames, env_keylike: envNames.filter(k => /KEY|TOKEN|SECRET/.test(k)),
        codexPathOverride: options.codexPathOverride ?? null, config: options.config ?? null, config_overrides: options.configOverrides ?? null, home: options.env?.HOME ?? null, tmpdir: options.env?.TMPDIR ?? null });
    }
    startThread(threadOptions = {}) { return new Thread(this, threadOptions, null); }
    resumeThread(id, threadOptions = {}) { return new Thread(this, threadOptions, id); }
  }
  Codex.calls = calls;
  return Codex;
}
