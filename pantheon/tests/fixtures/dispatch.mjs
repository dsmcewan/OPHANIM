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
//
// THE GOOGLE IMPLEMENTER OF THE PIPELINE IS AN ANTIGRAVITY SDK SESSION (owner direction 2026-11-19; src/antigravity).
// While a fixture is active the REAL transport runs it -- its model gateway, its subagent governor, its tool decisions
// and its jail -- against two scripted ends:
//   the session   PANTHEON_ANTIGRAVITY_PYTHON points at a launcher (written here) that runs FAKE_SDK_SESSION in place of
//                 the SDK's bridge: a thin relay that speaks the bridge's protocol, sends the unit prompt to the
//                 provider through the controller's gateway, and does what the scripted provider answers.
//   the provider  requests to generativelanguage.googleapis.com are answered IN THIS PROCESS (globalThis.fetch is
//                 wrapped while the fixture is active; every other URL goes to the real fetch). A session's first
//                 request RUNS THE WORKER as the model's work: `agyWorker(sh)` as before (sourced with $dir, $unit,
//                 $model, $effort (the session's thinking level, "" when none), $prompt), else `export const ok = true;`
//                 to the unit's first owned path. The worker asks for a
//                 native subagent with `sdk_subagent <type> "<assignment>"`; the relay then puts each request to the
//                 controller (invoke_subagent), and an admitted one makes its own request on the subagent model.
// The switches are the lane's, by MODEL name: agyQuota (HTTP 429 RESOURCE_EXHAUSTED), agyFail (HTTP 500), agyQuotaOnce,
// agyHang; `sdkUnavailable([...models])` makes the provider answer 404 for those models; `serve(f)` names the model
// that answered. `sdk()` lists what the provider saw: [{agent: "sdk-implementer" | "sdk-subagent:<type>", model, unit}].
// GEMINI_API_KEY is a synthetic value held by this process (the controller); it is never given to a worker.
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The worker's env is an ALLOWLIST (src/board/agy-cli.mjs workerEnv; independent review round 2, assignment 4, question
// 7): the fake CLI's own switches (FAKE_*) reach it only because the operator variable lists them.
process.env.PANTHEON_AGY_ENV_PASS ??= "FAKE_*";

/** What agy 1.5.10 printed on stderr when `agy agents` / `agy mcp list` got --log-file (observed, owner's probe of 5893432, 2026-11-18). */
export const AGY_1_5_10_BAD_FLAG_STDERR = Object.freeze({
  agents: "Usage: agy agent [flags]\n\nList available agents\n\nFlags:\n  -h      Show help\n  --help  Show help\nError: flags provided but not defined: -log-file\n",
  mcp_list: "Usage: agy mcp list [flags]\n\nList all configured MCP servers\n\nFlags:\n  -h      Show help\n  --help  Show help\nError: flags provided but not defined: -log-file\n",
});
/** The fake credential the fake `agy mcp list` prints (as the real one printed a global server's credential): it must never reach a record. */
export const FAKE_MCP_CREDENTIAL = "ctx7sk-FAKE-CREDENTIAL-do-not-store-7f3a9c";

const FAKE_AGY = `#!/bin/sh
here=$(cd "$(dirname "$0")" && pwd)
# The quota probe (\`agy -p /quota\`): prints the scripted report next to this script (agyQuotaReport) and exits with
# the scripted code. It is run with a minimal environment, so it reads files, not FAKE_AGY_* variables.
# Also the structured form the probe uses (\`agy --print /usage --output-format json\`, as observed on agy 1.5.10): a
# scripted report that is itself the JSON envelope is printed as is; a text report is wrapped in one.
if { [ "$1" = "-p" ] || [ "$1" = "--print" ]; } && { [ "$2" = "/quota" ] || [ "$2" = "/usage" ]; }; then
  { printf 'quota %s\\n' "$#" >> "$here/agy.quota.log"; } 2>/dev/null   # silent when the fixture dir is read-only (inside a jail)
  # Logged out (FAKE_AGY_NOT_LOGGED_IN=1, or FAKE_AGY_AUTH_MARKER naming a file absent under antigravity-cli/; see the
  # tools script, "sub"): the /usage envelope has no groups and stderr says so (the observed "Auth mode is unspecified"
  # line). Logged in, /usage succeeds whatever the subcommands print (observed on agy 1.5.10: they print the
  # not-logged-in lines in every layout).
  if [ "$FAKE_AGY_NOT_LOGGED_IN" = 1 ] || { [ -n "$FAKE_AGY_AUTH_MARKER" ] && [ ! -e "$HOME/.gemini/antigravity-cli/$FAKE_AGY_AUTH_MARKER" ]; }; then
    echo "W1118 00:00:00.000000 $$ models.go:9] Auth mode is unspecified, skipping fetchAvailableModels and returning empty response" >&2
    printf '{"conversation_id":"","status":"SUCCESS","response":"","num_turns":0,"usage":{"total_tokens":0},"command":{"name":"usage","data":{"groups":[]}}}\\n'
    exit 0
  fi
  if [ "$3" = "--output-format" ] && [ "$4" = "json" ] && [ -f "$here/quota-report.txt" ]; then
    if head -c 1 "$here/quota-report.txt" | grep -q '{'; then cat "$here/quota-report.txt"
    else node -e 'const t=require("fs").readFileSync(process.argv[1],"utf8");process.stdout.write(JSON.stringify({conversation_id:"",status:"SUCCESS",response:t,num_turns:0,usage:{total_tokens:0},command:{name:"usage"}}))' "$here/quota-report.txt"; fi
  else [ -f "$here/quota-report.txt" ] && cat "$here/quota-report.txt"; fi
  exit "$(cat "$here/quota-exit" 2>/dev/null || echo 0)"
fi
# \`agy --version\`: no model, not logged as a launch.
if [ "$1" = "--version" ]; then echo "fake-agy 0.0.0-fixture"; exit 0; fi
# \`agy agents\` and \`agy mcp list\` (the worker's zero-spend preflight): no model, not logged as a launch; logged to
# "$FAKE_AGY_LOG.sub" instead. See the tools script ("sub").
if [ "$1" = agents ] || { [ "$1" = mcp ] && [ "$2" = list ]; }; then
  { printf '%s\\n' "$*" >> "\${FAKE_AGY_LOG:-/dev/null}.sub"; } 2>/dev/null
  exec node "$here/fake-agy-tools.mjs" sub "$@"
fi
agent="none"; model="none"; prompt=""; dir="none"; mode="none"; dangerous="no"; sbx="no"; logfile=""; ptimeout="none"; conv=""
for a in "$@"; do
  case "$prev" in --conversation) conv="$a" ;; --agent) agent="$a" ;; --model) model="$a" ;; --print) prompt="$a" ;; --add-dir) dir="$a" ;; --mode) mode="$a" ;; --log-file) logfile="$a" ;; --print-timeout) ptimeout="$a" ;; esac
  case "$a" in --mode=*) mode="\${a#--mode=}" ;; --dangerously-skip-permissions) dangerous="yes" ;; --sandbox) sbx="yes" ;; --log-file=*) logfile="\${a#--log-file=}" ;; esac
  prev="$a"
done
# --log-file (owner-stated): the CLI's own log. The fake writes a line there (inside bwrap it must be writable).
if [ -n "$logfile" ]; then printf 'fake-agy start agent=%s model=%s add_dir=%s cwd=%s\\n' "$agent" "$model" "$dir" "$(pwd)" >> "$logfile" || echo "fake-agy: cannot write --log-file $logfile" >&2; fi
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
# The review runner's reviewer (src/review-runner/agy.mjs) is jailed exactly like a unit worker.
jailed=no; { [ "$agent" = "pantheon-unit-worker" ] || [ "$agent" = "pantheon-reviewer-agent" ]; } && jailed=yes
[ "$jailed" = yes ] && worker=yes
if [ "$worker" = yes ]; then
  unit=$(printf '%s\\n' "$prompt" | sed -n 's/.*the single implementer of work unit "\\([^"]*\\)".*/\\1/p' | head -n 1)
  verify=$(printf '%s\\n' "$prompt" | sed -n '/^GROUND TRUTH/{n;p;}' | sed 's/^ *//' | head -n 1)
  # The worker's ONE command (the prompt's VERIFY COMMAND section: \`cd '<worktree>' && <verify_cmd>\`); a prompt without
  # one (an older caller) falls back to the plain ground-truth command.
  wverify=$(printf '%s\\n' "$prompt" | sed -n '/^VERIFY COMMAND/{n;p;}' | sed 's/^ *//' | head -n 1)
  [ -n "$wverify" ] || wverify="$verify"
  printf '%s %s %s a2a_url=%s a2a_token=%s google_key=%s a2a_socket=%s mode=%s cleanup=%s dangerous=%s sandbox=%s log_file=%s\\n' "$agent" "$model" "$dir" "\${PANTHEON_A2A_URL:+yes}" "\${PANTHEON_A2A_TOKEN:+yes}" "\${GEMINI_API_KEY:+yes}\${GOOGLE_API_KEY:+yes}" "\${PANTHEON_A2A_SOCKET:+yes}" "$mode" "\${ANTIGRAVITY_AGY_CLEANUP:-none}" "$dangerous" "$sbx" "\${logfile:-none}" >> "$FAKE_AGY_LOG.ctx"
  # Owner-stated: --dangerously-skip-permissions skips the hooks, and --sandbox must never be passed inside bwrap. A
  # unit worker launched with either is a bug: the fake refuses to run it.
  if [ "$jailed" = yes ] && { [ "$dangerous" = yes ] || [ "$sbx" = yes ]; }; then
    echo "fake-agy: refusing a unit worker launched with --dangerously-skip-permissions or --sandbox" >&2; exit 64
  fi
  # The --print session's own diagnostics, as the CLI does (observed on agy 1.5.10 for its subcommands): to
  # $HOME/.gemini/antigravity-cli/log/cli-<n>.log when that dir is writable, else to stderr (only when the CLI's state
  # dir exists: a test without a fake ~/.gemini sees nothing). The hooks line counts ./.agents/hooks.json of the cwd;
  # the workspaceDirs line names the cwd and the --add-dir. They are NOT written to --log-file.
  if [ "$jailed" = yes ]; then
    cl="$HOME/.gemini/antigravity-cli/log"; nh=0; [ -f "$(pwd)/.agents/hooks.json" ] && nh=1
    diag=$(printf 'I1118 00:00:00.000000 %s hooks_manager.go:54] loaded %s named hooks from %s hooks.json file(s)\nI1118 00:00:00.000000 %s workspace.go:12] workspaceDirs=[%s %s]' "$$" "$nh" "$nh" "$$" "$(pwd)" "$dir")
    if [ -d "$cl" ] && [ -w "$cl" ]; then printf '%s\n' "$diag" >> "$cl/cli-$$.log"
    elif [ -d "$HOME/.gemini/antigravity-cli" ]; then printf '%s\n' "$diag" >&2; fi
  fi
  # FAKE_AGY_GEMINI_WRITES=1: behave like the CLI with its state under $HOME/.gemini/antigravity-cli, as OBSERVED on
  # agy 1.5.10 (owner's probe 2026-11-18): it reads its settings, then writes conversations/<id>.db, brain/<id>/,
  # presence/<id>.lock, cache/last_conversations.json (via a .tmp), implicit/<uuid>.<uuid>.tmp, mcp/pantheon-subagents/
  # and a top-level jetbox_summaries_proto.pb.<rand>.tmp. When any of those writes fails (the old layout, which left
  # antigravity-cli/ read-only) it logs "read-only file system" lines, writes a crash log (which fails too), and ends
  # as that probe did: no turn, a print-timeout result, exit 3. =refresh also tries what an OAuth refresh would do,
  # rewriting ~/.gemini/oauth_creds.json and settings.json (read-only inside the jail: the failure goes to stderr).
  if [ "$FAKE_AGY_GEMINI_WRITES" = 1 ] || [ "$FAKE_AGY_GEMINI_WRITES" = refresh ]; then
    g="$HOME/.gemini"; s="$g/antigravity-cli"; cid="fake-agy-conversation"; rnd="$$"; erofs=0
    flog() { { printf '%s\\n' "$1" >> "\${logfile:-/dev/null}"; } 2>/dev/null; printf '%s\\n' "$1" >&2; }
    swrite() {
      { mkdir -p "$(dirname "$1")" && printf '%s\\n' "$2" > "$1"; } 2>/dev/null && return 0
      erofs=$((erofs + 1)); flog "E1118 00:00:00.000000 $rnd state.go:1] $3: open $1: read-only file system"; return 1
    }
    for f in "$g/oauth_creds.json" "$g/settings.json" "$s/settings.json"; do
      [ -f "$f" ] && { cat "$f" > /dev/null 2>&1 && echo "fake-agy: read $f" >> "\${logfile:-/dev/null}" || echo "fake-agy: cannot read $f" >&2; }
    done
    swrite "$s/conversations/$cid.db" conversation "failed to create persistent trajectory in store 1: pre-create trajectory db file"
    swrite "$s/brain/$cid/task.md" brain "mkdir brain/$cid"
    swrite "$s/presence/$cid.lock" "$rnd" "presence lock"
    swrite "$s/cache/last_conversations.json.$rnd.tmp" '[]' "cache" && mv "$s/cache/last_conversations.json.$rnd.tmp" "$s/cache/last_conversations.json"
    swrite "$s/implicit/$rnd.$rnd.tmp" '{}' "implicit"
    swrite "$s/mcp/pantheon-subagents/state.json" '{}' "Failed to write server states, eagerly loading all tools"
    swrite "$s/jetbox_summaries_proto.pb.$rnd.tmp" 'jetbox' "jetbox summaries"
    if [ "$erofs" -gt 0 ]; then
      swrite "$s/crashes/crash_$rnd.log" "crash: $erofs state write(s) failed" "crash log"
      printf '{"event":"init","conversation_id":"%s","init":{"model":"%s","agent":"%s"}}\\n' "$cid" "$model" "$agent"
      printf '{"event":"result","result":{"status":"ERROR","num_turns":0,"usage":{"total_tokens":0},"error":"print timeout after %s with the turn still in progress"}}\\n' "$ptimeout"
      printf 'Error: print timeout after %s with the turn still in progress\\n' "$ptimeout" >&2
      exit 3
    fi
    if [ "$FAKE_AGY_GEMINI_WRITES" = refresh ]; then
      { printf '{}' >> "$g/oauth_creds.json"; } 2>/dev/null || echo "fake-agy: $g/oauth_creds.json refresh write failed: EROFS (read-only file system)" >&2
      { printf '{}' > "$g/settings.json"; } 2>/dev/null || echo "fake-agy: $g/settings.json write failed: EROFS (read-only file system)" >&2
    fi
  fi
  reply='done'
  # The tools of a unit worker, through the same channel the real CLI uses: every write and command FIRST goes through
  # the PreToolUse hooks of ./.agents/hooks.json (a deny is obeyed); ask_subagent goes through ./.agents/mcp_config.json.
  tools="$here/fake-agy-tools.mjs"
  FAKE_AGY_EVENTS=$(mktemp); export FAKE_AGY_EVENTS FAKE_AGY_DIR="$dir" FAKE_AGY_MODEL="$model" FAKE_AGY_VERIFY="$wverify" FAKE_AGY_UNIT="$unit"
  agy_write() { node "$tools" write "$1" "$2"; }
  agy_ask() { node "$tools" ask "$1" "$2"; }
  agy_mcp() { node "$tools" mcp "$1" "$2" "\${3:-pantheon-subagents}" "\${4:-ask_subagent}"; }
  agy_invoke_subagent() { node "$tools" invoke "\${1:-helper}"; }
  agy_read() { node "$tools" read "$1"; }
  agy_run() { node "$tools" run "$dir" "$1"; }
  agy_verify() { node "$tools" run "$dir" "$wverify"; }
  first=$(printf '%s\\n' "$prompt" | sed -n '/^PATHS YOU OWN/,/^Do not commit/p' | sed -n 's/^- //p' | head -n 1)
  [ "$agent" = "pantheon-reviewer-agent" ] && reply="\${FAKE_AGY_REVIEW_REPLY:-# Findings (fake agy reviewer)}"
  if [ -n "$FAKE_AGY_WORKER" ]; then . "$FAKE_AGY_WORKER"
  elif [ "$agent" = "pantheon-reviewer-agent" ]; then :
  elif [ "$agent" = "pantheon-unit-worker" ]; then
    agy_write "$first" 'export const ok = true;
' || true
    [ -n "$wverify" ] && { agy_verify >/dev/null 2>&1 || true; }
    reply=''
  else
    mkdir -p "$(dirname "$dir/$first")" && printf 'export const ok = true;\\n' > "$dir/$first"
  fi
  if [ "$jailed" = yes ]; then
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
//   write <path> <content>        PreToolUse write_file {Path, Content} (as OBSERVED on agy 1.5.10, 2026-11-18; the
//                                 older write_to_file {TargetFile, CodeContent, Overwrite} with FAKE_AGY_WRITE_TOOL=write_to_file)
//                                 -> write unless denied (exit 3 when denied)
//   run <ignored> <cmd>           PreToolUse run_command {CommandLine, WaitMsBeforeAsync, toolSummary} -- NO Cwd, as
//                                 observed -- run in the CLI's cwd (the control dir) unless not approved (exit 126). Like
//                                 the real CLI it first writes its helper ~/.gemini/antigravity-cli/bin/agentapi (when
//                                 ~/.gemini/antigravity-cli exists): a read-only bin/ fails the step with the observed
//                                 "failed to write agentapi script: ... read-only file system" ERROR (exit 126)
//   ask <role> <question>         the DIRECT (eager) MCP call: PreToolUse on $FAKE_AGY_MCP_NAME (default, as observed:
//                                 mcp_pantheon-subagents_ask_subagent) {question, role, toolSummary}; available only when mcp_config.json
//                                 marks the tool eager (owner-stated: lazy by default); then MCP stdio tools/call
//   mcp <role> <question> [server] [tool]
//                                 the LAZY form: PreToolUse call_mcp_tool {ServerName, ToolName, Arguments: {role, question}}
//   invoke [name]                 PreToolUse invoke_subagent (a native subagent; the jail must deny it)
//   read <path>                   PreToolUse view_file {AbsolutePath}
//   finish <agent>                prints init, the recorded step events and the result (reply: $FAKE_AGY_REPLY or the JSON summary)
// HOOK SEMANTICS EMULATED (owner-stated 2026-11-18): hooks.json is a top-level hook name -> {PreToolUse: [{matcher
// (a regex), hooks: [{type, command, timeout}]}]} (the older {PreToolUse: [...]} shape with exact/"*" matchers is
// still read); a hook command runs with cwd = .agents/; its EXIT CODE IS IGNORED; an EMPTY stdout ALLOWS; `{}` (or
// anything without a decision) DENIES; "deny" blocks; --mode=accept-edits headless soft-denies Ask-tier tools
// (run_command, MCP, call_mcp_tool, invoke_subagent) unless a hook said "auto_approve"; a file edit inside the
// workspace and a read run on "allow" / empty / no hook.
// TOOL STEPS EMULATED (observed on agy 1.5.10, 2026-11-18): every call emits a step ACTIVE, then DONE or ERROR; a
// hook deny is ERROR with tool_info.error {type: "TOOL_ERROR", message: "tool call denied by pre-tool hook: <reason>"}.
// The hook stdin is the observed shape {stepIdx, modelName, toolCall: {args, id, name}}.
const FAKE_AGY_TOOLS = String.raw`import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
const [cmd, ...rest] = process.argv.slice(2);
// Observed on agy 1.5.10 (owner's probe 2026-11-18): call_mcp_tool is not in the tool registry; grep_search, list_dir
// and multi_replace_file_content are deprecated.
const BAD_TOOLS = ["call_mcp_tool", "grep_search", "list_dir", "multi_replace_file_content"], DEPRECATED_TOOLS = ["grep_search", "list_dir", "multi_replace_file_content"];
const cwd = process.cwd(), dir = process.env.FAKE_AGY_DIR, events = process.env.FAKE_AGY_EVENTS, model = process.env.FAKE_AGY_MODEL;
const stateFile = events + ".state";
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { step: 0, changed: [], denied: [], verify: null, asked: [], hooks: [] };
const save = () => writeFileSync(stateFile, JSON.stringify(state));
const event = (name, st, info) => appendFileSync(events, JSON.stringify({ event: "step_update", step_update: { step_type: "tool", state: st, tool_name: name, tool_info: info ?? null } }) + "\n");
const toolError = message => ({ error: { type: "TOOL_ERROR", message } });
const inside = (root, p) => p === root || p.startsWith(root + sep);
const agentsDir = join(cwd, ".agents");
function hooksFor(ev, name) {
  const f = join(agentsDir, "hooks.json");
  if (!existsSync(f)) return [];
  const buf = readFileSync(f);
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) { process.stderr.write("fake-agy: hooks.json starts with a UTF-8 BOM; ignored\n"); return []; }
  const conf = JSON.parse(buf.toString("utf8"));
  const groups = Array.isArray(conf[ev]) ? conf[ev].map(g => ({ ...g, old: true }))
    : Object.values(conf).filter(v => v && typeof v === "object" && Array.isArray(v[ev])).flatMap(v => v[ev]);
  const hit = g => g.matcher === "*" || (g.old ? g.matcher === name : (() => { try { return new RegExp("^(?:" + g.matcher + ")$").test(name); } catch { return false; } })());
  return groups.filter(hit).flatMap(g => g.hooks ?? []).filter(h => h.type === "command");
}
const runHook = (h, input) => new Promise(res => {
  const c = spawn("sh", ["-c", h.command], { cwd: agentsDir, stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  const t = setTimeout(() => c.kill("SIGKILL"), (h.timeout ?? 10) * 1000);
  c.stdout.on("data", d => { out += d; });
  c.on("close", code => {
    clearTimeout(t);
    const text = out.trim();
    if (!text) return res({ decision: "allow", empty: true, exit: code });                      // empty stdout ALLOWS
    let v = null;
    try { v = JSON.parse(text.split("\n").pop()); } catch { /* not JSON */ }
    if (v && typeof v === "object" && typeof v.decision === "string") return res({ ...v, exit: code });
    res({ decision: "deny", reason: "hook printed " + JSON.stringify(text.slice(0, 80)) + " (no decision: denied)", exit: code });   // {} DENIES
  });
  c.stdin.on("error", () => {});
  c.stdin.end(JSON.stringify(input));
});
// tier: "edit" (a file edit), "read", or "ask" (run_command, MCP, native subagents).
async function gate(name, args, tier, editInWorkspace = true) {
  event(name, "ACTIVE", null);
  state.calls = (state.calls ?? 0) + 1;
  const input = { stepIdx: ++state.step, modelName: model, toolCall: { args, id: "call_" + state.calls, name } };
  const d = [];
  for (const h of hooksFor("PreToolUse", name)) d.push(await runHook(h, input));
  state.hooks.push({ tool: name, decisions: d.map(x => x.decision) });
  const denied = d.find(x => x.decision === "deny" || x.decision === "deny_unless_prior_grant");
  if (denied) return { ok: false, why: denied.reason ?? "denied by hook", message: "tool call denied by pre-tool hook: " + (denied.reason ?? ""), input };
  if (d.some(x => x.decision === "auto_approve")) return { ok: true, input };
  if (tier === "read" || (tier === "edit" && editInWorkspace)) return { ok: true, input };
  return { ok: false, why: "needs approval; headless accept-edits soft-deny", message: "tool call needs approval: headless accept-edits soft-deny", input };
}
function deniedOut(name, g, info, code, what) {
  state.denied.push({ tool: name, ...what, why: g.why }); save(); event(name, "ERROR", { ...info, ...toolError(g.message ?? g.why) });
  process.stderr.write(name + " denied: " + g.why + "\n"); process.exit(code);
}
async function mcpCall(server, tool, args) {
  const all = JSON.parse(readFileSync(join(agentsDir, "mcp_config.json"), "utf8")).mcpServers ?? {};
  const conf = all[server];
  if (!conf) { process.stderr.write("no MCP server " + server + " configured\n"); process.exit(4); }
  const srv = spawn(conf.command, conf.args ?? [], { env: { ...process.env, ...(conf.env ?? {}) }, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const waiting = new Map();
  srv.stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); waiting.get(m.id)?.(m); } catch {} } });
  const call = (id, method, params) => new Promise(res => { waiting.set(id, res); srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const init = await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-agy", version: "0" } });
  if (init.error) { process.stderr.write("mcp initialize failed: " + JSON.stringify(init.error) + "\n"); process.exit(4); }
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const r = await call(2, "tools/call", { name: tool, arguments: args });
  srv.stdin.end(); srv.kill();
  return { r, text: (r.result?.content ?? []).filter(c => c.type === "text").map(c => c.text).join("") };
}
async function finishMcp(name, info, role, server, tool, args) {
  const { r, text } = await mcpCall(server, tool, args);
  state.asked.push({ role, form: name === "call_mcp_tool" ? "call_mcp_tool" : "direct", ok: !r.error && !r.result?.isError }); save();
  if (r.error || r.result?.isError) { event(name, "ERROR", { ...info, ...toolError("ask_subagent failed") }); process.stderr.write("ask_subagent failed: " + (r.error ? JSON.stringify(r.error) : text) + "\n"); process.exit(5); }
  const now = new Date().toISOString();
  event(name, "DONE", { ...info, output: "Created At: " + now + "\nCompleted At: " + now + "\n" + text });
  process.stdout.write(text);
}
if (cmd === "write") {
  const [p, content] = rest;
  const abs = isAbsolute(p) ? p : join(dir, p);
  const old = process.env.FAKE_AGY_WRITE_TOOL === "write_to_file";
  const name = old ? "write_to_file" : "write_file", key = old ? "TargetFile" : "Path";
  const g = await gate(name, old ? { TargetFile: abs, CodeContent: content, Overwrite: true } : { Content: content, Path: abs }, "edit", inside(resolve(dir), resolve(abs)) || inside(cwd, resolve(abs)));
  if (!g.ok) deniedOut(name, g, { [key]: abs }, 3, { path: abs });
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  state.changed.push(abs.startsWith(dir + "/") ? abs.slice(dir.length + 1) : abs); save(); event(name, "DONE", { [key]: abs });
} else if (cmd === "run") {
  const [, line] = rest;
  const g = await gate("run_command", { CommandLine: line, WaitMsBeforeAsync: 5000, toolSummary: "Verify unit" }, "ask");
  if (!g.ok) deniedOut("run_command", g, { CommandLine: line }, 126, { command: line });
  // As observed: the CLI writes its shell-injection helper bin/agentapi before running anything.
  const cliDir = process.env.HOME ? join(process.env.HOME, ".gemini", "antigravity-cli") : null;
  if (cliDir && existsSync(cliDir)) {
    const helper = join(cliDir, "bin", "agentapi");
    try { mkdirSync(dirname(helper), { recursive: true }); writeFileSync(helper, "#!/bin/sh\n# fake agentapi\n", { mode: 0o755 }); }
    catch (e) {
      const why = e && (e.code === "EROFS" || e.code === "EACCES" || e.code === "EPERM") ? "read-only file system" : String(e && e.code);
      save(); event("run_command", "ERROR", { CommandLine: line, ...toolError("run_command: failed to build agentapi shell injection: failed to write agentapi script: open " + helper + ": " + why) });
      process.stderr.write("run_command failed: agentapi " + why + "\n"); process.exit(126);
    }
  }
  const code = await new Promise(res => { const c = spawn("sh", ["-c", line], { cwd, stdio: ["ignore", 2, 2] }); c.on("close", c2 => res(c2 ?? 1)); });
  if (line.trim() === (process.env.FAKE_AGY_VERIFY ?? "").trim()) state.verify = { cmd: line.trim(), exit_code: code };
  save(); event("run_command", "DONE", { CommandLine: line, exit_code: code });
  process.exit(code);
} else if (cmd === "ask") {
  const [role, question] = rest;
  const name = process.env.FAKE_AGY_MCP_NAME || "mcp_pantheon-subagents_ask_subagent";
  const conf = existsSync(join(agentsDir, "mcp_config.json")) ? JSON.parse(readFileSync(join(agentsDir, "mcp_config.json"), "utf8")).mcpServers?.["pantheon-subagents"] : null;
  if (conf && conf.tools?.ask_subagent?.eager !== true) { process.stderr.write("fake-agy: ask_subagent is lazy (not eager): only call_mcp_tool reaches it\n"); process.exit(6); }
  const g = await gate(name, { question, role, toolSummary: "Ask " + role }, "ask");
  if (!g.ok) deniedOut(name, g, { role }, 3, { role });
  await finishMcp(name, { ServerName: "pantheon-subagents", ToolName: "ask_subagent" }, role, "pantheon-subagents", "ask_subagent", { role, question });
} else if (cmd === "mcp") {
  const [role, question, server, tool] = rest;
  const args = { ServerName: server, ToolName: tool, Arguments: { role, question } };
  const g = await gate("call_mcp_tool", args, "ask");
  if (!g.ok) deniedOut("call_mcp_tool", g, { ServerName: server, ToolName: tool }, 3, { role, server, mcp_tool: tool });
  await finishMcp("call_mcp_tool", { ServerName: server, ToolName: tool }, role, server, tool, { role, question });
} else if (cmd === "invoke") {
  const [sub] = rest;
  const g = await gate("invoke_subagent", { Name: sub, Prompt: "do anything" }, "ask");
  if (!g.ok) deniedOut("invoke_subagent", g, { Name: sub }, 3, { subagent: sub });
  save(); event("invoke_subagent", "DONE", { Name: sub });
  process.stdout.write("a native subagent ran (the jail should have denied it)\n");
} else if (cmd === "read") {
  const [p] = rest;
  const g = await gate("view_file", { AbsolutePath: p }, "read");
  if (!g.ok) deniedOut("view_file", g, { AbsolutePath: p }, 3, { path: p });
  save(); event("view_file", "DONE", { AbsolutePath: p });
  process.stdout.write(readFileSync(p, "utf8"));
} else if (cmd === "sub") {
  // agy agents / agy mcp list, as OBSERVED on agy 1.5.10 (owner's probe of 5893432, 2026-11-18):
  //   - both REJECT --log-file: exit 1, their usage text, then exactly "Error: flags provided but not defined: -log-file".
  //   - both write the CLI's own log under $HOME/.gemini/antigravity-cli/log/ and a
  //     $HOME/.gemini/config/projects/default-cli-project.json.<rand>.tmp (then renamed); a write that fails logs an
  //     E-level "read-only file system" line.
  //   - (bisect of 6e0d1d1, 2026-11-18) when the log FILE could be created, every diagnostic line below goes THERE and
  //     not to stderr; when it could not, to stderr.
  //   - ALWAYS (observed in every layout, logged in or not): "Auth mode is unspecified, ..." and "error getting token
  //     source: You are not logged into Antigravity." -- routine output of these subcommands, not a logout.
  //   - logged out (FAKE_AGY_NOT_LOGGED_IN=1, or FAKE_AGY_AUTH_MARKER=<path under antigravity-cli/> naming a file that
  //     is absent under $HOME/.gemini/antigravity-cli): also "doRefreshQuota: skipped (not logged in)", agents exits 0
  //     with EMPTY stdout; mcp list still lists the global server; /usage returns no groups (the FAKE_AGY script).
  //   - both print the observed benign 'Failed to resolve GeminiDir ".gemini": ...' line when logged out.
  //   - both print "hooks_manager.go:54] loaded N named hooks from N hooks.json file(s)": N = 1 only when the cwd has
  //     .agents/hooks.json AND is a git repo (a stand-in for "project root" detection: the real rule is not known; the
  //     observed run printed 0 for a control dir that is not a git repo), else 0.
  //   - any other --flag is refused the same way as --log-file (an ASSUMPTION: only --log-file was observed).
  //   - FAKE_AGY_GLOBAL_ONLY=1: both list the GLOBAL configuration only (observed): agents lists none of the
  //     workspace's, mcp list only the global server.
  //   - mcp list ALWAYS prints the global server "context7" with a FAKE credential (observed: the real one printed the
  //     server's configured credential), so a test can prove it never reaches a record.
  // Otherwise agents lists ./.agents/agents/*/agent.md (name, "workspace", tool count); a card naming a tool in
  // BAD_TOOLS is not listed and an "unknown component ... not found in registry" line is logged for each.
  const agents = rest[0] === "agents";
  const flag = rest.find(a => a.startsWith("--"));
  if (flag) {
    const name = flag.replace(/^--/, "").replace(/=.*$/, "");
    process.stderr.write((agents ? ${JSON.stringify(AGY_1_5_10_BAD_FLAG_STDERR.agents)} : ${JSON.stringify(AGY_1_5_10_BAD_FLAG_STDERR.mcp_list)}).replace(/-log-file\n$/, "-" + name + "\n"));
    process.exit(1);
  }
  const home = process.env.HOME, g = home ? join(home, ".gemini") : null, rnd = process.pid * 100000 + Math.floor(Math.random() * 100000);   // the jail has its own PID namespace (--unshare-pid): every jailed process may see the same small pid
  let cliLog = null;
  const say = line => { if (cliLog) { try { appendFileSync(cliLog, line + "\n"); return; } catch { /* fall through to stderr */ } } process.stderr.write(line + "\n"); };
  const tryWrite = (p, content, what) => {
    try { if (!existsSync(dirname(p))) mkdirSync(dirname(p)); writeFileSync(p, content); return true; }   // one level, so a read-only parent reports EROFS
    catch (e) { say("E1118 00:00:00.000000 " + rnd + " state.go:7] " + what + ": open " + p + ": " + (e.code === "EROFS" ? "read-only file system" : e.code)); return false; }
  };
  if (g && existsSync(g)) {
    const lp = join(g, "antigravity-cli", "log", "cli-" + rnd + ".log");
    if (tryWrite(lp, "I1118 00:00:00.000000 " + rnd + " main.go:1] fake-agy " + rest.join(" ") + "\n", "Failed to redirect output for CLI: creating log file: opening log file")) cliLog = lp;
    const tmp = join(g, "config", "projects", "default-cli-project.json." + rnd + ".tmp");
    if (tryWrite(tmp, "{}", "failed to resolve project: project: write project config")) renameSync(tmp, join(g, "config", "projects", "default-cli-project.json"));
    // INFERRED (owner's report of 09d490f, 2026-11-19: the preflight "refused a write to a builtin plugin asset under a
    // read-only mount"; the exact line was not kept): when antigravity-cli/builtin/plugins/<p>/ exists, the CLI rewrites
    // that plugin's asset (a .tmp, then renamed) at startup.
    const plugins = join(g, "antigravity-cli", "builtin", "plugins");
    for (const p of existsSync(plugins) ? readdirSync(plugins).sort() : []) {
      const asset = join(plugins, p, "asset.js"), atmp = asset + "." + rnd + ".tmp";
      if (tryWrite(atmp, "// fake-agy builtin asset " + rnd + "\n", "failed to install builtin plugin asset")) renameSync(atmp, asset);
    }
  }
  const globalOnly = process.env.FAKE_AGY_GLOBAL_ONLY === "1";
  const marker = process.env.FAKE_AGY_AUTH_MARKER;
  const loggedOut = process.env.FAKE_AGY_NOT_LOGGED_IN === "1" || Boolean(marker && !(g && existsSync(join(g, "antigravity-cli", marker))));
  const hooksFound = existsSync(join(cwd, ".agents", "hooks.json")) && existsSync(join(cwd, ".git")) ? 1 : 0;
  say("I1118 00:00:00.000000 " + rnd + " hooks_manager.go:54] loaded " + hooksFound + " named hooks from " + hooksFound + " hooks.json file(s)");
  say("W1118 00:00:00.000000 " + rnd + " models.go:9] Auth mode is unspecified, skipping fetchAvailableModels and returning empty response");
  say("E1118 00:00:00.000000 " + rnd + " auth.go:2] error getting token source: You are not logged into Antigravity.");
  if (loggedOut) {
    say("W1118 00:00:00.000000 " + rnd + " settings.go:3] Failed to resolve GeminiDir \".gemini\": .gemini must be an absolute path: path is not absolute, falling back to default");
    say("I1118 00:00:00.000000 " + rnd + " settings.go:4] CLI app data directory: " + (g ? join(g, "antigravity-cli") : "?"));
    say("I1118 00:00:00.000000 " + rnd + " quota.go:5] doRefreshQuota: skipped (not logged in)");
  }
  if (agents) {
    if (loggedOut) process.exit(0);
    const base = join(cwd, ".agents", "agents"), listed = [];
    for (const n of existsSync(base) && !globalOnly ? readdirSync(base).sort() : []) {
      const f = join(base, n, "agent.md");
      if (!existsSync(f)) continue;
      const text = readFileSync(f, "utf8");
      const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? n;
      const tl = /^tools:\s*\[(.*)\]\s*$/m.exec(text);
      const tools = tl ? tl[1].split(",").map(x => x.trim()).filter(Boolean) : [];
      for (const t of tools.filter(t => DEPRECATED_TOOLS.includes(t))) say("W1118 00:00:00.000000 1 tools.go:88] Tool \"" + t + "\" is deprecated and has no effect");
      const unknown = tools.filter(t => BAD_TOOLS.includes(t));
      if (unknown.length) { for (const t of unknown) say("E1118 00:00:00.000000 1 agents.go:42] failed to resolve components: unknown component: tool \"" + t + "\" not found in registry"); continue; }
      listed.push(name + "\tworkspace\t" + tools.length + " tools");
    }
    if (listed.length) process.stdout.write(listed.join("\n") + "\n");
  } else {
    const f = join(cwd, ".agents", "mcp_config.json");
    const servers = existsSync(f) && !globalOnly ? JSON.parse(readFileSync(f, "utf8")).mcpServers ?? {} : {};
    const out = ["context7\tstdio\tnpx -y @upstash/context7-mcp --api-key " + ${JSON.stringify(FAKE_MCP_CREDENTIAL)}, "  headers: Authorization: Bearer " + ${JSON.stringify(FAKE_MCP_CREDENTIAL)}];
    for (const n of Object.keys(servers).sort()) out.push(n + "\tstdio\t" + [servers[n].command, ...(servers[n].args ?? [])].join(" "));
    process.stdout.write(out.join("\n") + "\n");
  }
  process.exit(0);
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
const AGY_SWITCHES = ["FAKE_AGY_AUTH_MARKER", "FAKE_AGY_NOT_LOGGED_IN", "FAKE_AGY_GLOBAL_ONLY", "FAKE_AGY_QUOTA", "FAKE_AGY_FAIL", "FAKE_AGY_QUOTA_ONCE", "FAKE_AGY_MODE", "FAKE_AGY_WORKER", "FAKE_AGY_GEMINI_WRITES", "FAKE_AGY_MCP_NAME", "FAKE_AGY_WRITE_TOOL",
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
// HOME is a FAKE (a fresh empty temp dir, NOT under `dir`, which the jail binds writable) while `fn` runs: a unit
// worker's jail reads ~/.gemini from the child's HOME (src/agy/sandbox.mjs geminiState), and a test must never read,
// copy or bind the real one.
export async function withFakeAgy(dir, fn) {
  const keys = ["PANTHEON_AGY_CLI", "FAKE_AGY_LOG", "PANTHEON_AGY_STATE_DIRS", "HOME", ...AGY_SWITCHES];
  const before = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const log = join(dir, "agy.log"), home = mkdtempSync(join(tmpdir(), "pantheon-fake-home-"));
  Object.assign(process.env, { PANTHEON_AGY_CLI: fakeAgy(dir), FAKE_AGY_LOG: log, PANTHEON_AGY_STATE_DIRS: dir, HOME: home });
  for (const k of AGY_SWITCHES) delete process.env[k];
  const agy = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map(l => { const [agent, model] = l.split(" "); return { agent, model }; }) : [];
  try { return await fn({ agy, agyContext: () => contextOf(log), agyWorker: sh => setWorker(dir, sh), ...workerControls(dir),
    agyQuota: models => { process.env.FAKE_AGY_QUOTA = models.join(" "); }, agyFail: models => { process.env.FAKE_AGY_FAIL = models.join(" "); } }); }
  finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } rmSync(home, { recursive: true, force: true }); }
}

/**
 * The fake CLI's launches as it saw them: [{agent, model, dir (its --add-dir), a2a_url, a2a_token, google_key,
 * a2a_socket, mode (--mode), cleanup ($ANTIGRAVITY_AGY_CLEANUP), dangerous (--dangerously-skip-permissions), sandbox (--sandbox),
 * log_file (--log-file)}].
 */
function contextOf(log) {
  const file = `${log}.ctx`;
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => {
    const [agent, model, dir, ...flags] = l.split(" ");
    const flag = k => flags.includes(`${k}=yes`) || flags.includes(`${k}=yesyes`);
    const value = k => flags.find(f => f.startsWith(`${k}=`))?.slice(k.length + 1) ?? null;
    return { agent, model, dir, a2a_url: flag("a2a_url"), a2a_token: flag("a2a_token"), google_key: flag("google_key"),
      a2a_socket: flag("a2a_socket"), mode: value("mode"), cleanup: value("cleanup"), dangerous: flag("dangerous"), sandbox: flag("sandbox"),
      log_file: value("log_file") === "none" ? null : value("log_file") };
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

/** The synthetic Gemini API key a fixture's controller holds (never a real key; never given to a worker). */
export const FIXTURE_GEMINI_KEY = "AIza-synthetic-fixture-key-not-a-credential";
const GEMINI_BASE = "https://generativelanguage.googleapis.com";
// The session relay (see the header): the bridge's protocol on stdio, the provider through the controller's gateway.
const FAKE_SDK_SESSION = String.raw`import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
const out = o => process.stdout.write(JSON.stringify(o) + "\n");
const sha = s => "sha256:" + createHash("sha256").update(s).digest("hex");
const waiting = new Map();
let start = null, cancelled = null, onStart;
const started = new Promise(r => { onStart = r; });
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type === "start") { start = m; onStart(); }
  else if (m.type === "decision") { waiting.get(m.id)?.(m); waiting.delete(m.id); }
  else if (m.type === "cancel") { cancelled = m.reason ?? "cancelled"; for (const f of waiting.values()) f({ allow: false, message: "cancelled" }); }
});
rl.on("close", () => { cancelled ??= "the controller closed the channel"; if (!start) process.exit(2); });
await started;
out({ type: "identity", runtime: { python: "fixture", executable: process.execPath, sdk: { module: "google.antigravity", status: "installed", distribution: "google-antigravity", version: "0.1.24", path: "/fixture" }, harness: null } });
out({ type: "ready", conversation_id: "conv-fixture", capabilities: { trajectory_events: true, define_subagent_disabled: true } });
const ROOT = "root-traj";
const state = (id, st, parent = "", depth = 0) => out({ type: "event", event: "trajectory_state", trajectory_id: id, parent_trajectory_id: parent, depth, state: st, error: "", error_code: "", stop_reason: "UNSPECIFIED" });
const fail = (kind, message, code = 3) => { out({ type: "result", ok: false, error: { kind, type: "AntigravityExecutionError", message } }); process.exit(code); };
const ask = async (model, system, payload) => {
  const r = await fetch(start.gateway.url + "/v1beta/models/" + model + ":streamGenerateContent?alt=sse", { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": start.gateway.token },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: JSON.stringify(payload) }] }], sessionId: payload.session, systemInstruction: { parts: [{ text: system }] } }) });
  const body = await r.text();
  if (r.status !== 200) return { status: r.status, body };
  let text = ""; try { text = JSON.parse(body.split("\n").find(l => l.startsWith("data:")).slice(5)).candidates[0].content.parts[0].text; } catch { /* not the scripted shape */ }
  return { status: 200, text };
};
state(ROOT, "RUNNING");
const first = await ask(start.model, start.system, { session: "sess-root", fixture_session: { workspace: start.workspace, prompt: start.prompt, model: start.model, thinking: start.thinking ?? null } }).catch(e => ({ status: null, body: String(e?.message ?? e) }));
if (cancelled) fail("cancelled", cancelled, 5);
if (first.status !== 200) fail("harness", "the model request failed (HTTP " + first.status + "): " + String(first.body).slice(0, 300));
let plan; try { plan = JSON.parse(first.text); } catch { fail("harness", "the scripted provider did not answer with a plan"); }
let n = 0;
for (const sub of plan.subagents ?? []) {
  if (cancelled) break;
  const id = ++n, decided = new Promise(r => waiting.set(id, r));
  out({ type: "hook", id, tool: "invoke_subagent", args: { Subagents: [{ TypeName: sub.type, Role: sub.type, Prompt: sub.assignment }] }, call_id: "call-" + id, step_id: ROOT + ":" + id, trajectory_id: ROOT, server_name: null });
  const d = await decided;
  const spec = (start.subagents ?? []).find(x => x.name === sub.type);
  if (!d.allow || !spec) continue;
  const child = "child-" + id;
  out({ type: "event", event: "child_started", trajectory_id: child, parent_trajectory_id: ROOT, prompt_key: sha(String(sub.assignment).trim()) });
  state(child, "RUNNING", ROOT, 1);
  const a = await ask(spec.model, spec.system, { session: "sess-" + child, fixture_subagent: { type: sub.type } }).catch(e => ({ status: null, body: String(e?.message ?? e) }));
  if (a.status === 200) out({ type: "event", event: "child_output", trajectory_id: child, digest: sha(a.text ?? ""), bytes: Buffer.byteLength(a.text ?? "") });
  state(child, "FULLY_IDLE", ROOT, 1);
}
if (cancelled) fail("cancelled", cancelled, 5);
state(ROOT, "FULLY_IDLE");
if (plan.exit) fail("harness", "the scripted worker exited " + plan.exit + ": " + String(plan.stderr ?? "").slice(0, 300));
out({ type: "result", ok: true, text: plan.note ?? "done", structured_output: null, stop_reason: "UNSPECIFIED", usage: { total_token_count: 1290 }, trajectory_usages: {}, root_trajectory_id: ROOT,
  conversation_id: "conv-fixture", tool_calls: n, duration_s: 0.1, capabilities: { trajectory_events: true, define_subagent_disabled: true } });
process.exit(0);
`;

/** Write the SDK session stand-in into `dir`; returns the launcher to name in PANTHEON_ANTIGRAVITY_PYTHON. */
export function fakeSdkSession(dir) {
  writeFileSync(join(dir, "fake-sdk-session.mjs"), FAKE_SDK_SESSION);
  const launcher = join(dir, "fake-antigravity-python");
  // Started as `<python> <bridge>`: the bridge argument is ignored, and the relay runs in its place. `<python> <bridge>
  // --identity` (the launcher's zero-spend preflight) prints the identity the real bridge would, for the qualified SDK.
  const identity = JSON.stringify({ python: "fixture", executable: launcher, sdk: { module: "google.antigravity", status: "installed", distribution: "google-antigravity", version: "0.1.24", path: "/fixture" }, harness: { path: "/fixture/localharness", bytes: 1, sha256: "sha256:fixture" } });
  writeFileSync(launcher, `#!/bin/sh\nhere=$(cd "$(dirname "$0")" && pwd)\ncase " $* " in *" --identity "*) printf '%s\\n' '${identity}'; exit 0 ;; esac\nexec ${JSON.stringify(process.execPath)} "$here/fake-sdk-session.mjs"\n`, { mode: 0o755 });
  return launcher;
}

/** Run the scripted worker as "the model's work" of one session: {exit, stderr, subagents: [{type, assignment}], note}. */
function runSdkWorker({ dir, unit, model, prompt, effort = null }) {
  const scratch = mkdtempSync(join(tmpdir(), "pantheon-sdk-worker-")), asked = join(scratch, "subagents");
  const first = (/PATHS YOU OWN[^\n]*\n((?:- .*\n)+)/.exec(prompt)?.[1] ?? "").split("\n")[0].replace(/^- /, "");
  const script = [
    `sdk_subagent() { printf '%s\\t%s\\n' "$1" "$2" >> "$SDK_SUBAGENTS"; }`,
    `agy_ask() { echo "agy_ask: an Antigravity SDK implementer has no A2A relay; its subagents are its own (sdk_subagent <type> <assignment>)" >&2; return 1; }`,
    process.env.FAKE_AGY_WORKER ? `. "$FAKE_AGY_WORKER"` : `mkdir -p "$(dirname "$dir/$first")" && printf 'export const ok = true;\\n' > "$dir/$first"`,
  ].join("\n");
  return new Promise(resolve => {
    const done = r => { rmSync(scratch, { recursive: true, force: true }); resolve(r); };
    const c = spawn("sh", ["-c", script, "sdk-worker"], { cwd: dir, env: { ...process.env, dir, unit: unit ?? "", model, effort: effort ?? "", prompt, first, agent: "sdk-implementer", SDK_SUBAGENTS: asked }, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    c.stderr.on("data", d => { err += d; });
    c.on("error", e => done({ exit: 127, stderr: String(e?.message ?? e), subagents: [], note: "" }));
    c.on("close", code => done({ exit: code ?? 1, stderr: err.slice(-300), note: "done",
      subagents: existsSync(asked) ? readFileSync(asked, "utf8").split("\n").filter(Boolean).map(l => { const [type, ...rest] = l.split("\t"); return { type, assignment: rest.join("\t") }; }) : [] }));
  });
}

/**
 * Answer Gemini API requests IN THIS PROCESS (see the header): {sessions, unavailable, restore}. withDispatch installs it
 * for its own process; a test that runs the lifecycle in a CHILD process calls this there (the child inherits the
 * fixture's environment, not its wrapped fetch).
 */
export function installScriptedGemini({ served = () => null } = {}) {
  const real = globalThis.fetch, sessions = [], unavailable = new Set();
  const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const sse = (model, text) => new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 }], usageMetadata: GOOGLE_USAGE,
    modelVersion: served("agy_google", model) ?? model })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  const has = (k, model) => ` ${process.env[k] ?? ""} `.includes(` ${model} `);
  const quota = () => json(429, { error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    if (!url.startsWith(`${GEMINI_BASE}/`)) return real(input, init);
    const m = /^\/v1beta\/models\/([^:/]+)(?::(\w+))?$/.exec(new URL(url).pathname);
    if (!m) return json(404, { error: { code: 404, message: "no such path on the scripted endpoint", status: "NOT_FOUND" } });
    const model = m[1];
    if ((init.method ?? "GET") === "GET") {
      return unavailable.has(model) ? json(404, { error: { code: 404, message: `models/${model} is not found for API version v1beta, or is not supported for generateContent.`, status: "NOT_FOUND" } })
        : json(200, { name: `models/${model}`, displayName: model, inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ["generateContent", "countTokens"] });
    }
    let payload = null;
    try { payload = JSON.parse(JSON.parse(Buffer.from(init.body).toString("utf8")).contents.at(-1).parts[0].text); } catch { payload = null; }
    if (payload?.fixture_subagent) { sessions.push({ agent: `sdk-subagent:${payload.fixture_subagent.type}`, model, unit: null }); return sse(model, "a specialist's answer"); }
    const s = payload?.fixture_session;
    if (!s) return json(400, { error: { code: 400, message: "the scripted endpoint serves the fixture's session relay only", status: "INVALID_ARGUMENT" } });
    const unit = /work unit "([^"]+)"/.exec(s.prompt)?.[1] ?? null;
    sessions.push({ agent: "sdk-implementer", model, unit, thinking: s.thinking });
    if (has("FAKE_AGY_QUOTA", model)) return quota();
    const once = process.env.FAKE_AGY_QUOTA_ONCE;
    if (once && s.prompt.includes(once) && !existsSync(`${process.env.FAKE_AGY_LOG}.once`)) { writeFileSync(`${process.env.FAKE_AGY_LOG}.once`, ""); return quota(); }
    if (has("FAKE_AGY_FAIL", model)) return json(500, { error: { code: 500, message: "scripted provider failure", status: "INTERNAL" } });
    if (has("FAKE_AGY_HANG", model)) { await new Promise(r => init.signal?.addEventListener("abort", r, { once: true })); throw new Error("the request was aborted"); }
    return sse(model, JSON.stringify(await runSdkWorker({ dir: s.workspace, unit, model, prompt: s.prompt, effort: s.thinking })));
  };
  return { sessions, unavailable, restore: () => { globalThis.fetch = real; } };
}

export async function withDispatch(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pantheon-dispatch-"));
  const keys = ["PANTHEON_COOLDOWN_DIR", "PANTHEON_AGY_CLI", "PANTHEON_AGY_PYTHON", "PANTHEON_AGY_TRANSPORT", "FAKE_AGY_LOG",
    "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPHANIM_LEDGER", "PANTHEON_POOLS_FILE", "PANTHEON_AGY_STATE_DIRS", "PANTHEON_ANTIGRAVITY_PYTHON", "PANTHEON_ANTIGRAVITY_SDK_ALLOW", ...AGY_SWITCHES];
  const before = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const agyLog = join(dir, "agy.log");
  fakeAgy(dir);
  Object.assign(process.env, { PANTHEON_COOLDOWN_DIR: join(dir, "cooldowns"), PANTHEON_AGY_CLI: join(dir, "fake-agy"),
    PANTHEON_AGY_PYTHON: "/nonexistent/no-agy-sdk-in-tests", FAKE_AGY_LOG: agyLog, PANTHEON_AGY_STATE_DIRS: dir });
  for (const k of ["PANTHEON_AGY_TRANSPORT", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPHANIM_LEDGER", "PANTHEON_POOLS_FILE", "PANTHEON_ANTIGRAVITY_SDK_ALLOW", ...AGY_SWITCHES]) delete process.env[k];
  // The pipeline's Google implementer: the real SDK transport, between the session relay and the in-process provider.
  Object.assign(process.env, { PANTHEON_ANTIGRAVITY_PYTHON: fakeSdkSession(dir), GEMINI_API_KEY: FIXTURE_GEMINI_KEY });
  const calls = [];
  let implement = () => "export const ok = true;\n";
  let fault = () => null;
  let review = () => null;
  let served = () => null;
  const makeClientFor = scriptedClients(calls, prompt => implement(prompt), call => fault(call), call => review(call), (vendor, model) => served(vendor, model));
  const gemini = installScriptedGemini({ served: (vendor, model) => served(vendor, model) });
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
      sdk: () => gemini.sessions.map(x => ({ ...x })), sdkUnavailable: models => { gemini.unavailable.clear(); for (const m of models) gemini.unavailable.add(m); },
      opts: (extra = {}) => ({ dir: join(dir, `board-${++n}`), makeClientFor, scouts: ["xai"], ...extra }) });
  } finally {
    gemini.restore();
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
