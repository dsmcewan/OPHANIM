// Assignments 2 and 4 in subscription mode: Codex through the official TypeScript SDK (`@openai/codex-sdk`, pinned
// exactly in pantheon/package.json), signed in with ChatGPT. The owner's direction (2026-11-18): the SDK reports a
// failure explicitly (a `turn.failed` / `error` event, or a thrown error) where the bare CLI had to be checked.
//
// WHAT THE SDK DOES (read in the installed @openai/codex-sdk 0.170.0, dist/index.js; re-read on any version bump --
// the real-package test pins the parts this runner depends on):
// - It does not talk to OpenAI itself. It spawns the Codex CLI binary and reads JSONL from its stdout (index.js:267):
//   `<binary> exec --experimental-json [--config k=v ...] [--model M] [--sandbox S] [--cd DIR] [--skip-git-repo-check]
//   [--config approval_policy="..."] [resume <thread id>]` (index.js:178-247), the prompt written to its STDIN
//   (index.js:277), never in argv.
// - The binary: `codexPathOverride` when given, else its own resolution (index.js:397-485): @openai/codex (an npm
//   dependency of the SDK) -> the platform package @openai/codex-<os>-<arch> -> vendor/<target triple>/bin/codex, a
//   ~285 MB native binary (the platform package unpacks to ~408 MB), plus vendor/<triple>/codex-path (ripgrep)
//   prepended to PATH. The owner's `codex` on PATH is NOT used. This runner mirrors that resolution
//   (resolveSdkCodexBinary), runs the zero-spend preflight against that binary, and passes the same path as
//   `codexPathOverride`, so the preflight and the run are one binary by construction (the real-package test checks the
//   mirror against the SDK's own field).
// - The environment: `env` given -> the child gets exactly that, process.env is NOT inherited (index.js:248-257); the
//   SDK adds CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codex_sdk_ts when absent (index.js:258-260) and sets CODEX_API_KEY
//   ONLY when an `apiKey` option was passed (index.js:261-263, from `this._options.apiKey`, index.js:61). The README's
//   "the SDK still injects its required variables (such as CODEX_API_KEY)" is that conditional; the source decides.
//   This runner never passes `apiKey` or `baseUrl`, passes the scrubbed environment (no key, token or secret; HOME kept,
//   so the CLI finds ~/.codex/auth.json), and REFUSES when the installed SDK's source assigns CODEX_API_KEY anywhere
//   other than under `if (args.apiKey)` (sdkKeyInjection): a version that injected a key unconditionally would bill the
//   API, and that is not worked around.
// - Auth is the CLI's own: $CODEX_HOME (default ~/.codex)/auth.json, written by `codex login`. Observed with this binary
//   (0.170.0, scratch HOME, no credentials -> no spend): `codex login status` prints "Not logged in" (exit 1) with no
//   login, "API key configured - sk-…" with an API-key auth.json, and IGNORES a CODEX_API_KEY in the environment (it
//   still says "Not logged in") -- so the env scrub, not the status line, is what keeps an env key out. With
//   `--config forced_login_method="chatgpt"` the CLI refuses an API key before any request ("ChatGPT login is required,
//   but an API key is currently being used. Logging out.") AND deletes that API-key auth.json; this runner passes that
//   config (a second guard behind the preflight) unless --allow-api-key-in-cli.
// - The wall clock: TurnOptions.signal goes to child_process.spawn (index.js:269), so an abort SIGTERMs the codex
//   process. The SDK exposes no pid and does not spawn detached, so the runner cannot kill a process GROUP: codex's
//   own children (sandboxed commands) are left to codex's own teardown. If the stream has not ended ABORT_GRACE_MS
//   after the abort, the runner stops waiting and records it.
// - Resume: `resumeThread(id, threadOptions)` appends `resume <id>` AFTER the exec-level --model/--sandbox/--cd and the
//   approval config (index.js:195-242). Observed with this binary (no credentials): `exec --sandbox workspace-write --cd
//   <new dir> ... resume <id>` of a session recorded in a since-deleted directory reports `workdir: <new dir>`,
//   `sandbox: workspace-write`, `approval: never` -- the working directory and sandbox ARE set on resume (placed after
//   `resume`, as `codex exec resume --help` shows, they are not accepted). Sessions live in $CODEX_HOME/sessions.
//
// NOT VERIFIED HERE (no ChatGPT login on this machine; every run test uses a fake SDK or a fake binary): a real model
// turn, the text of `codex login status` for a ChatGPT login (parsed conservatively: an API-key mention wins; anything
// that does not say ChatGPT is refused), and that a ChatGPT sign-in bills the subscription (OpenAI's docs: "Sign in
// with ChatGPT for subscription access"). NO event names the served model (served_model_source: input).
//
// Codex runs its OWN bubblewrap sandbox; this runner does NOT wrap it in ours (except on WSL: an outer namespace, see
// "WSL: the outer runtime namespace" below, leaves the inner profile unchanged). Containment is a codex PERMISSION
// PROFILE the runner defines (codexPermissionProfile, below) with approval_policy never, checked before the run by
// `codex debug prompt-input` (the profile codex will actually apply, no model turn), plus the runner's post-run git
// check of the worktree (subscription.mjs), which records any write outside .review-tests/ (any write, assignment 4).
//
// WHY NOT `--sandbox read-only` / `workspace-write` (the 09d490f runs). Observed with this 0.170.0 binary through
// `codex sandbox -P <profile> -- <cmd>` (codex's own sandbox, no model, no credentials; the legacy modes map to the
// built-in profiles :read-only and :workspace, which `codex debug prompt-input` shows): with the network off, codex's
// seccomp filter refuses setsockopt(2) and shutdown(2), and libuv calls setsockopt(SO_RCVBUF/SO_SNDBUF) on the
// socketpair behind every piped child, so any node spawn with pipes fails EPERM (`spawnSync git EPERM`, and
// `node --test` itself, whose per-file child reports only "test failed"). :read-only also leaves no writable temp
// dir. The profile below instead:
//   - reads only :minimal (codex's runtime set: /usr, /etc, ...), the codex binary's vendor dir, the node install,
//     the worktree and (when given) the telos root -- so the owner's HOME (~/.codex/auth.json included), /tmp and
//     every host Unix socket outside those are invisible; /run and /var/run are denied outright;
//   - writes only a per-run scratch dir outside the worktree (the commands' TMPDIR) and, for assignments 1-3,
//     <worktree>/.review-tests;
//   - turns the network ON only behind codex's managed proxy (features.network_proxy) with NO allowed domain: the
//     commands run in their own network namespace (observed: the host's loopback is unreachable; https via the
//     proxy and SOCKS both fail), which also lifts the setsockopt filter;
//   - allows Unix sockets (dangerously_allow_all_unix_sockets): the pipeline's A2A shim listens on one under TMPDIR;
//     with the read set above, no host socket is reachable (observed: a host socket under /root, /tmp or /run is
//     ENOENT/EACCES inside).
// Still failing inside it, and said so to the reviewer: anything that starts bwrap (nested user namespaces are
// refused: "Creating new namespace failed" / "Failed to create NETLINK_ROUTE socket"), and a node fetch to a server
// the test started unless NO_PROXY names loopback (codex clears NO_PROXY and sets NODE_USE_ENV_PROXY=1). Since the
// test relay (relay.mjs) no test runs in this sandbox: the runner runs codex's requested tests in its verify jail.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactStrong } from "../board/agy-cli.mjs";
import { REVIEW_TESTS_DIR, runCli, tail } from "./cli-common.mjs";

export const CODEX_SDK_PACKAGE = "@openai/codex-sdk";
export const FORBIDDEN_SANDBOX = Object.freeze(["danger-full-access"]);
export const ABORT_GRACE_MS = 15_000;

/** `codex login status` -> {method: "chatgpt" | "api-key" | "none" | "unknown", raw (redacted)}. */
export function parseLoginStatus(text, exitCode, env = {}) {
  const t = String(text ?? "");
  let method = "unknown";
  if (/api[ _-]?key/i.test(t)) method = "api-key";                       // checked first: an API-key mention always wins
  else if (/not\s+(logged|signed)\s+in|logged\s+out|no\s+(credentials|auth)/i.test(t)) method = "none";
  else if (exitCode === 0 && /chatgpt/i.test(t) && /(logged|signed)\s+in/i.test(t)) method = "chatgpt";
  return { method, raw: redactStrong(t, env).trim().slice(0, 2000) };
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
/**
 * Does `codex debug models` list `model`? {status: "listed" | "missing" | "unknown", format: "json" | "lines" | null,
 * count}. JSON (0.170.0 prints {"models":[{"slug":...}]}): model ids are the string values of slug/id/model/name keys
 * (or a string array). Text: a line names the model when it holds it as a whole word; "missing" only when some line
 * starts with an id-shaped token containing a digit; otherwise "unknown".
 */
export function parseModelList(stdout, model) {
  const text = String(stdout ?? "").trim();
  if (!text) return { status: "unknown", format: null, count: 0 };
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  if (json !== undefined) {
    const ids = new Set();
    const walk = v => {
      if (typeof v === "string") return;
      if (Array.isArray(v)) { for (const x of v) { if (typeof x === "string" && ID.test(x)) ids.add(x); else walk(x); } return; }
      if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (["slug", "id", "model", "name"].includes(k) && typeof x === "string") ids.add(x); else walk(x); }
    };
    walk(json);
    if (!ids.size) return { status: "unknown", format: "json", count: 0 };
    return { status: ids.has(model) ? "listed" : "missing", format: "json", count: ids.size };
  }
  const esc = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = new RegExp(`(^|[^A-Za-z0-9._-])${esc}($|[^A-Za-z0-9._-])`);
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const idLines = lines.filter(l => { const f = l.replace(/^[-*•]\s+/, "").split(/\s+/)[0]; return ID.test(f) && /\d/.test(f) && /-/.test(f); });
  if (lines.some(l => word.test(l))) return { status: "listed", format: "lines", count: idLines.length };
  return { status: idLines.length ? "missing" : "unknown", format: idLines.length ? "lines" : null, count: idLines.length };
}

// ---- the permission profile ---------------------------------------------------------------------------------------

export const REVIEW_PERMISSION_PROFILE = "ophanim-review";
export const LOOPBACK_NO_PROXY = "127.0.0.1,localhost,::1";
const tq = s => JSON.stringify(String(s));
const inlineToml = o => `{${Object.entries(o).map(([k, v]) => `${tq(k)}=${v && typeof v === "object" ? inlineToml(v) : typeof v === "string" ? tq(v) : String(v)}`).join(", ")}}`;

/**
 * The codex permission profile of a review run, as raw `--config` overrides (passed to the SDK as `configOverrides`,
 * so codex sees exactly these strings), plus the file-system entries `codex debug prompt-input` must then report.
 * All paths absolute and real. `readRoots`: the codex vendor dir, the node install, the telos root.
 */
// L-404 (self-audit round 3, assignment 4 (sealed fe2a612)): reviewed tests ran here, in codex's own sandbox, as the
// codex CLI's children. Codex's sandbox cannot start the verify jail (nested namespaces are refused), so the code under
// review must not run here at all: `denyPaths` (the node and npm binaries the runner finds: codex.mjs callers pass them)
// are DENIED, and the node install is no longer a read root. Codex runs no test itself: it REQUESTS the review's verify
// launchers and the runner runs them outside this sandbox (relay.mjs; owner direction 2026-11-21).
export function codexPermissionProfile({ worktree, write_allowed, scratchTmp, readRoots = [], denyPaths = [] }) {
  const name = REVIEW_PERMISSION_PROFILE;
  for (const p of [worktree, scratchTmp, ...readRoots, ...denyPaths]) if (!String(p ?? "").startsWith("/")) throw new Error(`codex permission profile: ${p} is not an absolute path`);
  if (scratchTmp === worktree || scratchTmp.startsWith(worktree + "/")) throw new Error("codex permission profile: the scratch TMPDIR must be outside the worktree");
  const fs = { ":minimal": "read" };
  for (const r of [...new Set(readRoots)]) fs[r] = "read";
  for (const d of [...new Set(denyPaths)]) fs[d] = "deny";
  Object.assign(fs, { "/run": "deny", "/var/run": "deny", [scratchTmp]: "write" });
  const roots = { ".": "read", ...(write_allowed ? { [REVIEW_TESTS_DIR]: "write" } : {}) };
  const network = { enabled: true, dangerously_allow_all_unix_sockets: true };
  const overrides = [
    `default_permissions=${tq(name)}`,
    "features.network_proxy=true",
    `permissions.${name}.filesystem=${inlineToml({ ...fs, ":workspace_roots": roots })}`,
    `permissions.${name}.network=${inlineToml(network)}`,
    'web_search="disabled"',
  ];
  const expected = [
    ...Object.entries(fs).map(([k, v]) => `${v} ${k}`),
    `read ${worktree}`, ...(write_allowed ? [`write ${worktree}/${REVIEW_TESTS_DIR}`] : []),
  ].sort();
  return { name, overrides, expected_entries: expected, filesystem: { ...fs, ":workspace_roots": roots }, network, scratch_tmp: scratchTmp };
}

/**
 * What `codex debug prompt-input` says codex will apply: {found, type, entries ["<access> <path or :special>"],
 * network "enabled" | "restricted" | null}. Its JSON holds the model-visible <environment_context>, whose
 * <permission_profile> lists the file-system entries, and the permissions text ("Network access is ...").
 */
export function parsePromptPermissions(stdout) {
  let text = String(stdout ?? "");
  try { text = JSON.stringify(JSON.parse(text)).replace(/\\"/g, '"'); } catch { text = text.replace(/\\"/g, '"'); }
  const m = text.match(/<permission_profile([^>]*)>(.*?)<\/permission_profile>/);
  const net = text.match(/Network access is (enabled|restricted)/);
  if (!m) return { found: false, type: null, entries: [], network: net?.[1] ?? null };
  const entries = [...m[2].matchAll(/<entry access="(\w+)"[^>]*><(?:path|special)>([^<]*)<\/(?:path|special)><\/entry>/g)].map(x => `${x[1]} ${x[2]}`).sort();
  return { found: true, type: (m[1].match(/type="(\w+)"/) ?? [])[1] ?? null, file_system: (m[2].match(/<file_system type="(\w+)"/) ?? [])[1] ?? null, entries, network: net?.[1] ?? null };
}

/** Does the observed profile match the expected one exactly? {ok, missing, unexpected, why}. */
export function checkPromptPermissions(observed, expected) {
  if (!observed.found) return { ok: false, missing: expected, unexpected: [], why: "`codex debug prompt-input` named no permission profile" };
  const want = new Set(expected), got = new Set(observed.entries);
  // Codex adds one entry of its own: read access to the per-process helper it re-executes inside the sandbox
  // ($CODEX_HOME/tmp/arg0-linux/codex-arg0<random>; observed, 0.170.0). Only that shape, and only `read`, is tolerated.
  const own = e => /^read \/.+\/arg0-linux\/codex-arg0[A-Za-z0-9]+$/.test(e);
  const missing = expected.filter(e => !got.has(e)), unexpected = observed.entries.filter(e => !want.has(e) && !own(e));
  const why = [];
  if (missing.length || unexpected.length) why.push(`file-system entries differ (missing ${JSON.stringify(missing)}, unexpected ${JSON.stringify(unexpected)})`);
  if (observed.file_system !== "restricted") why.push(`file_system is ${observed.file_system}, not restricted`);
  if (observed.network !== "enabled") why.push(`network is ${observed.network} (the profile turns it on behind codex's proxy; anything else means another profile is in force)`);
  return { ok: why.length === 0, missing, unexpected, why: why.join("; ") || null };
}

// ---- WSL: the outer runtime namespace -------------------------------------------------------------------------------
// OBSERVED (owner, round 2 at 77480d6, WSL host, codex 0.170.0; findings-runs-77480d6/codex-runtime-mitigation.json):
// with the profile above, codex fails before any turn in its AGENTS helper -- its bwrap "cannot mkdir /run/WSL under
// denied /run": WSL mounts its interop socket dir at /run/WSL, and codex's sandbox setup re-creates host mounts under a
// path the profile denies. Removing WSL_INTEROP from the environment did not help; other codex binaries failed the same
// zero-turn check. What worked (both exact-profile preflights passed, both reviews ran): an OUTER bubblewrap namespace
// around codex -- the host read-only, a private tmpfs on /run (so /run/WSL is gone before codex starts) and on /tmp,
// only the task base writable -- with codex then applying the UNCHANGED inner profile. The runner adopts exactly that
// on WSL: the SDK's codexPathOverride (and every preflight command) is a launcher that execs
//   bwrap --die-with-parent --ro-bind / / --dev /dev --proc /proc --tmpfs /run --tmpfs /tmp
//         [--ro-bind <codex vendor dir>]  --bind <run dir> --bind <scratch TMPDIR> --bind <CODEX_HOME>  -- <codex> "$@"
// so the inner permission profile, and its exact-profile preflight, stay as they are. Writable inside the outer
// namespace: the run's temp dir (the review copy and the run dir), the scratch TMPDIR and $CODEX_HOME (codex's login,
// sessions and its per-process helper under tmp/arg0-linux); the inner profile narrows what the reviewer's commands
// may write to the scratch TMPDIR and .review-tests/. Cost, said in the plan and header: one more namespace level
// (codex's own bwrap runs nested inside the outer one; the reviewer's commands were already unable to nest bwrap).

/** Is this Linux running under WSL? {wsl, evidence}: /proc/sys/kernel/osrelease naming Microsoft/WSL, or WSL_DISTRO_NAME. */
export function detectWsl({ env = {}, osrelease = null } = {}) {
  const evidence = [];
  if (osrelease && /microsoft|wsl/i.test(osrelease)) evidence.push(`/proc/sys/kernel/osrelease is ${JSON.stringify(String(osrelease).trim())}`);
  if (env.WSL_DISTRO_NAME) evidence.push(`WSL_DISTRO_NAME is set (${JSON.stringify(env.WSL_DISTRO_NAME)})`);
  return { wsl: evidence.length > 0, evidence };
}
export function readOsRelease() { try { return readFileSync("/proc/sys/kernel/osrelease", "utf8").trim(); } catch { return null; } }

const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
/**
 * The outer launcher: {argv (the bwrap prefix, ending with the codex binary), script (a /bin/sh file that execs it with
 * "$@"), writable, read_only}. `writable`: absolute real paths bound read-write (each must exist); `readOnly`: paths
 * re-bound read-only after the /tmp tmpfs (the codex binary's dir may sit under /tmp).
 */
export function codexOuterLauncher({ bwrap, codex, writable, readOnly = [] }) {
  for (const p of [bwrap, codex, ...writable, ...readOnly]) if (!String(p ?? "").startsWith("/")) throw new Error(`codex outer runtime: ${p} is not an absolute path`);
  const argv = [bwrap, "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/run", "--tmpfs", "/tmp"];
  const depth = p => p.split("/").filter(Boolean).length;
  const binds = [...new Set(readOnly)].map(p => ({ mode: "ro", path: p })).concat([...new Set(writable)].map(p => ({ mode: "rw", path: p }))).sort((a, b) => depth(a.path) - depth(b.path));
  for (const b of binds) argv.push(b.mode === "rw" ? "--bind" : "--ro-bind", b.path, b.path);
  argv.push("--", codex);
  const script = `#!/bin/sh\n# The review runner's outer runtime for codex on WSL (codex.mjs codexOuterLauncher).\nexec ${argv.map(shq).join(" ")} "$@"\n`;
  return { argv, script, writable: binds.filter(b => b.mode === "rw").map(b => b.path), read_only: binds.filter(b => b.mode === "ro").map(b => b.path) };
}

// ---- the scratch TMPDIR: short enough for Unix sockets ---------------------------------------------------------------
// OBSERVED (round 2, assignment 4): with TMPDIR <HOME>/.cache/ophanim-review/ophanim-review-XXXXXX/run/tmp (107 bytes
// on the owner's host), pantheon/tests/pipeline-a2a.test.mjs failed 8/10 with `listen EINVAL` on
// $TMPDIR/pa2a-test-XXXXXX/a2a.sock, and a2aSocketFor's own short fallback under os.tmpdir() could not fit either
// ("no Unix socket path fits 107 bytes"). A Unix socket path holds at most 107 bytes on Linux (108 with the NUL); the
// repository's tests put nested dirs and a socket under $TMPDIR (measured here, 2026-11-19: pipeline-run.test.mjs's implementer
// contract test fails with a TMPDIR over 59 bytes, pipeline-a2a/-mcp pass at 59), so 48 leaves a margin. So the scratch
// TMPDIR must be at most SCRATCH_TMP_MAX bytes: a short dir directly under the review temp base when that fits, else a
// fresh 0700 dir under /var/tmp (never /tmp: the repository's jail fixtures mount a fresh tmpfs there, hiding the tests'
// own temp files from the code they jail; cli-common.mjs reviewTmpBase).
export const UNIX_SOCKET_PATH_MAX = 107;
export const SCRATCH_TMP_MAX = 48;
/** The candidate parents of the scratch TMPDIR, in order, with the mkdtemp prefix each would get. */
export const scratchCandidates = tmpBase => [{ parent: tmpBase, prefix: "t-" }, { parent: "/var/tmp", prefix: "ophanim-rt-" }];
/** Would mkdtemp under `parent` with `prefix` give a path of at most SCRATCH_TMP_MAX bytes? (mkdtemp adds 6 characters.) */
export const scratchFits = ({ parent, prefix }) => Buffer.byteLength(join(parent, prefix)) + 6 <= SCRATCH_TMP_MAX;

// ---- the installed SDK -----------------------------------------------------------------------------------------------

// The SDK's own table (index.js:149-156, 397-440): platform/arch -> target triple -> platform package.
const TRIPLE = { "linux-x64": "x86_64-unknown-linux-musl", "android-x64": "x86_64-unknown-linux-musl", "linux-arm64": "aarch64-unknown-linux-musl", "android-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin", "darwin-arm64": "aarch64-apple-darwin", "win32-x64": "x86_64-pc-windows-msvc", "win32-arm64": "aarch64-pc-windows-msvc" };
const PLATFORM_PACKAGE = { "x86_64-unknown-linux-musl": "@openai/codex-linux-x64", "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64", "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64", "x86_64-pc-windows-msvc": "@openai/codex-win32-x64", "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64" };
const isFile = p => { try { return statSync(p).isFile(); } catch { return false; } };
const isDir = p => { try { return statSync(p).isDirectory(); } catch { return false; } };

/**
 * The installed SDK: {ok, version, entry (dist/index.js), why?}. The package exports only an `import` condition, so it
 * is located with import.meta.resolve, not require.resolve.
 */
export function codexSdkInfo() {
  let entry;
  try { entry = fileURLToPath(import.meta.resolve(CODEX_SDK_PACKAGE)); } catch { return { ok: false, why: `${CODEX_SDK_PACKAGE} is not installed (run \`npm --prefix pantheon install\`)` }; }
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8"));
    return { ok: true, version: pkg.version ?? null, entry };
  } catch (e) { return { ok: false, why: `${CODEX_SDK_PACKAGE}'s package.json could not be read (${e.code ?? e.message})`, entry }; }
}

/**
 * The binary the SDK would spawn without `codexPathOverride`: the same steps as its findCodexPath (index.js:397-485).
 * {ok, path, path_dirs, triple, platform_package} | {ok: false, why}.
 */
export function resolveSdkCodexBinary({ entry, platform = process.platform, arch = process.arch } = {}) {
  const triple = TRIPLE[`${platform}-${arch}`];
  if (!triple) return { ok: false, why: `the Codex SDK has no binary for ${platform} (${arch})` };
  const platformPackage = PLATFORM_PACKAGE[triple];
  let root;
  try {
    const codexPkg = createRequire(entry).resolve("@openai/codex/package.json");
    root = join(dirname(createRequire(codexPkg).resolve(`${platformPackage}/package.json`)), "vendor", triple);
  } catch { return { ok: false, why: `the Codex CLI binaries were not found (@openai/codex and its optional dependency ${platformPackage}; reinstall without --omit=optional)` }; }
  const name = platform === "win32" ? "codex.exe" : "codex";
  const bin = join(root, "bin", name);
  if (isFile(bin) && isFile(join(root, "codex-package.json"))) return { ok: true, path: bin, path_dirs: [join(root, "codex-path")].filter(isDir), triple, platform_package: platformPackage };
  const legacy = join(root, "codex", name);
  if (isFile(legacy)) return { ok: true, path: legacy, path_dirs: [join(root, "path")].filter(isDir), triple, platform_package: platformPackage };
  return { ok: false, why: `the Codex CLI binary for ${triple} is missing under ${root}` };
}

/**
 * Where the SDK's source sets CODEX_API_KEY. {conditional: true} when every assignment is `env.CODEX_API_KEY =
 * args.apiKey;` directly under `if (args.apiKey) {` (so a run that passes no apiKey gets no key); otherwise false,
 * with the offending lines. A source that names CODEX_API_KEY in any other way is not conditional either.
 */
export function sdkKeyInjection(source) {
  const lines = String(source ?? "").split("\n"), sites = [], bad = [];
  lines.forEach((l, i) => {
    if (!l.includes("CODEX_API_KEY")) return;
    sites.push(i + 1);
    const prev = (lines.slice(0, i).reverse().find(x => x.trim()) ?? "").trim();
    if (!(l.trim() === "env.CODEX_API_KEY = args.apiKey;" && prev === "if (args.apiKey) {")) bad.push({ line: i + 1, text: l.trim().slice(0, 200) });
  });
  return { conditional: sites.length > 0 && bad.length === 0, sites, bad, ...(sites.length ? {} : { note: "no CODEX_API_KEY in the source: the SDK changed shape; re-read it" }) };
}

/** Everything the plan records about the installed SDK: {ok, version, entry, key_injection, binary} | {ok: false, why}. */
export function inspectCodexSdk() {
  const info = codexSdkInfo();
  if (!info.ok) return info;
  let source = null;
  try { source = readFileSync(info.entry, "utf8"); } catch (e) { return { ...info, ok: false, why: `${info.entry} could not be read (${e.code ?? e.message})` }; }
  return { ...info, key_injection: sdkKeyInjection(source), binary: resolveSdkCodexBinary({ entry: info.entry }) };
}

/**
 * The Codex constructor options. Never an apiKey or a baseUrl: the scrubbed env, the pinned binary, and the raw
 * permission-profile overrides (`configOverrides`, passed to the CLI unchanged). No override may name sandbox_mode
 * (that would switch codex back to the legacy sandbox settings) or danger-full-access.
 */
export function codexSdkOptions({ env, binary, allowApiKeyLogin = false, configOverrides = [] }) {
  const o = { env: { ...env }, codexPathOverride: binary };
  if (!allowApiKeyLogin) o.config = { forced_login_method: "chatgpt" };
  for (const c of configOverrides) if (/sandbox_mode|sandbox_workspace_write|danger-full-access|bypass/i.test(c)) throw new Error(`codex config override ${c}: refused`);
  if (configOverrides.length) o.configOverrides = [...configOverrides];
  for (const k of ["apiKey", "baseUrl"]) if (k in o) throw new Error(`codex SDK options carry ${k}: refused`);
  for (const k of Object.keys(o.env)) if (/^(CODEX_API_KEY|OPENAI_API_KEY|CODEX_ACCESS_TOKEN)$/.test(k)) throw new Error(`codex SDK env carries ${k}: refused`);
  return o;
}

/**
 * The ThreadOptions (names from the SDK's index.d.ts:252-265). NO sandboxMode: the SDK would pass `--sandbox`, and
 * codex then ignores the permission profile (docs: "If ... you pass --sandbox ... Codex uses those older sandbox
 * settings instead of default_permissions"). The profile comes from codexPermissionProfile via configOverrides.
 */
export function codexThreadOptions({ model, worktree }) {
  const o = { model, workingDirectory: worktree, skipGitRepoCheck: true, approvalPolicy: "never" };
  if ("sandboxMode" in o || FORBIDDEN_SANDBOX.includes(o.sandboxMode)) throw new Error("codex thread options carry a sandbox mode: refused");
  return o;
}

/** The argv the SDK builds from these options (index.js:178-247), for the plan and the transcript. The prompt goes to stdin. */
export function sdkSpawnArgv({ binary, sdkOptions, threadOptions, resumeId = null }) {
  const a = [binary, "exec", "--experimental-json"];
  for (const [k, v] of Object.entries(sdkOptions.config ?? {})) a.push("--config", `${k}=${JSON.stringify(v)}`);
  for (const c of sdkOptions.configOverrides ?? []) a.push("--config", c);
  const t = threadOptions;
  if (t.model) a.push("--model", t.model);
  if (t.sandboxMode) a.push("--sandbox", t.sandboxMode);
  if (t.workingDirectory) a.push("--cd", t.workingDirectory);
  if (t.skipGitRepoCheck) a.push("--skip-git-repo-check");
  if (t.approvalPolicy) a.push("--config", `approval_policy="${t.approvalPolicy}"`);
  if (resumeId) a.push("resume", resumeId);
  return a;
}

/**
 * Zero-spend preflight on the binary the SDK will spawn: version, login status (must be ChatGPT), model catalog, and
 * (with `permissions`: {overrides, expected_entries, cwd}) the permission profile codex will apply, as `codex debug
 * prompt-input` renders it with the same overrides and working directory (no model turn).
 */
export async function codexPreflight({ cli, env, model, opts, sdk, permissions = null, timeoutMs = 60_000 }) {
  const checks = {}, failed = [];
  if (sdk) {
    checks.sdk = sdk;
    if (sdk.ok === false) failed.push(`the Codex SDK is not usable: ${sdk.why}`);
    else if (sdk.key_injection && !sdk.key_injection.conditional) failed.push(`the installed ${CODEX_SDK_PACKAGE} ${sdk.version} sets CODEX_API_KEY other than only when an apiKey option is passed (${JSON.stringify(sdk.key_injection.bad ?? sdk.key_injection.note)}): that would bill the API, so subscription mode refuses to run it`);
  }
  const v = await runCli({ cmd: cli, args: ["--version"], env, timeoutMs });
  checks.version = { argv: [cli, "--version"], exit_code: v.exit_code, text: redactStrong(v.stdout.trim() || v.stderr, env).trim().slice(0, 200) || null, ...(v.spawn_error ? { spawn_error: v.spawn_error } : {}) };
  if (v.exit_code !== 0) failed.push(`\`codex --version\` failed (exit ${v.exit_code ?? v.killed_for ?? v.spawn_error})`);
  const l = await runCli({ cmd: cli, args: ["login", "status"], env, timeoutMs });
  const login = parseLoginStatus(`${l.stdout}\n${l.stderr}`, l.exit_code, env);
  checks.login_status = { argv: [cli, "login", "status"], exit_code: l.exit_code, auth_method_observed: login.method, raw_redacted: login.raw };
  if (login.method === "api-key" && !opts.allowApiKeyInCli) failed.push("`codex login status` reports an API key (usage-based billing); subscription mode needs \"Sign in with ChatGPT\" (run `codex logout` then `codex login`), or pass --allow-api-key-in-cli to accept metered billing explicitly");
  else if (login.method === "none") failed.push("`codex login status` reports no login: run `codex login` and choose \"Sign in with ChatGPT\"");
  else if (login.method === "unknown") failed.push("`codex login status` did not say it is signed in with ChatGPT (its text is recorded, redacted): refusing rather than guessing the billing");
  const m = await runCli({ cmd: cli, args: ["debug", "models"], env, timeoutMs });
  const list = m.exit_code === 0 ? parseModelList(m.stdout, model) : { status: "unknown", format: null, count: 0 };
  checks.model_list = { argv: [cli, "debug", "models"], exit_code: m.exit_code, model, ...list, stderr_tail: redactStrong(tail(m.stderr, 1000), env) };
  if (list.status === "missing") failed.push(`\`codex debug models\` does not list ${model}`);
  else if (list.status === "unknown" && !opts.skipModelCheck) failed.push(`\`codex debug models\` could not be read for ${model} (status unknown); pass --skip-model-check to run without that check`);
  if (permissions) {
    const args = ["debug", "prompt-input", ...permissions.overrides.flatMap(c => ["--config", c]), "permission check"];
    const pi = await runCli({ cmd: cli, args, cwd: permissions.cwd, env, timeoutMs });
    const seen = parsePromptPermissions(pi.stdout);
    const verdict = checkPromptPermissions(seen, permissions.expected_entries);
    checks.permission_profile = { argv: [cli, ...args], cwd: permissions.cwd, exit_code: pi.exit_code, observed: seen, expected_entries: permissions.expected_entries, ok: verdict.ok, why: verdict.why,
      ...(pi.exit_code !== 0 ? { stderr_tail: redactStrong(tail(pi.stderr, 1000), env) } : {}) };
    if (pi.exit_code !== 0) failed.push(`\`codex debug prompt-input\` failed (exit ${pi.exit_code ?? pi.killed_for ?? pi.spawn_error}): the permission profile codex would apply could not be checked`);
    else if (!verdict.ok) failed.push(`codex would not apply the review's permission profile: ${verdict.why}`);
  }
  return { ok: failed.length === 0, failed, checks, cli_version: checks.version.text, auth_method_observed: login.method, model_check: list.status };
}

// ---- resume -----------------------------------------------------------------------------------------------------------

const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
/**
 * Is the earlier thread on this machine? The CLI keeps sessions as $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<id>
 * .jsonl (observed, 0.170.0). Returns the rollout path or null (then the runner falls back to the replayed appendix).
 */
export function findCodexSession(threadId, env) {
  if (!THREAD_ID.test(String(threadId ?? ""))) return null;
  const home = env?.CODEX_HOME || (env?.HOME ? join(env.HOME, ".codex") : null);
  if (!home) return null;
  const want = `-${threadId}.jsonl`;
  const walk = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(want)) return p;
      if (e.isDirectory() && depth < 4) { const r = walk(p, depth + 1); if (r) return r; }
    }
    return null;
  };
  return walk(join(home, "sessions"), 0);
}

// ---- the run ----------------------------------------------------------------------------------------------------------

const cap = (x, n = 16 * 1024) => { x = String(x ?? ""); return x.length > n ? `${x.slice(0, n)}… (${x.length} chars, truncated)` : x; };
const addUsage = (t, u) => { for (const [k, v] of Object.entries(u ?? {})) if (typeof v === "number") t[k] = (t[k] ?? 0) + v; return t; };

/** A fresh event log: what the transcript keeps of the SDK's ThreadEvents (index.d.ts:106-167). */
export function newCodexLog() {
  // own: the reviewer's own messages and tool results, in order (for a --continue that replays them).
  return { thread_id: null, usage: {}, final_text: null, commands: [], file_changes: [], other_items: {}, item_errors: [], errors: [], turn_failed: null, events: 0, turns_completed: 0, own: [] };
}

/** Fold one ThreadEvent into the log. */
export function applyCodexEvent(out, e) {
  if (!e || typeof e !== "object") return out;
  out.events++;
  if (e.type === "thread.started") out.thread_id = e.thread_id ?? null;
  else if (e.type === "turn.completed") { out.turns_completed++; addUsage(out.usage, e.usage); }
  else if (e.type === "turn.failed") out.turn_failed = String(e.error?.message ?? "turn failed").slice(0, 1000);
  else if (e.type === "error") out.errors.push(String(e.message ?? "error").slice(0, 1000));
  else if (e.type === "item.completed") {
    const it = e.item ?? {};
    if (it.type === "agent_message" && typeof it.text === "string") { out.final_text = it.text; out.own.push({ kind: "your message", text: cap(it.text) }); }
    else if (it.type === "command_execution") {
      // `denied` (the coverage gate, coverage.mjs; L-501): the sandbox refused the command a path (its own output says so).
      out.commands.push({ command: String(it.command ?? "").slice(0, 2000), exit_code: it.exit_code ?? null, status: it.status ?? null,
        denied: /Permission denied|Operation not permitted|\bEACCES\b|\bEPERM\b|declined|rejected/i.test(`${it.aggregated_output ?? ""} ${it.status ?? ""}`) });
      out.own.push({ kind: "command and its output", text: cap(`$ ${it.command ?? ""}\n(exit ${it.exit_code ?? "?"})\n${it.aggregated_output ?? ""}`) });
    } else if (it.type === "file_change") {
      out.file_changes.push({ changes: (it.changes ?? []).map(c => ({ path: c.path ?? null, kind: c.kind ?? null })), status: it.status ?? null });
      out.own.push({ kind: "file change", text: (it.changes ?? []).map(c => `${c.kind ?? "?"} ${c.path ?? "?"}`).join("\n") });
    } else if (it.type === "error") out.item_errors.push(String(it.message ?? "").slice(0, 1000));   // non-fatal (index.d.ts:83)
    else if (typeof it.type === "string") out.other_items[it.type] = (out.other_items[it.type] ?? 0) + 1;
  }
  return out;
}

/** Fold a list of ThreadEvents (a test helper and the replay of a recorded stream). */
export function parseCodexEvents(events) { const out = newCodexLog(); for (const e of events) applyCodexEvent(out, e); return out; }

const wallStop = (wall, stalled, graceMs) => `wall clock reached (${wall} s): the SDK's abort signal stopped codex${stalled ? `; its event stream had not ended ${graceMs / 1000} s later, so the runner stopped waiting` : ""}`;

// Top-level `error` events are NOT failures by themselves: index.d.ts calls them "unrecoverable", but the 0.170.0 CLI
// emits one per transport retry ({"type":"error","message":"Reconnecting... 2/5 (...)"}, observed) before it either
// recovers or ends with `turn.failed` and exit 1. They are recorded; the failure is the turn.failed / the thrown error.
/**
 * One SDK turn. `Codex` is the SDK constructor (the real one, or a test's fake). Returns {status: "complete" |
 * "failed" | "incomplete", stop_reason, usage, final_text, record}. A failure the SDK reports -- a `turn.failed`
 * event, or a thrown error (a non-zero CLI exit, a spawn error, an unparseable line) -- is `failed`, with its
 * message (error events alone only when no final message came); the wall clock is `incomplete`; a turn that ends
 * without a final message and without an error is `incomplete`.
 */
export async function runCodexSdk({ Codex, sdkOptions, threadOptions, prompt, wall, resumeId = null, redactEnv = {}, graceMs = ABORT_GRACE_MS }) {
  const log = newCodexLog();
  const ac = new AbortController();
  let timedOut = false, stalled = false, thrown = null, thread = null, graceTimer = null;
  const wallTimer = setTimeout(() => { timedOut = true; ac.abort(new Error(`wall clock (${wall} s)`)); }, wall * 1000);
  try {
    const codex = new Codex(sdkOptions);
    thread = resumeId ? codex.resumeThread(resumeId, threadOptions) : codex.startThread(threadOptions);
    const { events } = await thread.runStreamed(prompt, { signal: ac.signal });
    const consume = (async () => { for await (const e of events) applyCodexEvent(log, e); return "done"; })();
    const backstop = new Promise(res => ac.signal.addEventListener("abort", () => { graceTimer = setTimeout(() => res("stalled"), graceMs); }, { once: true }));
    if (await Promise.race([consume, backstop]) === "stalled") { stalled = true; consume.catch(() => {}); }
  } catch (e) { thrown = e; }
  finally { clearTimeout(wallTimer); clearTimeout(graceTimer); }
  const red = s => redactStrong(String(s ?? ""), redactEnv);
  const record = { thread_id: log.thread_id ?? thread?.id ?? null, ...(resumeId ? { resumed_thread_id: resumeId } : {}), events: log.events, turns_completed: log.turns_completed,
    commands: log.commands, file_changes: log.file_changes, other_items: log.other_items, item_errors: log.item_errors.map(red), errors: log.errors.map(red),
    turn_failed: log.turn_failed && red(log.turn_failed), sdk_error: thrown ? red(tail(thrown.message ?? thrown, 2000)) : null,
    aborted_by_wall_clock: timedOut, abort_stalled: stalled, own: log.own };
  const base = { usage: log.usage, final_text: log.final_text, record };
  if (timedOut) return { ...base, status: "incomplete", killed_for: "timeout", stop_reason: wallStop(wall, stalled, graceMs) };
  if (log.turn_failed) return { ...base, status: "failed", stop_reason: `codex reported turn.failed: ${record.turn_failed}` };
  if (thrown) return { ...base, status: "failed", stop_reason: `the Codex SDK reported a failure: ${tail(record.sdk_error, 1000)}` };
  if (!log.final_text || !log.final_text.trim()) {
    if (log.errors.length) return { ...base, status: "failed", stop_reason: `codex reported an error and no final message: ${record.errors.at(-1)}` };
    return { ...base, status: "incomplete", stop_reason: "codex ended the turn without a final message" };
  }
  return { ...base, status: "complete", stop_reason: "final answer" };
}
