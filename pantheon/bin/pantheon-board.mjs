#!/usr/bin/env node
// Pantheon on the status board (pantheon/src/board/operate.mjs, docs/operating-workflow.md).
//
//   node pantheon/bin/pantheon-board.mjs next [--json] [--seat role=vendor/model]... [--profile argo|legacy|fit]
//       the verified board's dispatchable items, in dependency order, each with its ticket and the team
//       its run would seat: the dispatch's own selector (selectSeat) on that ticket under the profile (its task
//       profile under fit), per chair the seat then its fallbacks, the review panel, and the cycle reviewers
//   node pantheon/bin/pantheon-board.mjs run <item> [--turn MODULE] [--clients MODULE] [--seat role=vendor/model]...
//       [--n 3] [--dir BOARD] [--out DIR] [--branch NAME] [--checked YYYY-MM-DD] [--profile argo|legacy|fit]
//       runOpenItem on the item's ticket (the run ledger on), the shipped change committed on a branch,
//       a review cycle over it on distinct labs, an evidence bundle and an UNSIGNED status proposal
//   node pantheon/bin/pantheon-board.mjs resume <item> --out DIR [--turn MODULE] [--max-attempts N] [--max-provider-calls N]
//       a run whose review cycle a failed reviewer left open: ask again only the seats with no review, on
//       the same cycle and change (never a new cycle; the item is not run again), then close and propose
//
// --max-provider-calls N (run, resume; audit M5): at most N provider calls for the board run, the pipeline's
// (checked before every call, retries and fallbacks included) and then the cycle reviewers'. A resume without
// it inherits the run's recorded bound and counts the calls already made against it; with it, N is the
// operator's new bound for the resume (recorded as basis "operator"). A seat-layer refusal that sent no request
// is not a provider call.
//   node pantheon/bin/pantheon-board.mjs propose --bundle DIR [--accept-unverified REASON]
//       close the bundle's review cycle once its findings are fixed or deferred, and write the proposal
//   node pantheon/bin/pantheon-board.mjs check <proposal.json>
//       re-derive the proposal's evidence with Pantheon's kinds (the run ledger, the cycle, the commit)
//
// run, resume and propose also take --practice-outcome O --practice-question TEXT: the review cycle's practice
// assessment (audit C3; retain | insufficient_evidence | propose_measurement), recorded before the close. A
// cycle opened under the practice contract does not close without one, as it does not with an open finding.
// Richer dispositions (a policy proposal, a candidate's promote) go through pantheon-review-cycle assess.
//
// Continuous evaluation (docs/routing-task-profile.md, "Continuous evaluation"): `run` deposits its run.json in
// the evidence store (--evidence-store DIR, else PANTHEON_EVIDENCE_STORE, else <run ledger dir>/../runs) and,
// with --interleave, dispatches the ticket's hash-assigned arm (argo or fit; low and normal stakes only; an
// explicit --profile wins). A cycle that closes with no stated assessment gets the evaluation's, recorded by
// the controller (never a promote).
// With --pair-rate R (0..1, default 0) and --pair-max-provider-calls N (required with a rate), a ticket the
// pair sample selects (sha256 of its key below R; every stakes stratum) is also run under the other profile in
// a separate dry board on a snapshot of the repository: it never ships, merges, proposes or reviews, it makes
// at most N provider calls, and its pair record goes to <store>/pairs/. At most R x tickets x N extra calls.
//   node pantheon/bin/pantheon-board.mjs evaluate [--runs DIR] [--json]
//       the current evaluation of the store (default PANTHEON_EVIDENCE_STORE, else <OPHANIM_LEDGER>/../runs)
//       per stakes stratum, and the strata the stop rule has halted, then the paired section (discordant
//       counts, paired intervals, Wilcoxon cost tests, pairs needed). Reads files only; no provider call.
//
// Common: --repo DIR (default: this repository), --status-ledger DIR (default OPHANIM_STATUS_LEDGER, else
// <repo>/status/ledger), --anchor sha256:... (the status ledger's expected genesis).
//
// It never writes the status ledger and never reads its keys. Seats: live SDK clients by default (the
// provider keys Pantheon already uses: OPENAI_API_KEY, XAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY,
// and an agy login for the Antigravity lane), or `--clients MODULE` whose default export is
// makeClientFor(vendor). Cycle reviewers: live SDK turns by default, or `--turn MODULE` whose default
// export is the reviewer turn (pantheon/bin/cycle-review-http-turn.mjs for the HTTPS path).
//
// Exit codes: 0 done, 1 refused (not dispatchable, not shipped, the cycle cannot close yet, a check
// failed), 2 usage.
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { boardNext, runBoardItem, resumeBoardItem, proposeFromBundle, checkProposal, defaultStatusRoot } from "../src/board/operate.mjs";
import { evaluate, defaultEvidenceStore } from "../src/practice/evaluate.mjs";

const REPO_DEFAULT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const [verb, ...argv] = process.argv.slice(2);
const opts = {}, multi = { seat: [] }, args = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) { args.push(a); continue; }
  const k = a.slice(2);
  if (k === "json" || k === "interleave") { opts[k] = true; continue; }
  if (i + 1 >= argv.length) usage(`--${k} needs a value`);
  if (k in multi) multi[k].push(argv[++i]); else opts[k] = argv[++i];
}
function usage(why) {
  console.error(`${why}\nusage: pantheon-board next [--json] [--profile argo|legacy|fit] | run <item> [--turn MODULE] [--clients MODULE] [--seat role=vendor/model] [--profile argo|legacy|fit] [--interleave] [--evidence-store DIR] [--pair-rate R --pair-max-provider-calls N --pair-budget-calls TOTAL] [--max-provider-calls N] [--plan-title model|ticket] | resume <item> --out DIR [--turn MODULE] [--max-provider-calls N] | propose --bundle DIR | check <proposal.json> | evaluate [--runs DIR] [--json]`);
  process.exit(2);
}
const repo = resolve(opts.repo ?? REPO_DEFAULT);
const statusRoot = opts["status-ledger"] ? resolve(opts["status-ledger"]) : defaultStatusRoot(repo);
const anchor = opts.anchor ?? null;
const load = async file => (await import(pathToFileURL(resolve(file)).href)).default;
const practice = opts["practice-outcome"] || opts["practice-question"]
  ? { outcome: opts["practice-outcome"] ?? usage("--practice-question needs --practice-outcome"), question: opts["practice-question"] ?? usage("--practice-outcome needs --practice-question") }
  : null;

async function liveClients() {
  const [{ default: OpenAI }, { GoogleGenAI }, { default: Anthropic }, { makeClient }] = await Promise.all([
    import("openai"), import("@google/genai"), import("@anthropic-ai/sdk"), import("../src/sdk/adapter.mjs")]);
  const clients = {};
  const make = (v, { pool = v, poolConfig } = {}) => (clients[`${v}:${pool}`] ??= makeClient(v, { OpenAI, GoogleGenAI, Anthropic, poolConfig }));
  // The run records what answered: the vendor SDKs are live providers (continuous evaluation reads this).
  make.providers = { kind: "live" };
  return make;
}
// A positive integer flag, or null when absent.
const intFlag = name => {
  if (opts[name] === undefined) return null;
  const v = Number(opts[name]);
  if (!(Number.isSafeInteger(v) && v > 0)) usage(`--${name} is a positive integer, got ${opts[name]}`);
  return v;
};
const pct = x => (x === null || x === undefined ? "-" : `${(x * 100).toFixed(1)}%`);
const ci = c => (c ? `[${c[0].toFixed(3)}, ${c[1].toFixed(3)}]` : "-");
function printEvaluation(e, store) {
  console.log(`Continuous evaluation of ${store}`);
  console.log(`  ${e.schema} ${e.digest}${e.synthetic ? "  SYNTHETIC" : ""}`);
  console.log(`  ${e.candidate.profile} (${e.candidate.policy.hash.slice(0, 19)}) against ${e.baseline.profile} (${e.baseline.policy.hash.slice(0, 19)}); ` +
    `${e.runs.length} interleaved run(s), ${e.excluded.length} excluded, providers: ${e.providers.join(", ") || "none"}`);
  const t = e.thresholds;
  console.log(`  rule: n >= ${t.MIN_N} per arm; non-inferior within ${t.NONINFERIORITY_MARGIN} at ${t.PROMOTION_CONFIDENCE * 100}%; stop at <= -${t.STOP_MARGIN} at ${t.STOP_CONFIDENCE * 100}% after ${t.STOP_MIN_N}`);
  console.log("\n  stratum    outcome                n fit/argo   accepted fit/argo   diff CI           first_pass fit/argo");
  for (const [s, x] of Object.entries(e.strata)) {
    const r = x.rates ?? {};
    console.log(`  ${s.padEnd(10)} ${(x.outcome + (x.halted ? " (halted)" : "")).padEnd(22)} ${`${x.n.fit}/${x.n.argo}${x.basis === "paired" ? "p" : ""}`.padEnd(12)} ` +
      `${`${pct(r.accepted?.fit)}/${pct(r.accepted?.argo)}`.padEnd(19)} ${ci(r.accepted?.diff_ci).padEnd(17)} ${pct(r.first_pass?.fit)}/${pct(r.first_pass?.argo)}`);
    console.log(`             ${x.why}`);
    if (x.basis === "paired") console.log(`             decided on paired runs (below); unpaired: ${x.unpaired.outcome}, n fit ${x.unpaired.n.fit}, argo ${x.unpaired.n.argo}: ${x.unpaired.why}`);
    if (x.cost) console.log(`             cost per accept: ${Object.entries(x.cost).map(([k, c]) => `${k} ${c.fit ?? "?"} vs ${c.argo ?? "?"} (${c.status})`).join("; ")}`);
  }
  if (!Object.keys(e.strata).length) console.log("  (no interleaved runs yet)");
  console.log(`\n  overall: ${e.outcome}${e.measured ? " (measured)" : " (provisional)"}`);
  console.log(`  halted strata: ${e.halted.length ? e.halted.join(", ") : "none"}`);
  if (e.flags?.length) console.log(`  flagged: ${e.flags.map(f => `${f.profile} in ${f.stratum} (${f.basis})`).join("; ")}`);
  printPaired(e);
  console.log(`  shadow: ${e.shadow.turns} turn(s), ${e.shadow.agree} agree, ${e.shadow.disagree} disagree, ${e.shadow.unavailable} unavailable (${e.shadow.note})`);
}
const pv = v => (v === null || v === undefined ? "-" : v < 1e-4 ? v.toExponential(1) : v.toFixed(4));
function printPaired(e) {
  const p = e.paired;
  if (!p) return;
  console.log(`\n  Paired runs: ${p.pairs.length} completed, ${p.refused.length} refused, ${p.invalid.length} invalid` +
    ` (paired stratum decides when present; n >= ${e.thresholds.MIN_PAIRS} pairs; stop after ${e.thresholds.PAIR_STOP_MIN_N}; cost: Wilcoxon at p < ${e.thresholds.PAIRED_COST_ALPHA})`);
  for (const r of p.refused) console.log(`    refused ${r.pair_id} (${r.ticket}): ${r.code}`);
  for (const [s, x] of Object.entries(p.strata)) {
    const a = x.accepted, f = x.first_pass;
    console.log(`  ${s.padEnd(10)} ${(x.outcome + (x.halted ? " (halted)" : "")).padEnd(22)} ${x.n} pairs${x.synthetic ? ", synthetic" : ""}`);
    console.log(`             accepted   fit ${pct(a.fit)} argo ${pct(a.argo)}; discordant fit only ${a.discordant.fit_only} / argo only ${a.discordant.argo_only}; diff ${a.diff.toFixed(3)} ${ci(a.diff_ci)} (99%)`);
    console.log(`             first_pass fit ${pct(f.fit)} argo ${pct(f.argo)}; discordant fit only ${f.discordant.fit_only} / argo only ${f.discordant.argo_only}; diff ${f.diff.toFixed(3)} ${ci(f.diff_ci)} (99%)`);
    console.log(`             cost (fit - argo, pairs both accepted): ${Object.entries(x.cost).map(([k, c]) =>
      `${k} median ${c.median_diff ?? "?"} over ${c.n} (p ${pv(c.test.p_two_sided)}${c.test.exact ? " exact" : ""}${c.missing.fit ? `, ${c.missing.fit} lack fit's` : ""}) ${c.status}`).join("; ")}`);
    const w = x.power.accepted;
    console.log(`             pairs needed (accepted, discordance ${pct(w.discordance)}, observed diff ${w.observed_diff.toFixed(3)}): ` +
      `${w.pairs_needed_at_observed ?? "not reachable"} for the expected 99% bound to clear -${e.thresholds.NONINFERIORITY_MARGIN}; ${w.pairs_needed_80 ?? "-"} for 80% power (Wald)`);
    console.log(`             ${x.why}`);
  }
}
async function liveTurn() {
  // As bin/pantheon-review-cycle.mjs: the vendor SDKs are imported here, at the edge.
  const [{ default: OpenAI }, { GoogleGenAI }, { default: Anthropic }, { makeClient, sendTurn }] = await Promise.all([
    import("openai"), import("@google/genai"), import("@anthropic-ai/sdk"), import("../src/sdk/adapter.mjs")]);
  const clients = new Map();
  return async ({ vendor, model, prompt }) => {
    if (!clients.has(vendor)) clients.set(vendor, makeClient(vendor, { OpenAI, GoogleGenAI, Anthropic }));
    const r = await sendTurn({ client: clients.get(vendor), vendor, model, prompt, label: `${vendor}-cycle-review` });
    if (r.complete === false) throw new Error(`${vendor}/${model}: the reply did not complete (${r.terminal_state ?? "unknown"})`);
    return { text: r.text ?? "", response_id: r.response_id ?? null, served_model: r.served_model ?? null };
  };
}
const seatOverrides = Object.fromEntries(multi.seat.map(s => {
  const [role, vm] = s.split("="), [vendor, model] = (vm ?? "").split("/");
  if (!role || !vendor || !model) usage(`--seat expects role=vendor/model, got "${s}"`);
  return [role, { vendor, model, rank: 0, pool: vendor, band: null, basis: "OPERATOR", why: "operator reseat for this board run" }];
}));

const seatLine = s => `${s.vendor}/${s.model} (${s.lab})${s.operator ? " [operator reseat]" : ""}` +
  (s.class !== undefined ? ` [${s.class ?? "-"}, effort ${s.effort ?? "-"}]` : "");
function printNext(r) {
  console.log(`Status board: ${r.board.root}`);
  console.log(`  verified: anchor ${r.board.anchor}, head ${r.board.head}, ${r.board.entries} entries`);
  console.log(`\nDispatchable (${r.items.length}), in dependency order:`);
  for (const it of r.items) {
    console.log(`\n* ${it.item}: ${it.title}`);
    console.log(`  latest status ${it.entry} (Ready): ${it.basis}`);
    console.log(`  ticket ${it.ticket.path} (${it.ticket.digest.slice(0, 19)}), slice: ${it.ticket.slice}`);
    console.log(`  files: ${it.ticket.files.join(", ")}; difficulty ${it.ticket.difficulty}; proposes ${it.ticket.proposes.state} on success`);
    console.log(`  acceptance: ${it.ticket.acceptance_cmd}`);
    console.log(`  team (${it.team.profile}: the dispatch's selector on this ticket; first seat then fallbacks):`);
    console.log(`    ${"scouts".padEnd(11)} ${it.team.scouts.length ? it.team.scouts.map(seatLine).join(" + ") : "(none: no explorer stage)"}`);
    console.log(`    ${"planner".padEnd(11)} ${it.team.planner.map(seatLine).join(" | ")}`);
    for (const [i, l] of it.team.implementers.entries()) console.log(`    ${(it.team.implementers.length > 1 ? `impl.${i}` : "implementer").padEnd(11)} ${l.map(seatLine).join(" | ")}`);
    for (const [i, p] of it.team.review_panels.entries()) console.log(`    ${(it.team.review_panels.length > 1 ? `review.${i}` : "reviewer").padEnd(11)} ${p.map(seatLine).join(" + ")}`);
    for (const n of it.team.notes ?? []) console.log(`      note: ${n}`);
    const c = it.team.cycle_reviewers;
    console.log(`    cycle review (n=${c.seats.length}, distinct labs, avoiding ${c.author_labs.join(", ")}): ${c.seats.map(seatLine).join(" | ")}`);
    if (c.note) console.log(`      note: ${c.note}`);
  }
  if (r.skipped.length) {
    console.log(`\nReady but not dispatchable (${r.skipped.length}):`);
    for (const s of r.skipped) console.log(`  - ${s.item}: ${s.why}`);
  }
}

try {
  if (verb === "next") {
    if (opts.profile && !["argo", "legacy", "fit"].includes(opts.profile)) usage(`--profile is argo, legacy or fit, got ${opts.profile}`);
    const r = boardNext({ repo, statusRoot, anchor, overrides: seatOverrides, profile: opts.profile ?? "argo" });
    if (opts.json) console.log(JSON.stringify(r, null, 2)); else printNext(r);
    process.exit(0);
  }
  if (verb === "run") {
    // Paired runs: a rate in [0, 1], and never without the counterpart's provider-call bound.
    const pairRate = opts["pair-rate"] === undefined ? 0 : Number(opts["pair-rate"]);
    if (!(Number.isFinite(pairRate) && pairRate >= 0 && pairRate <= 1)) usage(`--pair-rate is a number in [0, 1], got ${opts["pair-rate"]}`);
    const pairMax = opts["pair-max-provider-calls"] === undefined ? null : Number(opts["pair-max-provider-calls"]);
    if (pairMax !== null && !(Number.isSafeInteger(pairMax) && pairMax > 0)) usage(`--pair-max-provider-calls is a positive integer, got ${opts["pair-max-provider-calls"]}`);
    if (pairRate > 0 && pairMax === null) usage("--pair-rate needs --pair-max-provider-calls N: a counterpart never runs without an explicit provider-call bound (PAIR_UNBOUNDED)");
    const pairTotal = opts["pair-budget-calls"] === undefined ? null : Number(opts["pair-budget-calls"]);
    if (pairTotal !== null && !(Number.isSafeInteger(pairTotal) && pairTotal > 0)) usage(`--pair-budget-calls is a positive integer, got ${opts["pair-budget-calls"]}`);
    if (pairRate > 0 && pairTotal === null) usage("--pair-rate needs --pair-budget-calls N: the total provider calls all counterparts in the evidence store may make. A sampling rate is not a spending cap (PAIR_NO_TOTAL)");
    if (args.length !== 1) usage("run names one item");
    const maxCalls = intFlag("max-provider-calls");
    const planTitle = opts["plan-title"] ?? null;
    if (planTitle !== null && !["model", "ticket"].includes(planTitle)) usage(`--plan-title is model or ticket, got ${planTitle}`);
    const makeClientFor = opts.clients ? await load(opts.clients) : await liveClients();
    const turn = opts.turn ? await load(opts.turn) : await liveTurn();
    const r = await runBoardItem({ repo, item: args[0], statusRoot, anchor, makeClientFor, turn, n: Number(opts.n ?? 3),
      dir: opts.dir ? resolve(opts.dir) : null, out: opts.out ? resolve(opts.out) : null, branch: opts.branch ?? null,
      // --profile selects the routing profile for this run only; omitted, runOpenItem's default (argo) applies.
      // --interleave: the ticket's hash-assigned arm for an eligible stratum; an explicit --profile still wins.
      checked: opts.checked, runOpts: { seatOverrides, ...(maxCalls !== null ? { maxProviderCalls: maxCalls } : {}), ...(opts.profile ? { profile: opts.profile } : {}), ...(opts.interleave ? { interleave: true } : {}), ...(planTitle ? { planTitle } : {}) }, practice,
      evidenceStore: opts["evidence-store"] ? resolve(opts["evidence-store"]) : null,
      pairRate, pairMaxProviderCalls: pairMax, pairBudgetCalls: pairTotal,
      progress: ev => {
        if (ev.from !== "pipeline" && ev.from !== "pair") console.error(JSON.stringify(ev));
        else if (["stage.start", "ship", "run.end", "run.error"].includes(ev.event)) console.error(`  ${ev.from === "pair" ? "[pair] " : ""}[${ev.stage}] ${ev.event} ${ev.detail ?? ""}`);
      } });
    // Refused before any work: the cycle review the change needs cannot be formed from the configured pool.
    if (!r.bundle && r.pending) {
      console.error(`pending: ${r.why}`);
      console.log(JSON.stringify({ pending: r.pending, why: r.why, shipped: false }, null, 2));
      process.exit(1);
    }
    // The seating report: what the selector chose per role (class and effort under fit), from the run's turns.
    const seating = r.bundle.run.seating ?? [];
    if (seating.length) console.error(`Seating (${r.bundle.run.profile ?? "argo"}; what the selector chose):\n${seating.map(x => `  ${x.line}`).join("\n")}`);
    const pw = r.bundle.run.practice_warning;
    if (pw) console.error(`warning: ${pw.code}: the loaded practice disposition ${pw.disposition} (${pw.outcome}, policy ${pw.loaded_policy?.hash}) ` +
      `does not apply; this run dispatched under ${pw.ran_policy.version} (${pw.ran_policy.hash}): ${pw.reason}`);
    console.log(JSON.stringify({ bundle: `${r.dir}/evidence.json`, proposal: r.proposal ? `${r.dir}/proposal.json` : null, why: r.why ?? null, pair: r.bundle.pair ?? null,
      practice_warning: pw ?? null,
      provider_calls: r.bundle.provider_calls ?? null,
      seating: (r.bundle.run.seating ?? []).map(({ line, ...row }) => row), shipped: r.bundle.run.shipped, commit: r.bundle.commit, branch: r.bundle.branch, cycle: r.bundle.review?.cycle ?? null,
      outcome: r.bundle.review?.outcome ?? null, findings: r.bundle.review?.reviews.flatMap(x => x.findings) ?? [] }, null, 2));
    process.exit(r.proposal ? 0 : 1);
  }
  if (verb === "resume") {
    if (args.length !== 1) usage("resume names one item");
    if (!opts.out) usage("resume needs --out DIR, the run's evidence bundle");
    const maxCalls = intFlag("max-provider-calls");
    const turn = opts.turn ? await load(opts.turn) : await liveTurn();
    const r = await resumeBoardItem({ maxProviderCalls: maxCalls, repo, item: args[0], dir: resolve(opts.out), statusRoot, anchor, turn,
      max_attempts: opts["max-attempts"] === undefined ? undefined : Number(opts["max-attempts"]), practice,
      progress: ev => console.error(JSON.stringify(ev)) });
    console.log(JSON.stringify({ bundle: `${r.dir}/evidence.json`, proposal: r.proposal ? `${r.dir}/proposal.json` : null, why: r.why ?? null,
      cycle: r.bundle.review?.cycle ?? null, outcome: r.bundle.review?.outcome ?? null, failed: r.bundle.review?.failed ?? [],
      resumes: r.bundle.review?.resumes ?? [], provider_calls: r.bundle.provider_calls ?? null, findings: r.bundle.review?.reviews.flatMap(x => x.findings) ?? [] }, null, 2));
    process.exit(r.proposal ? 0 : 1);
  }
  if (verb === "propose") {
    if (!opts.bundle) usage("propose needs --bundle DIR");
    const r = proposeFromBundle({ dir: resolve(opts.bundle), statusRoot, anchor, acceptUnverified: opts["accept-unverified"], practice });
    console.log(JSON.stringify({ proposal: r.proposal ? `${resolve(opts.bundle)}/proposal.json` : null, why: r.why ?? null, outcome: r.bundle.review?.outcome ?? null }, null, 2));
    process.exit(r.proposal ? 0 : 1);
  }
  if (verb === "check") {
    if (args.length !== 1) usage("check names one proposal file");
    const r = checkProposal({ proposal: JSON.parse(readFileSync(resolve(args[0]), "utf8")), repo });
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }
  if (verb === "evaluate") {
    const store = opts.runs ? resolve(opts.runs) : opts["evidence-store"] ? resolve(opts["evidence-store"]) : defaultEvidenceStore();
    if (!store) usage("evaluate needs --runs DIR (or PANTHEON_EVIDENCE_STORE, or OPHANIM_LEDGER for <ledger>/../runs)");
    if (!existsSync(store)) usage(`no evidence store at ${store}`);
    const e = evaluate({ runs: store });
    // A large record on a pipe: wait for stdout to drain before exiting, or the JSON is cut short.
    if (opts.json) await new Promise(r => process.stdout.write(JSON.stringify(e, null, 2) + "\n", r)); else printEvaluation(e, store);
    process.exit(0);
  }
  usage(`unknown verb: ${verb ?? "(none)"}`);
} catch (err) {
  console.log(JSON.stringify({ refused: err.message, code: err.code ?? null }, null, 2));
  process.exit(1);
}
