#!/usr/bin/env node
/**
 * Guarded, exact-commit, scoped publication (#139).
 *
 * A candidate's branch push used to follow the gates without consuming their exit statuses: 4d577d4 (enforcing lint
 * exit 1, tests 49/49) was pushed. Here the transport is unreachable unless every required gate, run BY THIS GUARD on
 * the exact committed object, returned exit 0, and the branch still points at that object when the transport runs.
 *
 *   1  the sha is a full, existing commit; the branch is scoped (claude/...), never main or master; the branch
 *      head equals the sha now
 *   2  a fresh, controller-owned, DETACHED git checkout of the sha (a local clone, so the original checkout is never
 *      written), whose `git rev-parse HEAD` must equal the sha -- gates that read committed source through git
 *      (the graph extractor, for one) see the real object, not an archive without metadata
 *   3  each gate runs as an argv through the bounded child runner (pantheon/src/board/spawn.mjs) with a deadline --
 *      never a shell, never a filter over its output. A gate passes only on status 0 with no signal and no kill;
 *      an empty gate list, a launch error, a timeout or a missing status refuses. The raw output is kept.
 *      Each gate runs inside its own bwrap box with a LEAST-PRIVILEGE read view: the allowlisted view the worker
 *      launcher uses (worker-launch.mjs READ_VIEW: /usr and its links, /etc/alternatives, fresh /proc, /dev, /tmp),
 *      each positively identified interpreter FILE read-only (the guard's own process.execPath and any gate's
 *      absolute argv[0] outside the system view, each bound as a single file from its canonical path to the path
 *      the gate invokes -- never an inferred directory), the exact checkout read-only (the kernel refuses a write to the committed input
 *      with EROFS), and only the controller-owned scratch writable (OPHANIM_GATE_SCRATCH, TMPDIR, HOME). The host
 *      root, home, /etc and the receipt root are not mounted; the network and pid namespace are unshared. Git still reads the checkout, so `git rev-parse HEAD` works in a gate. A host
 *      where that box cannot start refuses (SANDBOX_UNAVAILABLE): there is no unboxed path.
 *      After EVERY gate, and again before the transport, the checkout must still be the committed object: an empty
 *      `git status --porcelain --untracked-files=all` and HEAD equal to the sha. A gate that changed, deleted or added
 *      any path refuses (INPUT_CHANGED) before a later gate or the transport can see it. Gates get a separate
 *      controller-owned writable scratch (OPHANIM_GATE_SCRATCH, TMPDIR) for legitimate output. This is evidence of
 *      no change after each gate, not a claim that the input could not be written.
 *   4  the branch head is read again; if it moved, the candidate is stale and refused
 *   5  only then transport({repo, remote, sha, branch}): by default `git push <remote> <sha>:refs/heads/<branch>`,
 *      which publishes exactly the admitted object to exactly that branch
 *
 * The REQUIRED gates are this module's (REQUIRED_GATES), not the caller's: the CLI always runs them, and a caller's
 * --test only ADDS a gate; it cannot replace or omit a required one.
 *
 * A receipt is written on every outcome (the sha, every gate's observation and raw-output reference, the decision),
 * outside the checkout; the checkout clone and the scratch are removed on success, refusal and throw alike.
 * Nothing a caller passes as a status can authorize the transport: only the guard's own gate runs can.
 *
 * Adoption boundary: this is the guard. Whether a given handoff actually publishes through it is the caller's to
 * prove; a push made any other way is not covered.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPromise } from "../../pantheon/src/board/spawn.mjs";
import { READ_VIEW } from "./worker-launch.mjs";

export const PUBLICATION_KIND = "ophanim.candidate-publication/1";
const SHA = /^[0-9a-f]{40}$/;
const SCOPED = /^claude\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const FORBIDDEN = new Set(["main", "master"]);
const sha256 = b => createHash("sha256").update(b).digest("hex");
const GIT_ENV = () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", HOME: process.env.HOME ?? "/nonexistent" });
const git = (repo, args, opts = {}) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: GIT_ENV(), timeout: 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...opts });
const headOf = (repo, branch) => { try { return git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]).trim(); } catch { return null; } };

/** Is the checkout still exactly the committed object? No changed, deleted or added path, and HEAD the sha. */
async function inputIntact(checkout, sha) {
  const st = await spawnPromise("git", ["-C", checkout, "status", "--porcelain", "--untracked-files=all"], { env: GIT_ENV(), timeout: 60_000 }).catch(e => ({ status: null, err: e }));
  if (st.status !== 0) return { ok: false, why: "git status could not be read" };
  if (st.stdout.trim()) return { ok: false, why: `changed paths ${JSON.stringify(st.stdout.trim().split("\n").slice(0, 20))}` };
  const h = await spawnPromise("git", ["-C", checkout, "rev-parse", "HEAD"], { env: GIT_ENV(), timeout: 30_000 }).catch(() => null);
  if (h?.status !== 0 || h.stdout.trim() !== sha) return { ok: false, why: `HEAD is ${h?.stdout?.trim() || "(unreadable)"}` };
  return { ok: true };
}

/** The default transport: publish exactly `sha` to exactly `refs/heads/<branch>` on `remote`. */
export function gitPushTransport({ repo, remote, sha, branch }) {
  git(repo, ["push", remote, `${sha}:refs/heads/${branch}`], { timeout: 120_000 });
  return { pushed: `${sha}:refs/heads/${branch}`, remote };
}

/** The trusted required gates: run on every publication, whatever the caller adds. */
export const REQUIRED_GATES = Object.freeze([
  Object.freeze({ name: "test-lint", argv: Object.freeze([process.execPath, "scripts/test-gates/lint-tests.mjs", "--enforce"]), timeoutMs: 600_000 }),
]);

/** Extra test gates a caller may ADD (never in place of REQUIRED_GATES). */
export function testGates({ tests = [], testTimeoutMs = 120_000, timeoutMs = 600_000 } = {}) {
  return tests.length ? [{ name: "tests", argv: [process.execPath, "--test", `--test-timeout=${testTimeoutMs}`, ...tests], timeoutMs }] : [];
}

/**
 * Publish `sha` to `branch` only if every gate passes on the exact commit. Returns the receipt: { ok, code, why, ... }.
 * `transport` is the test seam; nothing else the caller passes changes the decision.
 */
/** Inside the system view already: /usr and the links into it. */
const inSystemView = p => ["/usr/", "/bin/", "/lib/", "/lib64/"].some(r => p.startsWith(r));
/**
 * The interpreter files a gate needs beyond the system view: the guard's own Node and the gate's absolute argv[0],
 * each a regular file, each bound by itself (canonical source -> the path invoked). Never a directory.
 */
export function runtimeFiles(argv0) {
  const out = new Map();
  for (const p of [process.execPath, argv0]) {
    if (typeof p !== "string" || !p.startsWith("/") || inSystemView(p)) continue;
    let real; try { real = realpathSync(p); } catch { continue; }
    if (!statSync(real).isFile() || inSystemView(real)) continue;
    out.set(p, real);
  }
  return [...out].map(([at, from]) => ({ at, from }));
}

/** The box a gate runs in: the allowlisted read view, single interpreter files and the checkout read-only, `scratch` writable. */
export const gateBox = ({ checkout, scratch, bwrap = "bwrap", argv0 = null }) => [bwrap, "--die-with-parent", "--unshare-net", "--unshare-pid", ...READ_VIEW,
  ...runtimeFiles(argv0).flatMap(({ at, from }) => ["--ro-bind", from, at]),
  "--ro-bind", checkout, checkout, "--bind", scratch, scratch, "--chdir", checkout, "--"];
/** PATH inside a gate: the directory of each bound interpreter (it holds only that file), then the system view. */
const gatePath = argv0 => [...new Set(runtimeFiles(argv0).map(({ at }) => dirname(at))), "/usr/bin", "/bin"].join(":");

export async function publishCandidate({ repo, sha, branch, extra = [], required = REQUIRED_GATES, remote = "origin", transport = gitPushTransport, receiptRoot = null,
  workRoot = tmpdir(), now = () => Date.now(), bwrap = "bwrap" } = {}) {
  repo = resolvePath(repo ?? ".");
  const id = randomBytes(8).toString("hex");
  const receipt = { kind: PUBLICATION_KIND, id, repo, sha, branch, remote, started_at: new Date(now()).toISOString(), gates: [], decision: null };
  receiptRoot ??= join(workRoot, `publication-${id}`);
  mkdirSync(receiptRoot, { recursive: true });
  const finish = (ok, code, why, extra = {}) => {
    Object.assign(receipt, { ok, code, why, decision: ok ? "published" : "refused", finished_at: new Date(now()).toISOString(), ...extra });
    const bytes = JSON.stringify(receipt, null, 2);
    writeFileSync(join(receiptRoot, "receipt.json"), bytes);
    return { ...receipt, receipt_path: join(receiptRoot, "receipt.json"), receipt_sha256: sha256(bytes) };
  };

  // 1. inputs
  if (typeof sha !== "string" || !SHA.test(sha)) return finish(false, "SHA_SHAPE", `sha must be a full 40-hex commit id; got ${JSON.stringify(sha)}`);
  if (typeof branch !== "string" || FORBIDDEN.has(branch) || !SCOPED.test(branch) || branch.includes("..") || branch.split("/").some(x => x.startsWith(".") || x.endsWith(".lock"))) return finish(false, "BRANCH_SCOPE", `the destination ${JSON.stringify(branch)} is not a scoped claude/ branch (main and master are never published to)`);
  let type = null;
  try { type = git(repo, ["cat-file", "-t", sha]).trim(); } catch { /* absent */ }
  if (type !== "commit") return finish(false, "NO_COMMIT", `${sha} is not a commit in ${repo}`);
  const start = headOf(repo, branch);
  if (start !== sha) return finish(false, "HEAD_MISMATCH", `refs/heads/${branch} is ${start ?? "(absent)"}, not the candidate ${sha}`);
  if (!Array.isArray(required) || required.length === 0) return finish(false, "NO_GATES", "no required gate is configured; an empty requirement cannot admit anything");
  if (!Array.isArray(extra)) return finish(false, "GATE_SHAPE", "extra gates are a list");
  const gates = [...required, ...extra];
  for (const g of gates) {
    if (!g || typeof g.name !== "string" || !Array.isArray(g.argv) || !g.argv.length || !g.argv.every(a => typeof a === "string")) {
      return finish(false, "GATE_SHAPE", `a gate is { name, argv: [string, ...], timeoutMs? }; got ${JSON.stringify(g)}`);
    }
  }

  // 2. the exact checkout: a controller-owned detached clone, never the caller's working tree
  const owned = mkdtempSync(join(workRoot, "publication-checkout-"));
  const checkout = join(owned, "checkout"), scratch = join(owned, "scratch");
  mkdirSync(scratch);
  try {
  try {
    git(workRoot, ["clone", "-q", "--no-hardlinks", "--no-checkout", repo, checkout]);
    git(checkout, ["checkout", "-q", "--detach", sha]);
  } catch (e) { return finish(false, "CHECKOUT_FAILED", `cannot check out ${sha}: ${String(e?.stderr || e?.message).trim().split("\n")[0]}`); }
  receipt.checkout = checkout;
  const probe = await spawnPromise(bwrap, ["--ro-bind", "/", "/", "true"], { env: GIT_ENV(), timeout: 20_000 }).catch(e => ({ status: null, stderr: String(e?.code ?? e) }));
  receipt.sandbox = { tool: "bwrap", probe_status: probe.status };
  if (probe.status !== 0) return finish(false, "SANDBOX_UNAVAILABLE", `the read-only gate box cannot start here (${String(probe.stderr ?? "").trim().slice(0, 160)}); no gate runs unboxed`);
  const at = await spawnPromise("git", ["-C", checkout, "rev-parse", "HEAD"], { env: GIT_ENV(), timeout: 30_000 }).catch(() => null);
  receipt.checkout_head = at?.status === 0 ? at.stdout.trim() : null;
  if (receipt.checkout_head !== sha) return finish(false, "CHECKOUT_HEAD", `the gate checkout's HEAD is ${receipt.checkout_head ?? "(unreadable)"}, not ${sha}`);

  // 3. the gates, each its own bounded child, its exit read as such
  for (const [i, g] of gates.entries()) {
    const t0 = now();
    let r = null, launch_error = null;
    const boxed = [...gateBox({ checkout, scratch, bwrap, argv0: g.argv[0] }), ...g.argv];
    try { r = await spawnPromise(boxed[0], boxed.slice(1), { cwd: checkout, env: { PATH: gatePath(g.argv[0]), HOME: scratch, GIT_CONFIG_NOSYSTEM: "1", OPHANIM_GATE_SCRATCH: scratch, TMPDIR: scratch }, timeout: g.timeoutMs ?? 600_000, maxBuffer: 16 * 1024 * 1024 }); }
    catch (e) { launch_error = e?.code ?? String(e?.message ?? e); }
    const out = `gate-${i}-${g.name.replace(/[^A-Za-z0-9._-]/g, "_")}`;
    writeFileSync(join(receiptRoot, `${out}.stdout`), r?.stdout ?? ""); writeFileSync(join(receiptRoot, `${out}.stderr`), r?.stderr ?? "");
    const obs = { name: g.name, argv: g.argv, status: Number.isInteger(r?.status) ? r.status : null, signal: r?.signal ?? null, killed_for: r?.killedFor ?? null,
      launch_error, ms: Math.max(0, now() - t0), stdout_ref: join(receiptRoot, `${out}.stdout`), stdout_sha256: sha256(r?.stdout ?? ""),
      stderr_ref: join(receiptRoot, `${out}.stderr`), stderr_sha256: sha256(r?.stderr ?? "") };
    obs.passed = obs.status === 0 && obs.signal === null && obs.killed_for === null && obs.launch_error === null;
    receipt.gates.push(obs);
    if (obs.passed) {
      const intact = await inputIntact(checkout, sha);
      obs.input_intact = intact.ok;
      if (!intact.ok) return finish(false, "INPUT_CHANGED", `after gate ${g.name} the checkout is no longer exactly ${sha}: ${intact.why}; no later gate or the transport may see it`);
    }
    if (!obs.passed) {
      const why = launch_error ? `could not be started (${launch_error})` : obs.killed_for ? `was stopped (${obs.killed_for})` : obs.status === null ? "returned no exit status" : `exited ${obs.status}`;
      return finish(false, "GATE_FAILED", `required gate ${g.name} ${why} on ${sha}; nothing was published`);
    }
  }

  // 4. still the committed object, and still the head?
  const intact = await inputIntact(checkout, sha);
  if (!intact.ok) return finish(false, "INPUT_CHANGED", `before the transport the checkout is no longer exactly ${sha}: ${intact.why}`);
  const end = headOf(repo, branch);
  if (end !== sha) return finish(false, "STALE", `refs/heads/${branch} moved to ${end ?? "(absent)"} while the gates ran on ${sha}; the admitted object is no longer the candidate`);

  // 5. the transport, for exactly the admitted object and branch
  let sent;
  try { sent = await transport({ repo, remote, sha, branch }); }
  catch (e) { return finish(false, "TRANSPORT_FAILED", `the transport failed: ${String(e?.stderr || e?.message || e).trim().split("\n")[0]}`); }
  return finish(true, "PUBLISHED", null, { transport: sent ?? null });
  } finally {
    // The clone and the scratch are the controller's, and only the receipt outlives them.
    rmSync(owned, { recursive: true, force: true });
  }
}

// The normal entry: node scripts/blackboard/publish-candidate.mjs --sha <sha> --branch claude/<x> [--repo .] [--remote origin] [--test <path>]...
async function main(argv) {
  const opt = { tests: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === "--test") { opt.tests.push(v); i++; }
    else if (["--sha", "--branch", "--repo", "--remote", "--receipts"].includes(a)) { opt[a.slice(2)] = v; i++; }
    else { process.stderr.write(`publish-candidate: unknown argument ${a}\n`); return 2; }
  }
  const r = await publishCandidate({ repo: opt.repo ?? ".", sha: opt.sha, branch: opt.branch, remote: opt.remote ?? "origin",
    extra: testGates({ tests: opt.tests }), receiptRoot: opt.receipts ?? null });
  process.stdout.write(JSON.stringify({ ok: r.ok, code: r.code, why: r.why, sha: r.sha, branch: r.branch, receipt: r.receipt_path, receipt_sha256: r.receipt_sha256,
    gates: r.gates.map(g => ({ name: g.name, status: g.status, killed_for: g.killed_for, passed: g.passed })) }) + "\n");
  return r.ok ? 0 : 1;
}
if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
