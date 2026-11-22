// ONE COORDINATOR ACTION: independently review one PR, as recorded in a binding record (owner, 2026-11-21: "Make
// 'independently review PR #84' one coordinator action. Reuse Pantheon's existing sandbox runner. Bind the PR base,
// head ..., and a #84-specific review brief in the same record. Verify those bindings before dispatch.").
//
//   node pantheon/scripts/review-pr.mjs --binding docs/reviews/<round>/binding.json --telos-root <dir> --max-wall-s N
//        [--dry-run] [--grok-state-dir DIR] [--agy-cli PATH] [--grok-cli PATH] [--codex-cli PATH]
//        [--codex-outer-runtime auto|on|off]
//
// The binding record (BINDING_SCHEMA, committed in the round's directory beside the brief) names the repository, the PR,
// its base (the ref and the merge base the PR is judged against), its head (one commit), the brief (its directory, its
// assignment and each file's sha256), the author's labs and the panel (one reviewer per lab).
//
// ORDER, and what each step guarantees:
//   1. verifyBinding: every check runs and every failure is reported; ANY failure refuses (exit 1) and nothing is
//      dispatched. The checks: the record's shape; it sits in the brief's own directory; it and the brief are tracked
//      and unchanged from HEAD; each brief file's sha256 is the bound one; the README's row for the assignment names the
//      bound file, and the brief names the bound head and PR; origin is the bound repository; the head commit is in the
//      checkout and is the PR's head on origin now (refs/pull/<n>/head); the merge base of the head with origin's base
//      ref now is the bound merge base; the panel is at least three distinct labs, none of them an author lab.
//   2. Each reviewer runs, ONE AT A TIME, through pantheon/scripts/run-review.mjs --via subscription (the existing runner
//      and its sandboxes: a fresh review copy of the head, the reviewer CLI in its jail, the verify jail for tests),
//      with --review-dir and --assignment from the binding, --commit <head>, --reviewer <lab>:<model> where the README
//      row names another reviewer, --telos-root, --max-wall-s, and --out <stage>/<lab>.
//   3. PEER FINDINGS STAY HIDDEN until every reviewer has finished: the stage is a fresh mode-0700 directory under the
//      literal /tmp, which every reviewer jail replaces with its own empty tmpfs (grok.mjs, agy/sandbox.mjs, codex.mjs's
//      outer runtime; codex's own profile reads no /tmp), and nothing of the run is written into the checkout (which a
//      jail's --ro-bind / / can read) before the last reviewer ends.
//   4. judgeReviewer: a lab's review is `complete` only when its runner exited 0, its findings and transcript exist,
//      the transcript says complete with its coverage gate passed, it reviewed the bound commit with the bound model and
//      the bound brief (the prompt's README, assignment and HARNESS-cli digests), and the reviewer's message has the
//      sections the brief asks for. Anything else -- a timeout, a refusal to start (a sign-in the CLI lacks), an exit
//      3, missing files, a mismatch, a missing section -- is `incomplete`, with every reason recorded.
//   5. release: the stage is copied into <brief dir>/findings-<head12>-<run>/ with result.json (RESULT_SCHEMA): per lab
//      its status and reasons, the runner's own record of what ran (coverage, review_tests), the files and their
//      sha256, and the reviewer's own "Tests run", "Unresolved questions" and "Blockers for merging" sections. The
//      findings-* path is withheld from every later review copy (index.mjs WITHHELD).
// THE xAI SDK ROUTE (owner assignment 2026-11-22): a panel entry may carry `route: "xai-sdk"` (the xAI lab only) with its
// declared `limits` ({max_turns, max_tool_calls, max_output_tokens, timeout_s}). That reviewer runs through the API runner
// over the official SDK (run-review.mjs --via api --xai-transport sdk, with those limits and --max-wall-s), and is judged
// on the API transcript: via api, transport xai-sdk, every served model the bound one, the bound README, assignment and
// HARNESS.md, the coverage gate, no change to the review copy outside .review-tests/, and its calls within the bound
// limits. A CLI transcript never satisfies a routed reviewer, nor an SDK transcript a subscription one. Entries without a
// route dispatch and are judged exactly as before; the panel's independence rules are unchanged. A record may sit beside
// its brief as binding.json or binding-<name>.json (a fresh leg keeps the earlier record intact).
// The merge decision is never taken here: the result says so. Exit codes: 0 every reviewer complete (or a dry run whose
// plans all passed), 1 refused (a binding failed), 2 usage, 3 at least one review incomplete.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve, dirname, relative, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { REVIEW_DIR_RE, assignmentRow, BriefError } from "./brief.mjs";

export const BINDING_SCHEMA = "ophanim.pr-review/v1";
export const RESULT_SCHEMA = "ophanim.pr-review-result/v1";
export const EXIT = Object.freeze({ complete: 0, refused: 1, usage: 2, incomplete: 3 });
/** The runner's labs (index.mjs REVIEWER_LABS), by the key --reviewer takes. */
export const LABS = Object.freeze({ google: "Google", openai: "OpenAI", xai: "xAI" });
export const MIN_LABS = 3;
/** The line after which the runner's findings file holds the reviewer's final message verbatim (subscription.mjs). */
export const MARKER = "<!-- reviewer's final message, verbatim, follows -->";
/** The sections the brief's harness asks for, and which of them a complete review must have. */
export const SECTIONS = Object.freeze({ tests_run: "Tests run", unresolved_questions: "Unresolved questions", blockers_for_merging: "Blockers for merging" });
export const REQUIRED_SECTIONS = Object.freeze(["tests_run", "unresolved_questions"]);
/** Host flags passed through to run-review unchanged (the owner's configured subscription host). */
export const HOST_FLAGS = Object.freeze(["grok-state-dir", "agy-cli", "grok-cli", "codex-cli", "codex-outer-runtime"]);
/** Beyond --max-wall-s, how long a runner may take (preflights, the review copy, its own teardown) before it is killed. */
export const DEFAULT_GRACE_MS = 15 * 60 * 1000;
/** The routes a panel entry may name, the lab each is for, and the limits it must declare (each a whole number up to its cap). */
export const ROUTES = Object.freeze({ "xai-sdk": { lab: "xai", transport: "xai-sdk" } });
export const ROUTE_LIMITS = Object.freeze({ max_turns: 200, max_tool_calls: 400, max_output_tokens: 128000, timeout_s: 3600 });
/** The record's file name beside its brief. */
export const BINDING_NAME_RE = /^binding(-[a-z0-9][a-z0-9-]{0,62})?\.json$/;
const STAGE_ROOT = "/tmp";

const HEX40 = /^[0-9a-f]{40}$/, HEX64 = /^[0-9a-f]{64}$/;
export const sha256 = b => createHash("sha256").update(b).digest("hex");
class UsageError extends Error {}

function git(repoRoot, args, { timeoutMs = 120_000 } = {}) {
  return new Promise(res => {
    // The owner's own git, with the owner's environment (its credential helper reaches origin), never prompting.
    const c = spawn("git", ["-C", repoRoot, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] });
    const out = [], err = [];
    const t = setTimeout(() => c.kill("SIGKILL"), timeoutMs);
    c.stdout.on("data", d => out.push(d)); c.stderr.on("data", d => err.push(d));
    c.on("error", e => { clearTimeout(t); res({ code: -1, stdout: "", stderr: String(e.message) }); });
    c.on("close", code => { clearTimeout(t); res({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }); });
  });
}

export const gitCli = git;

/** The brief's files: README.md, HARNESS.md, HARNESS-cli.md and the assignment file, by name. */
const briefNames = b => Object.keys(b?.brief?.files ?? {}).sort();

/** Problems with the record's shape (no file or network is read). */
export function shapeProblems(b) {
  const p = [];
  if (!b || typeof b !== "object") return ["the binding is not a JSON object"];
  if (b.schema !== BINDING_SCHEMA) p.push(`schema is ${JSON.stringify(b.schema)}, expected ${BINDING_SCHEMA}`);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(b.repo ?? "")) p.push("repo must be <owner>/<name>");
  if (!Number.isSafeInteger(b.pr) || b.pr < 1) p.push("pr must be a positive integer");
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(b.base?.ref ?? "") || String(b.base?.ref).includes("..")) p.push("base.ref must be a branch name");
  if (!HEX40.test(b.base?.merge_base ?? "")) p.push("base.merge_base must be a full 40-hex commit id");
  if (!HEX40.test(b.head?.sha ?? "")) p.push("head.sha must be a full 40-hex commit id");
  if (!REVIEW_DIR_RE.test(b.brief?.dir ?? "")) p.push("brief.dir must be docs/reviews/<name>");
  if (!/^[1-4]$/.test(String(b.brief?.assignment ?? ""))) p.push("brief.assignment must be 1, 2, 3 or 4");
  const names = briefNames(b);
  for (const f of ["README.md", "HARNESS.md", "HARNESS-cli.md"]) if (!names.includes(f)) p.push(`brief.files must bind ${f}`);
  const others = names.filter(f => !["README.md", "HARNESS.md", "HARNESS-cli.md"].includes(f));
  if (others.length !== 1 || !/^\d-[\w.-]+\.md$/.test(others[0] ?? "")) p.push("brief.files must bind exactly one assignment file (<n>-<name>.md)");
  for (const f of names) {
    if (f.includes("/") || f.startsWith(".")) p.push(`brief.files: ${JSON.stringify(f)} is not a file name in the brief's directory`);
    if (!HEX64.test(b.brief.files[f] ?? "")) p.push(`brief.files[${JSON.stringify(f)}] must be a 64-hex sha256`);
  }
  if (!Array.isArray(b.author?.labs) || !b.author.labs.length) p.push("author.labs must name the labs that wrote the PR");
  if (b.via !== "subscription") p.push('via must be "subscription" (the owner\'s subscriptions; the metered API is a separate, owner-chosen run)');
  if (!Array.isArray(b.panel) || !b.panel.length) p.push("panel must list the reviewers");
  for (const r of b.panel ?? []) {
    if (!LABS[r?.lab]) p.push(`panel: lab ${JSON.stringify(r?.lab)} is not one of ${Object.keys(LABS).join(", ")}`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(r?.model ?? "")) p.push(`panel: model ${JSON.stringify(r?.model)} is not a model id`);
    if (r?.route === undefined) { if (r?.limits !== undefined) p.push("panel: limits apply to a routed reviewer only"); continue; }
    const route = ROUTES[r.route];
    if (!route) { p.push(`panel: route ${JSON.stringify(r.route)} is not a route (${Object.keys(ROUTES).join(", ")})`); continue; }
    if (r.lab !== route.lab) p.push(`panel: route ${r.route} is for the ${route.lab} lab only`);
    if (!r.limits || typeof r.limits !== "object" || Array.isArray(r.limits)) { p.push(`panel: route ${r.route} must declare limits (${Object.keys(ROUTE_LIMITS).join(", ")})`); continue; }
    for (const k of Object.keys(r.limits)) if (!Object.hasOwn(ROUTE_LIMITS, k)) p.push(`panel: limits has an unknown key ${JSON.stringify(k)}`);
    for (const [k, cap] of Object.entries(ROUTE_LIMITS)) if (!Number.isSafeInteger(r.limits[k]) || r.limits[k] < 1 || r.limits[k] > cap) p.push(`panel: limits.${k} must be a whole number from 1 to ${cap}`);
  }
  return p;
}

/** The panel's independence: distinct labs, at least MIN_LABS of them, none an author lab. */
export function panelProblems(b) {
  const p = [], labs = (b.panel ?? []).map(r => r?.lab);
  const author = new Set((b.author?.labs ?? []).map(s => String(s).toLowerCase()));
  const dup = labs.filter((l, i) => labs.indexOf(l) !== i);
  if (dup.length) p.push(`panel: a lab appears more than once (${[...new Set(dup)].join(", ")}): each reviewer must be a distinct lab`);
  if (new Set(labs).size < MIN_LABS) p.push(`panel: ${new Set(labs).size} distinct lab(s); a review panel keeps at least ${MIN_LABS}`);
  for (const l of labs) if (author.has(String(l).toLowerCase()) || author.has(String(LABS[l] ?? "").toLowerCase())) p.push(`panel: ${LABS[l] ?? l} wrote the PR and cannot review it`);
  return p;
}

const remoteNames = url => {
  const m = /github\.com[:/]+([^/]+\/[^/]+?)(\.git)?\/?$/i.exec(String(url).trim());
  return m ? m[1].toLowerCase() : null;
};

/**
 * Verify every binding before dispatch. Returns {ok, checks: [{check, ok, detail}]}; every check runs, so the owner
 * sees every failure at once. `bindingRel` is the record's path relative to the checkout.
 */
export async function verifyBinding({ binding: b, bindingRel, repoRoot, gitFn = git }) {
  const checks = [];
  const add = (check, ok, detail) => checks.push({ check, ok: Boolean(ok), detail });
  const shape = shapeProblems(b);
  add("shape", !shape.length, shape.length ? shape.join("; ") : "the record has every field the action needs");
  if (shape.length) return { ok: false, checks };
  const g = (...a) => gitFn(repoRoot, a);
  const dir = b.brief.dir, files = briefNames(b).map(f => `${dir}/${f}`);

  const beside = bindingRel.startsWith(`${dir}/`) && BINDING_NAME_RE.test(bindingRel.slice(dir.length + 1));
  add("record beside its brief", beside, beside ? `${bindingRel}` : `the record is ${bindingRel}; it must be ${dir}/binding.json or binding-<name>.json, in the brief's own directory`);

  const tracked = await g("ls-files", "--error-unmatch", "--", bindingRel, ...files);
  const clean = await g("diff", "--quiet", "HEAD", "--", bindingRel, ...files);
  add("committed", tracked.code === 0 && clean.code === 0,
    tracked.code !== 0 ? `not tracked: ${tracked.stderr.trim().split("\n")[0]}` : clean.code !== 0 ? "the record or the brief differs from HEAD (commit or discard the change first)" : "the record and the brief are tracked and unchanged from HEAD");

  const texts = {};
  const digestFails = [];
  for (const f of briefNames(b)) {
    const t = await readFile(join(repoRoot, dir, f)).catch(() => null);
    texts[f] = t;
    if (t === null) digestFails.push(`${f} is missing`);
    else if (sha256(t) !== b.brief.files[f]) digestFails.push(`${f} is sha256 ${sha256(t)}, bound ${b.brief.files[f]}`);
  }
  add("brief digests", !digestFails.length, digestFails.length ? digestFails.join("; ") : `${briefNames(b).length} files match their bound sha256`);

  const assignmentFile = briefNames(b).find(f => /^\d-/.test(f));
  let rowOk = false, rowDetail;
  try {
    const row = assignmentRow(String(texts["README.md"] ?? ""), Number(b.brief.assignment));
    rowOk = row.file === assignmentFile;
    rowDetail = rowOk ? `README row ${b.brief.assignment} is ${row.file}` : `README row ${b.brief.assignment} links ${row.file}, the record binds ${assignmentFile}`;
  } catch (e) { rowDetail = e instanceof BriefError ? e.message : String(e.message); }
  add("assignment row", rowOk, rowDetail);
  const names = ["README.md", assignmentFile].filter(f => !String(texts[f] ?? "").includes(b.head.sha) || !String(texts[f] ?? "").includes(`PR #${b.pr}`));
  add("brief names the candidate", !names.length, names.length ? `${names.join(", ")} must name PR #${b.pr} and its head ${b.head.sha}` : `README.md and ${assignmentFile} name PR #${b.pr} at ${b.head.sha}`);

  const url = await g("remote", "get-url", "origin");
  const repo = url.code === 0 ? remoteNames(url.stdout) : null;
  add("origin is the repository", repo === b.repo.toLowerCase(), url.code !== 0 ? "the checkout has no origin remote" : repo === b.repo.toLowerCase() ? `origin is ${b.repo}` : `origin is ${repo ?? "not a GitHub repository"}, the record binds ${b.repo}`);

  const t = await g("cat-file", "-t", b.head.sha);
  const haveHead = t.code === 0 && t.stdout.trim() === "commit";
  add("head in the checkout", haveHead, haveHead ? `${b.head.sha} is a commit here` : `${b.head.sha} is not in this checkout (git fetch origin pull/${b.pr}/head)`);

  const prRef = `refs/pull/${b.pr}/head`;
  const lr = await g("ls-remote", "origin", prRef);
  const remoteHead = lr.code === 0 ? (lr.stdout.split("\n").map(l => l.split("\t")).find(x => x[1] === prRef)?.[0] ?? null) : null;
  add("head is the PR's head now", remoteHead === b.head.sha,
    lr.code !== 0 ? `cannot read ${prRef} from origin: ${lr.stderr.trim().split("\n")[0] || `exit ${lr.code}`}` : remoteHead === null ? `origin has no ${prRef}` : remoteHead === b.head.sha ? `origin ${prRef} is ${remoteHead}` : `origin ${prRef} is ${remoteHead}: the PR moved since the record was bound, so the record must be bound again`);

  const baseRef = `refs/heads/${b.base.ref}`;
  const lb = await g("ls-remote", "origin", baseRef);
  const tip = lb.code === 0 ? (lb.stdout.split("\n").map(l => l.split("\t")).find(x => x[1] === baseRef)?.[0] ?? null) : null;
  let mbOk = false, mbDetail;
  if (lb.code !== 0) mbDetail = `cannot read ${baseRef} from origin: ${lb.stderr.trim().split("\n")[0] || `exit ${lb.code}`}`;
  else if (!tip) mbDetail = `origin has no ${baseRef}`;
  else if (!haveHead) mbDetail = "the head is not in the checkout";
  else {
    const tt = await g("cat-file", "-t", tip);
    if (tt.code !== 0) mbDetail = `origin's ${b.base.ref} is ${tip}, which is not in this checkout (git fetch origin ${b.base.ref})`;
    else {
      const mb = await g("merge-base", b.head.sha, tip);
      const got = mb.code === 0 ? mb.stdout.trim() : null;
      mbOk = got === b.base.merge_base;
      mbDetail = mbOk ? `merge base of the head and origin's ${b.base.ref} (${tip}) is ${got}` : `merge base of the head and origin's ${b.base.ref} (${tip}) is ${got ?? "none"}, bound ${b.base.merge_base}`;
    }
  }
  add("merge base with the base ref now", mbOk, mbDetail);

  const pp = panelProblems(b);
  add("panel independence", !pp.length, pp.length ? pp.join("; ") : `${b.panel.length} distinct labs (${b.panel.map(r => LABS[r.lab]).join(", ")}), none of them an author lab (${b.author.labs.join(", ")})`);
  return { ok: checks.every(c => c.ok), checks };
}

/** The run-review argv for one reviewer (after the script path). */
export function runnerArgs({ binding: b, reviewer, readmeRow, telosRoot, maxWallS, out, dryRun, hostFlags = {} }) {
  // A routed reviewer (xai-sdk) runs the API runner over the SDK with its bound limits; every other one, its subscription.
  const routed = reviewer.route === "xai-sdk", L = reviewer.limits ?? {};
  const a = ["--via", routed ? "api" : "subscription", ...(routed ? ["--xai-transport", "sdk"] : []), "--review-dir", b.brief.dir, "--assignment", String(b.brief.assignment), "--commit", b.head.sha,
    ...(routed ? ["--max-turns", String(L.max_turns), "--max-tool-calls", String(L.max_tool_calls), "--max-output-tokens", String(L.max_output_tokens), "--timeout-s", String(L.timeout_s)] : []),
    "--max-wall-s", String(maxWallS), "--telos-root", telosRoot, "--out", out];
  const isDefault = readmeRow && readmeRow.lab.toLowerCase() === LABS[reviewer.lab].toLowerCase() && readmeRow.model === reviewer.model;
  if (!isDefault) a.push("--reviewer", `${reviewer.lab}:${reviewer.model}`);
  // The subscription host flags configure the CLIs; a routed reviewer runs none.
  if (!routed) for (const k of HOST_FLAGS) if (hostFlags[k] !== undefined) a.push(`--${k}`, hostFlags[k]);
  if (dryRun) a.push("--dry-run");
  return a;
}

/** Spawn the runner in its own process group; kill the group at `timeoutMs`. stdout/stderr go to files in `outDir`. */
export function runReviewer({ node = process.execPath, script, args, cwd, env, outDir, timeoutMs }) {
  return new Promise(res => {
    const c = spawn(node, [script, ...args], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const out = [], err = [];
    let killed_for = null;
    const kill = sig => { try { process.kill(-c.pid, sig); } catch { try { c.kill(sig); } catch {} } };
    const t = setTimeout(() => { killed_for = "timeout"; kill("SIGTERM"); setTimeout(() => kill("SIGKILL"), 10_000).unref(); }, timeoutMs);
    c.stdout.on("data", d => out.push(d)); c.stderr.on("data", d => err.push(d));
    let settled = false;
    const done = async (code, signal, spawn_error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      await writeFile(join(outDir, "run-review.stdout"), Buffer.concat(out)).catch(() => {});
      await writeFile(join(outDir, "run-review.stderr"), Buffer.concat(err)).catch(() => {});
      res({ exit_code: code, signal: signal ?? null, killed_for, spawn_error, stderr_tail: Buffer.concat(err).toString("utf8").split("\n").filter(Boolean).slice(-5) });
    };
    c.on("error", e => done(null, null, e.message));
    c.on("close", (code, signal) => done(code, signal));
  });
}

/** The reviewer's own sections, from the text after MARKER: {tests_run, unresolved_questions, blockers_for_merging}. */
export function reviewerSections(findings) {
  const i = findings.indexOf(MARKER);
  const text = i < 0 ? "" : findings.slice(i + MARKER.length);
  const lines = text.split("\n"), out = {};
  for (const [key, title] of Object.entries(SECTIONS)) {
    const re = new RegExp(`^(#{1,6})\\s+${title.replace(/ /g, "\\s+")}\\s*:?\\s*$`, "i");
    const at = lines.findIndex(l => re.test(l.trim()));
    if (at < 0) { out[key] = null; continue; }
    const level = re.exec(lines[at].trim())[1].length;
    let end = lines.findIndex((l, k) => k > at && /^(#{1,6})\s/.test(l.trim()) && /^(#{1,6})/.exec(l.trim())[1].length <= level);
    out[key] = lines.slice(at + 1, end < 0 ? undefined : end).join("\n").trim();
  }
  return { found_marker: i >= 0, ...out };
}

/** The relay record of a transcript (relay.mjs), per request, as the result records it. */
export const relaySummary = tr => ({
  counts: tr.counts ?? null,
  requests: (tr.requests ?? []).map(q => ({ id: q.id, command: q.command, requested_by: q.requested_by ?? null, decision: q.decision, why: q.why ?? null,
    executed_by: q.executed_by ?? null, result: q.result ? { exit_code: q.result.exit_code, killed_for: q.result.killed_for ?? null, jail_refused: q.result.jail_refused ?? false,
      duration_ms: q.result.duration_ms ?? null, output_sha256: q.result.output_sha256 ?? null } : null, reviewer_conclusion: q.reviewer_conclusion ?? null })),
});

const readJson = async p => { try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; } };
const listFiles = async dir => {
  const out = [];
  const walk = async d => { for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) { const p = join(d, e.name); if (e.isDirectory()) await walk(p); else if (e.isFile()) out.push(p); } };
  await walk(dir);
  return out.sort();
};

/** One lab's verdict from what its run left in `outDir` (see the header, step 4). */
export async function judgeReviewer({ binding: b, reviewer, outDir, run }) {
  const lab = LABS[reviewer.lab], n = b.brief.assignment, key = lab.toLowerCase();
  const findingsPath = join(outDir, `findings-${n}-${key}.md`), transcriptPath = join(outDir, `findings-${n}-${key}.transcript.json`);
  const findings = await readFile(findingsPath, "utf8").catch(() => null);
  const t = await readJson(transcriptPath);
  const why = [];
  if (run.killed_for === "timeout") why.push("timeout: the runner did not finish within --max-wall-s and its grace, and was killed");
  else if (run.spawn_error) why.push(`the runner did not start: ${run.spawn_error}`);
  else if (run.exit_code === EXIT.refused) why.push(`refused to start (exit 1)${run.stderr_tail.length ? `: ${run.stderr_tail.join(" | ")}` : ""}`);
  else if (run.exit_code === EXIT.usage) why.push(`usage error (exit 2)${run.stderr_tail.length ? `: ${run.stderr_tail.join(" | ")}` : ""}`);
  else if (run.exit_code === EXIT.incomplete) why.push(`the runner recorded the review incomplete (exit 3)${t?.stop_reason ? `: ${t.stop_reason}` : ""}`);
  else if (run.exit_code !== EXIT.complete) why.push(`the runner exited ${run.exit_code ?? `on ${run.signal}`}`);
  if (findings === null) why.push(`missing evidence: no findings file (findings-${n}-${key}.md)`);
  if (t === null) why.push(`missing evidence: no readable transcript (findings-${n}-${key}.transcript.json)`);
  if (t) {
    if (t.status !== "complete") why.push(`the transcript's status is ${t.status}${t.stop_reason ? ` (${t.stop_reason})` : ""}`);
    if (!t.coverage_gate?.ok) why.push(`the coverage gate did not pass${t.coverage_gate?.reasons?.length ? `: ${t.coverage_gate.reasons.join("; ")}` : " (no gate recorded)"}`);
    if (t.commit !== b.head.sha) why.push(`the transcript reviewed ${t.commit ?? "no commit"}, not the bound head ${b.head.sha}`);
    if (t.requested_model !== reviewer.model) why.push(`the transcript's model is ${t.requested_model ?? "none"}, not the bound ${reviewer.model}`);
    if (t.lab !== lab) why.push(`the transcript's lab is ${t.lab ?? "none"}, not ${lab}`);
    // Entries without a route: exactly the checks, in the order, they had before the route existed.
    if (!reviewer.route && t.via !== "subscription") why.push(`the transcript's via is ${t.via ?? "none"}, not subscription`);
    if (!reviewer.route && t.identity_mismatch) why.push("the CLI reported another model than the one asked for (identity_mismatch)");
    const pr = t.prompt ?? {};
    const assignmentFile = briefNames(b).find(f => /^\d-/.test(f));
    if (pr.readme_sha256 !== b.brief.files["README.md"]) why.push("the prompt's README is not the bound README");
    if (pr.assignment_sha256 !== b.brief.files[assignmentFile]) why.push("the prompt's assignment is not the bound assignment file");
    if (!reviewer.route && pr.harness_cli_template?.sha256 !== b.brief.files["HARNESS-cli.md"]) why.push("the prompt's harness is not the bound HARNESS-cli.md");
    if (reviewer.route) why.push(...routedProblems(t, reviewer, b));
  }
  const sections = findings === null ? { found_marker: false, tests_run: null, unresolved_questions: null, blockers_for_merging: null } : reviewerSections(findings);
  if (findings !== null && !sections.found_marker) why.push("missing evidence: the findings file has no reviewer message (no marker line)");
  for (const k of REQUIRED_SECTIONS) if (findings !== null && sections.found_marker && sections[k] === null) why.push(`missing evidence: the reviewer's message has no "${SECTIONS[k]}" section`);
  const files = [];
  for (const p of await listFiles(outDir)) files.push({ path: relative(outDir, p), sha256: sha256(await readFile(p)), bytes: (await stat(p)).size });
  const cov = t?.coverage ?? null;
  return {
    lab, lab_key: reviewer.lab, model: reviewer.model, ...(reviewer.route ? { route: reviewer.route, served_models: t?.served_models ?? null, cost_totals: t?.cost_totals ?? null, limits: reviewer.limits } : {}),
    status: why.length ? "incomplete" : "complete", why,
    run: { exit_code: run.exit_code, signal: run.signal, killed_for: run.killed_for, spawn_error: run.spawn_error, started_at: run.started_at, ended_at: run.ended_at },
    runner: t ? { status: t.status ?? null, stop_reason: t.stop_reason ?? null, transport: t.transport ?? null, commit: t.commit ?? null, requested_model: t.requested_model ?? null } : null,
    tests: cov ? { tests_run: cov.tests_run ?? 0, tests_allowed: cov.tests_allowed ?? null, tests_refused: cov.tests_refused ?? null, source_reads: cov.source_reads ?? 0, denied_reads: cov.denied_reads ?? 0, method: cov.method ?? null } : null,
    coverage_gate: t?.coverage_gate ?? null,
    review_tests: t?.review_tests ?? null,
    // A reviewer whose sandbox cannot start the verify jail (codex) has its tests RELAYED (relay.mjs): per request, who
    // requested it, which runner executed it, its result, and what the reviewer concluded from it.
    relayed_tests: t?.test_relay ? relaySummary(t.test_relay) : null,
    reviewer_sections: { tests_run: sections.tests_run, unresolved_questions: sections.unresolved_questions, blockers_for_merging: sections.blockers_for_merging },
    files,
  };
}

/** What a routed reviewer's transcript must show beyond the common checks (see the header). */
function routedProblems(t, reviewer, b) {
  const why = [], route = ROUTES[reviewer.route], L = reviewer.limits ?? {};
  if (t.via !== "api") why.push(`the transcript's via is ${t.via ?? "none"}, not api (route ${reviewer.route})`);
  if (t.transport !== route.transport) why.push(`the transcript's transport is ${t.transport ?? "none"}, not ${route.transport}`);
  if (t.prompt?.harness_template?.sha256 !== b.brief.files["HARNESS.md"]) why.push("the prompt's harness is not the bound HARNESS.md");
  const served = Array.isArray(t.served_models) ? t.served_models : [];
  if (!served.length) why.push("missing provenance: no response named a served model");
  else if (served.includes(null)) why.push("missing provenance: a response named no served model");
  for (const s of served) if (s !== null && s !== reviewer.model) why.push(`a response was served by ${s}, not the bound ${reviewer.model}`);
  if (!t.worktree_check) why.push("missing evidence: the transcript records no check of the review copy");
  else if (t.worktree_check.violations?.length) why.push(`the review copy changed outside .review-tests/: ${t.worktree_check.violations.join(", ")}`);
  const diff = Object.keys(ROUTE_LIMITS).filter(k => t.limits?.[k] !== L[k]);
  if (diff.length) why.push(`the run's limits are not the bound limits (${diff.map(k => `${k} ${t.limits?.[k] ?? "none"} vs ${L[k]}`).join(", ")})`);
  if (Number.isInteger(t.provider_calls) && t.provider_calls > L.max_turns) why.push(`${t.provider_calls} provider calls exceed the bound max_turns ${L.max_turns}`);
  if (Number.isInteger(t.tool_calls) && t.tool_calls > L.max_tool_calls) why.push(`${t.tool_calls} tool calls exceed the bound max_tool_calls ${L.max_tool_calls}`);
  return why;
}

async function underTmp(p) {
  const tmp = await realpath(STAGE_ROOT).catch(() => null);
  const r = await realpath(p).catch(() => null);
  return tmp === STAGE_ROOT && r !== null && (r === STAGE_ROOT || r.startsWith(STAGE_ROOT + "/"));
}

function parseCli(argv) {
  let v;
  try {
    v = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
      binding: { type: "string" }, "telos-root": { type: "string" }, "max-wall-s": { type: "string" }, "dry-run": { type: "boolean" }, help: { type: "boolean" },
      ...Object.fromEntries(HOST_FLAGS.map(k => [k, { type: "string" }])),
    } }).values;
  } catch (e) { throw new UsageError(e.message); }
  if (v.help) throw new UsageError("help");
  if (!v.binding) throw new UsageError("--binding <docs/reviews/<round>/binding.json> is required");
  if (!/^[1-9]\d*$/.test(v["max-wall-s"] ?? "")) throw new UsageError("--max-wall-s is required: each reviewer's wall clock in seconds (there is no default)");
  if (v["codex-outer-runtime"] !== undefined && !["auto", "on", "off"].includes(v["codex-outer-runtime"])) throw new UsageError("--codex-outer-runtime must be auto, on or off");
  return { binding: v.binding, telosRoot: v["telos-root"] ?? null, maxWallS: Number(v["max-wall-s"]), dryRun: !!v["dry-run"], hostFlags: Object.fromEntries(HOST_FLAGS.filter(k => v[k] !== undefined).map(k => [k, v[k]])) };
}

export const USAGE = `usage: node pantheon/scripts/review-pr.mjs --binding docs/reviews/<round>/binding.json --telos-root <dir> --max-wall-s N
  [--dry-run] [--grok-state-dir DIR] [--agy-cli PATH] [--grok-cli PATH] [--codex-cli PATH] [--codex-outer-runtime auto|on|off]
  --telos-root defaults to $OPHANIM_TELOS_ROOT. Exit: 0 every review complete, 1 a binding failed, 2 usage, 3 a review incomplete.`;

const stamp = d => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/**
 * The action. deps: {repoRoot, env, out, err, now, gitFn, runnerScript, node, stageRoot, graceMs}.
 */
export async function main(argv, deps = {}) {
  const repoRoot = deps.repoRoot ?? process.cwd();
  const env = deps.env ?? process.env;
  const out = deps.out ?? (s => process.stdout.write(s)), err = deps.err ?? (s => process.stderr.write(s));
  const now = deps.now ?? (() => new Date());
  let opts;
  try { opts = parseCli(argv); } catch (e) { if (e instanceof UsageError) { err(`${e.message === "help" ? "" : `review-pr: ${e.message}\n`}${USAGE}\n`); return e.message === "help" ? EXIT.complete : EXIT.usage; } throw e; }

  const bindingAbs = resolve(repoRoot, opts.binding);
  const bindingRel = relative(repoRoot, bindingAbs);
  const bindingBytes = await readFile(bindingAbs).catch(() => null);
  if (bindingBytes === null) { err(`review-pr: refused: ${opts.binding} does not exist\n`); return EXIT.refused; }
  let binding;
  try { binding = JSON.parse(bindingBytes.toString("utf8")); } catch (e) { err(`review-pr: refused: ${opts.binding} is not JSON (${e.message})\n`); return EXIT.refused; }

  const telosRoot = opts.telosRoot ?? env.OPHANIM_TELOS_ROOT ?? null;
  if (!telosRoot || !isAbsolute(telosRoot)) { err(`review-pr: refused: --telos-root (or OPHANIM_TELOS_ROOT) must be an absolute path to the TELOS checkout\n`); return EXIT.refused; }
  const telosHead = await (deps.gitFn ?? git)(telosRoot, ["rev-parse", "HEAD"]);
  if (telosHead.code !== 0) { err(`review-pr: refused: the TELOS root is not a git checkout\n`); return EXIT.refused; }

  // 1. Verify every binding before anything is dispatched.
  const v = await verifyBinding({ binding, bindingRel, repoRoot, gitFn: deps.gitFn ?? git });
  for (const c of v.checks) err(`review-pr: ${c.ok ? "ok" : "FAILED"}  ${c.check}: ${c.detail}\n`);
  if (!v.ok) { err("review-pr: refused: a binding did not verify, so no reviewer was dispatched\n"); return EXIT.refused; }

  const readme = await readFile(join(repoRoot, binding.brief.dir, "README.md"), "utf8");
  const readmeRow = assignmentRow(readme, Number(binding.brief.assignment));
  const telos = { head: telosHead.stdout.trim(), ci_pin: binding.telos?.ci_pin ?? null };
  telos.matches_ci_pin = telos.ci_pin ? telos.head === telos.ci_pin : null;
  if (telos.matches_ci_pin === false) err(`review-pr: note: the TELOS checkout is at ${telos.head}, not CI's pin ${telos.ci_pin}; the result records it\n`);

  // 2-3. The stage: a fresh mode-0700 directory under the literal /tmp (hidden from every reviewer jail).
  const stageRoot = deps.stageRoot ?? STAGE_ROOT;
  if (!(await underTmp(stageRoot))) { err(`review-pr: refused: the stage must be under ${STAGE_ROOT}, which every reviewer jail replaces with an empty tmpfs (got ${stageRoot})\n`); return EXIT.refused; }
  const stage = await mkdtemp(join(stageRoot, "ophanim-pr-review-"));
  await chmod(stage, 0o700);
  if (!(await underTmp(stage))) { err("review-pr: refused: the stage resolved outside /tmp\n"); return EXIT.refused; }
  const started = now();
  const runId = stamp(started);
  const releaseRel = `${binding.brief.dir}/findings-${binding.head.sha.slice(0, 12)}-${runId}`;
  const releaseAbs = join(repoRoot, releaseRel);
  if (!opts.dryRun && await stat(releaseAbs).then(() => true, () => false)) { err(`review-pr: refused: ${releaseRel} exists\n`); return EXIT.refused; }
  err(`review-pr: stage ${stage} (mode 0700; released to ${releaseRel} after the last reviewer)\n`);
  // An earlier run's release is in the checkout, which a jail's --ro-bind / / can read: recorded, by name only.
  const priorReleases = (await readdir(join(repoRoot, binding.brief.dir)).catch(() => [])).filter(e => e.startsWith("findings-")).sort();
  if (priorReleases.length) err(`review-pr: note: ${priorReleases.length} earlier release(s) in ${binding.brief.dir} (${priorReleases.join(", ")}); a reviewer jail can read the checkout, so this run's reviewers could see them\n`);

  const script = deps.runnerScript ?? join(repoRoot, "pantheon/scripts/run-review.mjs");
  const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
  const results = [];
  for (const reviewer of binding.panel) {
    const outDir = join(stage, reviewer.lab);
    await mkdir(outDir, { mode: 0o700 });
    const args = runnerArgs({ binding, reviewer, readmeRow, telosRoot, maxWallS: opts.maxWallS, out: outDir, dryRun: opts.dryRun, hostFlags: opts.hostFlags });
    err(`review-pr: ${LABS[reviewer.lab]} (${reviewer.model}): run-review ${args.map(a => a.startsWith(stage) ? `<stage>${a.slice(stage.length)}` : a).join(" ")}\n`);
    const runStarted = now();
    const run = await runReviewer({ node: deps.node, script, args, cwd: repoRoot, env, outDir, timeoutMs: opts.maxWallS * 1000 + graceMs });
    run.started_at = runStarted.toISOString(); run.ended_at = now().toISOString();
    if (opts.dryRun) {
      const ok = run.exit_code === EXIT.complete;
      results.push({ lab: LABS[reviewer.lab], lab_key: reviewer.lab, model: reviewer.model, status: ok ? "dry-run" : "incomplete", why: ok ? [] : [`the dry run exited ${run.exit_code ?? run.killed_for ?? run.signal}${run.stderr_tail.length ? `: ${run.stderr_tail.join(" | ")}` : ""}`], run, plan: `${outDir}/run-review.stdout` });
    } else results.push(await judgeReviewer({ binding, reviewer, outDir, run }));
    const r = results.at(-1);
    err(`review-pr: ${r.lab}: ${r.status}${r.why.length ? ` (${r.why.join("; ")})` : ""}\n`);
  }

  const complete = results.filter(r => r.status === "complete");
  // The reviewers reviewed the bound head whatever happened since; the record says whether it is still the PR's head.
  const after = await (deps.gitFn ?? git)(repoRoot, ["ls-remote", "origin", `refs/pull/${binding.pr}/head`]);
  const headAfter = after.code === 0 ? (after.stdout.split("\n").map(l => l.split("\t")).find(x => x[1] === `refs/pull/${binding.pr}/head`)?.[0] ?? null) : null;
  const result = {
    schema: RESULT_SCHEMA, dry_run: opts.dryRun, live: !opts.dryRun,
    pr: binding.pr, repo: binding.repo, base: binding.base, head: binding.head,
    binding: { path: bindingRel, sha256: sha256(bindingBytes) }, verification: v.checks,
    brief: binding.brief, via: binding.via, max_wall_s: opts.maxWallS, host_flags: Object.keys(opts.hostFlags), telos,
    started_at: started.toISOString(), ended_at: now().toISOString(), order: binding.panel.map(r => r.lab),
    pr_head_after: { sha: headAfter, still_bound_head: headAfter === binding.head.sha, ...(headAfter === null ? { why: "origin could not be read after the last reviewer" } : {}) },
    prior_releases_visible: priorReleases,
    isolation: "each reviewer ran alone, in its own review copy and jail; outputs were staged in a mode-0700 directory under /tmp, which every reviewer jail replaces with an empty tmpfs, and released only after the last reviewer ended",
    reviewers: results,
    panel: opts.dryRun ? { status: results.every(r => r.status === "dry-run") ? "dry-run" : "incomplete" } : {
      status: complete.length === results.length ? "complete" : "incomplete",
      complete_labs: complete.map(r => r.lab), incomplete_labs: results.filter(r => r.status !== "complete").map(r => r.lab),
      distinct_complete_labs: new Set(complete.map(r => r.lab)).size, min_labs: MIN_LABS,
    },
    merge_decision: "the owner's; this action reviews and records, and never merges",
  };

  if (opts.dryRun) {
    out(JSON.stringify(result, null, 2) + "\n");
    err(`review-pr: dry run: ${results.filter(r => r.status === "dry-run").length}/${results.length} plans passed; nothing was released; the plans are in ${stage}\n`);
    return results.every(r => r.status === "dry-run") ? EXIT.complete : EXIT.incomplete;
  }

  // 5. Release, only now that every reviewer has ended.
  await mkdir(dirname(releaseAbs), { recursive: true });
  await cp(stage, releaseAbs, { recursive: true, errorOnExist: true, force: false });
  await writeFile(join(releaseAbs, "result.json"), JSON.stringify(result, null, 2) + "\n");
  out([
    `PR #${binding.pr} at ${binding.head.sha}: panel ${result.panel.status} (${complete.length}/${results.length} complete; at least ${MIN_LABS} distinct labs are needed)`,
    ...results.map(r => `  ${r.lab} ${r.model}: ${r.status}; tests the runner saw run: ${r.tests?.tests_run ?? "not recorded"}${r.why.length ? `; ${r.why.join("; ")}` : ""}`),
    ...(result.pr_head_after.still_bound_head ? [] : [`  NOTE: the PR's head is now ${headAfter ?? "unknown"}, not the reviewed ${binding.head.sha}`]),
    `  released: ${releaseRel}/ (result.json, and each lab's findings, transcript and the reviewer's "Tests run" and "Unresolved questions")`,
    `  merge decision: the owner's`,
  ].join("\n") + "\n");
  return result.panel.status === "complete" ? EXIT.complete : EXIT.incomplete;
}
