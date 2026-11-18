// Fake `codex` and `grok` CLIs for the review runner's subscription mode (src/review-runner/subscription.mjs). No
// network, no real CLI, no login. Each fake appends one JSON line per invocation to $FAKE_CLI_LOG: its argv (the prompt
// replaced by its length), the names of the key-like variables it received, and its cwd. Behaviour switches (names that
// scrubEnv passes through: no KEY/TOKEN/SECRET in them):
//   FAKE_CODEX_LOGIN   chatgpt (default) | apikey | none | weird        what `codex login status` prints
//   FAKE_CODEX_MODELS  json (default) | lines | missing | garbage       what `codex debug models` prints
//   FAKE_CLI_MODE      ok (default) | hang | fail | needkey             what a model run (`codex exec` / `grok -p`) does
//   FAKE_CLI_WRITE     a worktree-relative path the model run writes (a policy probe)
//   FAKE_CLI_PIDFILE   hang: the file the run writes its child's pid to (the timeout test checks it was killed)
//   FAKE_CLI_PROMPT_FILE  codex: the model run copies its prompt there (the --continue tests read the appendix)
//   FAKE_CLI_CHECK     codex: a worktree-relative path; the final message says whether it existed when the run began
//   codex FAKE_CLI_MODE=partial: an agent message and a command (with output), then turn.failed (an incomplete run)
// The fake grok also PROBES its jail and reports what it could write in its final text: `PROBE {...}`.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

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
const promptIdx = argv[0] === "exec" ? argv.length - 1 : -1;
log({ cli: "codex", argv: argv.map((a, i) => (i === promptIdx ? "<prompt " + a.length + ">" : a)), keys: ${KEYS}, cwd: process.cwd() });
if (argv[0] === "--version") { console.log("codex-cli 9.9.9-fake"); process.exit(0); }
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
if (argv[0] === "exec") {
  const val = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  const dir = val("-C"), out = val("-o");
  if (process.env.FAKE_CLI_PROMPT_FILE) fs.writeFileSync(process.env.FAKE_CLI_PROMPT_FILE, argv[argv.length - 1]);
  const check = process.env.FAKE_CLI_CHECK ? "CHECK " + process.env.FAKE_CLI_CHECK + " " + (fs.existsSync(path.join(dir, process.env.FAKE_CLI_CHECK)) ? "present" : "absent") + "\n" : "";
  if (mode === "hang") return hang();
  const ev = o => process.stdout.write(JSON.stringify(o) + "\n");
  ev({ type: "thread.started", thread_id: "th_fake" });
  ev({ type: "turn.started" });
  if (process.env.FAKE_CLI_WRITE) { const p = path.join(dir, process.env.FAKE_CLI_WRITE); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, "x\n"); }
  ev({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "node --test pantheon/tests/other.test.mjs", exit_code: 0, status: "completed" } });
  if (mode === "fail") { ev({ type: "turn.failed", error: { message: "usage limit reached" } }); process.exit(1); }
  if (mode === "partial") {
    ev({ type: "item.completed", item: { id: "i3", type: "agent_message", text: "EARLIER-OWN-MESSAGE: question 1 holds so far" } });
    ev({ type: "item.completed", item: { id: "i4", type: "command_execution", command: "node --test .review-tests/mine.test.mjs", aggregated_output: "EARLIER-OWN-OUTPUT ok 1", exit_code: 0, status: "completed" } });
    ev({ type: "turn.failed", error: { message: "usage limit reached" } }); process.exit(1);
  }
  const text = "# Findings (fake codex)\n\n" + check + "1. holds\n\nModel: " + val("-m") + "\n";
  ev({ type: "item.completed", item: { id: "i2", type: "agent_message", text } });
  ev({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20 } });
  if (out) fs.writeFileSync(out, text);
  process.exit(0);
}
console.error("fake codex: unknown command " + argv.join(" ")); process.exit(2);
`;

const FAKE_GROK = String.raw`
${COMMON}
const pi = argv.indexOf("-p");
log({ cli: "grok", argv: argv.map((a, i) => (i === pi + 1 && pi >= 0 ? "<prompt " + a.length + ">" : a)), keys: ${KEYS}, cwd: process.cwd(), home: process.env.HOME });
if (argv[0] === "--version") { console.log("grok 0.0.1-fake"); process.exit(0); }
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
    tmp: tryWrite("/tmp/fake-grok-probe.txt"),
    keys: ${KEYS},   // inside the jail the log (under the host /tmp) is hidden: the probe reports the env itself
    argv: argv.filter((a, i) => i !== pi + 1),
  };
  if (process.env.FAKE_CLI_WRITE) probe.extra = tryWrite(path.join(wt, process.env.FAKE_CLI_WRITE));
  const ev = o => process.stdout.write(JSON.stringify(o) + "\n");
  ev({ type: "start", model: argv[argv.indexOf("-m") + 1] });
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
