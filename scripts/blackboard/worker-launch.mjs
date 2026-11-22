/**
 * Controller-owned LOCAL worker launch (#128, ticket runtime-worker-launch-evidence).
 *
 * The handoff adapter (worker-handoff.mjs) used to admit a delivery on a scratch containment probe: a box built by
 * the controller's recipe, on fixtures, with no worker in it. That shows what a box COULD do, not that a worker ran
 * in one. This module launches the worker itself and records only what the controller observes of that launch:
 *
 *   checkout  a fresh exact checkout of the ticket's base in a controller scratch root
 *   box       bwrap through the bounded child runner (pantheon/src/board/spawn.mjs). READ scope is an allowlist,
 *             not the host: only /usr (with its /bin, /lib, /lib64 links) and /etc/alternatives read-only, a fresh
 *             /proc, /dev and /tmp, and the checkout read-only -- no home, no /etc, no credentials. The network and
 *             pid namespace are unshared. WRITE scope: ONLY the scoped paths.
 *   in-box    a controller prelude runs first, inside the box. It reads the kernel's /proc/self/mountinfo, derives
 *             the writable mounts inside the checkout, and REFUSES (exit 97) before the worker exists if they are not
 *             exactly the grant. Either way it prints ONE line -- the run's nonce, its pid, its verdict and only the
 *             mount lines under the checkout -- before anything else can write; the worker cannot forge it.
 *   outcome   the exit status, signal and kill reason the runner saw
 *   patch     after exit the controller commits the checkout itself (parent = base), fetches the candidate into the
 *             repository, and records the sha256 of `git diff --binary base candidate`
 *
 * The receipt binds all of it to the ticket, the base and every lease generation, with a bounded lifetime. A failed,
 * timed-out or unobservable run still writes its receipt -- the evidence is kept -- with no candidate.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, resolve as resolvePath, isAbsolute } from "node:path";
import { spawnPromise } from "../../pantheon/src/board/spawn.mjs";

export const LAUNCH_KIND = "ophanim.worker-launch.receipt";
export const LAUNCH_TTL_MS = 10 * 60_000;
export const LAUNCH_MAX_TTL_MS = 15 * 60_000;
const OUT_CAP = 256 * 1024;
const sha = b => createHash("sha256").update(b).digest("hex");
const GIT_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
const git = (dir, args, opts = {}) => execFileSync("git", ["-C", dir, "-c", "user.name=controller", "-c", "user.email=controller@example.invalid",
  "-c", "commit.gpgsign=false", ...args], { env: GIT_ENV, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...opts });

/** The patch a candidate makes on its base, as bytes the adapter can recompute from the repository. */
export const patchDigest = (repo, base, candidate) => sha(git(repo, ["diff", "--binary", "--no-renames", base, candidate]));

/** Writable mount points inside `root`, from mountinfo text (field 5 is the mount point, field 6 its options). */
export function writableUnder(mountinfo, root) {
  const unesc = s => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  const out = new Set();
  for (const line of mountinfo.split("\n").filter(Boolean)) {
    const f = line.split(" ");
    const point = unesc(f[4] ?? ""), opts = (f[5] ?? "").split(",");
    if (!opts.includes("rw")) continue;
    if (point === root) out.add(".");
    else if (point.startsWith(root + "/")) out.add(point.slice(root.length + 1));
  }
  return [...out].sort();
}

// The prelude: $1 nonce, $2 checkout, $3 the granted writable set ("a b c "); the worker's argv follows.
export const PRELUDE_REFUSED = 97;
const PRELUDE = [
  'n="$1"; r="$2"; want="$3"; shift 3',
  'got=$(awk -v r="$r" \'{ n = split($6, o, ","); w = 0; for (i = 1; i <= n; i++) if (o[i] == "rw") w = 1;' +
    ' if (w && ($5 == r || index($5, r "/") == 1)) print ($5 == r ? "." : substr($5, length(r) + 2)) }\' /proc/self/mountinfo | sort | tr "\\n" " ")',
  'rel=$(awk -v r="$r" \'$5 == r || index($5, r "/") == 1\' /proc/self/mountinfo | base64 -w0)',
  'if [ "$got" = "$want" ]; then v=ok; else v=refused; fi',
  'printf "OPHANIM-LAUNCH %s %s %s %s\\n" "$n" "$$" "$v" "$rel"',
  '[ "$v" = ok ] || exit ' + PRELUDE_REFUSED,
  'exec "$@"',
].join("\n");
export const READ_VIEW = ["--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
  "--ro-bind", "/etc/alternatives", "/etc/alternatives", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"];

/**
 * Launch `worker` (an argv the CONTROLLER chose) for `ticket` on a fresh checkout of its exact base and write the
 * receipt under `receiptRoot`. Returns { receipt, name, sha256, candidate|null }.
 */
export async function launchWorker({ repo, ticket, leases, worker, root, receiptRoot, timeoutMs = 60_000, now = () => Date.now(), bwrap = "bwrap", grant = null }) {
  if (!ticket?.key || !/^[0-9a-f]{40}$/.test(ticket.base ?? "") || !Array.isArray(ticket.scope) || !ticket.scope.length) throw new Error("launchWorker: ticket is { key, base (40 hex), scope }");
  if (!Array.isArray(worker) || !worker.length || !worker.every(a => typeof a === "string")) throw new Error("launchWorker: worker is an argv");
  for (const p of ticket.scope) if (isAbsolute(p) || p.split("/").includes("..")) throw new Error(`launchWorker: scope path ${p} is not a relative repository path`);
  const run_id = randomBytes(16).toString("hex");
  const checkout = join(mkdtempSync(join(root, "launch-")), "checkout");
  git(root, ["clone", "-q", "--no-hardlinks", "--no-checkout", resolvePath(repo), checkout]);
  git(checkout, ["checkout", "-q", "--detach", ticket.base]);
  const missing = ticket.scope.filter(p => !existsSync(join(checkout, p)) || !statSync(join(checkout, p)).isFile());
  // `grant` (tests only) lets a caller bind a different writable set from the scope the prelude checks against.
  const writable = grant ?? ticket.scope;
  const binds = writable.flatMap(p => ["--bind", join(checkout, p), join(checkout, p)]);
  const want = [...ticket.scope].sort().join(" ") + " ";
  const argv = ["--die-with-parent", "--unshare-net", "--unshare-pid", ...READ_VIEW, "--ro-bind", checkout, checkout, ...binds,
    "--chdir", checkout, "--", "/bin/sh", "-c", PRELUDE, "prelude", run_id, checkout, want, ...worker];
  const started_at = new Date(now()).toISOString();
  let r = null, launchError = null;
  if (!missing.length) {
    try { r = await spawnPromise(bwrap, argv, { env: { PATH: GIT_ENV.PATH, HOME: "/nonexistent" }, timeout: timeoutMs, maxBuffer: OUT_CAP }); }
    catch (e) { launchError = e?.code ?? String(e?.message ?? e); }
  }
  const ended_at = new Date(now()).toISOString();
  // The in-box observation: the FIRST stdout line, carrying this run's nonce.
  const first = (r?.stdout ?? "").split("\n")[0];
  const m = /^OPHANIM-LAUNCH ([0-9a-f]{32}) ([0-9]+) (ok|refused) ([A-Za-z0-9+/=]*)$/.exec(first);
  // Only the mount lines under the checkout are kept (bounded), never the host's whole mount table or worker output.
  const rel = m ? Buffer.from(m[4], "base64").toString("utf8") : null;
  const inbox = m && m[1] === run_id ? { pid: Number(m[2]), verdict: m[3], mounts_sha256: sha(rel), mounts: rel.split("\n").filter(Boolean).length,
    writable: writableUnder(rel, checkout) } : null;
  // What happened, distinguished: the box never seen; the prelude refused before the worker existed; the run was
  // stopped at its bound; the worker itself exited.
  const phase = missing.length || launchError || !r ? "not_launched" : !inbox ? "unobserved"
    : inbox.verdict === "refused" ? "prelude_refused" : r.killedFor ? `stopped_${r.killedFor}` : "worker_exited";
  const outcome = { phase, status: r?.status ?? null, signal: r?.signal ?? null, killed_for: r?.killedFor ?? null, launch_error: launchError,
    missing_scope: missing, stdout_bytes: Buffer.byteLength(r?.stdout ?? ""), stderr_bytes: Buffer.byteLength(r?.stderr ?? "") };
  const ok = phase === "worker_exited" && r.status === 0;
  let candidate = null, changed = [], patch_sha256 = null;
  if (ok) {
    const dirty = git(checkout, ["status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }).trim();
    if (dirty) {
      git(checkout, ["add", "-A"]);
      git(checkout, ["commit", "-q", "--no-verify", "-m", `worker delivery ${ticket.key} (run ${run_id})`]);
      candidate = git(checkout, ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      git(repo, ["fetch", "-q", checkout, candidate]);
      changed = git(repo, ["diff", "--name-only", "--no-renames", "-z", ticket.base, candidate], { encoding: "utf8" }).split("\0").filter(Boolean).sort();
      patch_sha256 = patchDigest(repo, ticket.base, candidate);
    }
  }
  const issued = now();
  const receipt = {
    kind: LAUNCH_KIND, v: 1, run_id, ticket: ticket.key, base: ticket.base, scope: [...ticket.scope].sort(),
    generations: Object.fromEntries([leases.item, ...leases.scopes].map(l => [l.resource, l.gen])),
    launch: { argv_sha256: sha(JSON.stringify([bwrap, ...argv])), worker_sha256: sha(JSON.stringify(worker)), started_at, ended_at, network: "unshared" },
    inbox, outcome, candidate, changed_paths: changed, patch_sha256,
    issued_at: new Date(issued).toISOString(), expires_at: new Date(issued + LAUNCH_TTL_MS).toISOString(),
  };
  const bytes = JSON.stringify(receipt);
  const name = `launch-${run_id}.json`;
  writeFileSync(join(receiptRoot, name), bytes);
  return { receipt, name, sha256: sha(bytes), candidate, checkout };
}
