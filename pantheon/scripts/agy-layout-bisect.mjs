#!/usr/bin/env node
// ZERO-SPEND LAYOUT BISECT of the agy CLI's state under bwrap, run ONCE on the owner's machine:
//
//   node pantheon/scripts/agy-layout-bisect.mjs [--cli <path>] [--timeout <seconds per command, default 60>] [--keep]
//
// WHY (observed on agy 1.5.10, owner's machine, 2026-11-18): inside the 5893432 jail (a scratch COPY of
// ~/.gemini/antigravity-cli with every top-level file copied and 7 state subdirs emptied) `agy agents` said "Auth mode
// is unspecified, skipping fetchAvailableModels ..." and "error getting token source: You are not logged into
// Antigravity.", while the earlier 8896740 run (antigravity-cli the REAL dir, read-only) reached
// .../v1internal:fetchAvailableModels, i.e. was authenticated. So the copy loses the login; WHICH part of the copy is
// not known (an emptied state subdir such as cache/, the skipped top-level symlink cli.log, or something else). The
// same run printed "loaded 0 named hooks from 0 hooks.json file(s)" with <ctl>/.agents/hooks.json present, and
// `agy mcp list` listed only the global server. This script does not guess: it measures.
// RESULT of the first two runs (bisect of 6e0d1d1, agy 1.5.10, 2026-11-18, identical twice): /usage returned quota
// groups with buckets in EVERY layout, and the not-logged-in lines appeared exactly where antigravity-cli/log/ was NOT
// writable (L1, L2, L3.* except L3.log), because elsewhere the CLI writes them to log/cli-<ts>.log: they are routine
// output of the subcommands, not a logout. So the login is judged from /usage only (quota_ok), the negative lines are
// counted separately, and the CLI's log FILES are now read (they hold the hooks line too).
//
// For each layout it runs `agy --print /usage --output-format json` (observed to spend zero tokens; it returns quota
// groups only when authenticated), `agy agents` and `agy mcp list` (no flags), cwd = the layout's workspace (a control
// dir with our .agents/: card, hooks.json, mcp_config.json from prepareWorkerWorkspace, with a dummy socket path),
// AGY_CLI_DISABLE_AUTO_UPDATE=true, no Google API keys. Layouts:
//   L0        control: NO bwrap, the real HOME as is (what a plain `agy` sees; the CLI may write its usual files there)
//   L1        bwrap, ~/.gemini read-only, antigravity-cli the REAL dir read-only (the 8896740 layout)
//   L2        bwrap, a scratch copy of antigravity-cli with EVERYTHING: every top-level file copied (history included),
//             every symlink recreated with the same target, every subdir ro-bound, NONE emptied; + the writable
//             config/projects copy
//   L3.<d>    L2 with exactly one state subdir <d> an EMPTY WRITABLE dir, for each of GEMINI_STATE_SUBDIRS
//   L4        the current layout (src/agy/sandbox.mjs geminiState: allowlisted copy, emptied state subdirs, writable
//             log/ and config/projects)
//   H1..H4    hook/MCP discovery, on the best authenticated layout (L4, else L2, else L1): H1 cwd = the control dir;
//             H2 the control dir after `git init` ("project root" detection); H3 `--add-dir <ctl>` passed to the
//             subcommands (refusal recorded); H4 an in-jail-only copy of ~/.gemini/trustedFolders.json with the control
//             dir added, ro-bound over the host file (it changes trust ONLY inside this jail; the host file is untouched)
// Per layout: quota_ok (bool: /usage returned the observed envelope with at least one group with buckets), auth
// (derived from /usage ALONE: quota_ok ? "ok" : "logged_out" when /usage printed the envelope without buckets or a
// not-logged-in line, else "unknown"), negative_login_lines (a COUNT of "not logged in" / "Auth mode is unspecified"
// lines in the three commands' stdout/stderr AND the CLI's new log files: observed on agy 1.5.10 to be routine output
// of the subcommands, printed to stderr whenever log/ is not writable; negative_login_sources splits the count), hooks_loaded {named, files} (from stderr AND the
// log files; null only when no such line is anywhere), workspace_dirs (the last `workspaceDirs=[...]` line's entries),
// log_sources {stderr_lines, file_lines}, mcp_servers (names only: the raw mcp list output is never kept: it was
// observed to print a credential), erofs_paths, project_resolve_error, exits, elapsed_s, and redacted negative-login /
// GeminiDir lines. The CLI's log dir (the layout's scratch log/, and the host's antigravity-cli/log/) is snapshotted
// before each command and its NEW files read afterwards (capped at 2 MB per layout, redacted), before any cleanup.
// Output: ONE JSON object (schema pantheon.agy-layout-bisect/v1). Exit 0 always, except 2 when agy is missing.
// The scratches contain COPIED CREDENTIALS (the OAuth token): all of them live under one 0700 temp dir that is deleted
// at the end unless --keep (the output says which). Nothing is ever created under the real home by the jailed layouts;
// L0 is the CLI run as usual. Async spawn only; no model turn; no API client.
import { createReadStream, existsSync, lstatSync, realpathSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPromise } from "../src/board/spawn.mjs";
import { bwrapArgs, cliDirOf, copyLevel, GEMINI_CLI_DIR, GEMINI_STATE_SUBDIRS, GEMINI_WRITABLE_COPIES, geminiState, sandboxAvailable } from "../src/agy/sandbox.mjs";
import { prepareWorkerWorkspace } from "../src/agy/workspace.mjs";
import { MCP_SERVER } from "../src/agy/jail-hook.mjs";
import { AGY_BAD_FLAG, AGY_NOT_LOGGED_IN, CLI_LOG_CAP_BYTES, cliLogEvidence, mcpServerNames, readNewCliLogs, redactStrong, snapshotCliLog, usageEnvelopeOf, usageHasBuckets, workerEnv } from "../src/board/agy-cli.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = join(HERE, "..", "src", "pipeline", "a2a-mcp-server.mjs");
export const SCHEMA = "pantheon.agy-layout-bisect/v1";
export const SPENT = "nothing (no model turn; /usage, agents and mcp list only)";

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] ?? null : null; };
const keep = argv.includes("--keep");
const timeoutS = Number(opt("--timeout") ?? 60);

const sha256File = p => new Promise(resolve => {
  const h = createHash("sha256");
  createReadStream(p).on("data", c => h.update(c)).on("end", () => resolve("sha256:" + h.digest("hex"))).on("error", () => resolve(null));
});
const lines = t => String(t ?? "").split("\n").map(l => l.trimEnd()).filter(Boolean);
const uniq = (xs, n) => [...new Set(xs)].slice(0, n);

/**
 * The per-layout evidence from the three commands' results (see the header): `res` is {usage, agents, mcp_list}, each
 * {status, killedFor, stdout, stderr, log?: text of the CLI's new log files (already redacted)}. Never keeps raw output.
 */
export function readLayout(res, env = {}) {
  const cmds = Object.values(res);
  const usage = usageEnvelopeOf(res.usage.stdout);
  const quota_ok = !res.usage.killedFor && usageHasBuckets(usage);
  const usageSaysOut = AGY_NOT_LOGGED_IN.test(`${res.usage.stdout}\n${res.usage.stderr}\n${res.usage.log ?? ""}`);
  const ev = cliLogEvidence({ stdout: cmds.map(r => r.stdout).join("\n"), stderr: cmds.map(r => r.stderr).join("\n"), log_dir: cmds.map(r => r.log ?? "").join("\n") }, env);
  const neg = lines(redactStrong(cmds.map(r => `${r.stdout}\n${r.stderr}\n${r.log ?? ""}`).join("\n"), env)).filter(l => AGY_NOT_LOGGED_IN.test(l));
  // hooks: stderr + log files (stdout is a listing, not a log)
  const hooksEv = cliLogEvidence({ stderr: cmds.map(r => r.stderr).join("\n"), log_dir: cmds.map(r => r.log ?? "").join("\n") }, env).hooks_loaded;
  return {
    quota_ok,
    auth: quota_ok ? "ok" : usage || usageSaysOut ? "logged_out" : "unknown",
    negative_login_lines: neg.length,
    negative_login_sources: { stdout_stderr: lines(redactStrong(cmds.map(r => `${r.stdout}\n${r.stderr}`).join("\n"), env)).filter(l => AGY_NOT_LOGGED_IN.test(l)).length,
      file: lines(cmds.map(r => r.log ?? "").join("\n")).filter(l => AGY_NOT_LOGGED_IN.test(l)).length },
    hooks_loaded: hooksEv ? { named: hooksEv.named, files: hooksEv.files } : null,
    workspace_dirs: ev.workspace_dirs,
    log_sources: { stderr_lines: ev.log_sources.stderr_lines, file_lines: ev.log_sources.file_lines },
    mcp_servers: mcpServerNames(res.mcp_list.stdout).servers,
    erofs_paths: ev.erofs_paths,
    project_resolve_error: ev.project_resolve_errors.length > 0,
    exits: Object.fromEntries(Object.entries(res).map(([k, r]) => [k, r.status ?? r.killedFor ?? null])),
    bad_flag: { agents: AGY_BAD_FLAG.test(res.agents.stderr), mcp_list: AGY_BAD_FLAG.test(res.mcp_list.stderr) },
    lines: { negative_login: uniq(neg.map(l => l.slice(0, 300)), 6), gemini_dir: uniq(lines(redactStrong(cmds.map(r => `${r.stdout}\n${r.stderr}\n${r.log ?? ""}`).join("\n"), env)).filter(l => /GeminiDir|CLI app data directory/i.test(l)).map(l => l.slice(0, 300)), 4) },
  };
}

/** The conclusion from the layouts (see the header). The login is judged from /usage (quota_ok) ONLY. */
export function conclude(layouts) {
  const by = id => layouts.find(l => l.id === id);
  const l2 = by("L2");
  const ran = layouts.filter(l => typeof l.quota_ok === "boolean");
  const withNeg = ran.filter(l => (l.negative_login_lines ?? 0) > 0);
  return {
    login_survives_copy: typeof l2?.quota_ok === "boolean" ? l2.quota_ok : null,
    login_lost_when: ran.filter(l => l.quota_ok === false).map(l => l.id),
    state_subdirs_losing_login: l2?.quota_ok === true ? ran.filter(l => l.id.startsWith("L3.") && l.quota_ok === false).map(l => l.id.slice(3)) : [],
    negative_login_lines_in: withNeg.map(l => l.id),
    negative_login_lines_are_noise: withNeg.length ? withNeg.every(l => l.quota_ok === true) : null,
    hooks_discovered_in: layouts.filter(l => (l.hooks_loaded?.files ?? 0) > 0).map(l => l.id),
    mcp_workspace_discovered_in: layouts.filter(l => (l.mcp_servers ?? []).includes(MCP_SERVER)).map(l => l.id),
  };
}

async function main() {
  const out = { schema: SCHEMA, agy: { path: null, version: null, sha256: null }, home_gemini: null, layouts: [], conclusion: null, h_base_layout: null,
    scratch: { root: null, kept: false, contains_credentials: true, note: null }, spent: SPENT, error: null };
  const print = code => { process.stdout.write(JSON.stringify(out, null, 2) + "\n"); process.exitCode = code; };
  const onPath = name => String(process.env.PATH ?? "").split(":").filter(Boolean).map(d => join(d, name)).find(p => existsSync(p)) ?? null;
  const cli = opt("--cli") ?? process.env.PANTHEON_AGY_CLI ?? onPath("agy") ?? (existsSync(join(homedir(), ".local", "bin", "agy")) ? join(homedir(), ".local", "bin", "agy") : null);
  if (!cli || !existsSync(cli)) { out.error = "agy not found (searched --cli, $PANTHEON_AGY_CLI, $PATH, ~/.local/bin/agy)"; out.scratch.contains_credentials = false; return print(2); }
  out.agy.path = realpathSync(cli);
  out.agy.sha256 = await sha256File(out.agy.path);
  const env = workerEnv({});   // the worker's env: no Google API keys, AGY_CLI_DISABLE_AUTO_UPDATE=true
  try { const v = await spawnPromise(cli, ["--version"], { env, timeout: 30000 }); out.agy.version = `${v.stdout || v.stderr}`.trim().slice(0, 200) || null; }
  catch (e) { out.agy.version = `unavailable: ${e?.code ?? e?.message ?? e}`; }

  const home = process.env.HOME ?? homedir(), g = join(realpathSync(home), ".gemini"), cliState = join(g, GEMINI_CLI_DIR);
  out.home_gemini = g;
  const root = realpathSync(await mkdtemp(join(tmpdir(), "pantheon-agy-bisect-")));
  await chmod(root, 0o700);
  out.scratch.root = root;
  try {
    const box = await sandboxAvailable("bwrap");
    const workspace = async (name, { git = false } = {}) => {
      const ctl = join(root, "ws", name, "control"), wt = join(root, "ws", name, "wt");
      await mkdir(wt, { recursive: true });
      await prepareWorkerWorkspace({ control_dir: ctl, worktree: wt, unit_id: "bisect", owned_paths: ["allowed/**"], verify_cmd: 'node -e "process.exit(0)"', roles: ["probe-helper"],
        mcp_server: MCP_SERVER_PATH, a2a_env: { PANTHEON_A2A_SOCKET: join(root, "no-such-a2a.sock"), PANTHEON_A2A_TOKEN: "dummy-bisect-not-a-token", PANTHEON_A2A_ROLES: "probe-helper", PANTHEON_UNIT_ID: "bisect" } });
      if (git) { const r = await spawnPromise("git", ["init", "-q", "."], { cwd: ctl, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 30000 }); if (r.status !== 0) throw new Error(`git init in ${ctl} exited ${r.status}`); }
      return { ctl: realpathSync(ctl), wt: realpathSync(wt) };
    };
    const base = await workspace("base");
    // `logDirs`: where the CLI's log/ lands on the host for this layout (the scratch's, and the host's own); each is
    // snapshotted before every command and its new files read afterwards, BEFORE the scratch is deleted.
    const run3 = async (prefix, cwd, extra = [], logDirs = [join(cliState, "log")]) => {
      const res = {}, budget = { left: CLI_LOG_CAP_BYTES };
      for (const [k, args] of [["usage", ["--print", "/usage", "--output-format", "json"]], ["agents", ["agents", ...extra]], ["mcp_list", ["mcp", "list", ...extra]]]) {
        const dirs = [...new Set(logDirs.filter(Boolean))];
        const before = await Promise.all(dirs.map(d => snapshotCliLog(d)));
        const r = await spawnPromise(prefix.length ? prefix[0] : cli, prefix.length ? [...prefix.slice(1), cli, ...args] : args, { cwd, env, timeout: timeoutS * 1000 })
          .catch(e => ({ status: null, stdout: "", stderr: `spawn failed: ${e?.code ?? e?.message ?? e}`, killedFor: null }));
        let log = "";
        for (let i = 0; i < dirs.length; i++) log += (await readNewCliLogs(dirs[i], before[i], { env, budget })).text;
        res[k] = { status: r.status, killedFor: r.killedFor ?? null, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? ""), log };
      }
      return res;
    };
    const logDirsOf = gs => [gs?.scratch_cli ? join(gs.scratch_cli, "log") : null, join(cliState, "log")];
    const jail = (ws, gemini_state) => bwrapArgs({ worktree: ws.wt, control_dir: ws.ctl, agy_state_dirs: [], extra_ro: [cliDirOf(cli)].filter(Boolean), gemini_state }).argv;
    const record = async (id, description, fn) => {
      const t0 = Date.now();
      try {
        const r = await fn();
        if (r?.skipped) { out.layouts.push({ id, description, skipped: r.skipped, quota_ok: null, auth: null, negative_login_lines: null, hooks_loaded: null, mcp_servers: null, erofs_paths: [], project_resolve_error: null, exits: null, elapsed_s: 0 }); return; }
        out.layouts.push({ id, description, ...readLayout(r.res, env), ...(r.note ? { note: r.note } : {}), elapsed_s: Math.round((Date.now() - t0) / 100) / 10 });
      } catch (e) {
        out.layouts.push({ id, description, error: String(e?.message ?? e).slice(0, 300), quota_ok: null, auth: null, negative_login_lines: null, hooks_loaded: null, mcp_servers: null, erofs_paths: [], project_resolve_error: null, exits: null, elapsed_s: Math.round((Date.now() - t0) / 100) / 10 });
      }
    };
    const noBwrap = { skipped: `bwrap unavailable: ${box.why}` };
    const cliIsDir = (() => { try { return lstatSync(cliState).isDirectory(); } catch { return false; } })();

    // The writable copy of each GEMINI_WRITABLE_COPIES dir (config/projects) under `dir`, as the current layout makes it.
    const writableCopies = async dir => {
      const mounts = [];
      for (const rel of GEMINI_WRITABLE_COPIES) {
        const dest = join(g, ...rel.split("/"));
        let s = null; try { s = lstatSync(dest); } catch { /* absent */ }
        if (!s?.isDirectory()) continue;
        const src = join(dir, "writable", ...rel.split("/"));
        await mkdir(src, { recursive: true, mode: 0o700 });
        const lvl = await copyLevel(dest, src);
        mounts.push({ dest, src, mode: "rw" }, ...lvl.mounts);
      }
      return mounts;
    };
    // L2 / L3.<d>: EVERYTHING copied or ro-bound, symlinks recreated, nothing emptied except `emptied`.
    const fullCopy = async (id, emptied = null) => {
      const dir = join(root, "layouts", id), scratch = join(dir, GEMINI_CLI_DIR);
      await mkdir(scratch, { recursive: true, mode: 0o700 });
      const mounts = [{ dest: cliState, src: scratch, mode: "rw" }];
      for (const e of (await readdir(cliState, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const host = join(cliState, e.name), dst = join(scratch, e.name);
        if (e.isSymbolicLink()) await symlink(await readlink(host), dst);
        else if (e.isFile()) { await copyFile(host, dst); await chmod(dst, (await stat(host)).mode & 0o7777); }
        else if (e.isDirectory()) { await mkdir(dst); if (e.name !== emptied) mounts.push({ dest: host, src: host, mode: "ro" }); }
      }
      if (emptied && !existsSync(join(scratch, emptied))) await mkdir(join(scratch, emptied));
      mounts.push(...await writableCopies(dir));
      return { enabled: true, mode: "scratch", gemini_dir: g, scratch_cli: scratch, mounts };
    };
    const ro = { enabled: true, mode: "ro", gemini_dir: g, mounts: [] };
    const needLayout = () => (!box.ok ? noBwrap : !existsSync(g) ? { skipped: `${g} does not exist` } : !cliIsDir ? { skipped: `${cliState} is not a plain directory` } : null);
    const states = {};

    await record("L0", "control: no bwrap, the real HOME as is", async () => ({ res: await run3([], base.ctl) }));
    await record("L1", "bwrap; ~/.gemini read-only; antigravity-cli the REAL dir, read-only (the 8896740 layout)", async () => {
      if (!box.ok) return noBwrap;
      if (!existsSync(g)) return { skipped: `${g} does not exist` };
      states.L1 = ro;
      return { res: await run3(jail(base, ro), base.ctl) };
    });
    await record("L2", "bwrap; scratch copy of antigravity-cli with everything copied or ro-bound, symlinks recreated, nothing emptied; writable config/projects", async () => {
      const s = needLayout(); if (s) return s;
      states.L2 = await fullCopy("L2");
      return { res: await run3(jail(base, states.L2), base.ctl, [], logDirsOf(states.L2)) };
    });
    for (const d of GEMINI_STATE_SUBDIRS) {
      await record(`L3.${d}`, `L2 with only ${d}/ an empty writable dir`, async () => {
        const s = needLayout(); if (s) return s;
        const gs = await fullCopy(`L3.${d}`, d);
        return { res: await run3(jail(base, gs), base.ctl, [], logDirsOf(gs)) };
      });
    }
    await record("L4", "the current layout (geminiState: allowlisted copy, emptied state subdirs, writable log/ and config/projects)", async () => {
      const s = needLayout(); if (s) return s;
      states.L4 = await geminiState({ home, run_dir: join(base.ctl, "run") });
      return { res: await run3(jail(base, states.L4), base.ctl, [], logDirsOf(states.L4)) };
    });

    const authOk = id => out.layouts.find(l => l.id === id)?.quota_ok === true;
    const hb = ["L4", "L2", "L1"].find(id => states[id] && authOk(id)) ?? (states.L1 ? "L1" : null);
    out.h_base_layout = hb;
    const hState = hb ? states[hb] : null;
    const onBest = (fn) => async () => (hState ? fn() : noBwrap);
    await record("H1", `${hb ?? "(none)"}; cwd = the control dir`, onBest(async () => ({ res: await run3(jail(base, hState), base.ctl, [], logDirsOf(hState)) })));
    await record("H2", `${hb ?? "(none)"}; cwd = the control dir after git init`, onBest(async () => { const w = await workspace("h2", { git: true }); return { res: await run3(jail(w, hState), w.ctl, [], logDirsOf(hState)) }; }));
    await record("H3", `${hb ?? "(none)"}; --add-dir <ctl> passed to agents and mcp list (tried once)`, onBest(async () => ({ res: await run3(jail(base, hState), base.ctl, ["--add-dir", base.ctl], logDirsOf(hState)) })));
    await record("H4", `${hb ?? "(none)"}; an in-jail-only copy of ~/.gemini/trustedFolders.json with the control dir added`, onBest(async () => {
      const host = join(g, "trustedFolders.json");
      let st = null; try { st = lstatSync(host); } catch { /* absent */ }
      if (!st?.isFile()) return { skipped: `${host} is not a regular file: nothing to bind over (nothing is created on the host)` };
      let tf;
      try { tf = JSON.parse(await readFile(host, "utf8")); } catch { return { skipped: `${host} is not JSON: not modified` }; }
      if (Array.isArray(tf)) tf.push(base.ctl);
      else if (tf && typeof tf === "object") tf[base.ctl] = "TRUST_FOLDER";
      else return { skipped: `${host} is neither an object nor an array: not modified` };
      const copy = join(root, "layouts", "H4", "trustedFolders.json");
      await mkdir(dirname(copy), { recursive: true, mode: 0o700 });
      await writeFile(copy, JSON.stringify(tf, null, 2) + "\n", { mode: 0o600 });
      const gs = { ...hState, mounts: [...(hState.mounts ?? []), { dest: host, src: copy, mode: "ro" }] };
      return { res: await run3(jail(base, gs), base.ctl, [], logDirsOf(gs)), note: "trust changed ONLY inside this jail (a copy bound over the host file); the host trustedFolders.json is untouched" };
    }));
    out.conclusion = conclude(out.layouts);
  } catch (e) {
    out.error = String(e?.message ?? e).slice(0, 500);
  } finally {
    if (keep) { out.scratch.kept = true; out.scratch.note = `KEPT at ${root}: it contains COPIED CREDENTIALS (the OAuth token); delete it when done`; }
    else { await rm(root, { recursive: true, force: true }).catch(() => {}); out.scratch.note = "deleted (it contained copied credentials)"; }
  }
  print(0);
}

// Run only as a script (a test imports readLayout / conclude without running the matrix).
const invoked = (() => { try { return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invoked) main().catch(e => {
  process.stdout.write(JSON.stringify({ schema: SCHEMA, error: `the bisect failed: ${String(e?.message ?? e).slice(0, 500)}`, spent: SPENT }, null, 2) + "\n");
  process.exitCode = 0;
});
