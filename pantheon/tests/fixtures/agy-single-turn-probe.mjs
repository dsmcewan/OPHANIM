// A FAKE agy CLI THAT PROBES ITS OWN PROCESS BOUNDARY, for the single-turn seat's jail (self-audit round 3, assignment 4
// (sealed fe2a612), L-401). It answers like the real CLI (stream-json init + result) and, before that, writes what it
// could see and do to $FAKE_AGY_PROBE_OUT/<n>.json (that dir is an explicit agy state dir, the only host path the test
// makes writable inside the jail):
//   argv, cwd, env (names only) and which SYNTHETIC SECRET VALUES ((read from $FAKE_AGY_PROBE_VALUES_FILE: their names
//   only, so the probe itself never needs the values in its env) appear in: its own env, any /proc/<pid>/environ or
//   /proc/<pid>/cmdline it can read, the files it is told to try ($FAKE_AGY_PROBE_FILES);
//   pid1 (the cmdline of PID 1 of its PID namespace: "bwrap" inside the jail), whether a host marker file under /tmp is
//   visible, whether it can write $FAKE_AGY_PROBE_WRITE (a host path outside every writable bind);
//   the PreToolUse hook's decisions, asked exactly as the CLI asks (the command of ./.agents/hooks.json, the payload on
//   stdin) for a run_command, a write in the worktree, a read outside it, a read inside it, invoke_subagent, an MCP call
//   and search_web.
// The secret VALUES reach the probe as $FAKE_AGY_PROBE_VALUES_FILE (a file in the probe's own dir, outside the jail's
// writable set, read-only inside) so that a leak shows up as a value seen, not as a name the test passed in.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const PROBE_SCRIPT = String.raw`#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const args = process.argv.slice(2), at = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const agent = at("--agent"), model = at("--model"), dir = at("--add-dir");
const out = process.env.FAKE_AGY_PROBE_OUT;
const secrets = (() => { try { return fs.readFileSync(process.env.FAKE_AGY_PROBE_VALUES_FILE, "utf8").split("\n").filter(Boolean).map(l => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }); } catch { return []; } })();
const found = text => secrets.filter(([, v]) => v && String(text).includes(v)).map(([k]) => k);
const rec = { argv: args.map(a => (a === at("--print") ? "<prompt>" : a)), cwd: process.cwd(), env_names: Object.keys(process.env).sort(),
  secrets_known: secrets.length, secrets_in_env: found(Object.entries(process.env).map(([k, v]) => k + "=" + v).join("\n")), secrets_in_proc: [], secrets_in_files: {}, proc_pids: [] };
for (const p of fs.readdirSync("/proc").filter(x => /^\d+$/.test(x))) {
  rec.proc_pids.push(Number(p));
  for (const f of ["environ", "cmdline"]) { try { const t = fs.readFileSync("/proc/" + p + "/" + f, "utf8").split("\0").join("\n"); for (const k of found(t)) if (!rec.secrets_in_proc.includes(k)) rec.secrets_in_proc.push(k); } catch {} }
}
try { rec.pid1 = fs.readFileSync("/proc/1/cmdline", "utf8").split("\0")[0]; } catch { rec.pid1 = null; }
for (const f of String(process.env.FAKE_AGY_PROBE_FILES || "").split(":").filter(Boolean)) { try { rec.secrets_in_files[f] = found(fs.readFileSync(f, "utf8")); } catch (e) { rec.secrets_in_files[f] = "unreadable: " + e.code; } }
rec.host_tmp_marker_visible = Boolean(process.env.FAKE_AGY_PROBE_MARKER) && fs.existsSync(process.env.FAKE_AGY_PROBE_MARKER);
if (process.env.FAKE_AGY_PROBE_WRITE) { try { fs.writeFileSync(process.env.FAKE_AGY_PROBE_WRITE, "escaped"); rec.host_write = "written"; } catch (e) { rec.host_write = "refused: " + e.code; } }
// The hook, asked as the CLI asks it: hooks.json in the workspace (cwd), its command, the payload on stdin.
rec.hook = {};
try {
  const hooks = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".agents", "hooks.json"), "utf8"));
  const command = Object.values(hooks)[0].PreToolUse[0].hooks[0].command;
  const ask = (name, a) => { const r = cp.spawnSync(command, [], { input: JSON.stringify({ toolCall: { name, args: a } }), cwd: path.join(process.cwd(), ".agents"), encoding: "utf8", timeout: 25000 }); try { return JSON.parse(r.stdout.trim().split("\n")[0]).decision; } catch { return "none:" + JSON.stringify(r.stdout); } };
  rec.hook.run_command = ask("run_command", { CommandLine: "cat /etc/hostname" });
  rec.hook.write_in_worktree = ask("write_file", { Path: path.join(dir, "x.mjs"), Content: "x" });
  rec.hook.read_outside = ask("view_file", { AbsolutePath: "/etc/passwd" });
  rec.hook.read_inside = ask("view_file", { AbsolutePath: path.join(dir, "seen.txt") });
  rec.hook.invoke_subagent = ask("invoke_subagent", { Name: "pantheon-fact-checker" });
  rec.hook.mcp = ask("call_mcp_tool", { ServerName: "pantheon-subagents", ToolName: "ask_subagent", Arguments: { role: "x", question: "q" } });
  rec.hook.search_web = ask("search_web", { query: "q" });
} catch (e) { rec.hook.error = String(e && e.message || e); }
if (out) { const n = fs.readdirSync(out).filter(f => f.endsWith(".json")).length; fs.writeFileSync(path.join(out, n + ".json"), JSON.stringify(rec, null, 2)); }
const say = e => process.stdout.write(JSON.stringify(e) + "\n");
say({ event: "init", conversation_id: "probe-conversation", init: { agent, model } });
say({ event: "result", result: { status: "SUCCESS", conversation_id: "probe-conversation", num_turns: 1, response: agent === "pantheon-planner" ? "TITLE: probe" : "VERDICT: approve" } });
`;

/** Write the probe CLI into `dir` (it is bound read-only inside the jail: the CLI's own directory). Returns its path. */
export function probeAgy(dir) {
  const p = join(dir, "agy-probe");
  writeFileSync(p, PROBE_SCRIPT, { mode: 0o755 });
  return p;
}
