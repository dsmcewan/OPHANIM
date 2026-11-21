// `--via subscription`: one command-line agent per vendor, signed in to the owner's SUBSCRIPTION, instead of the metered
// API (index.mjs, `--via api`). Assignment 1 (Google) -> agy-cli, 2 and 4 (OpenAI) -> codex-sdk (the Codex TypeScript SDK,
// which drives the Codex CLI binary it ships; codex.mjs), 3 (xAI) -> grok-cli.
//
// The reviewer is shown HARNESS-cli.md (values filled in) + "\n\n---\n\n" + the README and its assignment file verbatim +
// one commit line; the sha256 of each part and of the whole prompt is recorded. A subscription run that cannot start
// REFUSES (exit 1): it never falls back to the API, and no API key reaches a CLI (scrubEnv), so a CLI cannot switch to
// metered billing on its own. `--dry-run` runs only the zero-spend preflights (versions, login status, model list, agy
// /usage) and prints the plan; no model turn.
//
// Limits: `--max-wall-s` (required) is the whole run's wall clock (with `--timeout-s` also given, the smaller one); the
// CLI's process group is killed when it is reached (Codex: the SDK's abort signal stops the codex process; codex.mjs). The API caps (--max-turns, --max-tool-calls, --max-output-tokens)
// have no CLI equivalent and are ignored with a printed note. Usage is what the CLI reports.
//
// After the run the worktree is compared with its state before (git status, cli-common.mjs compareWorktree): any changed
// path outside .review-tests/ (any change at all for assignment 4) or a moved HEAD is a policy violation, recorded in
// the findings header, and the run's status becomes `policy_violation`. A failure the transport itself reports (Codex:
// `turn.failed` or an error the SDK throws) is status `failed`, with that message as the stop reason; it can be
// continued like an incomplete run.
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile, access } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { REVIEW_DIR, SEPARATOR, renderHarness, reviewerHeaderLines, sha256 } from "./brief.mjs";
import { WITHHELD } from "./sandbox.mjs";
import { redact } from "./vendors.mjs";
import { allowedCommands, compareWorktree, findCli, readRule, reviewTmpBase, runCli, sandboxNote, scrubEnv, secretValues, tail, worktreeState, writeRule, REVIEW_TESTS_DIR } from "./cli-common.mjs";
import { CODEX_SDK_PACKAGE, LOOPBACK_NO_PROXY, codexPermissionProfile, codexPreflight, codexSdkOptions, codexThreadOptions, findCodexSession, inspectCodexSdk, runCodexSdk, sdkSpawnArgv,
  SCRATCH_TMP_MAX, UNIX_SOCKET_PATH_MAX, codexOuterLauncher, detectWsl, readOsRelease, scratchCandidates, scratchFits } from "./codex.mjs";
import { dropGrokScratch, grokArgv, grokBwrapArgs, grokLauncherAllow, grokPreflight, grokStateScratch, grokStopFailure, NEEDS_KEY, parseGrokStream } from "./grok.mjs";
import { exportReviewCopy, REVIEW_COPY_KIND } from "./review-copy.mjs";
import { REVIEW_AGENT, prepareReviewWorkspace, reviewLane, writeReviewLaunchers } from "./agy.mjs";
import { coverageGate, coverageHeaderLine, coverageOfAgy, coverageOfCodex, coverageOfGrok, gatedStatus, mergeCoverage, testsAllowedBy } from "./coverage.mjs";
import { defaultAgyStateDirs, dropGeminiState, sandboxAvailable } from "../agy/sandbox.mjs";
import { AGY_MODEL_MISMATCH, prepareWorkerJail, readJailLog, redactStrong, runAgyPreflight, runAgyWorkerTurn, workerArgv, workerEnv } from "../board/agy-cli.mjs";
import { CLI_CONTINUE_NOTE, ContinueRefusal, captureReviewTests, cumulative, loadContinuation, ownTranscriptAppendix, preserveFiles, restoreReviewTests } from "./continue.mjs";

// --continue in subscription mode: what each CLI documents about a headless resume, and what the runner does with it.
export const RESUME_SUPPORT = Object.freeze({
  "agy-cli": { documented: true, source: "agy 1.5.10 --help: `--conversation <id>` \"Resume a previous conversation by ID\", `--continue` \"Continue the most recent conversation\"",
    used: "--conversation <the earlier run's conversation_id>, with the earlier run's conversations/ and brain/ state (saved beside the transcript when it ended incomplete) restored into the new per-run scratch; without both, the replayed-own-transcript fallback" },
  "codex-sdk": { documented: true, source: "@openai/codex-sdk 0.170.0: `codex.resumeThread(id, threadOptions)` (index.d.ts:288, README \"Resuming an existing thread\": threads persist in ~/.codex/sessions); the SDK puts --model/--sandbox/--cd and approval_policy on `exec` BEFORE `resume <id>` (dist/index.js:195-242), and the 0.170.0 binary then reports the NEW workdir and sandbox for a session recorded in a since-deleted directory (observed, no credentials)",
    used: "resumeThread(<the earlier run's thread_id>, the same thread options with this run's worktree) when that thread's rollout file is in $CODEX_HOME/sessions on this machine (codex-sdk-resume); otherwise the replayed-own-transcript fallback" },
  "grok-cli": { documented: false, source: "docs.x.ai/build/overview (read 2026-11-18) documents no resume", used: "the replayed-own-transcript fallback" },
});
const AGY_SAVED = ["conversations", "brain"];
const CLI_OWN_CAP = 256 * 1024;
const capOwn = own => { const out = []; let n = 0; for (const x of [...own].reverse()) { n += Buffer.byteLength(x.text); if (n > CLI_OWN_CAP) break; out.unshift(x); } return out; };

export const SUB_PLAN_SCHEMA = "ophanim.review-run-plan/v2-subscription";
export const TRANSPORT_FOR = Object.freeze({ gemini: "agy-cli", openai: "codex-sdk", xai: "grok-cli" });
export const COVERAGE = Object.freeze({ "agy-cli": "documented", "codex-sdk": "documented", "grok-cli": "undocumented" });
/** Why codex runs no test (L-404): its own sandbox cannot start the verify jail. */
export const CODEX_TESTS_REFUSED = "the codex transport runs no test: the code under review runs only in the runner's verify jail, and codex's own sandbox cannot start it (nested namespaces are refused there), so a test would run as codex's child next to its login (L-404, self-audit round 3, assignment 4)";
const DROP = { "codex-sdk": ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID"], "grok-cli": ["XAI_API_KEY", "GROK_API_KEY"], "agy-cli": ["GEMINI_API_KEY", "GOOGLE_API_KEY"] };
const LANES = new URL("../config/lanes.json", import.meta.url);
const exists = p => access(p).then(() => true, () => false);

// What each transport's plan says is verified by the preflight, assumed, and enforced by the runner itself.
const KNOWLEDGE = {
  "codex-sdk": {
    verified_by_preflight: [`the installed ${CODEX_SDK_PACKAGE} sets CODEX_API_KEY only when an apiKey option is passed (its source is read; any other assignment is a refusal)`,
      "the binary the SDK spawns is found (its own resolution, or --codex-cli) and the preflight runs THAT binary",
      "`codex --version` runs", "`codex login status` reports a ChatGPT sign-in (refused when it reports an API key, unless --allow-api-key-in-cli)", "`codex debug models` lists the requested model (unless --skip-model-check and the catalog could not be read)",
      "`codex debug prompt-input`, with the run's overrides and working directory, reports exactly the runner's permission profile (file-system entries, restricted file system, network on behind the proxy); anything else is a refusal"],
    assumed: ["no real model turn has been run through this runner (no ChatGPT login where it was written); the SDK's spawn, argv and env handling were read in its source and the CLI's resume/sandbox/login behaviour observed without credentials",
      "a ChatGPT sign-in bills the run to the subscription (documented: \"Sign in with ChatGPT for subscription access\")",
      "codex applies the runner's permission profile in exec as `codex debug prompt-input` reports it and as `codex sandbox -P` enforced it (observed with the 0.170.0 binary, no model turn); codex runs its OWN bubblewrap sandbox, NOT nested in the runner's (on WSL it runs inside the runner's outer namespace: codex_outer_runtime)",
      "the commands inherit TMPDIR (the scratch dir) from the codex process (codex's default shell_environment_policy; observed through `codex sandbox`, not through a model turn)",
      "approval_policy never: no command is escalated out of the sandbox; codex has no per-command allowlist, so the listed test commands are asked for, not enforced",
      "on the wall clock the SDK SIGTERMs the codex process only (it exposes no pid, so no process group); codex's own children are left to codex's teardown",
      "the served model is the requested one: no codex event names the served model (served_model_source: input)"],
    enforced_by_runner: ["the SDK is given an explicit env (the scrubbed one: no key, token or secret, OPENAI_API_KEY and CODEX_API_KEY included) and never an apiKey or baseUrl",
      "forced_login_method=\"chatgpt\" is passed to the CLI (unless --allow-api-key-in-cli): the CLI refuses an API-key login before any request",
      "the wall clock: the SDK's abort signal", "a failure the SDK reports (turn.failed, a thrown error) is status `failed` with its message", "the post-run git check of the worktree (writes outside .review-tests/, any write for assignment 4, a moved HEAD)"],
  },
  "grok-cli": {
    verified_by_preflight: ["`grok --version` runs", "the state dir (--grok-state-dir) exists and is not empty", "bwrap runs",
      "the state dir's config.toml has at least one string-form [permission] allow rule (grok 1.0.44 loaded zero from the structured rules = [...] form) and no approve-everything mode; with --grok-permissions-inspect, the CLI's own inspection reports more than zero loaded rules"],
    assumed: ["the browser login lives in the state dir (nothing was discovered; no documented login-status command)",
      "UNDOCUMENTED: whether a SuperGrok / X Premium subscription covers Grok Build CLI usage (subscription_coverage: undocumented)",
      "`-p`, `--output-format streaming-json`, `-m` as documented (docs.x.ai/build/overview, read 2026-11-18); the event schema is undocumented: the observed grok 1.0.44 shapes (text/thought/tool_call/end) are read, others tolerantly",
      "the CLI needs to write only its state dir, /tmp and (assignments 1-3) .review-tests/; the runner's bwrap jail is the containment, whatever the CLI's permission profile allows",
      "the permission profile in the state dir's config.toml (recorded as grok_permissions; the runner writes no rule): under the default \"ask\" a headless run cancels what no allow rule covers (observed 2026-11-19)",
      "the served model is the requested one (served_model_source: input)"],
    enforced_by_runner: ["XAI_API_KEY and every other key, token or secret scrubbed (a CLI that then asks for a key is a refusal)", "the bwrap jail: the host read-only, the worktree read-only except .review-tests/ (1-3), a per-run scratch copy of the state dir", "the wall clock", "a turn ended with any stopReason but end_turn (e.g. cancelled) is status `failed`, whatever the exit code", "the post-run git check of the worktree"],
  },
  "agy-cli": {
    verified_by_preflight: ["the review card's tool list", "the login and the lane's quota by an in-jail `agy --print /usage --output-format json` (no model turn)", "`agy agents` runs in the jail", "no read-only-file-system / unknown-component lines in the CLI's output and log"],
    assumed: ["the hook semantics observed on agy 1.5.10 / owner-stated (an empty hook stdout allows, so the hook always prints a decision; headless accept-edits soft-denies run_command unless auto_approve)",
      "the served model is the lane id (Antigravity names no served model; served_model_source: input)"],
    enforced_by_runner: ["the unit worker's bwrap jail (prepareWorkerJail: ~/.gemini read-only, per-run scratch state)", "the PreToolUse jail hook with the review policy (writes only under .review-tests/ for 1-3, none for 4; run_command only the listed commands; no MCP; no native subagents)", "no Google API key in the CLI's environment", "the wall clock", "the post-run git check of the worktree"],
  },
};

const UNKNOWNS_GROK = ["Does the owner's subscription cover Grok Build CLI usage? (undocumented)", "Where does the CLI keep its browser login? (assumed: --grok-state-dir, default ~/.grok)",
  "Does the CLI write outside its state dir and /tmp? (a write elsewhere fails inside the jail)", "What does its streaming-json look like? (parsed tolerantly; unparsed lines are counted)",
  "Which tool calls does a headless run allow? (the default \"ask\" profile cancelled an authorized edit on 2026-11-19; the [permission] rules in the state dir's config.toml decide: see grok_permissions)"];

function git(repoRoot, args) {
  return runCli({ cmd: "git", args: ["-C", repoRoot, ...args], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir(), LANG: "C.UTF-8" }, timeoutMs: 120_000 })
    .then(r => ({ code: r.exit_code, stdout: r.stdout, stderr: r.stderr }));
}

/**
 * Run (or dry-run) one assignment in subscription mode. `a` is index.mjs's loadAssignment result. Returns the exit code.
 */
export async function subscriptionMain({ opts, a, repoRoot, env, deps, out, err, EXIT, outPaths }) {
  const { row, b, permissions } = a;
  const transport = TRANSPORT_FOR[row.vendor];
  const wall = opts.limits.timeout_s ? Math.min(opts.limits.max_wall_s, opts.limits.timeout_s) : opts.limits.max_wall_s;
  const scrub = scrubEnv(env, { drop: DROP[transport], set: transport === "grok-cli" ? { TMPDIR: "/tmp" } : {} });
  const childEnv = scrub.env;
  const secrets = secretValues(env);
  const write_allowed = Boolean(permissions.write_test);
  const harnessTemplate = await readFile(join(repoRoot, REVIEW_DIR, "HARNESS-cli.md"), "utf8").catch(() => null);
  if (harnessTemplate === null) { err(`run-review: refused: ${REVIEW_DIR}/HARNESS-cli.md is missing\n`); return EXIT.refused; }

  // The lane (agy only).
  let lane = null;
  if (transport === "agy-cli") {
    const lanes = JSON.parse(await readFile(LANES, "utf8"));
    const l = reviewLane(lanes, row.model);
    if (!l.ok) { err(`run-review: refused: ${l.why}\n`); return EXIT.refused; }
    lane = l.id;
  }
  const cliName = { "codex-sdk": "codex", "grok-cli": "grok", "agy-cli": "agy" }[transport];
  const explicit = { "codex-sdk": opts.codexCli, "grok-cli": opts.grokCli, "agy-cli": opts.agyCli ?? env.PANTHEON_AGY_CLI }[transport];
  // Codex: the binary the SDK itself would spawn (codex.mjs resolveSdkCodexBinary), not a `codex` on PATH; --codex-cli
  // overrides it, and the same path goes to the SDK as codexPathOverride, so the preflight and the run are one binary.
  const sdk = transport === "codex-sdk" ? (deps.inspectCodexSdk ?? inspectCodexSdk)() : null;
  let cli = transport === "codex-sdk" && !explicit ? (sdk.ok && sdk.binary?.ok ? sdk.binary.path : null) : await findCli(cliName, explicit, env);
  if (!cli && transport === "agy-cli" && !explicit && env.HOME) cli = await findCli(cliName, join(env.HOME, ".local", "bin", "agy"), env).catch(() => null);
  // The SDK prepends its codex-path dir (ripgrep) to PATH when it resolves the binary itself (dist/index.js:264-266);
  // passing codexPathOverride turns that off, so the runner does it for the SDK-resolved binary.
  if (transport === "codex-sdk" && cli && !explicit && sdk.binary.path_dirs?.length) childEnv.PATH = [...sdk.binary.path_dirs, childEnv.PATH ?? ""].filter(Boolean).join(":");
  const grokStateDir = transport === "grok-cli" ? resolve(opts.grokStateDir ?? join(env.HOME ?? homedir(), ".grok")) : null;

  let resume = null, method = null;
  if (opts.continue) {
    try { resume = await loadContinuation(resolve(deps.cwd ?? process.cwd(), opts.continue), { n: opts.n, lab: row.lab.toLowerCase(), vendor: row.vendor, model: row.model, commit: opts.commit, via: "subscription", transport, brief_sha256: sha256(b.brief), reviewer: row.reviewer_override ? row.reviewer_spec : null }); }
    catch (e) { if (e instanceof ContinueRefusal) { err(`run-review: refused: ${e.message}\n`); return EXIT.refused; } throw e; }
    const saved = resume.t.agy_state?.dir ? join(resolve(resume.path, ".."), resume.t.agy_state.dir) : null;
    method = transport === "agy-cli" && resume.t.cli?.conversation_id && saved && await exists(join(saved, "conversations")) ? "agy --conversation"
      : transport === "codex-sdk" && findCodexSession(resume.t.cli?.thread_id, childEnv) ? "codex-sdk-resume" : "replayed-own-transcript";
    resume.agy_saved = method === "agy --conversation" ? saved : null;
  }
  // Not under /tmp (cli-common.mjs reviewTmpBase: the repository's jail fixtures hide /tmp from the code they jail).
  const tmpBase = deps.tmpBase ?? reviewTmpBase(env);
  await mkdir(tmpBase, { recursive: true, mode: 0o700 });
  const tmp = await realpath(await mkdtemp(join(tmpBase, "ophanim-review-")));
  const wtPath = join(tmp, "worktree"), control = join(tmp, "control"), runDir = join(tmp, "run");
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  let agyJail = null, grokScratch = null, code = EXIT.refused, outsideScratch = null, reviewCopy = null;
  const cleanup = async () => {
    if (agyJail) await dropGeminiState(agyJail.gstate).catch(() => null);   // the scratch holds the OAuth token: always dropped
    await dropGrokScratch(grokScratch);                                     // the copy of the Grok login: always dropped
    if (outsideScratch && !opts.keep) await rm(outsideScratch, { recursive: true, force: true });
    if (!opts.keep) await rm(tmp, { recursive: true, force: true });
  };
  try {
    // THE REVIEW COPY: a fresh single-commit repository exporting the commit minus the withheld paths (review-copy.mjs:
    // git then works inside every CLI's sandbox, and no withheld findings file is recoverable from its history; a
    // `git worktree` needed the owner's .git/worktrees/<id> readable and exposed the whole history). An empty stand-in
    // for a dry run (only the preflights run).
    if (opts.dryRun) await mkdir(wtPath);
    else {
      try { reviewCopy = await exportReviewCopy({ repoRoot, commit: opts.commit, dest: wtPath, withheld: a.withheld, scratch: join(runDir, "export") }); }
      catch (e) { err(`run-review: refused: the review copy could not be made: ${e.message}\n`); return EXIT.refused; }
      finally { await rm(join(runDir, "export"), { recursive: true, force: true }); }
      if (deps.copyDependencies !== false) {
        for (const d of ["node_modules", "pantheon/node_modules", "packages/model-client/node_modules", "packages/ledger/node_modules"]) {
          if (await exists(join(repoRoot, d))) await cp(join(repoRoot, d), join(wtPath, d), { recursive: true, verbatimSymlinks: true });
        }
      }
    }
    if (write_allowed) await mkdir(join(wtPath, REVIEW_TESTS_DIR), { recursive: true });
    const wt = await realpath(wtPath);
    let restored = null;
    if (resume && !opts.dryRun && resume.t.review_tests.files?.length) restored = await restoreReviewTests(wt, resume.t.review_tests);

    // Codex: the permission profile its sandbox applies (codex.mjs codexPermissionProfile), with a per-run scratch
    // TMPDIR outside the copy (the tests' temp files; deleted with the run dir).
    let codexProfile = null, scratchRec = null, outer = null, launcher = cli;
    const runWarnings = [];
    if (transport === "codex-sdk") {
      // A SHORT scratch TMPDIR (codex.mjs SCRATCH_TMP_MAX): the tests put Unix sockets under it.
      const cand = (deps.scratchCandidates ?? scratchCandidates)(tmpBase);
      let scratchTmp = null;
      for (const c of cand) {
        if (!scratchFits(c)) continue;
        try { await mkdir(c.parent, { recursive: true, mode: 0o700 }); scratchTmp = await realpath(await mkdtemp(join(c.parent, c.prefix))); await chmod(scratchTmp, 0o700); break; } catch { scratchTmp = null; }
      }
      if (scratchTmp && !scratchTmp.startsWith(tmp + "/")) outsideScratch = scratchTmp;
      if (!scratchTmp) {
        scratchTmp = join(runDir, "tmp");
        await mkdir(scratchTmp, { recursive: true, mode: 0o700 });
        runWarnings.push(`scratch TMPDIR: no candidate (${cand.map(c => join(c.parent, `${c.prefix}XXXXXX`)).join(", ")}) is at most ${SCRATCH_TMP_MAX} bytes and writable, so TMPDIR is ${scratchTmp} (${Buffer.byteLength(scratchTmp)} bytes): a test that puts a Unix socket under it may fail with listen EINVAL (the limit is ${UNIX_SOCKET_PATH_MAX} bytes)`);
      }
      scratchRec = { path: scratchTmp, bytes: Buffer.byteLength(scratchTmp), max_bytes: SCRATCH_TMP_MAX, unix_socket_path_max: UNIX_SOCKET_PATH_MAX, removed_after_run: !opts.keep };
      childEnv.TMPDIR = scratchTmp;
      const rr = await codexReadRoots({ cli, childEnv, telosRoot: opts.telosRoot });
      codexProfile = codexPermissionProfile({ worktree: wt, write_allowed, scratchTmp, readRoots: rr.roots, denyPaths: rr.deny });
      // WSL: the outer runtime namespace (codex.mjs codexOuterLauncher), unless --codex-outer-runtime off.
      const det = detectWsl({ env, osrelease: deps.osRelease !== undefined ? deps.osRelease : readOsRelease() });
      const mode = opts.codexOuterRuntime ?? "auto";
      outer = { applied: false, mode, wsl: det.wsl, evidence: det.evidence };
      if ((mode === "on" || (mode === "auto" && det.wsl)) && cli) {
        const bw = await findCli("bwrap", deps.bwrap?.startsWith("/") ? deps.bwrap : null, env);
        const codexHome = resolve(childEnv.CODEX_HOME || join(childEnv.HOME ?? homedir(), ".codex"));
        if (!bw) outer.why = "bwrap was not found on PATH";
        else if (!(await exists(codexHome))) outer.why = `${codexHome} (CODEX_HOME) does not exist: sign in with \`codex login\` first`;
        else {
          const realCli = await realpath(cli);
          const l = codexOuterLauncher({ bwrap: bw, codex: realCli, writable: [tmp, scratchTmp, await realpath(codexHome)], readOnly: [dirname(realCli)] });
          launcher = join(runDir, "codex-outer");
          await writeFile(launcher, l.script, { mode: 0o700 });
          delete childEnv.WSL_INTEROP;   // as the operator did; the private /run hides /run/WSL anyway
          Object.assign(outer, { applied: true, launcher, argv: [...l.argv, "<codex arguments>"], writable: l.writable, read_only: l.read_only,
            reason: "WSL: codex's own bwrap cannot mkdir /run/WSL under the profile's denied /run (observed at 77480d6); a private /run in an outer namespace removes the host interop mount before codex starts; the inner permission profile is unchanged",
            cost: "one more namespace level: codex's own bwrap runs nested inside the outer one" });
        }
        if (!outer.applied) outer.failed = `the WSL outer runtime for codex could not be set up: ${outer.why}`;
      }
    }
    // L-404 (self-audit round 3, assignment 4 (sealed fe2a612)): the code under review runs ONLY in a verify jail. agy and
    // grok reach it through the review's launchers in the control dir (grok: allowed by --allow for exactly those paths,
    // and a config.toml rule that could run it another way refuses the preflight); codex's own sandbox cannot start the
    // jail, so codex runs no test at all (testsRefused) and the coverage gate says so.
    const cmds = allowedCommands({ permissions, worktree: wt, telosRoot: opts.telosRoot, ...(transport === "agy-cli" || transport === "grok-cli" ? { launcherDir: control } : {}),
      ...(transport === "codex-sdk" ? { testsRefused: CODEX_TESTS_REFUSED } : {}),
      envPrefix: transport === "codex-sdk" ? `env NO_PROXY=${LOOPBACK_NO_PROXY} no_proxy=${LOOPBACK_NO_PROXY} ` : "" });
    if (transport === "grok-cli" && !opts.dryRun) { await mkdir(control, { recursive: true }); cmds.launchers = writeReviewLaunchers({ control_dir: control, worktree: wt, run_command_policy: cmds.run_command_policy }); }
    else if (transport === "grok-cli") cmds.launchers = {};
    const harness = renderHarness(harnessTemplate, { COMMIT: opts.commit, WORKTREE: wt, ALLOWED_COMMANDS: cmds.lines.join("\n"), WRITE_RULE: writeRule({ write_allowed, worktree: wt }),
      READ_RULE: readRule({ transport }), SANDBOX_NOTE: sandboxNote({ transport, scratchTmp: codexProfile?.scratch_tmp ?? null }), MAX_WALL_S: wall });
    // A continuation: agy and codex resume their own conversation (a note, then the same prompt); otherwise the same
    // prompt PLUS the delimited appendix of the reviewer's own earlier messages and tool results (that transcript only).
    const appendix = resume && method === "replayed-own-transcript" ? ownTranscriptAppendix(resume.t) : null;
    const prompt = resume && method !== "replayed-own-transcript" ? CLI_CONTINUE_NOTE + SEPARATOR + harness + SEPARATOR + b.brief
      : harness + SEPARATOR + b.brief + (appendix ? "\n\n" + appendix + "\n" : "");
    const promptRef = `<prompt sha256:${sha256(prompt)}>`;

    // ---- per transport: argv, sandbox, writable paths, preflight ------------------------------------------------
    const plan = {
      schema: SUB_PLAN_SCHEMA, dry_run: opts.dryRun, via: "subscription", transport,
      assignment: { n: opts.n, title: row.title, file: `${REVIEW_DIR}/${row.file}`, scope: row.scope, testing: row.testing },
      lab: row.lab, vendor: row.vendor, requested_model: row.model, ...(lane ? { lane } : {}), commit: opts.commit,
      default_reviewer: row.default_reviewer, reviewer_override: row.reviewer_override, ...(row.reviewer_override ? { reviewer: row.reviewer_spec } : {}),
      subscription_coverage: COVERAGE[transport],
      prompt: {
        harness_cli_template: { path: `${REVIEW_DIR}/HARNESS-cli.md`, sha256: sha256(harnessTemplate) },
        harness_sha256: sha256(harness), brief_sha256: sha256(b.brief), readme_sha256: sha256(b.readme), assignment_sha256: sha256(b.assignmentText),
        sha256: sha256(prompt), bytes: Buffer.byteLength(prompt),
        ...(opts.dryRun ? { note: "computed with the dry run's stand-in worktree path; a real run's prompt names its own worktree and records its own sha256" } : {}),
      },
      cli: { name: cliName, path: cli, found: Boolean(cli) },
      allowed_commands: cmds.lines, write_rule: write_allowed ? `only under ${REVIEW_TESTS_DIR}/` : "none",
      limits: { max_wall_s: opts.limits.max_wall_s, ...(opts.limits.timeout_s ? { timeout_s: opts.limits.timeout_s } : {}), wall_clock_s: wall,
        ignored: opts.ignoredCaps, note: transport === "codex-sdk" ? "Codex exposes no turn, tool-call or output-token caps; the wall clock aborts the SDK turn (its signal SIGTERMs the codex process)" : "the CLIs expose no turn, tool-call or output-token caps; the wall clock kills the process group" },
      env: { passed: Object.keys(childEnv).sort(), removed: scrub.removed, note: "names only; every key, token and secret is removed so the CLI cannot switch to metered billing" },
      ...KNOWLEDGE[transport],
      ...(transport === "grok-cli" ? { unknowns: UNKNOWNS_GROK } : {}),
      worktree: { path: wt, kind: opts.dryRun ? "empty stand-in (dry run: no copy is created)" : REVIEW_COPY_KIND, removed_after_run: !opts.keep },
      out: outPaths,
      model_turns: 0,
      ...(resume ? { continue: { from: resume.path, transcript_sha256: resume.sha256, method, resume_support: RESUME_SUPPORT[transport], prior: resume.prior,
        review_tests_to_restore: (resume.t.review_tests.files ?? []).map(f => f.path), ...(appendix ? { appendix_sha256: sha256(appendix), appendix_bytes: Buffer.byteLength(appendix) } : {}),
        ...(method === "agy --conversation" ? { conversation_id: resume.t.cli.conversation_id } : {}), ...(method === "codex-sdk-resume" ? { thread_id: resume.t.cli.thread_id } : {}) } } : {}),
    };
    let pre, runner;
    if (transport === "codex-sdk") plan.sdk = codexSdkRecord(sdk, explicit, cli);
    if (!cli) {
      const why = transport === "codex-sdk" && !explicit ? `the codex binary the SDK would spawn was not found (${sdk.ok ? sdk.binary?.why : sdk.why})` : `${cliName} not found (${explicit ? `at ${explicit}` : "on PATH"})`;
      pre = { ok: false, failed: [`${why}; subscription mode never falls back to the API`], checks: {}, cli_version: null, auth_method_observed: null };
    } else if (transport === "codex-sdk") {
      // On WSL the SDK and every preflight command run the outer launcher, which execs the same codex binary.
      const sdkOptions = codexSdkOptions({ env: childEnv, binary: launcher, allowApiKeyLogin: Boolean(opts.allowApiKeyInCli), configOverrides: codexProfile.overrides });
      const threadOptions = codexThreadOptions({ model: row.model, worktree: wt });
      const resumeId = method === "codex-sdk-resume" ? resume.t.cli.thread_id : null;
      plan.codex_outer_runtime = outer;
      plan.scratch_tmp = scratchRec;
      // The command that runs. Without the outer runtime the SDK spawns codex itself: its argv. With it, the SDK spawns the
      // launcher, which execs `bwrap ... -- <codex> "$@"`: the outer argv up to and including codex (its last item, the
      // "<codex arguments>" placeholder, dropped), then the SDK's arguments WITHOUT its own binary, so codex is named once,
      // as the launcher names it. (Appending the SDK's whole argv named codex twice, in the plan and the transcript.)
      const sdkArgv = sdkSpawnArgv({ binary: cli, sdkOptions, threadOptions, resumeId });
      Object.assign(plan, { argv: [...(outer.applied ? [...outer.argv.slice(0, -1), ...sdkArgv.slice(1)] : sdkArgv), `(stdin: ${promptRef})`], cwd: null,
        argv_note: `the argv ${CODEX_SDK_PACKAGE} builds from these options (dist/index.js:178-247) and spawns itself; the prompt is written to the CLI's stdin`,
        sdk_options: { env: "the scrubbed environment (names under env.passed); the SDK adds CODEX_INTERNAL_ORIGINATOR_OVERRIDE", codexPathOverride: launcher, ...(sdkOptions.config ? { config: sdkOptions.config } : {}), configOverrides: sdkOptions.configOverrides, apiKey: "never passed", baseUrl: "never passed" },
        thread_options: threadOptions, ...(resumeId ? { resume_thread_id: resumeId } : {}),
        sandbox: { kind: "codex's own sandbox (bubblewrap + seccomp on Linux) under the runner's permission profile", profile: codexProfile.name, filesystem: codexProfile.filesystem, network: codexProfile.network,
          network_note: "on only behind codex's managed proxy (features.network_proxy) with no allowed domain: the commands get their own network namespace", approvals: threadOptions.approvalPolicy, nested_in_runner_bwrap: false, outer_runtime: outer.applied ? "an outer bwrap namespace (WSL; codex_outer_runtime): host read-only, private /run and /tmp" : null },
        writable_paths: [`${codexProfile.scratch_tmp} (the commands' TMPDIR, outside the worktree, removed with the run)`, ...(write_allowed ? [`${wt}/${REVIEW_TESTS_DIR}`] : [])] });
      pre = await codexPreflight({ cli: launcher, env: childEnv, model: row.model, opts, sdk: plan.sdk, permissions: { overrides: codexProfile.overrides, expected_entries: codexProfile.expected_entries, cwd: wt } });
      if (outer.failed) { pre.ok = false; pre.failed.unshift(outer.failed); }
      if (outer.applied) pre.checks.outer_runtime = { applied: true, evidence: outer.evidence, note: "every preflight command above ran through the outer launcher, as the run will" };
      runner = async () => {
        const Codex = deps.CodexSDK ?? (await import(CODEX_SDK_PACKAGE)).Codex;
        return runCodexSdk({ Codex, sdkOptions, threadOptions, prompt, wall, resumeId, redactEnv: childEnv, ...(deps.codexAbortGraceMs ? { graceMs: deps.codexAbortGraceMs } : {}) });
      };
    } else if (transport === "grok-cli") {
      const bw = deps.bwrap ?? "bwrap";
      const box = await sandboxAvailable(bw);
      const stateOk = await exists(grokStateDir);
      const cliDir = resolve(cli, "..");
      const jailPlan = grokBwrapArgs({ worktree: wt, write_allowed, state: { dir: grokStateDir, scratch: join(runDir, "grok-state") }, cliDir, bwrap: bw, controlDir: opts.dryRun ? null : control });
      const gargv = grokArgv({ model: row.model, prompt, allow: grokLauncherAllow(cmds) });
      Object.assign(plan, { argv: [...jailPlan.argv, cli, ...gargv.map(x => (x === prompt ? promptRef : x))], cwd: wt,
        sandbox: { kind: "the runner's bwrap jail (the containment; the Grok CLI's permission profile only decides what it attempts)", binds: jailPlan.binds, network: "not cut (the CLI must reach xAI)", state_dir: grokStateDir, state_dir_exists: stateOk },
        writable_paths: jailPlan.writable });
      // --grok-permissions-inspect: the CLI's own report of the rules it loads, run in the same jail against a scratch
      // copy of the state dir (no model turn); 0 loaded rules is a refusal (grok.mjs grokPermissionVerdict).
      const inspect = opts.grokPermissionsInspect && box.ok && stateOk ? { argv: [cli, ...opts.grokPermissionsInspect], run: async () => {
        const s = await grokStateScratch(grokStateDir, join(runDir, "inspect"));
        try { const j = grokBwrapArgs({ worktree: wt, write_allowed: false, state: s, cliDir, bwrap: bw }); return await runCli({ cmd: j.argv[0], args: [...j.argv.slice(1), cli, ...opts.grokPermissionsInspect], cwd: wt, env: childEnv, timeoutMs: 60_000 }); }
        finally { await dropGrokScratch(s); }
      } } : null;
      pre = await grokPreflight({ cli, env: childEnv, stateDir: grokStateDir, bwrapOk: box, parentEnv: env, inspect });
      runner = async () => {
        grokScratch = await grokStateScratch(grokStateDir, runDir);
        const j = grokBwrapArgs({ worktree: wt, write_allowed, state: grokScratch, cliDir, bwrap: bw, controlDir: control });
        return runGrok({ argv: [...j.argv, cli, ...gargv], wt, childEnv, wall });
      };
    } else {
      const sandbox = { home: childEnv.HOME, agy_state_dirs: defaultAgyStateDirs(childEnv), ...(deps.bwrap ? { bwrap: deps.bwrap } : {}) };
      const ws = await prepareReviewWorkspace({ control_dir: control, worktree: wt, n: opts.n, write_allowed, run_command_policy: cmds.run_command_policy });
      const graceS = Math.max(1, Math.min(15, Math.floor(wall / 5))), timeoutS = Math.max(1, wall - graceS);
      const conversation = method === "agy --conversation" ? resume.t.cli.conversation_id : null;
      const args = workerArgv({ model: lane, worktree: wt, prompt, timeoutS, log_file: ws.paths.agy_log, agent: REVIEW_AGENT, conversation });
      Object.assign(plan, { argv: ["<bwrap jail prefix>", cli, ...args.map(x => (x === prompt ? promptRef : x))], cwd: ws.paths.control_dir,
        print_timeout_s: timeoutS, kill_after_s: timeoutS + graceS,
        hook_policy: { owned_paths: ws.policy.owned_paths, run_command_policy: ws.policy.run_command_policy, mcp: "none", card_tools: write_allowed ? "view_file, write_file, replace_file_content, run_command" : "view_file, run_command" },
        writable_paths: [`${wt} (bwrap; the jail hook allows writes only under ${REVIEW_TESTS_DIR}/${write_allowed ? "" : ": none for this assignment"})`, `${ws.paths.run} (jail.log, the CLI's --log-file, the agy state scratch)`, "/tmp (a fresh tmpfs)"] });
      const v = await runCli({ cmd: cli, args: ["--version"], env: workerEnv({}, childEnv), timeoutMs: 30_000 });
      const version = redactStrong(`${v.stdout}${v.stderr}`, childEnv).trim().slice(0, 200) || null;
      try {
        agyJail = await prepareWorkerJail({ cli, control_dir: ws.paths.control_dir, worktree: wt, env: workerEnv({}, childEnv), sandbox });
        plan.sandbox = { kind: "bwrap (the unit worker's jail, src/agy/sandbox.mjs)", binds: agyJail.sandboxRec.binds, gemini_state: { mode: agyJail.sandboxRec.gemini_state?.mode, copied: agyJail.sandboxRec.gemini_state?.copied, withheld: (agyJail.sandboxRec.gemini_state?.withheld ?? []).map(w => w.name) } };
        const pf = await runAgyPreflight({ cli, control_dir: ws.paths.control_dir, worktree: wt, base_env: childEnv, sandbox, jail: agyJail, model: lane, agent: REVIEW_AGENT });
        const failed = pf.failed.map(k => `agy preflight ${k}: ${pf.checks[k]?.why ?? "failed"}`);
        if (v.exit_code !== 0) failed.unshift(`\`agy --version\` failed (exit ${v.exit_code ?? v.killed_for ?? v.spawn_error})`);
        pre = { ok: failed.length === 0, failed, warnings: pf.warnings, checks: { version: { exit_code: v.exit_code, text: version }, auth: pf.checks.auth && { ok: pf.checks.auth.ok, why: pf.checks.auth.why, groups: pf.checks.auth.groups, num_turns: pf.checks.auth.num_turns },
          lane_quota: pf.checks.lane_quota && { ok: pf.checks.lane_quota.ok, state: pf.checks.lane_quota.quota_scope?.state ?? null, groups: pf.checks.lane_quota.quota_scope?.groups ?? null, why: pf.checks.lane_quota.why },
          card_tools: pf.checks.card_tools, agents: pf.checks.agents && { ok: pf.checks.agents.ok, why: pf.checks.agents.why }, log_scan: pf.checks.log_scan && { ok: pf.checks.log_scan.ok, why: pf.checks.log_scan.why } },
          cli_version: version, auth_method_observed: pf.checks.auth?.ok ? "antigravity OAuth (in-jail /usage returned quota groups)" : "none observed" };
      } catch (e) {
        pre = { ok: false, failed: [`the agy jail could not be built (${e.code ?? "error"}): ${e.message}`], checks: { version: { exit_code: v.exit_code, text: version } }, cli_version: version, auth_method_observed: null };
      }
      runner = async () => {
        // agy --conversation: the earlier run's conversation state, restored into this run's scratch before the turn.
        if (conversation && agyJail?.gstate?.scratch_cli) for (const d of AGY_SAVED) if (await exists(join(resume.agy_saved, d))) await cp(join(resume.agy_saved, d), join(agyJail.gstate.scratch_cli, d), { recursive: true, force: true });
        return runAgy({ cli, ws, wt, lane, prompt, timeoutS, graceS, childEnv, sandbox, jail: agyJail, conversation });
      };
    }
    const warnings = [...(pre.warnings ?? []), ...runWarnings];
    plan.preflight = { ok: pre.ok, failed: pre.failed, ...(warnings.length ? { warnings } : {}), checks: pre.checks };
    plan.review_copy = reviewCopy ?? { kind: "empty stand-in (dry run: no copy is made)", would_be: REVIEW_COPY_KIND };
    out(JSON.stringify(plan, null, 2) + "\n");
    for (const n of opts.notes) err(`run-review: note: ${n}\n`);
    if (opts.dryRun) {
      if (!pre.ok) { err(`run-review: refused: preflight failed: ${pre.failed.join("; ")}\n`); return (code = EXIT.refused); }
      return (code = EXIT.complete);
    }
    if (!pre.ok) { err(`run-review: refused: preflight failed (no model turn was started; no fallback to the API): ${pre.failed.join("; ")}\n`); return (code = EXIT.refused); }
    const sameFiles = resume && resolve(resume.path) === resolve(outPaths.transcript);
    if (sameFiles) await preserveFiles(resume, outPaths);
    else if (!opts.force && (await exists(outPaths.findings) || await exists(outPaths.transcript))) { err(`run-review: refused: ${outPaths.findings} or its transcript exists (use --force to overwrite)\n`); return (code = EXIT.refused); }

    // ---- the run ------------------------------------------------------------------------------------------------
    const g = args => git(wt, args);
    const before = await worktreeState(g);
    const started = (deps.now ?? (() => new Date()))();
    const r = await runner();
    const ended = (deps.now ?? (() => new Date()))();
    const after = await worktreeState(g);
    const reviewTests = await captureReviewTests(wt).catch(e => ({ captured: false, why: e.message }));
    // agy: an incomplete run keeps its conversation state beside the transcript, for a later --continue.
    let agyState = null;
    // (Not for an identity mismatch: another model's conversation is never kept to be resumed.)
    if (transport === "agy-cli" && r.status !== "complete" && !r.identity_mismatch && agyJail?.gstate?.scratch_cli && r.record?.conversation_id) {
      const name = outPaths.findings.split(/[\\/]/).pop().replace(/\.md$/, ".agy-state"), dir = join(resolve(outPaths.findings, ".."), name);
      await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true, mode: 0o700 });
      const saved = [];
      for (const d of AGY_SAVED) if (await exists(join(agyJail.gstate.scratch_cli, d))) { await cp(join(agyJail.gstate.scratch_cli, d), join(dir, d), { recursive: true }); saved.push(d); }
      agyState = { dir: name, conversation_id: r.record.conversation_id, saved, note: "the CLI's conversation state of this run (no OAuth token: only conversations/ and brain/), for --continue" };
    }
    const check = compareWorktree(before, after, { write_allowed });
    // THE COVERAGE GATE (L-501; coverage.mjs): what the runner observed of the reviewer's reads and test runs, per
    // transport. A `complete` transport result whose gate fails is `incomplete`.
    const tests_allowed = testsAllowedBy(permissions);
    // A continuation is one review across its runs: the earlier runs' coverage counts too (as the API runner's events do).
    const coverage = mergeCoverage(resume?.t?.coverage ?? null, transport === "agy-cli" ? coverageOfAgy(r.record ?? {}, { worktree: wt, tests_allowed })
      : transport === "codex-sdk" ? coverageOfCodex(r.record ?? {}, { worktree: wt, tests_allowed, tests_refused: cmds.tests_refused ?? null })
        : coverageOfGrok(r.record ?? {}, { worktree: wt, control_dir: control, tests_allowed }));
    const gate = coverageGate(coverage);
    const gated = gatedStatus(r.status, r.stop_reason, gate);
    let status = gated.status;
    const stopReason = gated.stop_reason;
    if (check.violations.length && status !== "refused") status = "policy_violation";
    const finalText = r.final_text ? redact(r.final_text, secrets) : "";
    const transcript = {
      schema: "ophanim.review-transcript/v2-subscription", via: "subscription", transport, assignment: opts.n, lab: row.lab, vendor: row.vendor,
      requested_model: row.model, ...(lane ? { lane } : {}), commit: opts.commit,
      default_reviewer: row.default_reviewer, reviewer_override: row.reviewer_override, ...(row.reviewer_override ? { reviewer: row.reviewer_spec } : {}), argv: plan.argv, cwd: plan.cwd, env_names: plan.env.passed, env_removed: scrub.removed,
      prompt: plan.prompt, sandbox: plan.sandbox, review_copy: plan.review_copy, ...(plan.codex_outer_runtime ? { codex_outer_runtime: plan.codex_outer_runtime, scratch_tmp: plan.scratch_tmp } : {}),
      preflight: plan.preflight, limits: plan.limits, started_at: started.toISOString(), ended_at: ended.toISOString(),
      status, stop_reason: stopReason, ...(r.identity_mismatch ? { identity_mismatch: r.identity_mismatch } : {}), coverage, coverage_gate: gate, exit_code: r.exit_code ?? null, killed_for: r.killed_for ?? null, usage: r.usage ?? null, cli: r.record ?? {},
      worktree_check: { changed: check.changed, violations: check.violations, limits: check.limits }, worktree_kept: opts.keep ? wt : null,
      review_tests: reviewTests, ...(agyState ? { agy_state: agyState } : {}),
      ...(resume ? { continued_from: { transcript: resume.name, sha256: resume.sha256, method }, continued: method, ...(restored ? { restored_review_tests: restored.restored } : {}),
        cumulative: cumulative(resume.prior, { usage: r.usage ?? {}, wall_s: Math.round((ended - started) / 1000) }) } : {}),
    };
    await mkdir(resolve(outPaths.findings, ".."), { recursive: true });
    const tBytes = redact(JSON.stringify(transcript, null, 2) + "\n", secrets);
    await writeFile(outPaths.transcript, tBytes);
    const header = [
      "<!-- Written by pantheon/scripts/run-review.mjs (--via subscription). The runner's header ends at the marker line below; the reviewer's final message follows it verbatim. -->",
      `# Review run: assignment ${opts.n}, ${row.title}`,
      "",
      `- status: ${status}`,
      `- stop_reason: ${stopReason}`,
      `- coverage: ${coverageHeaderLine(coverage, gate)}`,
      `- via: subscription`,
      `- transport: ${transport}`,
      `- cli_version: ${pre.cli_version ? `\`${pre.cli_version.replace(/`/g, "'")}\`` : "unknown"}`,
      `- auth_method_observed: ${pre.auth_method_observed ?? "unknown"}`,
      `- subscription_coverage: ${COVERAGE[transport]}`,
      `- lab: ${row.lab}`,
      `- requested_model: \`${row.model}\``,
      ...reviewerHeaderLines({ ...row, reviewer: row.reviewer_spec }),
      ...(lane ? [`- lane: \`${lane}\``] : []),
      // An identity mismatch (L-504 invariant 3) is never stamped with the lane as served: both identities are named.
      ...(r.identity_mismatch ? [`- served_model: none (${AGY_MODEL_MISMATCH}: the CLI reported \`${r.identity_mismatch.reported?.agent ?? "none"}/${r.identity_mismatch.reported?.model ?? "none"}\`, \`${r.identity_mismatch.requested?.agent ?? "none"}/${r.identity_mismatch.requested?.model ?? "none"}\` was requested)`,
        "- served_model_source: refused (the model guard failed: no result of the turn was used)"]
        : [`- served_model: \`${lane ?? row.model}\``,
          `- served_model_source: input (the CLI names no served model; this is the ${lane ? "lane" : "model"} the runner asked for)`]),
      `- sandbox: ${sandboxLine(transport, plan)}`,
      ...(transport === "codex-sdk" ? [`- codex_outer_runtime: ${outerLine(plan.codex_outer_runtime)}`, `- scratch_tmpdir: \`${plan.scratch_tmp.path}\` (${plan.scratch_tmp.bytes} bytes; at most ${plan.scratch_tmp.max_bytes} so the tests' Unix sockets fit ${plan.scratch_tmp.unix_socket_path_max} bytes)`] : []),
      ...(transport === "grok-cli" ? [`- grok_permissions: ${grokPermissionsLine(pre.checks?.permissions, pre.checks?.permissions_inspect)}`] : []),
      `- review_copy: ${reviewCopyLine(plan.review_copy)}`,
      `- policy_violations: ${check.violations.length ? check.violations.map(v => `\`${v}\``).join(", ") : "none"}`,
      `- commit: \`${opts.commit}\``,
      `- started_at: ${started.toISOString()}`,
      `- ended_at: ${ended.toISOString()}`,
      `- usage_totals: \`${JSON.stringify(r.usage ?? {})}\` (as the CLI reported it)`,
      `- limits: \`${JSON.stringify({ wall_clock_s: wall, ignored: opts.ignoredCaps })}\``,
      `- transcript: \`${outPaths.transcript.split(/[\\/]/).pop()}\` sha256 \`${sha256(tBytes)}\``,
      `- harness_cli_template_sha256: \`${plan.prompt.harness_cli_template.sha256}\``,
      `- harness_sha256: \`${plan.prompt.harness_sha256}\``,
      `- brief_sha256: \`${plan.prompt.brief_sha256}\``,
      `- prompt_sha256: \`${plan.prompt.sha256}\``,
      ...(resume ? [
        `- continued_from: \`${resume.sha256}\` (\`${resume.name}\`)`,
        `- continuation_method: ${method}${method === "agy --conversation" ? ` (conversation \`${resume.t.cli.conversation_id}\`, state restored)` : method === "codex-sdk-resume" ? ` (thread \`${resume.t.cli.thread_id}\` resumed with this run's worktree and sandbox)` : " (a new session; the prompt carries a delimited appendix of the reviewer's own earlier messages and tool results)"}`,
        `- runs: ${transcript.cumulative.runs}`,
        `- usage_totals_cumulative: \`${JSON.stringify(transcript.cumulative.usage)}\``,
        `- wall_clock_cumulative_s: ${transcript.cumulative.wall_s}`,
      ] : []),
      "",
      "<!-- reviewer's final message, verbatim, follows -->",
      "",
      "",
    ].join("\n");
    // A run the coverage gate made incomplete keeps the reviewer's final message (marked by the header's status and
    // coverage lines): it is evidence of what was reviewed, not a finished review.
    await writeFile(outPaths.findings, header + (status === "complete" || status === "policy_violation" || (r.status === "complete" && !gate.ok) ? finalText : ""));
    err(`run-review: ${status} (${stopReason}); wrote ${outPaths.findings}\n`);
    code = status === "complete" ? EXIT.complete : status === "refused" ? EXIT.refused : EXIT.incomplete;
    return code;
  } finally {
    await cleanup();
  }
}

/** The findings header's record of the Grok permission profile the run saw (from the preflight's read of config.toml). */
function grokPermissionsLine(p, inspect = null) {
  if (!p) return "not read";
  if (!p.present) return "no config.toml in the state dir (the CLI's default profile, \"ask\")";
  const tick = x => `\`${String(x).replace(/`/g, "'")}\``;
  const structured = p.structured_rules ? `; ${p.structured_rules} structured \`rules = [...]\` rule(s), not counted (grok 1.0.44 loaded none)` : "";
  const native = inspect ? `; the CLI's own inspection: ${inspect.ok ? `${inspect.loaded} loaded, ${inspect.skipped.length} skipped` : `unreadable (${inspect.why})`}` : "";
  return `config.toml ${p.permission_mode ? tick(p.permission_mode) : "permission_mode unset (default \"ask\")"}; ${p.allow_rules} string-form allow rule(s): ${p.allow.length ? p.allow.map(tick).join(" ") : "none"}${p.deny?.length ? `; deny ${p.deny.map(tick).join(" ")}` : ""}${structured}${native}`;
}

/** The findings header's record of the codex outer runtime (WSL). */
function outerLine(o) {
  if (!o) return "not applicable";
  if (!o.applied) return `none (${o.mode === "off" ? "--codex-outer-runtime off" : o.wsl ? `WSL detected, but: ${o.why}` : "not WSL"}; codex runs directly under its own sandbox)`;
  return `an outer bwrap namespace around codex (${o.mode === "on" ? "--codex-outer-runtime on" : `WSL: ${o.evidence.join("; ")}`}): host read-only, private /run and /tmp, writable only ${o.writable.map(p => `\`${p}\``).join(", ")}; codex then applies the unchanged inner permission profile (its exact-profile preflight ran through the same launcher). Reason: codex's bwrap cannot mkdir /run/WSL under the profile's denied /run. Cost: one more namespace level`;
}

/** The findings header's record of the review copy. */
function reviewCopyLine(c) {
  if (!c?.head) return c?.kind ?? "unknown";
  return `${c.kind}: HEAD \`${c.head}\` (tree \`${c.tree}\`), ${c.files} file(s) whose modes and blob ids equal \`${c.source_commit}\`'s (tree \`${c.source_tree}\`), ${c.withheld_count} withheld path(s) never written into it${c.submodules_skipped ? `, ${c.submodules_skipped} submodule(s) not exported` : ""}`;
}

function sandboxLine(transport, plan) {
  if (transport === "codex-sdk") return `codex permission profile ${plan.sandbox.profile} (codex's own bubblewrap sandbox${plan.sandbox.outer_runtime ? ", inside the runner's outer WSL namespace (see codex_outer_runtime)" : ", not nested in the runner's"}: reads the review copy and the runtime only; writes ${plan.writable_paths.length > 1 ? `${REVIEW_TESTS_DIR}/ and ` : ""}a scratch TMPDIR outside the worktree; network cut by codex's proxy), approvals ${plan.sandbox.approvals}`;
  if (transport === "grok-cli") return "the runner's bwrap jail (host read-only; worktree read-only" + (plan.writable_paths.some(p => p.endsWith(REVIEW_TESTS_DIR)) ? ` except ${REVIEW_TESTS_DIR}/` : "") + "; state dir a per-run scratch copy; network not cut)";
  return "the unit worker's bwrap jail + PreToolUse jail hook (review policy)";
}

const timeoutStop = wall => `wall clock reached (${wall} s): process group killed`;

/**
 * The paths codex's sandbox must let the commands read besides :minimal and the worktree: the codex binary's vendor
 * dir (codex re-executes itself inside its sandbox; ripgrep sits beside it), the install of the `node` the commands
 * will run (first on the child's PATH, else this process's), and the telos root when given. All real paths.
 */
// L-404: the node install is NO LONGER a read root (no code under review runs in codex's sandbox); the node and npm
// binaries the commands would find are returned as `deny` (codexPermissionProfile denyPaths), so a node that sits under
// :minimal (/usr/bin/node) is denied too.
async function codexReadRoots({ cli, childEnv, telosRoot }) {
  const real = p => realpath(p).catch(() => null);
  const bin = await real(cli);
  const vendor = bin ? (/\/bin\/codex(\.exe)?$/.test(bin) ? dirname(dirname(bin)) : dirname(bin)) : null;
  const deny = new Set();
  for (const n of ["node", "npm", "npx", "nodejs"]) { const p = await findCli(n, null, childEnv).catch(() => null); if (p) deny.add(p); }
  const self = await real(process.execPath); if (self) deny.add(self);
  return { roots: [vendor, telosRoot ? await real(telosRoot) : null].filter(Boolean), deny: [...deny].sort() };
}

/** What the plan and transcript record about the SDK: package, version, which binary runs and why, the key check. */
function codexSdkRecord(sdk, explicit, cli) {
  return { package: CODEX_SDK_PACKAGE, version: sdk.version ?? null, ok: sdk.ok, ...(sdk.ok ? {} : { why: sdk.why }),
    binary: { path: cli, source: explicit ? "--codex-cli (passed to the SDK as codexPathOverride)" : "the SDK's own resolution (@openai/codex -> its platform package's vendor/<triple>/bin/codex), passed as codexPathOverride so the preflight runs the same binary",
      ...(explicit ? {} : { triple: sdk.binary?.triple ?? null, platform_package: sdk.binary?.platform_package ?? null, path_dirs: sdk.binary?.path_dirs ?? [] }) },
    spawns: "`<binary> exec --experimental-json ...`, JSONL over stdout, the prompt on stdin (dist/index.js:178-277)",
    auth: "the CLI's own login under $CODEX_HOME (default ~/.codex/auth.json); the SDK sets CODEX_API_KEY only when an apiKey option is passed, and none is",
    key_injection: sdk.key_injection ?? null };
}

async function runGrok({ argv, wt, childEnv, wall }) {
  const lines = [];
  const r = await runCli({ cmd: argv[0], args: argv.slice(1), cwd: wt, env: childEnv, timeoutMs: wall * 1000, onLine: l => lines.push(l) });
  const ev = parseGrokStream(lines);
  const record = { own: capOwn(ev.own), events: ev.events, unparsed_lines: ev.unparsed, text_chunks: ev.chunks, complete_messages: ev.messages, final_source: ev.final_source,
    cli_stop_reason: ev.stop_reason, num_turns: ev.num_turns, tool_calls: ev.tool_calls, advertised_tools: ev.advertised_tools, ...(ev.cancelled_tools.length ? { cancelled_tools: ev.cancelled_tools } : {}), ...(ev.diagnosis ? { no_final_text: ev.diagnosis } : {}), error: ev.error && redactStrong(ev.error, childEnv), stderr_tail: redactStrong(tail(r.stderr), childEnv), ...(r.spawn_error ? { spawn_error: r.spawn_error } : {}) };
  const base = { exit_code: r.exit_code, killed_for: r.killed_for, usage: ev.usage, record, final_text: ev.final_text };
  if (r.killed_for === "timeout") return { ...base, status: "incomplete", stop_reason: timeoutStop(wall) };
  if (r.killed_for || r.spawn_error) return { ...base, status: "incomplete", stop_reason: `grok stopped (${r.killed_for ?? r.spawn_error})` };
  const said = `${r.stderr}\n${ev.error ?? ""}\n${r.exit_code !== 0 ? r.stdout : ""}`;
  if ((r.exit_code !== 0 || !ev.final_text) && NEEDS_KEY.test(said)) {
    return { ...base, final_text: null, status: "refused", stop_reason: "the Grok CLI asked for an API key or a login: subscription mode never supplies XAI_API_KEY (that would be metered); sign in once with the browser (`grok`), then run again" };
  }
  if (r.exit_code !== 0) return { ...base, status: "incomplete", stop_reason: `grok exited ${r.exit_code}${ev.error ? `: ${record.error}` : ""}` };
  // A turn the CLI ended with any stopReason but end_turn did not finish, whatever its exit code (observed 2026-11-19:
  // exit 0 with stopReason "cancelled" after the default permission profile cancelled an authorized edit).
  if (ev.stop_reason && ev.stop_reason !== "end_turn") return { ...base, final_text: null, status: "failed", stop_reason: redactStrong(grokStopFailure(ev.stop_reason, ev.cancelled_tools, r.exit_code), childEnv) };
  if (!ev.final_text || !ev.final_text.trim()) return { ...base, status: "incomplete", stop_reason: `grok returned no final text (${ev.events} event(s), ${ev.unparsed} unparsed line(s); no assistant message, result event or text chunk was recognised; last event types: ${ev.diagnosis.last_event_types.join(", ") || "none"}; most frequent: ${Object.entries(ev.diagnosis.type_counts).slice(0, 6).map(([k, n]) => `${k} x${n}`).join(", ") || "none"}; the transcript keeps the events (record.own) and record.no_final_text)` };
  return { ...base, status: "complete", stop_reason: "final answer" };
}

async function runAgy({ cli, ws, wt, lane, prompt, timeoutS, graceS, childEnv, sandbox, jail, conversation = null }) {
  const summarize = async x => ({ conversation_id: x?.conversation_id ?? null,
    own: capOwn([...(x?.tool_steps ?? []).map(st => ({ kind: `tool step ${st.tool_name ?? "?"} (${st.state ?? "?"})`, text: JSON.stringify(st.tool_info ?? null).slice(0, 16384) })),
      ...(typeof x?.text === "string" && x.text ? [{ kind: "your message", text: x.text }] : [])]),
    tool_steps: x?.tool_steps ?? [], tool_drift: x?.tool_drift ?? null, jail_decisions: (await readJailLog(ws.paths.control_dir)).map(d => ({ tool: d.tool ?? null, args: d.args ?? null, decision: d.decision ?? null, reason: d.reason ?? null })),
    launch: x?.launch ?? null, num_turns: x?.num_turns ?? null, result_status: x?.result_status ?? x?.status ?? null, exit_code: x?.exit_code ?? null, stderr_tail: x?.stderr_tail ? redactStrong(x.stderr_tail, childEnv) : null });
  try {
    const t = await runAgyWorkerTurn({ cli, control_dir: ws.paths.control_dir, worktree: wt, model: lane, prompt, timeoutS, graceS, base_env: childEnv, sandbox, jail, agent: REVIEW_AGENT, conversation });
    return { status: "complete", stop_reason: "final answer", final_text: t.text, usage: t.usage ?? null, exit_code: t.exit_code ?? 0, record: await summarize(t) };
  } catch (e) {
    const rec = await summarize(e);
    // THE MODEL GUARD (L-504 invariant 3; board/agy-cli.mjs agyIdentityMismatch): a CLI that started on another agent or
    // model is REFUSED, recorded with both identities; the header names no served model for it (never the lane). Refused,
    // not incomplete or failed: such a run is never continued (continue.mjs), so the other model's messages and tool
    // results are never replayed to a reviewer as its own (`own` is emptied; the tool steps stay on the record).
    if (e.code === AGY_MODEL_MISMATCH) {
      return { status: "refused", stop_reason: redactStrong(`${AGY_MODEL_MISMATCH}: ${e.message}`, childEnv), final_text: null, usage: e.usage ?? null, exit_code: e.exit_code ?? null,
        killed_for: null, identity_mismatch: e.identity ?? null, record: { ...rec, own: [], identity_mismatch: e.identity ?? null } };
    }
    const why = e.code === "quota_exhausted" ? `Antigravity refused for quota (${e.quota?.matched ?? "quota"})` : e.kind === "timeout" ? `wall clock reached (${timeoutS + graceS} s) or the print timeout (${timeoutS} s): ${e.message}` : `${e.code ?? "error"}${e.kind ? `/${e.kind}` : ""}: ${e.message}`;
    return { status: "incomplete", stop_reason: redactStrong(why, childEnv), final_text: null, usage: e.usage ?? null, exit_code: e.exit_code ?? null, killed_for: e.kind === "timeout" ? "timeout" : null, record: rec };
  }
}
