// What the three subscription transports (codex-cli, grok-cli, agy-cli) share: the scrubbed environment, finding a
// CLI, running one bounded process, the commands and write rule the CLI harness lists, and the post-run check of the
// worktree. See subscription.mjs for the run and HARNESS-cli.md for the text the reviewer is shown.
import { access, constants, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { spawnPromise } from "../board/spawn.mjs";
import { shQuote } from "../agy/jail-hook.mjs";

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
export function allowedCommands({ permissions, worktree, prefixWithCd, telosRoot = null }) {
  const prefix = prefixWithCd ? `cd ${shQuote(worktree)} && ` : "";
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

export function writeRule({ write_allowed, worktree }) {
  return write_allowed
    ? `You may create and change files only under \`${REVIEW_TESTS_DIR}/\` in the copy (\`${worktree}/${REVIEW_TESTS_DIR}/\`), for example \`${REVIEW_TESTS_DIR}/<name>.test.mjs\`; give absolute paths where a tool asks for one. Write nothing anywhere else, inside the copy or outside it.`
    : "You may not create, change or delete any file, inside the copy or outside it.";
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
