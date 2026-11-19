// What the three subscription transports (codex-cli, grok-cli, agy-cli) share: the scrubbed environment, finding a
// CLI, running one bounded process, the commands and write rule the CLI harness lists, and the post-run check of the
// worktree. See subscription.mjs for the run and HARNESS-cli.md for the text the reviewer is shown.
import { access, constants, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { spawnPromise } from "../board/spawn.mjs";
import { REVIEW_SUITE_LAUNCHER, REVIEW_TEST_LAUNCHER, shQuote } from "../agy/jail-hook.mjs";

// A name whose value a CLI child never receives in subscription mode: any key, token or secret. A key in the
// environment is how each of these CLIs switches to metered billing (OpenAI: CODEX_API_KEY "forces API-key usage for
// one invocation"; xAI: "In non-browser environments, use an API key" XAI_API_KEY), so none may reach the child.
export const CLI_SECRETISH = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE/i;
// Also never passed: NODE_OPTIONS (it can load code into a node-based CLI), and these by name.
const ALWAYS_DROP = ["NODE_OPTIONS", "OPENAI_API_KEY", "CODEX_API_KEY", "XAI_API_KEY", "GROK_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];

/**
 * The child environment of a subscription CLI: the parent's, minus every secret-looking name, the named keys and any
 * proxy URL that carries user:pass@. HOME is kept (each CLI finds its own login under it). Returns {env, removed:
 * [names]} (names only; a value is never recorded).
 */
export function scrubEnv(parent, { drop = [], set = {} } = {}) {
  const env = {}, removed = [];
  for (const [k, v] of Object.entries(parent ?? {})) {
    if (typeof v !== "string") continue;
    if (CLI_SECRETISH.test(k) || ALWAYS_DROP.includes(k) || drop.includes(k) || (/_proxy$/i.test(k) && /:\/\/[^/]*@/.test(v))) { removed.push(k); continue; }
    env[k] = v;
  }
  Object.assign(env, set);
  return { env, removed: removed.sort() };
}

/** The secret values of `parent` (for redaction): every value of a secret-looking name, 8 characters or longer. */
export const secretValues = parent => Object.entries(parent ?? {}).filter(([k, v]) => typeof v === "string" && v.length >= 8 && (CLI_SECRETISH.test(k) || ALWAYS_DROP.includes(k))).map(([, v]) => v);

const executable = p => access(p, constants.X_OK).then(() => true, () => false);
/** The CLI to run: `explicit` (must exist and be executable) or the first `name` on env.PATH. Real path, or null. */
export async function findCli(name, explicit, env) {
  if (explicit) return (await executable(explicit)) ? realpath(explicit) : null;
  for (const d of String(env?.PATH ?? "").split(delimiter).filter(x => x && isAbsolute(x))) {
    const p = join(d, name);
    if (await executable(p)) return realpath(p);
  }
  return null;
}

/** One bounded process (async spawn, its process group killed at the timeout). Never throws: a spawn failure is a result. */
export async function runCli({ cmd, args, cwd, env, timeoutMs, onLine }) {
  try {
    const r = await spawnPromise(cmd, args, { cwd, env, timeout: timeoutMs, onStdoutLine: onLine, killGraceMs: 2000 });
    return { exit_code: r.status, killed_for: r.killedFor ?? null, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
  } catch (e) {
    return { exit_code: null, killed_for: null, spawn_error: String(e?.code ?? e?.message ?? e), stdout: "", stderr: "" };
  }
}

/** The last `n` bytes of a text, for a record. */
export const tail = (s, n = 4000) => { s = String(s ?? ""); return s.length > n ? s.slice(-n) : s; };

// ---- what the reviewer may run and write --------------------------------------------------------------------------

export const REVIEW_TESTS_DIR = ".review-tests";
// The test files an assignment with its own tests may run (as the API runner's run_tests: existing *.test.mjs under
// ophanim/ or pantheon/tests/, or one the reviewer wrote under .review-tests/).
export const OPEN_TEST_GLOBS = Object.freeze(["ophanim/**/*.test.mjs", "pantheon/tests/**/*.test.mjs", ".review-tests/**/*.test.mjs"]);

/**
 * The commands the CLI harness lists and (for agy) the jail hook enforces. `prefix` is "cd '<worktree>' && " for agy
 * (run_command has no working directory) and "" for the CLIs that run in the worktree. Returns {lines (markdown list
 * items), run_command_policy (jail.json), suites, files (listed-only) | null, write_allowed}.
 */
export function allowedCommands({ permissions, worktree, prefixWithCd = false, telosRoot = null, envPrefix = "", launcherDir = null }) {
  // envPrefix: codex's `env NO_PROXY=... ` (codex clears NO_PROXY inside its sandbox; codex.mjs).
  // launcherDir (agy): the review's control dir. CREDENTIAL ISOLATION: the code under review runs only through the verify
  // launchers written there (prepareReviewWorkspace; src/agy/verify-jail.mjs): `<dir>/pantheon-test <files>` and
  // `<dir>/pantheon-suite-<name>`, never as agy's own child (agy holds the OAuth scratch copy).
  if (launcherDir) return launcherCommands({ permissions, launcherDir, telosRoot });
  const prefix = (prefixWithCd ? `cd ${shQuote(worktree)} && ` : "") + envPrefix;
  const listed = permissions.run_tests.files ?? null;
  const lines = [];
  if (listed) {
    for (const f of listed) lines.push(`- \`${prefix}node --test ${f}\``);
  } else {
    lines.push(`- \`${prefix}node --test <files>\`, where \`<files>\` is one or more worktree-relative paths separated by single spaces, each an existing \`*.test.mjs\` file under \`ophanim/\` or \`pantheon/tests/\`, or a test file you wrote under \`${REVIEW_TESTS_DIR}/\` (for example \`${prefix}node --test ${REVIEW_TESTS_DIR}/my-check.test.mjs\`)`);
  }
  const suites = {};
  if (permissions.run_suite) {
    suites.proof = `${prefix}${telosRoot ? `OPHANIM_TELOS_ROOT=${shQuote(telosRoot)} ` : ""}npm run test:proof`;
    suites.pantheon = `${prefix}npm --prefix pantheon test`;
    suites.all = `${prefix}npm test`;
    for (const c of Object.values(suites)) lines.push(`- \`${c}\``);
  }
  const write_allowed = Boolean(permissions.write_test);
  return {
    prefix, lines, suites, files: listed, write_allowed,
    run_command_policy: { kind: "node-test", files: listed, allowed_files_glob: listed ? [] : [...OPEN_TEST_GLOBS], max_files: 50, suites },
  };
}
/** The agy review's commands: the verify launchers (see allowedCommands). `suite_scripts` is what each suite launcher runs. */
function launcherCommands({ permissions, launcherDir, telosRoot }) {
  const test = `${launcherDir}/${REVIEW_TEST_LAUNCHER}`;
  const listed = permissions.run_tests.files ?? null;
  const lines = [];
  if (listed) for (const f of listed) lines.push(`- \`${test} ${f}\``);
  else lines.push(`- \`${test} <files>\`, where \`<files>\` is one or more worktree-relative paths separated by single spaces, each an existing \`*.test.mjs\` file under \`ophanim/\` or \`pantheon/tests/\`, or a test file you wrote under \`${REVIEW_TESTS_DIR}/\` (for example \`${test} ${REVIEW_TESTS_DIR}/my-check.test.mjs\`); it runs \`node --test <files>\` in the copy`);
  const suites = {}, suite_scripts = {};
  if (permissions.run_suite) {
    suite_scripts.proof = `${telosRoot ? `OPHANIM_TELOS_ROOT=${shQuote(telosRoot)} ` : ""}npm run test:proof`;
    suite_scripts.pantheon = "npm --prefix pantheon test";
    suite_scripts.all = "npm test";
    for (const [n, sc] of Object.entries(suite_scripts)) { suites[n] = `${launcherDir}/${REVIEW_SUITE_LAUNCHER(n)}`; lines.push(`- \`${suites[n]}\` (it runs \`${sc}\` in the copy)`); }
  }
  const write_allowed = Boolean(permissions.write_test);
  return {
    prefix: "", lines, suites, files: listed, write_allowed,
    run_command_policy: { kind: "node-test", launcher: test, files: listed, allowed_files_glob: listed ? [] : [...OPEN_TEST_GLOBS], max_files: 50, suites, suite_scripts,
      extra_ro: telosRoot ? [telosRoot] : [] },
  };
}

const TESTS_OWN_TEMP = "The temporary files the authorized tests create for themselves (under `$TMPDIR`) are theirs, not yours.";
export function writeRule({ write_allowed, worktree }) {
  return write_allowed
    ? `You may create and change files only under \`${REVIEW_TESTS_DIR}/\` in the copy (\`${worktree}/${REVIEW_TESTS_DIR}/\`), for example \`${REVIEW_TESTS_DIR}/<name>.test.mjs\`; give absolute paths where a tool asks for one. Write nothing anywhere else, inside the copy or outside it. ${TESTS_OWN_TEMP}`
    : `You may not create, change or delete any file, inside the copy or outside it. ${TESTS_OWN_TEMP}`;
}

// The read-only shell commands a command-line reviewer may use to read the source (codex, grok). Reading is the
// review: the 09d490f run of assignment 4 read the old "You may run only these commands" literally, ran only tests,
// and read no source at all.
export const READ_ONLY_SHELL = Object.freeze(["cat", "head", "tail", "sed -n", "nl", "wc", "ls", "find", "rg", "grep", "diff", "cmp", "file", "stat",
  "git log", "git show", "git diff", "git grep", "git ls-files", "git blame", "git status", "git rev-parse"]);

/** How the reviewer reads the source: agy has file-reading tools and a jail-limited run_command; codex and grok read with the shell. */
export function readRule({ transport }) {
  if (transport === "agy-cli") {
    return "Reading the source is the review. Read any file in the copy with your file-reading tools (`read_file`, `view_file`, `view_file_outline`, `view_code_item`, `list_dir`, `find_by_name`, `grep_search`, `codebase_search`): they are permitted for this and are not limited by the list under Commands. `run_command` is limited to that list (the jail refuses any other command, `cat` and `ls` included), so read files with those tools, not with the shell. Cite what you read as `file:line`.";
  }
  const cmds = READ_ONLY_SHELL.map(c => `\`${c}\``).join(", ");
  return [
    "Reading the source is the review. Read any file in the copy, and its git history, with your own file-reading tools or with read-only shell commands. Both are permitted for this and are not limited by the list under Commands. The read-only commands are:",
    "",
    `${cmds}, alone or piped into one another (\`find\` without \`-delete\`, \`-exec\`, \`-execdir\`, \`-ok\`, \`-fprint\` or \`-fls\`).`,
    "",
    "A read-only command writes no file (no `>`, `>>` or `tee`, no `sed -i`), changes no git state, starts no other program and reaches no network. Cite what you read as `file:line`.",
  ].join("\n");
}

/** What the reviewer should know about the sandbox its commands run in. */
export function sandboxNote({ transport, scratchTmp = null }) {
  const bwrap = "Tests that start a bwrap jail of their own cannot do so in this sandbox (nested namespaces are refused): they skip with \"bwrap unavailable\" or fail with \"Creating new namespace failed\" / \"Failed to create NETLINK_ROUTE socket\". Report what such a test would have shown as `cannot tell` (a limit of this environment), not as a defect, and say so.";
  if (transport === "codex-sdk") {
    return [`Your commands run in Codex's own sandbox under the runner's permission profile: they can read only the copy, the system's runtime files, the node install and the codex binary; they can write only \`$TMPDIR\` (\`${scratchTmp}\`, a per-run scratch directory outside the copy, deleted after the run) and what the Writing section allows; the network is cut (codex's proxy, with no host allowed). Codex clears \`NO_PROXY\` there, which is why the test commands above start with \`env NO_PROXY=...\`: without it a test's request to a server it started on 127.0.0.1 goes to the proxy and fails (403 or \"fetch failed\"). Run them as written.`, "", bwrap].join("\n");
  }
  if (transport === "grok-cli") return `Your commands run in the runner's bubblewrap jail: the host is read-only, \`/tmp\` is a fresh private directory (\`$TMPDIR\` is \`/tmp\`), and the copy is read-only except what the Writing section allows. The jail does not cut the network (the CLI itself must reach xAI); make no network request yourself.\n\n${bwrap}`;
  return `Your test commands run in a separate verify jail, through the launchers listed above: it sees only the copy (writable as the Writing section allows), the system's runtime files and the node install, with a fresh private \`/tmp\` (\`$HOME\` is \`/tmp/home\`), no network at all (its own loopback only) and none of your environment. Your file tools run in the CLI's own bubblewrap jail with its PreToolUse hook, which refuses any write or command this harness does not allow.\n\n${bwrap}`;
}

/**
 * Where a review run's temp dir (the worktree, the run dir) goes: NOT under /tmp. The repository's jail fixtures
 * mount a fresh tmpfs on /tmp (src/agy/sandbox.mjs bwrapArgs), so code checked out under /tmp is hidden inside the
 * jails the tests start (observed at 604d297: ophanim/operate/fit-lifecycle.test.mjs passes 5/5 in a worktree under
 * /root and 1-3/5 in one under /tmp). Default ~/.cache/ophanim-review (created 0700).
 */
export function reviewTmpBase(env) {
  return join(env?.HOME || homedir(), ".cache", "ophanim-review");
}

// ---- the post-run check of the worktree ---------------------------------------------------------------------------

/**
 * The worktree's state as git sees it: {head, entries: Map<path, code>} from `git status --porcelain=v1 -z
 * --untracked-files=all --ignored=matching` (renames and copies count both paths). `git` is (args) => {code, stdout}.
 */
export async function worktreeState(git) {
  const h = await git(["rev-parse", "HEAD"]);
  const s = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]);
  const entries = new Map();
  const parts = s.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const code = e.slice(0, 2), p = e.slice(3);
    entries.set(p, code);
    if (/[RC]/.test(code) && parts[i + 1]) { entries.set(parts[i + 1], code); i++; }
  }
  return { head: h.code === 0 ? h.stdout.trim() : null, entries, ok: h.code === 0 && s.code === 0 };
}

/**
 * Compare the worktree before and after the run. A path is changed when it is new in `git status` or its code
 * changed. Allowed: paths under .review-tests/ when `write_allowed`, nothing otherwise. A moved HEAD is a violation.
 * Returns {changed: [paths], violations: [paths | "HEAD moved ..."], limits: [...]}.
 */
export function compareWorktree(before, after, { write_allowed }) {
  const changed = [];
  for (const [p, code] of after.entries) if (before.entries.get(p) !== code) changed.push(p);
  for (const p of before.entries.keys()) if (!after.entries.has(p)) changed.push(p);
  changed.sort();
  const violations = changed.filter(p => !(write_allowed && p.startsWith(`${REVIEW_TESTS_DIR}/`) && !p.split("/").includes("..")));
  if (before.head !== after.head) violations.push(`HEAD moved from ${before.head} to ${after.head}`);
  if (!before.ok || !after.ok) violations.push("git status could not be read before and after the run: the check is incomplete");
  return { changed, violations,
    limits: ["a change inside a directory git already listed as ignored before the run (e.g. node_modules/) is not seen",
      "only the worktree is checked: a CLI's own sandbox decides what it could write elsewhere"] };
}
