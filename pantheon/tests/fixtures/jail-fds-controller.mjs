#!/usr/bin/env node
// THE CONTROLLER OF THE DESCRIPTOR TESTS (register KG-11; pantheon/tests/jail-fds.test.mjs).
//
//   node jail-fds-controller.mjs <config.json>
//
// A process of its own, which the test starts with fd 20 (and fd 9) open on a SYNTHETIC secret file WITHOUT close-on-exec
// (node's spawn dup2s a stdio entry into place, which clears the flag): what a supervisor leaks into a controller. It first
// records its own fd 20 (the PRECONDITION: open on the secret, still inheritable, so node's startup did not mark it), then
// drives the production entry points, which spawn the jails, and writes what the test asserts to config.result.
//   mode "worker": the CLI lane. runAgyWorkerTurn with the fake agy CLI (fixtures/dispatch.mjs), whose worker snippet runs
//                  the probe as the agy process's child (what the agy worker inherits), then the unit's verify launcher
//                  through run_command FROM A SHELL THAT HOLDS fd 20 ON THE SECRET AGAIN (agy's side of KG-11: only the
//                  launcher's closer stands between it and the verify_cmd), with the probe as the verify_cmd; then
//                  runVerify, the controller's own launch of the same launcher, with the probe as the verify_cmd. Also the
//                  POSITIVE CONTROLS: the probe spawned by node directly, and under bwrap without the closer, hold fd 20.
//   mode "board":  the python SDK seat's board spawn (runOpenItem, PANTHEON_AGY_TRANSPORT=sdk), the seat's python a stub that
//                  runs the probe inside the jail, then the real agy-seat.py over the L-150 stub SDK through the model
//                  gateway (its upstream a local fake).
// Config: {mode, result, root, secret, needle_hex, probe, model}. Synthetic secrets only; no provider is reached.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { fdExecArgv, fdExecPrefix } from "../../src/agy/fd-exec.mjs";
import { seatStub } from "./jail-fds-helpers.mjs";

const cfg = JSON.parse(readFileSync(process.argv[2], "utf8"));
const O_CLOEXEC = 0o2000000;
/** This process's descriptor `fd`: {target, cloexec}, or null when it is not open. */
const own = fd => {
  try {
    const target = readlinkSync(`/proc/self/fd/${fd}`);
    const flags = parseInt(/^flags:\s*([0-7]+)/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"))[1], 8);
    return { target, cloexec: Boolean(flags & O_CLOEXEC) };
  } catch { return null; }
};
const readJson = f => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null);
const out = { precondition: { fd20: own(20), fd9: own(9) } };
const probeArgs = (report, label) => [cfg.probe, report, cfg.needle_hex, label];

if (cfg.mode === "worker") {
  const { prepareWorkerWorkspace } = await import("../../src/agy/workspace.mjs");
  const { runAgyWorkerTurn } = await import("../../src/board/agy-cli.mjs");
  const { runVerify } = await import("../../src/pipeline/review.mjs");
  const { withFakeAgy } = await import("./dispatch.mjs");
  // POSITIVE CONTROLS: node's spawn passes fd 20 on (it closes nothing beyond the stdio it sets up), and so does bwrap.
  const ctl0 = join(cfg.root, "controls"); mkdirSync(ctl0, { recursive: true });
  spawnSync("python3", probeArgs(join(ctl0, "spawn.json"), "control-spawn"), { stdio: "ignore" });
  const bw = ["bwrap", "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--bind", ctl0, ctl0, "--", "python3", ...probeArgs(join(ctl0, "bwrap.json"), "control-bwrap")];
  spawnSync(bw[0], bw.slice(1), { stdio: "ignore" });
  // The same bwrap, through the closer: nothing.
  const [c, ...a] = fdExecArgv([...bw.slice(0, bw.indexOf("--") + 1), "python3", ...probeArgs(join(ctl0, "bwrap-closer.json"), "control-bwrap-closer")]);
  const closed = spawnSync(c, a, { encoding: "utf8" });
  out.controls = { spawn: readJson(join(ctl0, "spawn.json")), bwrap: readJson(join(ctl0, "bwrap.json")), bwrap_closer: readJson(join(ctl0, "bwrap-closer.json")), closer_status: closed.status, closer_stderr: closed.stderr };

  // THE CLI LANE: a repository with a unit's worktree and control dir, all under the root (/var/tmp, outside /tmp).
  const repo = join(cfg.root, "repo"), wt = join(cfg.root, "run", "worktrees", "u1"), ctl = join(cfg.root, "run", "control", "u1"), fx = join(cfg.root, "fx"), home = join(cfg.root, "home");
  for (const d of [repo, ctl, fx, home]) mkdirSync(d, { recursive: true });
  const git = (args, cwd) => { const r = spawnSync("git", args, { cwd, encoding: "utf8" }); if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`); };
  writeFileSync(join(repo, "README.md"), "base\n");
  git(["init", "-q", "-b", "main", "."], repo);
  git(["-c", "user.name=t", "-c", "user.email=t@t.invalid", "add", "-A"], repo);
  git(["-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "-m", "base"], repo);
  git(["worktree", "add", "-q", "-b", "unit-u1", wt], repo);
  // The verify jail binds the worktree and nothing of this repository: the probe is copied in (worker-controlled content).
  copyFileSync(cfg.probe, join(wt, "jail-fds-probe.py"));
  const verifyCmd = label => `python3 jail-fds-probe.py jail-fds-${label}.json ${cfg.needle_hex} ${label}`;
  const ws = await prepareWorkerWorkspace({ control_dir: ctl, worktree: wt, unit_id: "u1", owned_paths: ["src/**"], verify_cmd: verifyCmd("verify") });
  out.worker = await withFakeAgy(fx, async agy => {
    process.env.HOME = home;
    // The agy worker: the probe as its child (what the CLI inherits), then its ONE command from a shell holding fd 20 on the
    // secret (bash: a POSIX sh cannot name a descriptor above 9).
    agy.agyWorker(`python3 ${JSON.stringify(cfg.probe)} ${JSON.stringify(join(fx, "jail-fds-agy.json"))} ${cfg.needle_hex} agy || exit 21
bash -c 'exec 20<"$0"; exec python3 "$1" "$2" "$3" agy-held' ${JSON.stringify(cfg.secret)} ${JSON.stringify(cfg.probe)} ${JSON.stringify(join(fx, "jail-fds-agy-held.json"))} ${cfg.needle_hex} || exit 23
bash -c 'exec 20<"$0"; exec node "$1" run "$2" "$3"' ${JSON.stringify(cfg.secret)} "$tools" "$dir" "$wverify" > ${JSON.stringify(join(fx, "verify.out"))} 2>&1 || exit 22
reply=''
`);
    let r = null, error = null;
    try {
      r = await runAgyWorkerTurn({ cli: process.env.PANTHEON_AGY_CLI, control_dir: ctl, worktree: wt, model: cfg.model,
        prompt: ["PATHS YOU OWN", "- src/**", "Do not commit", "", "VERIFY COMMAND", `  ${ws.worker_verify_cmd}`].join("\n"), timeoutS: 60,
        env: { HOME: home }, sandbox: { agy_state_dirs: [fx], home } });
    } catch (e) { error = { message: String(e?.message ?? e).slice(0, 2000), code: e?.code ?? null, stderr_tail: e?.stderr_tail ?? null }; }
    // args0: the closer's own arguments (fdExecPrefix less its interpreter) and the command it starts, bwrap.
    return { error, launch: r ? { cmd: r.launch.cmd, args0: r.launch.args.slice(0, fdExecPrefix().length) } : null, descriptors: r?.sandbox?.descriptors ?? null,
      approved: r ? r.jail_log.some(l => l.tool === "run_command" && l.decision === "auto_approve" && l.args?.CommandLine === ws.worker_verify_cmd) : false,
      verify_out: existsSync(join(fx, "verify.out")) ? readFileSync(join(fx, "verify.out"), "utf8").slice(-2000) : null,
      agy: readJson(join(fx, "jail-fds-agy.json")), agy_held: readJson(join(fx, "jail-fds-agy-held.json")), verify: readJson(join(wt, "jail-fds-verify.json")) };
  });
  // THE CONTROLLER'S OWN LAUNCH of the verify launcher (runVerify), this process still holding fd 20.
  const v = await runVerify({ worktree: wt, verify_cmd: verifyCmd("runverify") });
  out.runverify = { exit_code: v.exit_code, passed: v.passed, jail: v.jail, output: String(v.output ?? "").slice(-2000), probe: readJson(join(wt, "jail-fds-runverify.json")) };
} else if (cfg.mode === "board") {
  const { withDispatch, seat } = await import("./dispatch.mjs");
  const { startFakeGemini } = await import("./l150-fake-gemini.mjs");
  const { billingFromFlags, geminiBilling, geminiUsageFile } = await import("../../src/route/gemini-billing.mjs");
  const { runOpenItem } = await import("../../src/board/run-item.mjs");
  const usage = join(cfg.root, "usage.jsonl");
  const fake = await startFakeGemini({ mode: "review", usage });
  const KEY = process.env.GEMINI_API_KEY;
  try {
    await withDispatch(async ({ dir, spec, opts }) => {
      // THE SEAT'S python: the probe first, inside the jail (its report in the seat's out dir), then the real agy-seat.py over
      // the L-150 stub SDK, whose requests reach this controller's model gateway.
      const python = seatStub(dir, { needle_hex: cfg.needle_hex });
      Object.assign(process.env, { GEMINI_API_KEY: KEY, PANTHEON_AGY_TRANSPORT: "sdk", PANTHEON_AGY_PYTHON: python, PANTHEON_AGY_GATEWAY_UPSTREAM: fake.url });
      const billing = geminiBilling({ policy: billingFromFlags({ "gemini-api-primary": "100" }), ledger: geminiUsageFile(usage) });
      const r = await runOpenItem(spec(`kg11-${process.pid}`), { ...opts(), maxProviderCalls: 50, billing,
        seatOverrides: { reviewer: seat("agy_google", cfg.model, { transport: "agy" }) } }).catch(e => ({ error: { message: String(e?.message ?? e), code: e?.code ?? null } }));
      const board = r?.board ?? null;
      const run = board && existsSync(join(board, "run.json")) ? JSON.parse(readFileSync(join(board, "run.json"), "utf8")) : null;
      const seatRoot = join(dir, "outputs", "open-items", `kg11-${process.pid}`, "agy_google");
      const seatDirs = existsSync(seatRoot) ? readdirSync(seatRoot).sort().map(n => join(seatRoot, n)) : [];
      out.board = { shipped: r?.shipped ?? null, error: r?.error ? { message: String(r.error.message ?? r.error).slice(0, 600), code: r.error.code ?? null } : null,
        critique: (run?.attempts ?? []).filter(a => a.vendor === "agy_google" && a.purpose === "critique").map(a => ({ transport: a.transport, outcome: a.outcome, code: a.code ?? null, provider_requests: a.provider_requests })),
        requests: fake.requests.length, probe: seatDirs.map(d => readJson(join(d, "jail-fds-seat.json"))).find(Boolean) ?? null };
    });
  } finally { await fake.close(); }
} else throw new Error(`unknown mode ${cfg.mode}`);
writeFileSync(cfg.result, JSON.stringify(out, null, 1));
