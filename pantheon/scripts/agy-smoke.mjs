#!/usr/bin/env node
// ZERO-SPEND SMOKE PROBE of the real Antigravity CLI: what flags it really has, and what `/quota` really prints.
//   node pantheon/scripts/agy-smoke.mjs [path-to-agy]
// Runs `agy --help`, `agy --version`, checks that the flags the unit worker relies on appear in the help text, runs
// `agy -p /quota` (no model, no workspace; whether it spends tokens is undocumented, it names no model) and prints the
// observed flags and the parsed quota report. If `agy` is not found it says so and exits 0. Async spawn only.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnPromise } from "../src/board/spawn.mjs";
import { probeQuota, parseQuotaReport, minimalEnv } from "../src/agy/quota.mjs";

const WANTED = ["--mode", "--add-dir", "--agent", "--output-format", "--print-timeout"];

async function onPath(name) {
  for (const d of String(process.env.PATH ?? "").split(":").filter(Boolean)) if (existsSync(join(d, name))) return join(d, name);
  return null;
}

const cli = process.argv[2] ?? process.env.PANTHEON_AGY_CLI ?? (await onPath("agy")) ?? (existsSync(join(homedir(), ".local", "bin", "agy")) ? join(homedir(), ".local", "bin", "agy") : null);
if (!cli || !existsSync(cli)) {
  console.log(JSON.stringify({ agy: "absent", searched: ["argv[2]", "$PANTHEON_AGY_CLI", "$PATH", "~/.local/bin/agy"], note: "nothing was run" }, null, 2));
  process.exit(0);
}
const run = async args => {
  try { const r = await spawnPromise(cli, args, { env: minimalEnv(), timeout: 30000, maxBuffer: 4 * 1024 * 1024 }); return { exit: r.status, killed: r.killedFor, out: r.stdout, err: r.stderr }; }
  catch (e) { return { exit: null, error: String(e?.code ?? e?.message ?? e), out: "", err: "" }; }
};
const help = await run(["--help"]);
const version = await run(["--version"]);
const text = `${help.out}\n${help.err}`;
const flags = Object.fromEntries(WANTED.map(f => [f, new RegExp(`(^|[\\s,\\[])${f.replace(/-/g, "\\-")}(?![\\w-])`, "m").test(text)]));
const quota = await probeQuota({ cli });
const quotaRaw = await run(["-p", "/quota"]);
console.log(JSON.stringify({
  agy: cli,
  version: { exit: version.exit, text: (version.out || version.err).trim().slice(0, 200) },
  help: { exit: help.exit, bytes: text.length },
  flags_in_help: flags,
  dangerous_flag_in_help: /--dangerously-skip-permissions/.test(text),
  quota: { state: quota.state, buckets: quota.buckets, exit_code: quota.exit_code, raw_digest: quota.raw_digest, error: quota.error ?? null },
  quota_raw_head: `${quotaRaw.out}`.slice(0, 2000),
  reparsed_state: parseQuotaReport(quotaRaw.out ?? "").state,
}, null, 2));
