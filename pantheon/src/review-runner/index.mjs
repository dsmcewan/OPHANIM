// The independent-review runner: one assignment, one reviewer model, one disposable worktree.
// The owner runs it on their own machine with their own key. See HARNESS.md in the review
// directory for the only text the runner adds to what the reviewer is shown.
import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { REVIEW_DIR, BriefError, loadBrief, sha256, inScopePaths, listedTests, testingLine } from "./brief.mjs";
import { CAPS, permissionsFor, toolDefinitions, createToolbox } from "./tools.mjs";
import { buildChildEnv, WITHHELD } from "./sandbox.mjs";
import { VENDORS, authHeaders, createConversation, addUsage, redact } from "./vendors.mjs";

export const EXIT = { complete: 0, refused: 1, usage: 2, incomplete: 3 };
export const PLAN_SCHEMA = "ophanim.review-run-plan/v1";

const USAGE = `usage: node pantheon/scripts/run-review.mjs --assignment <1|2|3|4> --commit <40-hex>
  --max-turns N --max-tool-calls N --max-output-tokens N --timeout-s N
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
    } }).values;
  } catch (e) { throw new UsageError(e.message); }
  if (v.help) throw new UsageError("help");
  if (!/^[1-4]$/.test(v.assignment ?? "")) throw new UsageError("--assignment must be 1, 2, 3 or 4");
  if (!/^[0-9a-f]{40}$/.test(v.commit ?? "")) throw new UsageError("--commit must be a full 40-character lowercase hex commit id");
  const limits = {};
  for (const k of ["max-turns", "max-tool-calls", "max-output-tokens", "timeout-s"]) {
    if (v[k] === undefined) throw new UsageError(`--${k} is required (there are no defaults; the owner chooses the spend)`);
    if (!/^[1-9]\d*$/.test(v[k])) throw new UsageError(`--${k} must be a positive integer`);
    limits[k.replace(/-/g, "_")] = Number(v[k]);
  }
  return { n: Number(v.assignment), commit: v.commit, limits, out: v.out ?? null, dryRun: !!v["dry-run"], keep: !!v.keep, force: !!v.force, telosRoot: v["telos-root"] ?? null };
}

// Build the plan: everything the run will send and allow, computed without a worktree or network.
export async function buildPlan(opts, { repoRoot, env, cwd = process.cwd() }) {
  const { n, commit, limits } = opts;
  const t = await git(repoRoot, ["cat-file", "-t", commit], env);
  if (t.code !== 0 || t.stdout.trim() !== "commit") throw new Refusal(`commit ${commit} does not exist in ${repoRoot}`);
  const ls = await git(repoRoot, ["ls-tree", "-r", "--name-only", "-z", commit], env);
  if (ls.code !== 0) throw new Refusal(`cannot list commit ${commit}`);
  const files = ls.stdout.split("\0").filter(Boolean);

  const harnessValues = {
    MAX_TURNS: limits.max_turns, MAX_TOOL_CALLS: limits.max_tool_calls, MAX_OUTPUT_TOKENS: limits.max_output_tokens,
    TIMEOUT_S: limits.timeout_s, READ_CAP: CAPS.READ_BYTES, GREP_CAP: CAPS.GREP_MATCHES, OUTPUT_CAP: CAPS.OUTPUT_BYTES,
  };
  let b;
  try { b = await loadBrief({ repoRoot, n, commit, harnessValues }); }
  catch (e) { if (e instanceof BriefError || e.code === "ENOENT") throw new Refusal(e.message); throw e; }
  const { row } = b;

  const fileTesting = testingLine(b.assignmentText);
  const listed = listedTests(b.assignmentText, files);
  const permissions = permissionsFor(row.testing, listed.files);
  if (!permissions) throw new Refusal(`assignment ${n}: testing limit "${row.testing}" has no tool policy in the runner; refusing rather than guessing`);
  if (permissions.run_tests.files && permissions.run_tests.files.length === 0) throw new Refusal(`assignment ${n}: the assignment lists no existing tests that exist at ${commit}`);
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
    assignment: { n, title: row.title, file: `${REVIEW_DIR}/${row.file}`, scope: row.scope, testing: row.testing, testing_line_in_file: fileTesting },
    lab: row.lab, vendor: row.vendor, model: row.model,
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
    out: { findings, transcript, findings_exists: await exists(findings), overwrite: opts.force },
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
  let plan;
  try { plan = await buildPlan(opts, { repoRoot: deps.repoRoot, env, cwd: deps.cwd }); }
  catch (e) {
    if (e instanceof UsageError) { err(`run-review: ${e.message}\n`); return EXIT.usage; }
    if (e instanceof Refusal) { err(`run-review: refused: ${e.message}\n`); return EXIT.refused; }
    throw e;
  }
  out(JSON.stringify(printable(plan), null, 2) + "\n");
  if (opts.dryRun) return EXIT.complete;

  const key = env[plan.key.env];
  if (!plan.key.present) { err(`run-review: refused: ${plan.key.env} is not set\n`); return EXIT.refused; }
  if (plan.out.findings_exists && !opts.force) { err(`run-review: refused: ${plan.out.findings} exists (use --force to overwrite)\n`); return EXIT.refused; }
  if (!opts.force && await exists(plan.out.transcript)) { err(`run-review: refused: ${plan.out.transcript} exists (use --force to overwrite)\n`); return EXIT.refused; }

  const result = await liveRun({ plan, opts, key, env, deps });
  err(`run-review: ${result.status} (${result.stop_reason}); wrote ${plan.out.findings}\n`);
  return result.status === "complete" ? EXIT.complete : EXIT.incomplete;
}

async function liveRun({ plan, opts, key, env, deps }) {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());
  const repoRoot = deps.repoRoot;
  const secrets = Object.entries(env).filter(([k, v]) => v && (/_API_KEY$|KEY|TOKEN|SECRET/i.test(k)) && v.length >= 8).map(([, v]) => v);
  if (!secrets.includes(key)) secrets.push(key);
  const timeoutMs = opts.limits.timeout_s * 1000;
  const b = plan._brief;

  const started = now();
  const tmp = await mkdtemp(join(deps.tmpBase ?? tmpdir(), "ophanim-review-"));
  const wt = join(tmp, "worktree"), home = join(tmp, "home"), childTmp = join(tmp, "tmp");
  await mkdir(home); await mkdir(childTmp);
  const transcript = {
    schema: "ophanim.review-transcript/v1",
    assignment: plan.assignment.n, lab: plan.lab, vendor: plan.vendor, requested_model: plan.model, commit: plan.commit,
    endpoint: plan.endpoint,
    hashes: { harness_template: plan.request.harness_template.sha256, system: plan.request.system.sha256, brief: plan.request.brief.sha256, tools: plan.request.tools.sha256 },
    limits: opts.limits, started_at: started.toISOString(), events: [],
  };
  const state = { providerCalls: 0, toolCalls: 0, usage: {}, served: [], stop: null, final: null };
  let worktreeAdded = false;
  try {
    const add = await git(repoRoot, ["worktree", "add", "--detach", wt, plan.commit], env);
    if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr.trim()}`);
    worktreeAdded = true;
    for (const f of plan.withheld_from_worktree) await rm(join(wt, f), { force: true });
    if (deps.copyDependencies !== false) {
      for (const d of ["node_modules", "pantheon/node_modules", "packages/model-client/node_modules", "packages/ledger/node_modules"]) {
        if (await exists(join(repoRoot, d))) await cp(join(repoRoot, d), join(wt, d), { recursive: true, verbatimSymlinks: true });
      }
    }
    const childEnv = buildChildEnv({ parentEnv: env, home, tmpdir: childTmp, telosRoot: opts.telosRoot, secrets });
    const toolbox = createToolbox({ root: wt, permissions: plan.tool_permissions, env: childEnv, timeoutMs });
    const conv = createConversation(plan.vendor, { model: plan.model, system: b.system, brief: b.brief, tools: toolbox.definitions, maxOutputTokens: opts.limits.max_output_tokens });

    let turn = 0;
    outer: for (;;) {
      if (state.providerCalls >= opts.limits.max_turns) { state.stop = `max_turns reached (${opts.limits.max_turns})`; break; }
      turn++;
      const req = conv.request();
      const res = await providerCall({ req, plan, key, fetchFn, sleep, timeoutMs, state, opts, transcript, secrets, turn });
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
        if (state.toolCalls >= opts.limits.max_tool_calls) { state.stop = `max_tool_calls reached (${opts.limits.max_tool_calls})`; break outer; }
        state.toolCalls++;
        const t0 = Date.now();
        const out = c.args_error ? { text: `refused: ${c.args_error}`, refused: true } : await toolbox.call(c.name, c.args);
        const text = redact(out.text, secrets);
        transcript.events.push({
          type: "tool_call", n: state.toolCalls, turn, id: c.id ?? null, name: c.name, args: clipArgs(c.args),
          outcome: out.refused ? "refused" : out.error ? "error" : "ok", exit_code: out.exit_code ?? null, timed_out: out.timed_out ?? false,
          result_sha256: sha256(text), result_bytes: Buffer.byteLength(text), result_text: clip(text, 8192), duration_ms: Date.now() - t0,
        });
        results.push({ id: c.id, name: c.name, output: text });
      }
      conv.addToolResults(results);
    }
  } catch (e) {
    state.stop = `runner error: ${redact(e.message, secrets)}`;
  } finally {
    if (worktreeAdded && !opts.keep) {
      await git(repoRoot, ["worktree", "remove", "--force", wt], env);
      await git(repoRoot, ["worktree", "prune"], env);
    }
    if (!opts.keep) await rm(tmp, { recursive: true, force: true });
  }

  const ended = now();
  const status = state.final !== null ? "complete" : "incomplete";
  const servedFinal = state.served.at(-1) ?? null;
  const distinctServed = [...new Set(state.served.map(s => s ?? null))];
  Object.assign(transcript, {
    ended_at: ended.toISOString(), status, stop_reason: state.stop, provider_calls: state.providerCalls, tool_calls: state.toolCalls,
    served_models: distinctServed, usage_totals: state.usage, worktree_kept: opts.keep ? wt : null,
  });
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
    `- lab: ${plan.lab}`,
    `- requested_model: \`${plan.model}\``,
    `- served_model: ${servedFinal === null ? "null (the provider's response named no served model; the requested name is not substituted)" : `\`${servedFinal}\``}`,
    ...(distinctServed.length > 1 ? [`- served_models_across_calls: ${distinctServed.map(s => s === null ? "null" : `\`${s}\``).join(", ")}`] : []),
    `- commit: \`${plan.commit}\``,
    `- started_at: ${started.toISOString()}`,
    `- ended_at: ${ended.toISOString()}`,
    `- provider_calls: ${state.providerCalls}`,
    `- tool_calls: ${state.toolCalls}`,
    `- usage_totals: \`${JSON.stringify(state.usage)}\``,
    `- limits: \`${JSON.stringify(opts.limits)}\``,
    `- transcript: \`${plan.out.transcript.split(/[\\/]/).pop()}\` sha256 \`${sha256(tBytes)}\``,
    `- harness_template_sha256: \`${plan.request.harness_template.sha256}\``,
    `- system_sha256: \`${plan.request.system.sha256}\``,
    `- brief_sha256: \`${plan.request.brief.sha256}\``,
    `- tools_sha256: \`${plan.request.tools.sha256}\``,
    ...(redactions ? [`- redactions: ${redactions} occurrence(s) of the API key were replaced in the final message`] : []),
    "",
    "<!-- reviewer's final message, verbatim, follows -->",
    "",
    "",
  ].join("\n");
  await writeFile(plan.out.findings, header + (status === "complete" ? finalText : ""));
  return { status, stop_reason: state.stop };
}

async function providerCall({ req, plan, key, fetchFn, sleep, timeoutMs, state, opts, transcript, secrets, turn }) {
  const body = JSON.stringify(req.body);
  for (let attempt = 1; ; attempt++) {
    state.providerCalls++;
    const ev = { type: "provider_call", n: state.providerCalls, turn, attempt, at: new Date().toISOString(), request_bytes: Buffer.byteLength(body), request_sha256: sha256(body) };
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
  return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, typeof v === "string" ? clip(v, 4096) : v]));
}
