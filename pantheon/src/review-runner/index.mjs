// The independent-review runner: one assignment, one reviewer model, one disposable worktree.
// The owner runs it on their own machine with their own key. See HARNESS.md in the review
// directory for the only text the runner adds to what the reviewer is shown.
//
// THE GEMINI BILLING POLICY (register L-136; pantheon/src/route/gemini-billing.mjs, docs/billing-policy.md). `--via api`
// with a Google reviewer (assignment 1's default, or --reviewer google:<model>) is PRIMARY Gemini API execution: every
// request it sends -- each turn, and a retry after a 429/5xx -- is admitted by gemini_api_primary (default OFF; enabled by
// --gemini-api-primary N, N the budget of billed requests) BEFORE it is sent, and recorded in
// findings-<n>-<lab>.gemini-billing.jsonl beside the transcript (the budget's consumption: a --continue run continues
// it, a restart never resets it) and on the provider_call event of the transcript. Refused (off, or the budget spent):
// nothing is sent, the refusal is a transcript event, the run stops incomplete, and `--continue` resumes it once the
// owner allows the spend. A GEMINI_API_KEY in the environment authorizes nothing. --metered-gemini-failover N is
// resolved too, but no seat here fails over from a lane; --via subscription (the vendors' OAuth CLIs) is never refused.
import { spawn } from "node:child_process";
import { billingFromFlags, geminiBilling, geminiUsageFile, spendGemini, billingRecord, policyRecord, isGeminiBillingRefusal } from "../route/quota-failover.mjs";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { reviewTmpBase } from "./cli-common.mjs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { REVIEW_DIR, BriefError, loadBrief, reviewerHeaderLines, sha256, inScopePaths, listedTests, testingLine } from "./brief.mjs";
import { CAPS, permissionsFor, toolDefinitions, createToolbox } from "./tools.mjs";
import { coverageGate, coverageHeaderLine, coverageOfApi, gatedStatus, testsAllowedBy } from "./coverage.mjs";
import { buildChildEnv, WITHHELD } from "./sandbox.mjs";
import { VENDORS, authHeaders, createConversation, addUsage, redact } from "./vendors.mjs";
import { subscriptionMain, TRANSPORT_FOR } from "./subscription.mjs";
import { CONTINUE_NOTE, ContinueRefusal, preserveFiles, RESULT_CAP, captureReviewTests, cumulative, loadContinuation, replayApi, restoreReviewTests } from "./continue.mjs";
import { repoMutex } from "../pipeline/git.mjs";

export const EXIT = { complete: 0, refused: 1, usage: 2, incomplete: 3 };
export const PLAN_SCHEMA = "ophanim.review-run-plan/v1";

const USAGE = `usage: node pantheon/scripts/run-review.mjs --via api|subscription --assignment <1|2|3|4> --commit <40-hex> ...
  --via api            the metered API, the owner's key:
                       --max-turns N --max-tool-calls N --max-output-tokens N --timeout-s N
  --via subscription   one CLI agent per vendor, signed in to the owner's subscription
                       (1: agy, 2 and 4: codex via @openai/codex-sdk, 3: grok): --max-wall-s N [--timeout-s N]
                       [--allow-api-key-in-cli] [--skip-model-check] [--grok-state-dir DIR]
                       [--codex-cli PATH (default: the SDK's own codex binary)] [--grok-cli PATH] [--agy-cli PATH]
                       [--codex-outer-runtime auto|on|off (default auto: on under WSL)]
                       [--grok-permissions-inspect "<grok args>" (the CLI's own permission inspection; it must load > 0 rules)]
  [--reviewer <lab>:<model>]   run the assignment on another reviewer than its README default (lab: google, openai
                       or xai); the same brief, withheld files, tools, write rules and worktree checks, and that lab's
                       transport and model check; the findings are named by the actual lab (findings-<n>-<lab>.md)
                       and their header records default_reviewer and reviewer_override: true
  [--continue <findings-<n>-<lab>.transcript.json>]   resume an incomplete review of the same assignment
  [--gemini-api-primary N]   allow the Gemini API (a Google reviewer --via api) at most N billed requests; off by default
  [--metered-gemini-failover N]   resolved with the same policy; no seat here fails over from a lane
  [--out DIR] [--dry-run] [--keep] [--force] [--telos-root DIR]`;

const CAPABILITY_FACTS = JSON.parse(await readFile(new URL("../config/capability-facts.json", import.meta.url), "utf8"));

class Refusal extends Error {}
class UsageError extends Error {}

const exists = p => access(p).then(() => true, () => false);

function git(repoRoot, args, env) {
  return new Promise((res, rej) => {
    const c = spawn("git", ["-C", repoRoot, ...args], { env: { PATH: env.PATH ?? "/usr/bin:/bin", HOME: env.HOME ?? tmpdir(), LANG: env.LANG ?? "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] });
    const out = [], err = [];
    c.stdout.on("data", d => out.push(d));
    c.stderr.on("data", d => err.push(d));
    c.on("error", rej);
    c.on("close", code => res({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });
}

function parseCli(argv) {
  let v;
  try {
    v = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
      assignment: { type: "string" }, commit: { type: "string" },
      "max-turns": { type: "string" }, "max-tool-calls": { type: "string" },
      "max-output-tokens": { type: "string" }, "timeout-s": { type: "string" },
      out: { type: "string" }, "dry-run": { type: "boolean" }, keep: { type: "boolean" },
      force: { type: "boolean" }, "telos-root": { type: "string" }, help: { type: "boolean" },
      via: { type: "string" }, "max-wall-s": { type: "string" }, "allow-api-key-in-cli": { type: "boolean" }, "skip-model-check": { type: "boolean" },
      "grok-state-dir": { type: "string" }, continue: { type: "string" }, "codex-cli": { type: "string" }, "grok-cli": { type: "string" }, "agy-cli": { type: "string" },
      reviewer: { type: "string" }, "codex-outer-runtime": { type: "string" }, "grok-permissions-inspect": { type: "string" },
      "gemini-api-primary": { type: "string" }, "metered-gemini-failover": { type: "string" },
    } }).values;
  } catch (e) { throw new UsageError(e.message); }
  // THE BILLING POLICY, resolved before anything is read or run (see the header): malformed or unbudgeted is a usage error.
  let billing;
  try { billing = billingFromFlags(v); } catch (e) { throw new UsageError(e.message); }
  if (v.help) throw new UsageError("help");
  if (!/^[1-4]$/.test(v.assignment ?? "")) throw new UsageError("--assignment must be 1, 2, 3 or 4");
  if (!/^[0-9a-f]{40}$/.test(v.commit ?? "")) throw new UsageError("--commit must be a full 40-character lowercase hex commit id");
  // --via has no default: the owner chooses between metered API spend and the subscription CLIs every time.
  const reviewer = v.reviewer === undefined ? null : parseReviewer(v.reviewer);
  if (v.via !== "api" && v.via !== "subscription") throw new UsageError("--via is required: api (the metered API, the owner's key) or subscription (the vendors' CLIs, signed in to the owner's subscriptions)");
  const limits = {}, notes = [], ignoredCaps = [];
  const int = k => { if (!/^[1-9]\d*$/.test(v[k])) throw new UsageError(`--${k} must be a positive integer`); return Number(v[k]); };
  const subOnly = ["max-wall-s", "allow-api-key-in-cli", "skip-model-check", "grok-state-dir", "codex-cli", "grok-cli", "agy-cli", "codex-outer-runtime", "grok-permissions-inspect"];
  if (v["codex-outer-runtime"] !== undefined && !["auto", "on", "off"].includes(v["codex-outer-runtime"])) throw new UsageError("--codex-outer-runtime must be auto, on or off");
  if (v["grok-permissions-inspect"] !== undefined && !/^[A-Za-z0-9][A-Za-z0-9 ._=-]*$/.test(v["grok-permissions-inspect"])) throw new UsageError("--grok-permissions-inspect takes the Grok CLI arguments of its permission inspection, space-separated (letters, digits, . _ = -)");
  if (v.via === "api") {
    for (const k of ["max-turns", "max-tool-calls", "max-output-tokens", "timeout-s"]) {
      if (v[k] === undefined) throw new UsageError(`--${k} is required (there are no defaults; the owner chooses the spend)`);
      limits[k.replace(/-/g, "_")] = int(k);
    }
    for (const k of subOnly) if (v[k] !== undefined) notes.push(`--${k} applies to --via subscription only; ignored`);
  } else {
    if (v["max-wall-s"] === undefined) throw new UsageError("--max-wall-s is required with --via subscription (there are no defaults; it is the whole run's wall clock)");
    limits.max_wall_s = int("max-wall-s");
    if (v["timeout-s"] !== undefined) limits.timeout_s = int("timeout-s");
    for (const k of ["max-turns", "max-tool-calls", "max-output-tokens"]) {
      if (v[k] === undefined) continue;
      int(k);
      ignoredCaps.push(`--${k}`);
      notes.push(`--${k} is an API-mode cap; the subscription CLIs expose no such cap, so it is ignored (the wall clock bounds the run)`);
    }
  }
  return { via: v.via, n: Number(v.assignment), commit: v.commit, limits, notes, ignoredCaps, out: v.out ?? null, dryRun: !!v["dry-run"], keep: !!v.keep, force: !!v.force, telosRoot: v["telos-root"] ?? null,
    allowApiKeyInCli: !!v["allow-api-key-in-cli"], skipModelCheck: !!v["skip-model-check"], grokStateDir: v["grok-state-dir"] ?? null,
    codexCli: v["codex-cli"] ?? null, grokCli: v["grok-cli"] ?? null, agyCli: v["agy-cli"] ?? null, continue: v.continue ?? null, reviewer,
    codexOuterRuntime: v["codex-outer-runtime"] ?? "auto", grokPermissionsInspect: v["grok-permissions-inspect"] ? v["grok-permissions-inspect"].trim().split(/ +/) : null, billing };
}

// --reviewer <lab>:<model>: the lab names the vendor exactly as the README table's labs do (brief.mjs LAB_TO_VENDOR).
export const REVIEWER_LABS = Object.freeze({ google: { lab: "Google", vendor: "gemini" }, openai: { lab: "OpenAI", vendor: "openai" }, xai: { lab: "xAI", vendor: "xai" } });
export function parseReviewer(spec) {
  const m = /^([a-z]+):([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(String(spec ?? ""));
  if (!m) throw new UsageError(`--reviewer must be <lab>:<model> (lab: ${Object.keys(REVIEWER_LABS).join(", ")}), e.g. google:gemini-4-carbon; got ${JSON.stringify(spec)}`);
  const l = REVIEWER_LABS[m[1]];
  if (!l) throw new UsageError(`--reviewer: unknown lab ${JSON.stringify(m[1])} (one of ${Object.keys(REVIEWER_LABS).join(", ")})`);
  return { spec: `${m[1]}:${m[2]}`, lab: l.lab, vendor: l.vendor, model: m[2] };
}

/** The assignment row with the reviewer replaced (everything else -- title, file, scope, testing -- is the assignment's own). */
export function withReviewer(row, reviewer) {
  const default_reviewer = { lab: row.lab, vendor: row.vendor, model: row.model };
  if (!reviewer) return { ...row, default_reviewer, reviewer_override: false, reviewer_spec: null };
  return { ...row, lab: reviewer.lab, vendor: reviewer.vendor, model: reviewer.model, default_reviewer, reviewer_override: true, reviewer_spec: reviewer.spec };
}

// What both modes read: the commit's file list, the brief, the assignment row, the tool permissions.
async function loadAssignment(opts, { repoRoot, env, harnessValues }) {
  const { n, commit } = opts;
  const t = await git(repoRoot, ["cat-file", "-t", commit], env);
  if (t.code !== 0 || t.stdout.trim() !== "commit") throw new Refusal(`commit ${commit} does not exist in ${repoRoot}`);
  const ls = await git(repoRoot, ["ls-tree", "-r", "--name-only", "-z", commit], env);
  if (ls.code !== 0) throw new Refusal(`cannot list commit ${commit}`);
  const files = ls.stdout.split("\0").filter(Boolean);
  let b;
  try { b = await loadBrief({ repoRoot, n, commit, harnessValues }); }
  catch (e) { if (e instanceof BriefError || e.code === "ENOENT") throw new Refusal(e.message); throw e; }
  const row = withReviewer(b.row, opts.reviewer);
  b.row = row;
  const listed = listedTests(b.assignmentText, files);
  const permissions = permissionsFor(row.testing, listed.files);
  if (!permissions) throw new Refusal(`assignment ${n}: testing limit "${row.testing}" has no tool policy in the runner; refusing rather than guessing`);
  if (permissions.run_tests.files && permissions.run_tests.files.length === 0) throw new Refusal(`assignment ${n}: the assignment lists no existing tests that exist at ${commit}`);
  return { files, b, row, listed, permissions, withheld: files.filter(f => WITHHELD.some(re => re.test(f))) };
}

const outPathsFor = (opts, row, repoRoot, cwd) => {
  const outDir = opts.out ? resolve(cwd, opts.out) : join(repoRoot, REVIEW_DIR);
  const lab = row.lab.toLowerCase();
  return { findings: join(outDir, `findings-${opts.n}-${lab}.md`), transcript: join(outDir, `findings-${opts.n}-${lab}.transcript.json`) };
};

// Build the plan: everything the run will send and allow, computed without a worktree or network.
export async function buildPlan(opts, { repoRoot, env, cwd = process.cwd() }) {
  const { n, commit, limits } = opts;
  const harnessValues = {
    MAX_TURNS: limits.max_turns, MAX_TOOL_CALLS: limits.max_tool_calls, MAX_OUTPUT_TOKENS: limits.max_output_tokens,
    TIMEOUT_S: limits.timeout_s, READ_CAP: CAPS.READ_BYTES, GREP_CAP: CAPS.GREP_MATCHES, OUTPUT_CAP: CAPS.OUTPUT_BYTES,
  };
  const { files, b, row, listed, permissions } = await loadAssignment(opts, { repoRoot, env, harnessValues });
  const fileTesting = testingLine(b.assignmentText);
  const tools = toolDefinitions(permissions);

  const cited = CAPABILITY_FACTS.models?.[row.model]?.output?.value ?? null;
  if (Number.isSafeInteger(cited) && limits.max_output_tokens > cited) {
    throw new UsageError(`--max-output-tokens ${limits.max_output_tokens} exceeds the cited output limit ${cited} for ${row.model}`);
  }

  const atCommit = async rel => { const r = await git(repoRoot, ["show", `${commit}:${rel}`], env); return r.code === 0 ? r.stdout : null; };
  const sameAs = async (rel, text) => { const c = await atCommit(rel); return c === null ? "absent at commit" : c === text; };

  const vendor = VENDORS[row.vendor];
  const outDir = opts.out ? resolve(cwd, opts.out) : join(repoRoot, REVIEW_DIR);
  const lab = row.lab.toLowerCase();
  const findings = join(outDir, `findings-${n}-${lab}.md`);
  const transcript = join(outDir, `findings-${n}-${lab}.transcript.json`);
  const childEnvNames = Object.keys(buildChildEnv({ parentEnv: env, home: "<temp>", tmpdir: "<temp>", telosRoot: opts.telosRoot })).sort();

  return {
    schema: PLAN_SCHEMA,
    dry_run: opts.dryRun,
    via: "api",
    assignment: { n, title: row.title, file: `${REVIEW_DIR}/${row.file}`, scope: row.scope, testing: row.testing, testing_line_in_file: fileTesting },
    lab: row.lab, vendor: row.vendor, model: row.model,
    default_reviewer: row.default_reviewer, reviewer_override: row.reviewer_override, ...(row.reviewer_override ? { reviewer: row.reviewer_spec } : {}),
    model_facts: { cited_max_output: cited, reasoning_effort_sent: null },
    commit,
    endpoint: row.vendor === "gemini" ? vendor.endpoint.replace("<model>", row.model) : vendor.endpoint,
    request: {
      harness_template: { path: `${REVIEW_DIR}/HARNESS.md`, bytes: Buffer.byteLength(b.harnessTemplate), sha256: sha256(b.harnessTemplate) },
      system: { bytes: Buffer.byteLength(b.system), sha256: sha256(b.system), text: b.system },
      brief: { bytes: Buffer.byteLength(b.brief), sha256: sha256(b.brief), text: b.brief,
               parts: { readme_sha256: sha256(b.readme), assignment_sha256: sha256(b.assignmentText) } },
      tools: { sha256: sha256(JSON.stringify(tools)), definitions: tools },
      source_files_match_commit: {
        readme: await sameAs(`${REVIEW_DIR}/README.md`, b.readme),
        assignment: await sameAs(`${REVIEW_DIR}/${row.file}`, b.assignmentText),
        harness: await sameAs(`${REVIEW_DIR}/HARNESS.md`, b.harnessTemplate),
      },
    },
    tool_permissions: permissions,
    in_scope_paths: inScopePaths(b.assignmentText, files),
    listed_test_patterns: listed.patterns,
    withheld_from_worktree: files.filter(f => WITHHELD.some(re => re.test(f))),
    limits: { ...limits, per_call_caps: { ...CAPS } },
    key: { env: vendor.key_env, present: typeof env[vendor.key_env] === "string" && env[vendor.key_env].length > 0, sent_as: vendor.auth },
    child_process_env: { names: childEnvNames, telos_root_set: !!opts.telosRoot },
    worktree: { kind: "detached git worktree in a new temp dir", removed_after_run: !opts.keep, dependencies: "node_modules copied from the runner's checkout where present" },
    out: { findings, transcript, findings_exists: await exists(findings), overwrite: opts.force, gemini_billing: join(outDir, `findings-${n}-${lab}.gemini-billing.jsonl`) },
    // THE GEMINI BILLING POLICY in force (see the header): a Google reviewer over the API is primary Gemini API execution.
    gemini_billing: { ...policyRecord(opts.billing), applies: row.vendor === "gemini" ? "primary: every request admitted by gemini_api_primary before it is sent" : "none: no Gemini API request on this run" },
    provider_calls: 0,
    _brief: b, // not printed
  };
}

const printable = plan => { const { _brief, ...p } = plan; return p; };

// Entry point. Returns the exit code. deps: { repoRoot, env, fetch, stdout, stderr, sleep, now, tmpBase, cwd, copyDependencies }
export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const out = deps.stdout ?? (s => process.stdout.write(s));
  const err = deps.stderr ?? (s => process.stderr.write(s));
  let opts;
  try { opts = parseCli(argv); }
  catch (e) { err(`${e.message === "help" ? "" : `run-review: ${e.message}\n`}${USAGE}\n`); return e.message === "help" ? EXIT.complete : EXIT.usage; }
  if (opts.via === "subscription") {
    let a;
    try { a = await loadAssignment(opts, { repoRoot: deps.repoRoot, env, harnessValues: { MAX_TURNS: "n/a", MAX_TOOL_CALLS: "n/a", MAX_OUTPUT_TOKENS: "n/a", TIMEOUT_S: "n/a", READ_CAP: CAPS.READ_BYTES, GREP_CAP: CAPS.GREP_MATCHES, OUTPUT_CAP: CAPS.OUTPUT_BYTES } }); }
    catch (e) {
      if (e instanceof Refusal) { err(`run-review: refused: ${e.message}\n`); return EXIT.refused; }
      throw e;
    }
    if (!TRANSPORT_FOR[a.row.vendor]) { err(`run-review: refused: no subscription transport for vendor ${a.row.vendor}\n`); return EXIT.refused; }
    return subscriptionMain({ opts, a, repoRoot: deps.repoRoot, env, deps, out, err, EXIT, outPaths: outPathsFor(opts, a.row, deps.repoRoot, deps.cwd ?? process.cwd()) });
  }
  for (const n of opts.notes) err(`run-review: note: ${n}\n`);
  let plan;
  try { plan = await buildPlan(opts, { repoRoot: deps.repoRoot, env, cwd: deps.cwd }); }
  catch (e) {
    if (e instanceof UsageError) { err(`run-review: ${e.message}\n`); return EXIT.usage; }
    if (e instanceof Refusal) { err(`run-review: refused: ${e.message}\n`); return EXIT.refused; }
    throw e;
  }
  let resume = null;
  if (opts.continue) {
    try {
      resume = await loadContinuation(resolve(deps.cwd ?? process.cwd(), opts.continue), { n: opts.n, lab: plan.lab.toLowerCase(), vendor: plan.vendor, model: plan.model, commit: plan.commit, via: "api", brief_sha256: plan.request.brief.sha256, reviewer: plan.reviewer_override ? plan.reviewer : null });
    } catch (e) { if (e instanceof ContinueRefusal) { err(`run-review: refused: ${e.message}\n`); return EXIT.refused; } throw e; }
    plan.continue = { from: resume.path, transcript_sha256: resume.sha256, method: plan.vendor === "openai" ? "previous_response_id" : "replayed-history",
      prior: resume.prior, review_tests_to_restore: (resume.t.review_tests.files ?? []).map(f => f.path) };
  }
  out(JSON.stringify(printable(plan), null, 2) + "\n");
  if (opts.dryRun) return EXIT.complete;

  const key = env[plan.key.env];
  if (!plan.key.present) { err(`run-review: refused: ${plan.key.env} is not set\n`); return EXIT.refused; }
  const sameFiles = resume && resolve(resume.path) === resolve(plan.out.transcript);
  if (sameFiles) await preserveFiles(resume, plan.out);
  else if (plan.out.findings_exists && !opts.force) { err(`run-review: refused: ${plan.out.findings} exists (use --force to overwrite)\n`); return EXIT.refused; }
  if (!sameFiles && !opts.force && await exists(plan.out.transcript)) { err(`run-review: refused: ${plan.out.transcript} exists (use --force to overwrite)\n`); return EXIT.refused; }

  const result = await liveRun({ plan, opts, key, env, deps, resume });
  err(`run-review: ${result.status} (${result.stop_reason}); wrote ${plan.out.findings}\n`);
  return result.status === "complete" ? EXIT.complete : EXIT.incomplete;
}

async function liveRun({ plan, opts, key, env, deps, resume = null }) {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());
  const repoRoot = deps.repoRoot;
  const secrets = Object.entries(env).filter(([k, v]) => v && (/_API_KEY$|KEY|TOKEN|SECRET/i.test(k)) && v.length >= 8).map(([, v]) => v);
  if (!secrets.includes(key)) secrets.push(key);
  const timeoutMs = opts.limits.timeout_s * 1000;
  const b = plan._brief;
  // The run's Gemini billing context: the declared policy over the usage record beside the transcript (see the header).
  const billing = geminiBilling({ policy: opts.billing, ledger: geminiUsageFile(plan.out.gemini_billing) });

  const started = now();
  // Not under /tmp (cli-common.mjs reviewTmpBase: the repository's jail fixtures hide /tmp from the code they jail).
  const tmpBase = deps.tmpBase ?? reviewTmpBase(env);
  await mkdir(tmpBase, { recursive: true, mode: 0o700 });
  const tmp = await mkdtemp(join(tmpBase, "ophanim-review-"));
  const wt = join(tmp, "worktree"), home = join(tmp, "home"), childTmp = join(tmp, "tmp");
  await mkdir(home); await mkdir(childTmp);
  const transcript = {
    schema: "ophanim.review-transcript/v1",
    assignment: plan.assignment.n, lab: plan.lab, vendor: plan.vendor, requested_model: plan.model, commit: plan.commit,
    default_reviewer: plan.default_reviewer, reviewer_override: plan.reviewer_override, ...(plan.reviewer_override ? { reviewer: plan.reviewer } : {}),
    endpoint: plan.endpoint,
    hashes: { harness_template: plan.request.harness_template.sha256, system: plan.request.system.sha256, brief: plan.request.brief.sha256, tools: plan.request.tools.sha256 },
    via: "api", limits: opts.limits, started_at: started.toISOString(), gemini_billing: null,
    // A continuation carries the earlier run's events first (they are what a later --continue replays), then its own.
    events: resume ? [...(resume.t.events ?? [])] : [],
    ...(resume ? { continued_from: { transcript: resume.name, sha256: resume.sha256, method: plan.continue.method } } : {}),
  };
  const state = { providerCalls: 0, toolCalls: 0, usage: {}, served: [], stop: null, final: null };
  let worktreeAdded = false;
  // THE REPOSITORY LOCK (register L-126). `git worktree add` creates <common>/worktrees/<name>/ and only then writes its
  // `gitdir`; a `git worktree prune` run by another process in between deletes that half-made entry (and a prune here
  // could delete a pipeline's). The pipeline holds git.mjs repoMutex -- one lock per repository, across processes, the
  // file <git common dir>/pantheon-worktrees.lock -- for every mutation of the worktree list; this runner's add, remove
  // and prune of its disposable worktree run under the same lock, keyed by the repository root (never the worktree), and
  // each holds it until its git has exited.
  let repoLock = null;
  try {
    repoLock = repoMutex(repoRoot);
    const add = await repoLock(() => git(repoRoot, ["worktree", "add", "--detach", wt, plan.commit], env));
    if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr.trim()}`);
    worktreeAdded = true;
    for (const f of plan.withheld_from_worktree) await rm(join(wt, f), { force: true });
    if (deps.copyDependencies !== false) {
      for (const d of ["node_modules", "pantheon/node_modules", "packages/model-client/node_modules", "packages/ledger/node_modules"]) {
        if (await exists(join(repoRoot, d))) await cp(join(repoRoot, d), join(wt, d), { recursive: true, verbatimSymlinks: true });
      }
    }
    const childEnv = buildChildEnv({ parentEnv: env, home, tmpdir: childTmp, telosRoot: opts.telosRoot, secrets });
    const toolbox = createToolbox({ root: wt, permissions: plan.tool_permissions, env: childEnv, timeoutMs, telosRoot: opts.telosRoot ?? null, ...(deps.bwrap ? { bwrap: deps.bwrap } : {}) });
    const conv = createConversation(plan.vendor, { model: plan.model, system: b.system, brief: b.brief, tools: toolbox.definitions, maxOutputTokens: opts.limits.max_output_tokens });

    let turn = 0;
    // One tool call, executed and recorded (full arguments and full result, each capped at RESULT_CAP, so that a later
    // --continue can replay them). Returns its result, or null when max_tool_calls is reached.
    const execCall = async (c, atTurn) => {
      if (state.toolCalls >= opts.limits.max_tool_calls) { state.stop = `max_tool_calls reached (${opts.limits.max_tool_calls})`; return null; }
      state.toolCalls++;
      const t0 = Date.now();
      const out = c.args_error ? { text: `refused: ${c.args_error}`, refused: true } : await toolbox.call(c.name, c.args);
      const text = redact(out.text, secrets);
      const kept = clipFull(text, RESULT_CAP);
      transcript.events.push({
        type: "tool_call", n: state.toolCalls, turn: atTurn, id: c.id ?? null, name: c.name, args: clipArgs(c.args), args_full: true,
        outcome: out.refused ? "refused" : out.error ? "error" : "ok", exit_code: out.exit_code ?? null, timed_out: out.timed_out ?? false,
        result_sha256: sha256(text), result_bytes: Buffer.byteLength(text), result_text: kept.text, result_full: true, ...(kept.truncated ? { result_truncated: true } : {}), duration_ms: Date.now() - t0,
      });
      return { id: c.id, name: c.name, output: text };
    };
    let stopped = false;
    if (resume) {
      // THE CONTINUATION: the earlier conversation, as recorded, then what it was waiting for.
      if (resume.t.review_tests?.files?.length) state.restored = await restoreReviewTests(wt, resume.t.review_tests);
      const rp = replayApi(conv, resume.t);
      turn = Math.max(rp.last_turn, ...(resume.t.events ?? []).map(e => (Number.isInteger(e.turn) ? e.turn : 0)), 0);
      state.replayed_turns = rp.turns;
      const ev = { type: "continuation", from_sha256: resume.sha256, method: plan.continue.method, replayed_turns: rp.turns, restored_review_tests: state.restored?.restored ?? [] };
      if (rp.partial !== null) { ev.note = CONTINUE_NOTE; ev.cut_off_reply_bytes = Buffer.byteLength(rp.partial); conv.addContinuation(rp.partial, CONTINUE_NOTE); }
      if (rp.last) { ev.pending_recorded_outputs = rp.last.recorded.length; ev.pending_unrun_calls = rp.last.missing.length; }
      transcript.events.push(ev);
      if (rp.last) {
        const byId = new Map(rp.last.recorded.map(r => [r.id, r]));
        const results = [];
        for (const c of rp.last.calls) {
          if (byId.has(c.id)) { results.push(byId.get(c.id)); continue; }
          const r = await execCall(c, rp.last_turn);
          if (!r) { stopped = true; break; }
          results.push(r);
        }
        if (!stopped) conv.addToolResults(results);
      }
    }
    outer: for (;;) {
      if (stopped) break;
      if (state.providerCalls >= opts.limits.max_turns) { state.stop = `max_turns reached (${opts.limits.max_turns})`; break; }
      turn++;
      const req = conv.request();
      const res = await providerCall({ req, plan, key, fetchFn, sleep, timeoutMs, state, opts, transcript, secrets, turn, billing });
      if (!res.ok) { state.stop = res.reason; break; }
      const r = conv.accept(res.json);
      state.served.push(r.served_model);
      state.usage = addUsage(state.usage, r.usage);
      transcript.events.at(-1).served_model = r.served_model;
      if (r.calls.length === 0) {
        if (r.incomplete) { state.stop = `provider stopped: ${r.incomplete}`; break; }
        if (!r.text.trim()) { state.stop = "provider returned no text and no tool call"; break; }
        state.final = r.text; state.stop = "final answer"; break;
      }
      const results = [];
      for (const c of r.calls) {
        const res = await execCall(c, turn);
        if (!res) break outer;
        results.push(res);
      }
      conv.addToolResults(results);
    }
  } catch (e) {
    state.stop = `runner error: ${redact(e.message, secrets)}`;
  } finally {
    // What the reviewer wrote under .review-tests/, in full (capped), so a later --continue can restore it.
    if (worktreeAdded) state.review_tests = await captureReviewTests(wt).catch(e => ({ captured: false, why: e.message }));
    if (worktreeAdded && !opts.keep) {
      // Under the repository lock (L-126); a lock that cannot be taken (REPO_LOCK_TIMEOUT) leaves the worktree
      // registered and is recorded, rather than losing the transcript.
      try {
        await repoLock(async () => {
          await git(repoRoot, ["worktree", "remove", "--force", wt], env);
          await git(repoRoot, ["worktree", "prune"], env);
        });
      } catch (e) { state.cleanup_error = redact(e?.message ?? String(e), secrets); }
    }
    if (!opts.keep) await rm(tmp, { recursive: true, force: true });
  }

  const ended = now();
  // THE COVERAGE GATE (L-501, self-audit round 3, assignment 4 (sealed fe2a612); coverage.mjs): a final answer is not a
  // finished review when no source file was read, a read was denied, or no test ran where the testing limit allows tests.
  // On a continuation the events of the earlier runs count too (the review is one review across its runs).
  const coverage = coverageOfApi(transcript.events, { tests_allowed: testsAllowedBy(plan.tool_permissions) });
  const gate = coverageGate(coverage);
  const gated = gatedStatus(state.final !== null ? "complete" : "incomplete", state.stop, gate);
  const status = gated.status;
  state.stop = gated.stop_reason;
  const servedFinal = state.served.at(-1) ?? null;
  const distinctServed = [...new Set(state.served.map(s => s ?? null))];
  Object.assign(transcript, {
    ended_at: ended.toISOString(), status, stop_reason: state.stop, coverage, coverage_gate: gate, provider_calls: state.providerCalls, tool_calls: state.toolCalls,
    served_models: distinctServed, usage_totals: state.usage, worktree_kept: opts.keep ? wt : null,
    // The policy, every billed Gemini request (recorded before it was sent) and every refusal of this run (L-136).
    gemini_billing: billingRecord(billing),
    review_tests: state.review_tests ?? { captured: false, why: "no worktree was created" },
    ...(state.cleanup_error ? { worktree_cleanup_error: state.cleanup_error } : {}),
  });
  const cum = resume ? cumulative(resume.prior, { provider_calls: state.providerCalls, tool_calls: state.toolCalls, usage: state.usage, wall_s: Math.round((ended - started) / 1000) }) : null;
  if (cum) transcript.cumulative = cum;
  const outDir = resolve(plan.out.findings, "..");
  await mkdir(outDir, { recursive: true });
  const tBytes = redact(JSON.stringify(transcript, null, 2) + "\n", [key]);
  await writeFile(plan.out.transcript, tBytes);

  let finalText = state.final ?? "";
  let redactions = 0;
  if (finalText.includes(key)) { redactions = finalText.split(key).length - 1; finalText = finalText.split(key).join("[REDACTED]"); }
  const header = [
    "<!-- Written by pantheon/scripts/run-review.mjs. The runner's header ends at the marker line below; the reviewer's final message follows it verbatim. -->",
    `# Review run: assignment ${plan.assignment.n}, ${plan.assignment.title}`,
    "",
    `- status: ${status}`,
    `- stop_reason: ${state.stop}`,
    `- coverage: ${coverageHeaderLine(coverage, gate)}`,
    `- lab: ${plan.lab}`,
    `- requested_model: \`${plan.model}\``,
    ...reviewerHeaderLines(plan),
    `- served_model: ${servedFinal === null ? "null (the provider's response named no served model; the requested name is not substituted)" : `\`${servedFinal}\``}`,
    ...(distinctServed.length > 1 ? [`- served_models_across_calls: ${distinctServed.map(s => s === null ? "null" : `\`${s}\``).join(", ")}`] : []),
    `- commit: \`${plan.commit}\``,
    `- started_at: ${started.toISOString()}`,
    `- ended_at: ${ended.toISOString()}`,
    `- provider_calls: ${state.providerCalls}`,
    ...(plan.vendor === "gemini" ? [`- gemini_billing: gemini_api_primary ${opts.billing.gemini_api_primary.enabled ? `enabled, budget ${opts.billing.gemini_api_primary.budget}` : "off"} (${opts.billing.gemini_api_primary.source}); billed requests this run: ${billing.rows.length}; refused: ${billing.refusals.length}`] : []),
    `- tool_calls: ${state.toolCalls}`,
    `- usage_totals: \`${JSON.stringify(state.usage)}\``,
    `- limits: \`${JSON.stringify(opts.limits)}\``,
    `- transcript: \`${plan.out.transcript.split(/[\\/]/).pop()}\` sha256 \`${sha256(tBytes)}\``,
    `- harness_template_sha256: \`${plan.request.harness_template.sha256}\``,
    `- system_sha256: \`${plan.request.system.sha256}\``,
    `- brief_sha256: \`${plan.request.brief.sha256}\``,
    `- tools_sha256: \`${plan.request.tools.sha256}\``,
    ...(redactions ? [`- redactions: ${redactions} occurrence(s) of the API key were replaced in the final message`] : []),
    ...(resume ? [
      `- continued_from: \`${resume.sha256}\` (\`${resume.name}\`, kept as \`${resume.name.replace(/\.transcript\.json$/, `.transcript.prev-${resume.sha256.slice(0, 12)}.json`)}\` when overwritten)`,
      `- continuation_method: ${plan.continue.method}${plan.vendor === "openai" ? " (the earlier responses are stored server-side; pending function_call_output items sent)" : " (the recorded responses and full tool results replayed as the conversation so far)"}`,
      `- runs: ${cum.runs}`,
      `- provider_calls_cumulative: ${cum.provider_calls}`,
      `- tool_calls_cumulative: ${cum.tool_calls}`,
      `- usage_totals_cumulative: \`${JSON.stringify(cum.usage)}\``,
    ] : []),
    "",
    "<!-- reviewer's final message, verbatim, follows -->",
    "",
    "",
  ].join("\n");
  // A final message the coverage gate did not accept is kept after the header (status incomplete says what it is).
  await writeFile(plan.out.findings, header + (status === "complete" || (state.final !== null && !gate.ok) ? finalText : ""));
  return { status, stop_reason: state.stop };
}

async function providerCall({ req, plan, key, fetchFn, sleep, timeoutMs, state, opts, transcript, secrets, turn, billing }) {
  const body = JSON.stringify(req.body);
  for (let attempt = 1; ; attempt++) {
    // A Gemini request is PRIMARY Gemini API execution: admitted by the billing policy and recorded on its usage record
    // BEFORE it is sent, each attempt (a retry is a billed request too); refused, nothing is sent (see the header).
    let gemini = null;
    if (plan.vendor === "gemini") {
      try { gemini = spendGemini(billing, { kind: "primary", vendor: "gemini", model: plan.model, purpose: `review assignment ${plan.assignment.n}`, role: "reviewer", transport: "api", request: state.providerCalls + 1 }); }
      catch (e) {
        const b = e?.billing ?? {};
        transcript.events.push({ type: "provider_call_refused", turn, attempt, at: new Date().toISOString(), code: e?.code ?? null, kind: "primary", setting: "gemini_api_primary",
          source: b.source ?? null, budget: b.budget ?? null, used: b.used ?? null, provider_requests: 0, why: redact(String(e?.message ?? e), secrets) });
        return { ok: false, reason: `${isGeminiBillingRefusal(e) ? "" : "the Gemini usage could not be recorded: "}${redact(String(e?.message ?? e), secrets)}` };
      }
    }
    state.providerCalls++;
    const ev = { type: "provider_call", n: state.providerCalls, turn, attempt, at: new Date().toISOString(), request_bytes: Buffer.byteLength(body), request_sha256: sha256(body),
      ...(gemini ? { gemini: { kind: gemini.kind, setting: gemini.setting, source: gemini.source, budget: gemini.budget, used_before: gemini.used_before, remaining_after: gemini.remaining_after } } : {}) };
    transcript.events.push(ev);
    const t0 = Date.now();
    let resp;
    try {
      resp = await fetchFn(req.url, { method: "POST", headers: { "content-type": "application/json", ...authHeaders(plan.vendor, key) }, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      ev.duration_ms = Date.now() - t0;
      ev.error = redact(e?.message ?? String(e), secrets);
      return { ok: false, reason: `network error: ${ev.error}` };
    }
    ev.duration_ms = Date.now() - t0;
    ev.http_status = resp.status;
    const raw = await resp.text().catch(() => "");
    if (!resp.ok) {
      let msg = raw;
      try { const j = JSON.parse(raw); msg = j?.error?.message ?? j?.message ?? raw; } catch {}
      ev.error = clip(redact(msg, secrets), 500);
      const retryable = resp.status === 429 || resp.status >= 500;
      if (retryable && attempt === 1 && state.providerCalls < opts.limits.max_turns) {
        const ra = Number(resp.headers?.get?.("retry-after"));
        const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : 5000;
        ev.retry_after_ms = wait;
        await sleep(wait);
        continue;
      }
      return { ok: false, reason: `HTTP ${resp.status}: ${ev.error}` };
    }
    let json;
    try { json = JSON.parse(raw); } catch { ev.error = "response is not JSON"; return { ok: false, reason: "provider response is not JSON" }; }
    ev.usage = json?.usage ?? json?.usageMetadata ?? null;
    ev.response = json;
    return { ok: true, json };
  }
}

function clip(s, n) {
  s = String(s ?? "");
  return Buffer.byteLength(s) <= n ? s : `${Buffer.from(s).subarray(0, n).toString("utf8")}… (${Buffer.byteLength(s)} bytes, truncated)`;
}
function clipArgs(a) {
  if (!a || typeof a !== "object") return a ?? null;
  return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, typeof v === "string" ? clip(v, RESULT_CAP) : v]));
}
function clipFull(s, n) {
  const b = Buffer.from(String(s ?? ""));
  return b.length <= n ? { text: String(s ?? ""), truncated: false } : { text: b.subarray(0, n).toString("utf8"), truncated: true };
}
