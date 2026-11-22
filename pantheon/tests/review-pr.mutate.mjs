#!/usr/bin/env node
// MUTATION RUNNER for the coordinator action "independently review a PR" (pantheon/src/review-runner/pr-review.mjs,
// pantheon/scripts/review-pr.mjs) and the runner's --review-dir it relies on (brief.mjs, index.mjs, subscription.mjs).
// Modelled on pantheon/tests/capability.mutate.mjs. Every mutation re-introduces a plausible regression of what the
// action states: a binding no longer verified (the PR's head now, the merge base, the brief's digests, the record
// committed and beside its brief, the brief naming the candidate, origin, the panel's independence and its three-lab
// floor, the subscription-only via), a failed verification that still dispatches, reviewers run at once or a lab's
// findings released into the checkout before the last reviewer ends, a stage outside /tmp or readable by others, a
// timeout, a failed gate, a missing file or section, another commit, model or brief taken as a complete review, the
// panel called complete with a lab incomplete, every lab run as the README's default reviewer, the release made outside
// the withheld findings-* path, and --review-dir ignored -- on a DISPOSABLE COPY of this tree (never the tree itself;
// recorded review findings, `findings-*`, are not copied). Only the tests that decide it run there (`tests`: each [file,
// --test-name-pattern]), and the copy is thrown away.
//
//   node pantheon/tests/review-pr.mutate.mjs [--only P1,P7] [--log DIR] [--copy-root DIR] [--check]
//
// Each mutation names its edits: {file, from, to}, the EXACT text replaced. The runner EXITS NON-ZERO when a target does
// not occur exactly once (2), when the unmutated suites are not green (3), or when any mutation SURVIVES (1): its deciding
// tests stay green with it. The reviewers are a stand-in runner; nothing reaches a CLI, a provider or the network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TEST = 'pantheon/tests/review-pr.test.mjs';
const SDK = 'pantheon/tests/review-runner-xai-sdk.test.mjs';
const SUITES = [TEST, SDK];
const R = 'pantheon/src/review-runner/', PR = `${R}pr-review.mjs`, BRIEF = `${R}brief.mjs`, INDEX = `${R}index.mjs`, SUB = `${R}subscription.mjs`, CLI = `${R}cli-common.mjs`;
const one = (file, from, to) => ({file, from, to});
const t = pattern => [TEST, pattern];
const s = pattern => [SDK, pattern];

export const MUTATIONS = [
  // ---- the bindings, verified before dispatch ----------------------------------------------------------------------
  {id: 'P1', what: 'the head is not checked against the PR\'s head on origin now', tests: [t('^PR REVIEW BINDING refuses before dispatch: the PR\'s head moved on origin')],
    edits: [one(PR, '  add("head is the PR\'s head now", remoteHead === b.head.sha,', '  add("head is the PR\'s head now", remoteHead !== null,')]},
  {id: 'P2', what: 'the merge base is not checked against the bound one', tests: [t('^PR REVIEW BINDING refuses before dispatch: the bound merge base is not the merge base')],
    edits: [one(PR, '      mbOk = got === b.base.merge_base;', '      mbOk = got !== null;')]},
  {id: 'P3', what: 'a brief file whose sha256 differs from the bound one is accepted', tests: [t('^PR REVIEW BINDING refuses before dispatch: a brief file changed after binding \\(committed\\)')],
    edits: [one(PR, '    else if (sha256(t) !== b.brief.files[f]) digestFails.push(', '    else if (false) digestFails.push(')]},
  {id: 'P4', what: 'an uncommitted change to the record or the brief is accepted', tests: [t('^PR REVIEW BINDING refuses before dispatch: a brief file changed after binding \\(uncommitted\\)')],
    edits: [one(PR, '  add("committed", tracked.code === 0 && clean.code === 0,', '  add("committed", tracked.code === 0,')]},
  {id: 'P5', what: 'an untracked record is accepted', tests: [t('^PR REVIEW BINDING refuses before dispatch: the record is not tracked')],
    edits: [one(PR, '  add("committed", tracked.code === 0 && clean.code === 0,', '  add("committed", clean.code === 0,')]},
  {id: 'P6', what: 'a record outside the brief\'s own directory is accepted', tests: [t('^PR REVIEW BINDING refuses before dispatch: the record is not in the brief\'s directory')],
    edits: [one(PR, '  const beside = bindingRel.startsWith(`${dir}/`) && BINDING_NAME_RE.test(bindingRel.slice(dir.length + 1));', '  const beside = true;')]},
  {id: 'P7', what: 'the README row may link another assignment file than the bound one', tests: [t('^PR REVIEW BINDING: the README\'s row')],
    edits: [one(PR, '    rowOk = row.file === assignmentFile;', '    rowOk = true;')]},
  {id: 'P8', what: 'a brief that does not name the bound PR and head is accepted', tests: [t('^PR REVIEW BINDING: the brief must name')],
    edits: [one(PR, '  const names = ["README.md", assignmentFile].filter(', '  const names = [].filter(')]},
  {id: 'P9', what: 'origin may be another repository', tests: [t('^PR REVIEW BINDING refuses before dispatch: origin is another')],
    edits: [one(PR, '  add("origin is the repository", repo === b.repo.toLowerCase(),', '  add("origin is the repository", true,')]},
  {id: 'P10', what: 'an author lab may sit on the panel', tests: [t('^PR REVIEW BINDING refuses before dispatch: an author lab is on the panel')],
    edits: [one(PR, '  for (const l of labs) if (author.has(', '  for (const l of []) if (author.has(')]},
  {id: 'P11', what: 'the three-lab floor is dropped', tests: [t('^PR REVIEW BINDING refuses before dispatch: two labs only')],
    edits: [one(PR, '  if (new Set(labs).size < MIN_LABS) p.push(', '  if (new Set(labs).size < 1) p.push(')]},
  {id: 'P12', what: 'the metered API is accepted as the via', tests: [t('^PR REVIEW BINDING refuses before dispatch: the metered API')],
    edits: [one(PR, '  if (b.via !== "subscription") p.push(', '  if (false) p.push(')]},
  {id: 'P13', what: 'a failed verification still dispatches the reviewers', tests: [t('^PR REVIEW BINDING refuses before dispatch: the bound merge base is not the merge base'), t('^PR REVIEW BINDING refuses before dispatch: an author lab is on the panel')],
    edits: [one(PR, '  if (!v.ok) { err("review-pr: refused: a binding did not verify', '  if (false) { err("review-pr: refused: a binding did not verify')]},
  // ---- dispatch: one at a time, peers hidden until the last ends ----------------------------------------------------
  {id: 'P14', what: 'the reviewers run at once', tests: [t('^PR REVIEW: each lab runs alone')],
    edits: [one(PR, '  for (const reviewer of binding.panel) {', '  await Promise.all(binding.panel.map(async reviewer => {'),
      one(PR, '  }\n\n  const complete = results.filter(', '  }));\n\n  const complete = results.filter(')]},
  {id: 'P15', what: 'each lab\'s findings are released into the checkout as soon as it ends', tests: [t('^PR REVIEW: each lab runs alone')],
    edits: [one(PR, '    const r = results.at(-1);\n', '    const r = results.at(-1);\n    if (!opts.dryRun) await cp(outDir, join(releaseAbs, reviewer.lab), { recursive: true });\n')]},
  {id: 'P16', what: 'the stage may be outside /tmp', tests: [t('^PR REVIEW: the stage must be under')],
    edits: [one(PR, '  if (!(await underTmp(stageRoot))) {', '  if (false) {')]},
  {id: 'P17', what: 'the stage is readable by others', tests: [t('^PR REVIEW: each lab runs alone')],
    edits: [one(PR, '  await chmod(stage, 0o700);', '  await chmod(stage, 0o755);')]},
  {id: 'P18', what: 'every lab runs as the README row\'s default reviewer', tests: [t('^PR REVIEW: each lab runs alone')],
    edits: [one(PR, '  if (!isDefault) a.push("--reviewer"', '  if (false) a.push("--reviewer"')]},
  {id: 'P19', what: 'the runner is given the merge base, not the bound head', tests: [t('^PR REVIEW: each lab runs alone')],
    edits: [one(PR, '"--commit", b.head.sha,', '"--commit", b.base.merge_base,')]},
  {id: 'P20', what: 'the release is made outside the withheld findings-* path', tests: [t('^PR REVIEW: each lab runs alone')],
    edits: [one(PR, '  const releaseRel = `${binding.brief.dir}/findings-${', '  const releaseRel = `${binding.brief.dir}/review-${')]},
  // ---- a review is complete only on its evidence --------------------------------------------------------------------
  {id: 'P21', what: 'a timeout is not named as one', tests: [t('^PR REVIEW: a timeout, a refusal')],
    edits: [one(PR, '  if (run.killed_for === "timeout") why.push(', '  if (false) why.push(')]},
  {id: 'P22', what: 'the transcript\'s own status is not read', tests: [t('^PR REVIEW: missing evidence')],
    edits: [one(PR, '    if (t.status !== "complete") why.push(', '    if (false) why.push(')]},
  {id: 'P23', what: 'the coverage gate is not read', tests: [t('^PR REVIEW: missing evidence')],
    edits: [one(PR, '    if (!t.coverage_gate?.ok) why.push(', '    if (false) why.push(')]},
  {id: 'P24', what: 'a review of another commit counts', tests: [t('^PR REVIEW: missing evidence')],
    edits: [one(PR, '    if (t.commit !== b.head.sha) why.push(', '    if (false) why.push(')]},
  {id: 'P25', what: 'a review by another model counts', tests: [t('^PR REVIEW: missing evidence')],
    edits: [one(PR, '    if (t.requested_model !== reviewer.model) why.push(', '    if (false) why.push(')]},
  {id: 'P26', what: 'a review prompted with another brief counts', tests: [t('^PR REVIEW: missing evidence')],
    edits: [one(PR, '    if (pr.readme_sha256 !== b.brief.files["README.md"]) why.push(', '    if (false) why.push(')]},
  {id: 'P27', what: 'a message without the required sections counts', tests: [t('^PR REVIEW: missing evidence')],
    edits: [one(PR, '  for (const k of REQUIRED_SECTIONS) if (', '  for (const k of []) if (')]},
  {id: 'P28', what: 'a missing findings file is not named', tests: [t('^PR REVIEW: missing evidence')],
    edits: [one(PR, '  if (findings === null) why.push(', '  if (false) why.push(')]},
  {id: 'P29', what: 'the panel is complete when any lab is', tests: [t('^PR REVIEW: missing evidence')],
    edits: [one(PR, '      status: complete.length === results.length ? "complete" : "incomplete",', '      status: complete.length > 0 ? "complete" : "incomplete",')]},
  {id: 'P30', what: 'an earlier release a reviewer jail could read is not recorded', tests: [t('^PR REVIEW: a second run records')],
    edits: [one(PR, '.catch(() => [])).filter(e => e.startsWith("findings-")).sort();', '.catch(() => [])).filter(() => false);')]},
  {id: 'P31', what: 'a PR head that moved during the run is not recorded', tests: [t('^PR REVIEW: a second run records')],
    edits: [one(PR, 'still_bound_head: headAfter === binding.head.sha,', 'still_bound_head: true,')]},
  // ---- the runner's --review-dir -------------------------------------------------------------------------------------
  {id: 'R1', what: '--review-dir is not validated as docs/reviews/<name>', tests: [t('^REVIEW DIR: a --review-dir outside')],
    edits: [one(INDEX, '  if (v["review-dir"] !== undefined && !REVIEW_DIR_RE.test(v["review-dir"])) throw', '  if (false) throw')]},
  {id: 'R2', what: 'the brief is read from the default round whatever --review-dir says', tests: [t('^REVIEW DIR: --review-dir loads')],
    edits: [one(BRIEF, '  const dir = join(repoRoot, reviewDir);', '  const dir = join(repoRoot, REVIEW_DIR);')]},
  {id: 'R3', what: 'the subscription preamble is read from the default round', tests: [t('^REVIEW DIR: in subscription mode')],
    edits: [one(SUB, '  const harnessTemplate = await readFile(join(repoRoot, reviewDir, "HARNESS-cli.md"), "utf8")', '  const harnessTemplate = await readFile(join(repoRoot, REVIEW_DIR, "HARNESS-cli.md"), "utf8")')]},
  {id: 'R4', what: 'the plan names the default round\'s harness', tests: [t('^REVIEW DIR: --review-dir loads')],
    edits: [one(INDEX, '      harness_template: { path: `${reviewDir}/HARNESS.md`', '      harness_template: { path: `${REVIEW_DIR}/HARNESS.md`')]},
  // ---- the xAI SDK route (owner assignment 2026-11-22): the coordinator's dispatch and judgment, the runner's SDK leg ----
  {id: 'X1', what: 'a route is accepted on a lab it is not for', tests: [t('^XAI SDK ROUTE: the binding may route')],
    edits: [one(PR, '    if (r.lab !== route.lab) p.push(', '    if (false) p.push(')]},
  {id: 'X2', what: 'a routed reviewer needs no declared limits', tests: [t('^XAI SDK ROUTE: the binding may route')],
    edits: [one(PR, "    if (!r.limits || typeof r.limits !== \"object\" || Array.isArray(r.limits)) { p.push(", "    if (false) { p.push(")]},
  {id: 'X3', what: 'the routed reviewer is dispatched to its subscription', tests: [t('^XAI SDK ROUTE: runnerArgs dispatch'), t('^XAI SDK ROUTE: the complete coordinator path')],
    edits: [one(PR, '  const routed = reviewer.route === "xai-sdk", L = reviewer.limits ?? {};', '  const routed = false, L = reviewer.limits ?? {};')]},
  {id: 'X4', what: 'the routed reviewer is dispatched without its bound limits', tests: [t('^XAI SDK ROUTE: runnerArgs dispatch')],
    edits: [one(PR, '"--max-turns", String(L.max_turns), ', '"--max-turns", "200", ')]},
  {id: 'X5', what: 'a CLI transcript satisfies a routed reviewer', tests: [t('^XAI SDK ROUTE: judgeReviewer refuses')],
    edits: [one(PR, '  if (t.via !== "api") why.push(', '  if (false) why.push(')]},
  {id: 'X6', what: 'another transport satisfies a routed reviewer', tests: [t('^XAI SDK ROUTE: judgeReviewer refuses')],
    edits: [one(PR, '  if (t.transport !== route.transport) why.push(', '  if (false) why.push(')]},
  {id: 'X7', what: 'a response served by another model is accepted', tests: [t('^XAI SDK ROUTE: judgeReviewer refuses')],
    edits: [one(PR, '  for (const s of served) if (s !== null && s !== reviewer.model) why.push(', '  for (const s of served) if (false) why.push(')]},
  {id: 'X8', what: 'a response naming no served model is accepted', tests: [t('^XAI SDK ROUTE: judgeReviewer refuses')],
    edits: [one(PR, '  else if (served.includes(null)) why.push(', '  else if (false) why.push(')]},
  {id: 'X9', what: 'a change to the review copy is accepted', tests: [t('^XAI SDK ROUTE: judgeReviewer refuses')],
    edits: [one(PR, '  else if (w.violations.length) why.push(', '  else if (false) why.push(')]},
  {id: 'X10', what: 'a run under other limits is accepted', tests: [t('^XAI SDK ROUTE: judgeReviewer refuses')],
    edits: [one(PR, '  if (diff.length) why.push(`the run\'s limits', '  if (false) why.push(`the run\'s limits')]},
  {id: 'X11', what: 'an SDK run satisfies a subscription reviewer', tests: [t('^XAI SDK ROUTE: judgeReviewer refuses')],
    edits: [one(PR, '    if (!reviewer.route && t.via !== "subscription") why.push(', '    if (false) why.push(')]},
  {id: 'X12', what: 'the SDK client keeps the SDK\'s own retries', tests: [s('^XAI SDK: the SDK client is built for xAI only')],
    edits: [one(INDEX, '      state.xai = await make({ apiKey: key, baseURL: XAI_SDK.base_url, maxRetries: XAI_SDK.max_retries, timeout: timeoutMs });', '      state.xai = await make({ apiKey: key, baseURL: XAI_SDK.base_url, timeout: timeoutMs });')]},
  {id: 'X13', what: 'the SDK route is not bounded by its wall clock', tests: [s('^XAI SDK: the whole run is bounded by --max-wall-s')],
    edits: [one(INDEX, '    if (plan.transport === "xai-sdk" && deadline !== null && now().getTime() >= deadline) return wallStop();', '    if (false) return wallStop();')]},
  {id: 'X14', what: 'a 429 on the SDK route is retried beyond max_turns', tests: [s('^XAI SDK: the retry never exceeds max_turns')],
    edits: [one(INDEX, '        if ((status === 429 || status >= 500) && attempt === 1 && state.providerCalls < opts.limits.max_turns) {', '        if ((status === 429 || status >= 500) && attempt === 1) {')]},
  {id: 'X15', what: 'an unreported cost is recorded as zero', tests: [s('^XAI SDK: the SDK client is built for xAI only'), s('^XAI SDK: a reported cost of zero')],
    edits: [one(INDEX, '  return { reported: false, value: null, field: null };\n}', '  return { reported: true, value: 0, field: "cost" };\n}')]},
  {id: 'X16', what: 'a source edit in the review copy leaves the review complete', tests: [s('^XAI SDK: a change to a source file')],
    edits: [one(INDEX, '  if (state.worktree_check?.violations.length) { status = "incomplete";', '  if (false) { status = "incomplete";')]},
  {id: 'X17', what: 'a continuation is accepted across transports', tests: [s('^XAI SDK: --continue refuses a transcript of another transport')],
    edits: [one(INDEX, '    if (prior && (prior.via ?? "api") === "api" && (prior.transport ?? null) !== (plan.transport ?? null)) {', '    if (false) {')]},
  {id: 'X18', what: 'the SDK error class is lost (every failure recorded as Error)', tests: [s("^XAI SDK: the real SDK's own error classes")],
    edits: [one(INDEX, '        ev.sdk_error = cls && cls !== "Error" ? cls : (e?.name ?? "Error");', '        ev.sdk_error = e?.name ?? "Error";')]},
  {id: 'X19', what: 'the SDK route may serve a non-xAI reviewer', tests: [s('^XAI SDK: usage')],
    edits: [one(INDEX, '  if (opts.xaiTransport && row.vendor !== "xai") throw new UsageError(', '  if (false) throw new UsageError(')]},
  // ---- round 2 (Codex's independent cases at 42836cc): the inner retry's deadline, provenance before effects, a judge
  // that fails closed on an incomplete record, the documented cost field ------------------------------------------
  {id: 'X20', what: 'an attempt (a retry included) is sent past the wall clock', tests: [s('^XAI SDK R2: the wall clock bounds the INNER retry')],
    edits: [one(INDEX, '    if (plan.transport === "xai-sdk" && deadline !== null && now().getTime() >= deadline) return wallStop();', '    if (false) return wallStop();'),
            one(INDEX, '          if (deadline !== null && now().getTime() + wait >= deadline) { ev.retry_skipped', '          if (false) { ev.retry_skipped')]},
  {id: 'X21', what: 'a retry sleeps past the wall clock', tests: [s('^XAI SDK R2: the wall clock bounds the INNER retry')],
    edits: [one(INDEX, '          if (deadline !== null && now().getTime() + wait >= deadline) { ev.retry_skipped', '          if (false) { ev.retry_skipped')]},
  {id: 'X22', what: 'an attempt\'s abort deadline ignores the remaining wall clock', tests: [s("^XAI SDK R2: each attempt's abort deadline")],
    edits: [one(INDEX, '      const callMs = deadline === null ? timeoutMs : Math.max(1, Math.min(timeoutMs, deadline - now().getTime()));', '      const callMs = timeoutMs;')]},
  {id: 'X23', what: 'a response served by another model is used (its tools run)', tests: [s('^XAI SDK R2: provenance before effects'), s('^XAI SDK R2: a response naming no served model')],
    edits: [one(INDEX, '      if (plan.transport === "xai-sdk" && r.served_model !== plan.model) {', '      if (false) {')]},
  {id: 'X24', what: 'a cost-looking field other than cost_in_usd_ticks is read as a cost', tests: [s('^XAI SDK R2: an undocumented cost-looking field')],
    edits: [one(INDEX, '  const v = usage && typeof usage === "object" ? usage.cost_in_usd_ticks : undefined;', '  const v = usage && typeof usage === "object" ? (usage.cost_in_usd_ticks ?? usage.cost) : undefined;')]},
  {id: 'X25', what: 'a failed request carries no cost reading (missing from the unavailable count)', tests: [s('^XAI SDK R2: cost is read only from')],
    edits: [one(INDEX, '        ev.cost = costOf(null); // a failed request: its cost is unavailable, never a zero', '')]},
  {id: 'X26', what: 'a missing counter passes the judge', tests: [t('^XAI SDK ROUTE R2: a record with a required field removed')],
    edits: [one(PR, '  for (const k of ["provider_calls", "tool_calls"]) if (!wholeCount(t[k])) why.push(', '  for (const k of []) if (!wholeCount(t[k])) why.push(')]},
  {id: 'X27', what: 'a malformed worktree check passes the judge', tests: [t('^XAI SDK ROUTE R2: a record with a required field removed')],
    edits: [one(PR, '  else if (typeof w !== "object" || !Array.isArray(w.changed) || !Array.isArray(w.violations)) why.push(', '  else if (false) why.push(')]},
  {id: 'X28', what: 'the gate\'s verdict is trusted over its own coverage facts', tests: [t('^XAI SDK ROUTE R2: a record with a required field removed')],
    edits: [one(PR, '    if (t.coverage_gate?.ok && !g.ok) why.push(', '    if (false) why.push(')]},
  {id: 'X29', what: 'the coverage is not checked against the assignment\'s testing limit', tests: [t('^XAI SDK ROUTE R2: a record with a required field removed')],
    edits: [one(PR, '  if (!perms) why.push(`the assignment', '  if (false) why.push(`the assignment'),
            one(PR, '    if (c && typeof c === "object" && typeof c.tests_allowed === "boolean" && c.tests_allowed !== allowed) why.push(', '    if (false) why.push(')]},
  {id: 'X30', what: 'the coordinator judges without the assignment\'s row', tests: [t('^XAI SDK ROUTE: the complete coordinator path')],
    edits: [one(PR, '    } else results.push(await judgeReviewer({ binding, reviewer, outDir, run, readmeRow }));', '    } else results.push(await judgeReviewer({ binding, reviewer, outDir, run }));')]},
  // ---- round 3 (Codex's control at 1a7050f): the changed paths, not the violations summary, decide a clean review copy --
  {id: 'X31', what: 'the judge takes the violations summary alone (the changed paths are not re-checked)', tests: [t('^XAI SDK ROUTE R3: a changed path outside')],
    edits: [one(PR, '      for (const p of worktreeViolations(w.changed, { write_allowed: writable }))', '      for (const p of [])')]},
  {id: 'X32', what: 'the judge re-checks the changed paths as if every assignment allowed writes', tests: [t('^XAI SDK ROUTE R3: a changed path outside')],
    edits: [one(PR, '      const writable = perms.tools.includes("write_test");', '      const writable = true;')]},
  {id: 'X33', what: 'the shared path policy lets a .. path out of .review-tests/', tests: [t('^XAI SDK ROUTE R3: a changed path outside')],
    edits: [one(CLI, '  changed.filter(p => !(write_allowed && p.startsWith(`${REVIEW_TESTS_DIR}/`) && !p.split("/").includes("..")));', '  changed.filter(p => !(write_allowed && p.startsWith(`${REVIEW_TESTS_DIR}/`)));')]},
  // ---- round 4 (Codex's interaction case at 1a7050f): an identity-rejected response is never replayed or counted ---------
  {id: 'X34', what: 'a continuation replays a response served by another model (or none)', tests: [s('^XAI SDK R4: a run stopped on a response from')],
    edits: [one(INDEX, '      if (rejected || prior.identity_mismatch) {', '      if (false) {')]},
  {id: 'X35', what: 'the judge trusts served_models over the recorded responses', tests: [t('^XAI SDK ROUTE R4: a recorded response served by another model')],
    edits: [one(PR, '    if (e?.type !== "provider_call" || (!hasResponse && (e.served_model === undefined || e.served_model === null))) continue;', '    continue;')]},
  {id: 'X36', what: 'a call naming another served model without its response body is not checked', tests: [t('^XAI SDK ROUTE R4: a recorded response served by another model')],
    edits: [one(PR, '    if (e?.type !== "provider_call" || (!hasResponse && (e.served_model === undefined || e.served_model === null))) continue;', '    if (e?.type !== "provider_call" || !hasResponse) continue;')]},
  // ---- round 5 (Codex's pass at 8942598): the routed judge derives its counts and coverage from the recorded events -----
  {id: 'X37', what: 'the provider_calls counter is trusted over the recorded events', tests: [t('^XAI SDK ROUTE R5: the three summary-over-facts'), t('^XAI SDK ROUTE R5: a retry is a provider call'), s("^XAI SDK R5: the real runner's fresh run")],
    edits: [one(PR, '  if (wholeCount(t.provider_calls) && t.provider_calls !== pc) why.push(', '  if (false) why.push(')]},
  {id: 'X38', what: 'the bound max_turns is checked against the counter, not the recorded calls', tests: [t('^XAI SDK ROUTE R5: the three summary-over-facts')],
    edits: [one(PR, '  if (pc > L.max_turns) why.push(', '  if (t.provider_calls > L.max_turns) why.push(')]},
  {id: 'X39', what: 'a continuation\'s counters are compared with every event (a valid continuation fails)', tests: [t('^XAI SDK ROUTE R5: a valid continuation'), s("^XAI SDK R5: the real runner's continuation")],
    edits: [one(PR, '  const thisRun = lastCont >= 0 ? events.slice(lastCont + 1) : events;', '  const thisRun = events;')]},
  {id: 'X40', what: 'a continuation\'s cumulative counts are not checked', tests: [t('^XAI SDK ROUTE R5: a valid continuation')],
    edits: [one(PR, '      if (cu.provider_calls !== pcAll) why.push(', '      if (false) why.push(')]},
  {id: 'X41', what: 'a run with no recorded response served by the bound model passes', tests: [t('^XAI SDK ROUTE R5: the three summary-over-facts')],
    edits: [one(PR, '  if (!events.some(e => e?.type === "provider_call" && e.response && typeof e.response === "object" && rawModelOf(e) === reviewer.model))', '  if (false)')]},
  // ---- #118: the attestation is the raw provider response's model ---------------------------------------------------
  {id: 'X44', what: "a derived event served_model that contradicts the raw provider model is not refused", tests: [t('^XAI SDK ROUTE #118: the judge attests a response')],
    edits: [one(PR, '    if (e.served_model !== undefined && e.served_model !== s) why.push(', '    if (false) why.push(')]},
  {id: 'X45', what: "the event's derived served_model outranks the raw provider model again", tests: [t('^XAI SDK ROUTE #118: the judge attests a response')],
    edits: [one(PR, '    const s = rawModelOf(e);', '    const s = e.served_model ?? rawModelOf(e);'), one(PR, '    if (e.served_model !== undefined && e.served_model !== s) why.push(', '    if (false) why.push(')]},
  {id: 'X46', what: 'a served model claimed with no recorded provider response is taken as an attestation', tests: [t('^XAI SDK ROUTE #118: the judge attests a response')],
    edits: [one(PR, '      why.push(`missing provenance: the call at turn ${turn} claims served model ${e.served_model} with no recorded provider response`);', '')]},
  {id: 'X42', what: 'the coverage summary is trusted over the recorded events', tests: [t('^XAI SDK ROUTE R5: the three summary-over-facts')],
    edits: [one(PR, '      if (off.length) why.push(`the coverage summary contradicts', '      if (false) why.push(`the coverage summary contradicts')]},
  {id: 'X43', what: 'a continued_from without its continuation event passes', tests: [t('^XAI SDK ROUTE R5: a valid continuation')],
    edits: [one(PR, '  if (continued && lastCont < 0) why.push(', '  if (false) why.push(')]},
];

const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const WITHHELD = f => f.split('/').some(s => s.startsWith('findings-'));
function copyTree(dest) {
  const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard', '-z'], {encoding: 'utf8', maxBuffer: 1 << 28}).split('\0').filter(Boolean);
  for (const f of files) {
    if (WITHHELD(f)) continue;
    const from = path.join(ROOT, f);
    if (!fs.existsSync(from) || fs.lstatSync(from).isDirectory()) continue;
    fs.mkdirSync(path.dirname(path.join(dest, f)), {recursive: true});
    if (fs.lstatSync(from).isSymbolicLink()) { fs.symlinkSync(fs.readlinkSync(from), path.join(dest, f)); continue; }
    fs.copyFileSync(from, path.join(dest, f));
    fs.chmodSync(path.join(dest, f), fs.statSync(from).mode);
  }
  for (const nm of ['node_modules', 'pantheon/node_modules', 'packages/model-client/node_modules', 'packages/ledger/node_modules', 'packages/graph/node_modules']) {
    if (fs.existsSync(path.join(ROOT, nm))) fs.symlinkSync(path.join(ROOT, nm), path.join(dest, nm), 'dir');
  }
}
const runSuites = (dir, logFile, files, patterns = []) => {
  const r = spawnSync(process.execPath, ['--test', '--test-timeout=600000', ...patterns.map(p => `--test-name-pattern=${p}`), ...files],
    {cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, env: {...process.env}});
  const out = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(logFile, out);
  const count = k => Number(new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
  return {status: r.status, tests: count('tests'), pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'), skipped: count('skipped'),
    failed: [...new Set(out.split('\n').filter(l => /^\s*✖ /.test(l) && !/failing tests/.test(l)).map(l => l.trim().replace(/ \(\d+(\.\d+)?ms\)$/, '')))]};
};

const only = arg('--only')?.split(',') ?? null;
const chosen = MUTATIONS.filter(m => !only || only.includes(m.id));
if (only && chosen.length !== only.length) { console.error(`unknown mutation id(s): ${only.filter(id => !MUTATIONS.some(m => m.id === id)).join(', ')}`); process.exit(2); }
if (new Set(MUTATIONS.map(m => m.id)).size !== MUTATIONS.length) { console.error('mutation ids are not unique'); process.exit(2); }
// Every edit must apply EXACTLY ONCE on this tree, and every deciding test file must be a suite, before anything runs.
const bad = chosen.flatMap(m => m.edits.map(e => ({m, e, n: fs.readFileSync(path.join(ROOT, e.file), 'utf8').split(e.from).length - 1}))).filter(x => x.n !== 1);
const strays = chosen.flatMap(m => m.tests.filter(([f]) => !SUITES.includes(f)).map(([f]) => `${m.id}: ${f}`));
if (bad.length || strays.length) {
  for (const {m, e, n} of bad) console.error(`${m.id}: the target occurs ${n} time(s) in ${e.file}; a mutation applies exactly once`);
  for (const s of strays) console.error(`${s} is not one of the runner's suites`);
  process.exit(2);
}
if (process.argv.includes('--check')) { console.log(`${chosen.length} mutation(s), every target occurring exactly once`); process.exit(0); }
const copyRoot = path.resolve(arg('--copy-root', os.tmpdir()));
const logDir = path.resolve(arg('--log', path.join(copyRoot, `review-pr-mutations-${Date.now()}`)));
fs.mkdirSync(logDir, {recursive: true});
const copy = fs.mkdtempSync(path.join(copyRoot, 'review-pr-mutate-'));
let exit = 0;
const summary = [];
try {
  copyTree(copy);
  const baseline = runSuites(copy, path.join(logDir, 'baseline.log'), SUITES);
  console.log(`baseline: ${baseline.pass}/${baseline.tests} pass, ${baseline.fail} fail, ${baseline.cancelled} cancelled, ${baseline.skipped} skipped`);
  if (baseline.status !== 0 || baseline.fail || baseline.cancelled || baseline.skipped || !(baseline.tests > 0)) {
    console.error('the unmutated suites are not green: no mutation result would mean anything');
    exit = 3;
  } else {
    for (const m of chosen) {
      const originals = new Map();
      for (const e of m.edits) {
        const file = path.join(copy, e.file);
        if (!originals.has(file)) originals.set(file, fs.readFileSync(file, 'utf8'));
        const before = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, before.replace(e.from, () => e.to));
        if (fs.readFileSync(file, 'utf8') === before) { console.error(`${m.id}: EDIT DID NOT APPLY in ${e.file}`); exit = 2; }
      }
      const files = [...new Set(m.tests.map(([f]) => f))], patterns = [...new Set(m.tests.map(([, p]) => p))];
      const r = runSuites(copy, path.join(logDir, `${m.id}.log`), files, patterns);
      for (const [file, text] of originals) fs.writeFileSync(file, text);
      const killed = r.status !== 0 && (r.fail > 0 || r.cancelled > 0) && r.tests > 0;
      summary.push({id: m.id, what: m.what, tests: m.tests, files: [...new Set(m.edits.map(e => e.file))], killed, ran: r.tests, pass: r.pass, fail: r.fail, cancelled: r.cancelled, failed: r.failed.slice(0, 12)});
      console.log(`${m.id} ${killed ? 'KILLED  ' : 'SURVIVED'} ${r.pass}/${r.tests} pass, ${r.fail} fail  ${m.what}`);
      for (const f of r.failed.slice(0, 3)) console.log(`    ${f.slice(0, 200)}`);
      if (!killed) exit = exit || 1;
    }
  }
} finally {
  fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify({suites: SUITES, mutations: summary}, null, 2) + '\n');
  fs.rmSync(copy, {recursive: true, force: true});
}
console.log(`logs: ${logDir}`);
process.exit(exit);
