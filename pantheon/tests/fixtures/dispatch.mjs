// Fake providers for the REAL dispatcher (runOpenItem), with every request recorded as the provider saw
// it: vendor, model, credential pool and pool configuration. The Antigravity lane is a fake CLI script
// that logs the agent and model it was launched with; the real agy binary and the agy SDK venv are
// unreachable while a fixture is active (PANTHEON_AGY_CLI points at the fake, PANTHEON_AGY_PYTHON at
// nothing, and no Google API key is in the environment). No network is touched.
// `agyQuota([...models])` makes the fake CLI refuse those lane models as Antigravity would a spent quota (a result
// event saying 429 RESOURCE_EXHAUSTED, exit 1); `agyFail([...models])` makes it fail them for another reason;
// `agyQuotaOnce(marker)` refuses for quota the first lane turn whose prompt contains the marker. The fake CLI reports the
// `agyMode("frozen" | "reject")` gives a lane seat the lifecycle's stateless review/revise behaviour. The fake CLI reports the
// same usage as the scripted API clients (USAGE below), so a run's token totals do not depend on which transport answered.
//
// THE PIPELINE'S IMPLEMENTER (pantheon/src/pipeline: a multi-turn worker that writes files itself). When the prompt is
// a work unit's implementer prompt the fake CLI WRITES INTO ITS --add-dir (the unit's worktree): by default
// `export const ok = true;` to the unit's first owned path; `agyWorker(sh)` replaces that with a shell snippet that
// is sourced with $dir (the worktree), $unit, $model, $agent and $prompt set and may set $reply. Every such launch is
// logged to "$FAKE_AGY_LOG.ctx" as: agent, model, --add-dir, and whether PANTHEON_A2A_URL / _TOKEN and a Google API
// key were in its environment (`agyContext()`).
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_AGY = `#!/bin/sh
here=$(cd "$(dirname "$0")" && pwd)
# The quota probe (\`agy -p /quota\`): prints the scripted report next to this script (agyQuotaReport) and exits with
# the scripted code. It is run with a minimal environment, so it reads files, not FAKE_AGY_* variables.
if [ "$1" = "-p" ] && [ "$2" = "/quota" ]; then
  printf 'quota %s\\n' "$#" >> "$here/agy.quota.log"
  [ -f "$here/quota-report.txt" ] && cat "$here/quota-report.txt"
  exit "$(cat "$here/quota-exit" 2>/dev/null || echo 0)"
fi
agent="none"; model="none"; prompt=""; dir="none"; mode="none"; dangerous="no"; sbx="no"
for a in "$@"; do
  case "$prev" in --agent) agent="$a" ;; --model) model="$a" ;; --print) prompt="$a" ;; --add-dir) dir="$a" ;; --mode) mode="$a" ;; esac
  case "$a" in --mode=*) mode="\${a#--mode=}" ;; --dangerously-skip-permissions) dangerous="yes" ;; --sandbox) sbx="yes" ;; esac
  prev="$a"
done
printf '%s %s\\n' "$agent" "$model" >> "$FAKE_AGY_LOG"
case "$prompt" in *"REQUESTED CHANGES"*) printf '%s %s\\n' "$agent" "$model" >> "$FAKE_AGY_LOG.revisions" ;; esac
case " $FAKE_AGY_QUOTA " in *" $model "*)
  printf '{"event":"init","conversation_id":"fake-agy-conversation","init":{"model":"%s","agent":"%s"}}\\n' "$model" "$agent"
  printf '{"event":"result","result":{"status":"ERROR","error":"429 RESOURCE_EXHAUSTED: quota exceeded for %s"}}\\n' "$model"
  exit 1 ;;
esac
if [ -n "$FAKE_AGY_QUOTA_ONCE" ] && [ ! -e "$FAKE_AGY_LOG.once" ]; then case "$prompt" in *"$FAKE_AGY_QUOTA_ONCE"*)
  : > "$FAKE_AGY_LOG.once"
  printf '{"event":"result","result":{"status":"ERROR","error":"429 RESOURCE_EXHAUSTED: quota exceeded for %s"}}\\n' "$model"
  exit 1 ;;
esac; fi
case " $FAKE_AGY_FAIL " in *" $model "*)
  printf '{"event":"result","result":{"status":"ERROR","error":"internal error"}}\\n'
  exit 1 ;;
esac
# More failure switches (space-separated lane models): a SOFT quota phrase (no 429), a hang (the process timeout),
# a print timeout, a stream that ends without a result event, and an unparseable stream.
case " $FAKE_AGY_QUOTA_SOFT " in *" $model "*)
  printf '{"event":"init","conversation_id":"fake-agy-conversation","init":{"model":"%s","agent":"%s"}}\\n' "$model" "$agent"
  printf '{"event":"result","result":{"status":"ERROR","error":"weekly quota reached for this model group"}}\\n'
  printf 'Error: weekly quota reached for this model group\\n' >&2
  exit 1 ;;
esac
case " $FAKE_AGY_HANG " in *" $model "*) sleep 60; exit 0 ;; esac
case " $FAKE_AGY_PRINT_TIMEOUT " in *" $model "*)
  printf '{"event":"init","conversation_id":"fake-agy-conversation","init":{"model":"%s","agent":"%s"}}\\n' "$model" "$agent"
  printf 'Error: print timeout exceeded\\n' >&2
  exit 1 ;;
esac
case " $FAKE_AGY_STREAM " in *" $model "*)
  printf '{"event":"init","conversation_id":"fake-agy-conversation","init":{"model":"%s","agent":"%s"}}\\n' "$model" "$agent"
  exit 0 ;;
esac
case " $FAKE_AGY_GARBLE " in *" $model "*) printf 'not json at all\\n{"event":\\n'; exit 0 ;; esac
case "$agent" in
  pantheon-planner) reply='TITLE: fixture change' ;;
  pantheon-implementer) reply='export const ok = true;' ;;
  pantheon-reviewer) reply='VERDICT: approve' ;;
  *) reply='RAN: nothing' ;;
esac
# A work unit's implementer (the five-stage pipeline): a worker that writes files in its worktree itself.
worker=no
case "$prompt" in *"the single implementer of work unit"*) worker=yes ;; esac
[ "$agent" = "pantheon-unit-worker" ] && worker=yes
if [ "$worker" = yes ]; then
  unit=$(printf '%s\\n' "$prompt" | sed -n 's/.*the single implementer of work unit "\\([^"]*\\)".*/\\1/p' | head -n 1)
  verify=$(printf '%s\\n' "$prompt" | sed -n '/^GROUND TRUTH/{n;p;}' | sed 's/^ *//' | head -n 1)
  printf '%s %s %s a2a_url=%s a2a_token=%s google_key=%s a2a_socket=%s mode=%s cleanup=%s dangerous=%s sandbox=%s\\n' "$agent" "$model" "$dir" "\${PANTHEON_A2A_URL:+yes}" "\${PANTHEON_A2A_TOKEN:+yes}" "\${GEMINI_API_KEY:+yes}\${GOOGLE_API_KEY:+yes}" "\${PANTHEON_A2A_SOCKET:+yes}" "$mode" "\${ANTIGRAVITY_AGY_CLEANUP:-none}" "$dangerous" "$sbx" >> "$FAKE_AGY_LOG.ctx"
  reply='done'
  # The tools of a unit worker, through the same channel the real CLI uses: every write and command FIRST goes through
  # the PreToolUse hooks of ./.agents/hooks.json (a deny is obeyed); ask_subagent goes through ./.agents/mcp_config.json.
  tools="$here/fake-agy-tools.mjs"
  FAKE_AGY_EVENTS=$(mktemp); export FAKE_AGY_EVENTS FAKE_AGY_DIR="$dir" FAKE_AGY_MODEL="$model" FAKE_AGY_VERIFY="$verify" FAKE_AGY_UNIT="$unit"
  agy_write() { node "$tools" write "$1" "$2"; }
  agy_ask() { node "$tools" ask "$1" "$2"; }
  agy_run() { node "$tools" run "$dir" "$1"; }
  agy_verify() { node "$tools" run "$dir" "$verify"; }
  first=$(printf '%s\\n' "$prompt" | sed -n '/^PATHS YOU OWN/,/^Do not commit/p' | sed -n 's/^- //p' | head -n 1)
  if [ -n "$FAKE_AGY_WORKER" ]; then . "$FAKE_AGY_WORKER"
  elif [ "$agent" = "pantheon-unit-worker" ]; then
    agy_write "$first" 'export const ok = true;
' || true
    [ -n "$verify" ] && { agy_verify >/dev/null 2>&1 || true; }
    reply=''
  else
    mkdir -p "$(dirname "$dir/$first")" && printf 'export const ok = true;\\n' > "$dir/$first"
  fi
  if [ "$agent" = "pantheon-unit-worker" ]; then
    FAKE_AGY_REPLY="$reply" node "$tools" finish "$agent"; code=$?
    rm -f "$FAKE_AGY_EVENTS" "$FAKE_AGY_EVENTS.state"
    exit $code
  fi
fi
# FAKE_AGY_MODE (the lifecycle's stateless hooks, ophanim/operate/test-restart-child.mjs, for a lane seat):
#   frozen  the reviewer rejects bytes not marked "// frozen"; the implementer revises when given REQUESTED CHANGES
#   reject  the reviewer always rejects; the implementer revises the same way
case "$FAKE_AGY_MODE:$agent" in
  frozen:pantheon-implementer|reject:pantheon-implementer)
    case "$prompt" in *"REQUESTED CHANGES"*) reply='// frozen: the importer reads it lazily\\nexport const ok = true;' ;; esac ;;
  frozen:pantheon-reviewer)
    case "$prompt" in *"// frozen"*) ;; *) reply='export ok as a frozen constant; a comment must say why\\nVERDICT: request_changes' ;; esac ;;
  reject:pantheon-reviewer) reply='export ok as a frozen constant; a comment must say why\\nVERDICT: request_changes' ;;
esac
printf '{"event":"init","conversation_id":"fake-agy-conversation","init":{"model":"%s","agent":"%s"}}\\n' "$model" "$agent"
printf '{"event":"result","result":{"status":"SUCCESS","conversation_id":"fake-agy-conversation","num_turns":1,"response":"%s","usage":{"input_tokens":1234,"output_tokens":56}}}\\n' "$reply"
`;

// The unit worker's tools for the fake CLI (node; run from the fake's cwd, the unit's control dir). See FAKE_AGY.
//   write <path> <content>   PreToolUse write_to_file {TargetFile} -> write unless denied (exit 3 when denied)
//   run <cwd> <cmd>          PreToolUse run_command {CommandLine, Cwd} -> run unless not approved (exit 126)
//   ask <role> <question>    PreToolUse on the MCP tool, then MCP stdio initialize -> tools/call ask_subagent; prints the answer
//   finish <agent>           prints init, the recorded step events and the result (reply: $FAKE_AGY_REPLY or the JSON summary)
// Approval follows --mode=accept-edits as documented: a hook "deny" blocks; with no hook decision a file edit inside the
// workspace is approved, a command or an MCP tool is not (it would ask, and headless soft-denies).
const FAKE_AGY_TOOLS = String.raw`import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
const [cmd, ...rest] = process.argv.slice(2);
const cwd = process.cwd(), dir = process.env.FAKE_AGY_DIR, events = process.env.FAKE_AGY_EVENTS, model = process.env.FAKE_AGY_MODEL;
const stateFile = events + ".state";
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { step: 0, changed: [], denied: [], verify: null, asked: [] };
const save = () => writeFileSync(stateFile, JSON.stringify(state));
const event = name => appendFileSync(events, JSON.stringify({ event: "step_update", step_update: { step_type: "tool", state: "DONE", tool_name: name } }) + "\n");
const inside = (root, p) => p === root || p.startsWith(root + sep);
function hooksFor(ev, name) {
  const f = join(cwd, ".agents", "hooks.json");
  if (!existsSync(f)) return [];
  const conf = JSON.parse(readFileSync(f, "utf8"));
  return (conf[ev] ?? []).filter(e => e.matcher === name || e.matcher === "*").flatMap(e => e.hooks ?? []).filter(h => h.type === "command");
}
const runHook = (h, input) => new Promise(res => {
  const c = spawn("sh", ["-c", h.command], { stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  const t = setTimeout(() => c.kill("SIGKILL"), (h.timeout ?? 10) * 1000);
  c.stdout.on("data", d => { out += d; });
  c.on("close", () => { clearTimeout(t); try { res(JSON.parse(out.trim().split("\n").pop())); } catch { res(null); } });
  c.stdin.end(JSON.stringify(input));
});
async function gate(name, args, editInWorkspace) {
  const input = { toolCall: { name, args }, stepIdx: ++state.step, conversationId: "fake-agy-conversation", workspacePaths: [cwd, dir], transcriptPath: join(cwd, "transcript.jsonl"), modelName: model };
  const decisions = [];
  for (const h of hooksFor("PreToolUse", name)) decisions.push(await runHook(h, input));
  const d = decisions.filter(Boolean);
  const denied = d.find(x => x.decision === "deny" || x.decision === "deny_unless_prior_grant");
  if (denied) return { ok: false, why: denied.reason ?? "denied by hook", input };
  if (d.some(x => x.decision === "auto_approve" || x.decision === "allow")) return { ok: true, input };
  return editInWorkspace ? { ok: true, input } : { ok: false, why: "needs approval; headless soft-deny", input };
}
async function post(name, input) { for (const h of hooksFor("PostToolUse", name)) await runHook(h, input); }
if (cmd === "write") {
  const [p, content] = rest;
  const abs = isAbsolute(p) ? p : join(dir, p);
  const g = await gate("write_to_file", { TargetFile: abs, CodeContent: content, Overwrite: true }, inside(resolve(dir), resolve(abs)) || inside(cwd, resolve(abs)));
  if (!g.ok) { state.denied.push({ path: abs, why: g.why }); save(); process.stderr.write("write denied: " + g.why + "\n"); process.exit(3); }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  state.changed.push(abs.startsWith(dir + "/") ? abs.slice(dir.length + 1) : abs); save(); event("write_to_file");
  await post("write_to_file", g.input);
} else if (cmd === "run") {
  const [at, line] = rest;
  const g = await gate("run_command", { CommandLine: line, Cwd: at }, false);
  if (!g.ok) { state.denied.push({ command: line, why: g.why }); save(); process.stderr.write("command denied: " + g.why + "\n"); process.exit(126); }
  const code = await new Promise(res => { const c = spawn("sh", ["-c", line], { cwd: at, stdio: ["ignore", 2, 2] }); c.on("close", c2 => res(c2 ?? 1)); });
  if (line.trim() === (process.env.FAKE_AGY_VERIFY ?? "").trim()) state.verify = { cmd: line.trim(), exit_code: code };
  save(); event("run_command");
  process.exit(code);
} else if (cmd === "ask") {
  const [role, question] = rest;
  const name = "pantheon-subagents/ask_subagent";
  const g = await gate(name, { role, question }, false);
  if (!g.ok) { state.denied.push({ tool: name, why: g.why }); save(); process.stderr.write("mcp denied: " + g.why + "\n"); process.exit(3); }
  const conf = JSON.parse(readFileSync(join(cwd, ".agents", "mcp_config.json"), "utf8")).mcpServers?.["pantheon-subagents"];
  if (!conf) { process.stderr.write("no pantheon-subagents MCP server configured\n"); process.exit(4); }
  const srv = spawn(conf.command, conf.args ?? [], { env: { ...process.env, ...(conf.env ?? {}) }, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const waiting = new Map();
  srv.stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); waiting.get(m.id)?.(m); } catch {} } });
  const call = (id, method, params) => new Promise(res => { waiting.set(id, res); srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const init = await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-agy", version: "0" } });
  if (init.error) { process.stderr.write("mcp initialize failed: " + JSON.stringify(init.error) + "\n"); process.exit(4); }
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const r = await call(2, "tools/call", { name: "ask_subagent", arguments: { role, question } });
  srv.stdin.end(); srv.kill();
  const text = (r.result?.content ?? []).filter(c => c.type === "text").map(c => c.text).join("");
  state.asked.push({ role, ok: !r.error && !r.result?.isError }); save(); event(name);
  if (r.error || r.result?.isError) { process.stderr.write("ask_subagent failed: " + (r.error ? JSON.stringify(r.error) : text) + "\n"); process.exit(5); }
  process.stdout.write(text);
} else if (cmd === "finish") {
  const [agent] = rest;
  const reply = process.env.FAKE_AGY_REPLY || JSON.stringify({ unit_id: process.env.FAKE_AGY_UNIT ?? null, status: state.verify?.exit_code === 0 ? "done" : "stuck",
    changed_paths: state.changed, verify: state.verify ?? { cmd: process.env.FAKE_AGY_VERIFY || null, exit_code: null }, notes: state.denied.length ? state.denied.length + " tool call(s) denied" : "" });
  process.stdout.write(JSON.stringify({ event: "init", conversation_id: "fake-agy-conversation", init: { model, agent } }) + "\n");
  if (existsSync(events)) process.stdout.write(readFileSync(events, "utf8"));
  process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", conversation_id: "fake-agy-conversation", num_turns: 1 + state.step, response: reply, usage: { input_tokens: 1234, output_tokens: 56 } } }) + "\n");
}
`;

/** Write the fake Antigravity CLI into `dir` and return its path (for a fixture that is not withDispatch). It logs to $FAKE_AGY_LOG. */
export function fakeAgy(dir) {
  const path = join(dir, "fake-agy");
  writeFileSync(path, FAKE_AGY, { mode: 0o755 });
  writeFileSync(join(dir, "fake-agy-tools.mjs"), FAKE_AGY_TOOLS);
  return path;
}

// The switches every fixture saves, clears and restores. PANTHEON_AGY_STATE_DIRS is set to the fixture dir: the unit
// worker runs inside the bwrap jail, where only the worktree, the control dir's run/ and the agy state dirs are
// writable, and the fake CLI writes its logs ($FAKE_AGY_LOG*) in the fixture dir.
const AGY_SWITCHES = ["FAKE_AGY_QUOTA", "FAKE_AGY_FAIL", "FAKE_AGY_QUOTA_ONCE", "FAKE_AGY_MODE", "FAKE_AGY_WORKER",
  "FAKE_AGY_QUOTA_SOFT", "FAKE_AGY_HANG", "FAKE_AGY_PRINT_TIMEOUT", "FAKE_AGY_STREAM", "FAKE_AGY_GARBLE"];
/** The worker-turn controls a fixture hands its test (see FAKE_AGY): failure switches and the scripted /quota report. */
function workerControls(dir) {
  const set = k => models => { process.env[k] = models.join(" "); };
  return {
    agyQuotaSoft: set("FAKE_AGY_QUOTA_SOFT"), agyHang: set("FAKE_AGY_HANG"), agyPrintTimeout: set("FAKE_AGY_PRINT_TIMEOUT"),
    agyStream: set("FAKE_AGY_STREAM"), agyGarble: set("FAKE_AGY_GARBLE"),
    /** What `agy -p /quota` prints (null: nothing) and its exit code. */
    agyQuotaReport: (text, exit = 0) => { if (text == null) rmSync(join(dir, "quota-report.txt"), { force: true }); else writeFileSync(join(dir, "quota-report.txt"), text); writeFileSync(join(dir, "quota-exit"), String(exit)); },
    /** How many times the quota probe ran. */
    agyQuotaProbes: () => existsSync(join(dir, "agy.quota.log")) ? readFileSync(join(dir, "agy.quota.log"), "utf8").split("\n").filter(Boolean).length : 0,
  };
}

/**
 * Run `fn` with the fake Antigravity CLI installed in `dir` (for a test with its own scripted API clients): a Google
 * seat goes through its lane first, so a run that reaches one needs the CLI. `fn` gets `agy()`, the lane turns so far.
 */
export async function withFakeAgy(dir, fn) {
  const keys = ["PANTHEON_AGY_CLI", "FAKE_AGY_LOG", "PANTHEON_AGY_STATE_DIRS", ...AGY_SWITCHES];
  const before = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const log = join(dir, "agy.log");
  Object.assign(process.env, { PANTHEON_AGY_CLI: fakeAgy(dir), FAKE_AGY_LOG: log, PANTHEON_AGY_STATE_DIRS: dir });
  for (const k of AGY_SWITCHES) delete process.env[k];
  const agy = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map(l => { const [agent, model] = l.split(" "); return { agent, model }; }) : [];
  try { return await fn({ agy, agyContext: () => contextOf(log), agyWorker: sh => setWorker(dir, sh), ...workerControls(dir),
    agyQuota: models => { process.env.FAKE_AGY_QUOTA = models.join(" "); }, agyFail: models => { process.env.FAKE_AGY_FAIL = models.join(" "); } }); }
  finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

/**
 * The fake CLI's launches as it saw them: [{agent, model, dir (its --add-dir), a2a_url, a2a_token, google_key,
 * a2a_socket, mode (--mode), cleanup ($ANTIGRAVITY_AGY_CLEANUP), dangerous (--dangerously-skip-permissions), sandbox (--sandbox)}].
 */
function contextOf(log) {
  const file = `${log}.ctx`;
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => {
    const [agent, model, dir, ...flags] = l.split(" ");
    const flag = k => flags.includes(`${k}=yes`) || flags.includes(`${k}=yesyes`);
    const value = k => flags.find(f => f.startsWith(`${k}=`))?.slice(k.length + 1) ?? null;
    return { agent, model, dir, a2a_url: flag("a2a_url"), a2a_token: flag("a2a_token"), google_key: flag("google_key"),
      a2a_socket: flag("a2a_socket"), mode: value("mode"), cleanup: value("cleanup"), dangerous: flag("dangerous"), sandbox: flag("sandbox") };
  });
}
/** Install a shell snippet as the pipeline implementer's behaviour (see the header); null restores the default. */
function setWorker(dir, sh) {
  if (sh == null) { delete process.env.FAKE_AGY_WORKER; return; }
  const file = join(dir, "fake-agy-worker.sh");
  writeFileSync(file, sh);
  process.env.FAKE_AGY_WORKER = file;
}

export const WORK = /Output ONLY the complete new contents of/;

export async function withDispatch(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pantheon-dispatch-"));
  const keys = ["PANTHEON_COOLDOWN_DIR", "PANTHEON_AGY_CLI", "PANTHEON_AGY_PYTHON", "PANTHEON_AGY_TRANSPORT", "FAKE_AGY_LOG",
    "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPHANIM_LEDGER", "PANTHEON_POOLS_FILE", "PANTHEON_AGY_STATE_DIRS", ...AGY_SWITCHES];
  const before = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const agyLog = join(dir, "agy.log");
  fakeAgy(dir);
  Object.assign(process.env, { PANTHEON_COOLDOWN_DIR: join(dir, "cooldowns"), PANTHEON_AGY_CLI: join(dir, "fake-agy"),
    PANTHEON_AGY_PYTHON: "/nonexistent/no-agy-sdk-in-tests", FAKE_AGY_LOG: agyLog, PANTHEON_AGY_STATE_DIRS: dir });
  for (const k of ["PANTHEON_AGY_TRANSPORT", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPHANIM_LEDGER", "PANTHEON_POOLS_FILE", ...AGY_SWITCHES]) delete process.env[k];
  const calls = [];
  let implement = () => "export const ok = true;\n";
  let fault = () => null;
  let review = () => null;
  let served = () => null;
  const makeClientFor = scriptedClients(calls, prompt => implement(prompt), call => fault(call), call => review(call), (vendor, model) => served(vendor, model));
  let n = 0;
  const lines = file => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => { const [agent, model] = l.split(" "); return { agent, model }; }) : [];
  const agy = () => lines(agyLog);
  // The lane turns whose prompt carried REQUESTED CHANGES (a reviewer's findings given to the worker).
  const agyRevisions = () => lines(`${agyLog}.revisions`);
  const spec = (key, extra = {}) => ({ key, repo_root: dir, title: "fixture", goal: "fixture goal", question: "q", copy: [],
    acceptance_cmd: "true", slot: "code", path: "code.mjs", ...extra });
  try {
    return await fn({ dir, calls, agy, agyRevisions, makeClientFor, spec, implement: f => { implement = f; }, fault: f => { fault = f; }, review: f => { review = f; }, serve: f => { served = f; },
      agyQuota: models => { process.env.FAKE_AGY_QUOTA = models.join(" "); }, agyFail: models => { process.env.FAKE_AGY_FAIL = models.join(" "); },
      agyQuotaOnce: marker => { process.env.FAKE_AGY_QUOTA_ONCE = marker; }, agyMode: mode => { process.env.FAKE_AGY_MODE = mode; },
      agyContext: () => contextOf(agyLog), agyWorker: sh => setWorker(dir, sh), ...workerControls(dir),
      opts: (extra = {}) => ({ dir: join(dir, `board-${++n}`), makeClientFor, scouts: ["xai"], ...extra }) });
  } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true });
  }
}

// What every scripted provider reports it used, in its own surface's shape (Responses and Messages
// `usage`, Google `usageMetadata`). A Messages stream reports input on message_start and output on
// message_delta, as the provider does.
export const USAGE = { input_tokens: 1234, output_tokens: 56 };
const GOOGLE_USAGE = { promptTokenCount: 1234, candidatesTokenCount: 56, totalTokenCount: 1290 };

/**
 * makeClientFor(vendor, {pool, poolConfig}) over the three streaming surfaces, recording each request.
 * `fault({vendor, model, pool, prompt})` may refuse a request: `{ error }` throws it before any output
 * (the request is recorded with `failed: true`), and `{ incomplete: true }` ends the stream truncated
 * (with usage). Returning null serves the request normally. `review({vendor, model, pool, prompt})` may
 * answer a reviewer's prompt itself (a reply text); returning null keeps the default verdict.
 */
// `served(vendor, model)` names the model a scripted provider REPORTS as having answered (the adapter reads it from the
// stream, as from a live provider): by default none is reported, as before; a test of answer admission passes one.
export function scriptedClients(calls = [], implement = () => "export const ok = true;\n", fault = () => null, review = () => null, served = () => null) {
  let n = 0;
  const answer = (prompt, who = {}) => {
    if (/VERDICT/i.test(prompt)) return review({ ...who, prompt }) ?? (/exited 1\b/.test(prompt) ? "VERDICT: request_changes" : "VERDICT: approve");
    if (/TITLE:/i.test(prompt)) return "TITLE: fixture change";
    if (/RAN: nothing/i.test(prompt)) return "RAN: nothing";
    return implement(prompt);
  };
  const makeClientFor = (vendor, { pool = null, poolConfig = null } = {}) => {
    const note = (req, prompt) => {
      const row = { vendor, model: req.model, pool, poolConfig, prompt, effort: req.reasoning?.effort ?? req.output_config?.effort ?? req.config?.thinkingConfig?.thinkingLevel?.toLowerCase() ?? null,
        max_output_tokens: req.max_output_tokens ?? req.max_tokens ?? req.config?.maxOutputTokens ?? null };
      const f = fault({ vendor, model: req.model, pool, prompt });
      if (f?.error) { calls.push({ ...row, failed: true }); throw f.error; }
      calls.push(f?.incomplete ? { ...row, incomplete: true } : row);
      return { text: answer(prompt, { vendor, model: req.model, pool }), incomplete: Boolean(f?.incomplete) };
    };
    return {
      responses: { inputTokens: { count: async () => ({ input_tokens: 1000 }) }, create: async req => {
        const { text, incomplete } = note(req, typeof req.input === "string" ? req.input : req.input?.at(-1)?.content ?? ""), id = `fixture_${++n}`;
        return { async *[Symbol.asyncIterator]() {
          const m = served(vendor, req.model);
          yield { type: "response.created", response: { id, ...(m ? { model: m } : {}) } };
          yield { type: "response.output_text.delta", delta: text };
          if (incomplete) {
            yield { type: "response.incomplete", response: { id, status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage: { ...USAGE } } };
            return;
          }
          yield { type: "response.completed", response: { id, status: "completed", output_text: text, output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { ...USAGE } } };
        } };
      } },
      messages: { create: async req => {
        const last = req.messages?.at(-1)?.content;
        const { text, incomplete } = note(req, typeof last === "string" ? last : (last ?? []).map(p => p.text ?? "").join(""));
        return { async *[Symbol.asyncIterator]() {
          const m = served(vendor, req.model);
          yield { type: "message_start", message: { ...(m ? { model: m } : {}), usage: { input_tokens: USAGE.input_tokens, output_tokens: 1 } } };
          yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
          yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
          yield { type: "message_delta", delta: { stop_reason: incomplete ? "max_tokens" : "end_turn" }, usage: { output_tokens: USAGE.output_tokens } };
          yield { type: "message_stop" };
        } };
      } },
      models: { countTokens: async () => ({ totalTokens: 1000 }), generateContentStream: async req => {
        const { text, incomplete } = note(req, (req.contents?.at?.(-1)?.parts ?? []).map(p => p.text ?? "").join("") || String(req.contents ?? ""));
        return { async *[Symbol.asyncIterator]() {
          const m = served(vendor, req.model);
          yield { ...(m ? { modelVersion: m } : {}), candidates: [{ finishReason: incomplete ? "MAX_TOKENS" : "STOP", content: { parts: [{ text }] } }], usageMetadata: { ...GOOGLE_USAGE } };
        } };
      } },
    };
  };
  // What answered, as a run records it (run.json `providers`): fakes, so every fixture run is synthetic evidence.
  makeClientFor.providers = { kind: "fake", fixture: "pantheon/tests/fixtures/dispatch.mjs scriptedClients" };
  return makeClientFor;
}

export const seat = (vendor, model, extra = {}) => ({ vendor, model, pool: vendor, rank: 0, basis: "OPERATOR", why: "offline fixture", ...extra });
