#!/usr/bin/env node
// Pantheon on the status board (pantheon/src/board/operate.mjs, docs/operating-workflow.md).
//
//   node pantheon/bin/pantheon-board.mjs next [--json] [--seat role=vendor/model]...
//       the verified board's dispatchable items, in dependency order, each with its ticket and the team
//       it would seat (vendor, model, lab per chair, and the cycle reviewers)
//   node pantheon/bin/pantheon-board.mjs run <item> [--turn MODULE] [--clients MODULE] [--seat role=vendor/model]...
//       [--n 3] [--dir BOARD] [--out DIR] [--branch NAME] [--checked YYYY-MM-DD] [--profile argo|legacy|fit]
//       runOpenItem on the item's ticket (the run ledger on), the shipped change committed on a branch,
//       a review cycle over it on distinct labs, an evidence bundle and an UNSIGNED status proposal
//   node pantheon/bin/pantheon-board.mjs resume <item> --out DIR [--turn MODULE] [--max-attempts N]
//       a run whose review cycle a failed reviewer left open: ask again only the seats with no review, on
//       the same cycle and change (never a new cycle; the item is not run again), then close and propose
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
import { readFileSync } from "node:fs";
import { boardNext, runBoardItem, resumeBoardItem, proposeFromBundle, checkProposal, defaultStatusRoot } from "../src/board/operate.mjs";

const REPO_DEFAULT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const [verb, ...argv] = process.argv.slice(2);
const opts = {}, multi = { seat: [] }, args = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) { args.push(a); continue; }
  const k = a.slice(2);
  if (k === "json") { opts.json = true; continue; }
  if (i + 1 >= argv.length) usage(`--${k} needs a value`);
  if (k in multi) multi[k].push(argv[++i]); else opts[k] = argv[++i];
}
function usage(why) {
  console.error(`${why}\nusage: pantheon-board next [--json] | run <item> [--turn MODULE] [--clients MODULE] [--seat role=vendor/model] [--profile argo|legacy|fit] | resume <item> --out DIR [--turn MODULE] | propose --bundle DIR | check <proposal.json>`);
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
  return (v, { pool = v, poolConfig } = {}) => (clients[`${v}:${pool}`] ??= makeClient(v, { OpenAI, GoogleGenAI, Anthropic, poolConfig }));
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

const seatLine = s => `${s.vendor}/${s.model} (${s.lab})${s.operator ? " [operator reseat]" : ""}`;
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
    console.log("  team (runOpenItem's routing, first seat then fallbacks):");
    for (const role of ["scout", "planner", "implementer", "reviewer"]) console.log(`    ${role.padEnd(11)} ${it.team[role].map(seatLine).join(" | ")}`);
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
    const r = boardNext({ repo, statusRoot, anchor, overrides: seatOverrides });
    if (opts.json) console.log(JSON.stringify(r, null, 2)); else printNext(r);
    process.exit(0);
  }
  if (verb === "run") {
    if (args.length !== 1) usage("run names one item");
    const makeClientFor = opts.clients ? await load(opts.clients) : await liveClients();
    const turn = opts.turn ? await load(opts.turn) : await liveTurn();
    const r = await runBoardItem({ repo, item: args[0], statusRoot, anchor, makeClientFor, turn, n: Number(opts.n ?? 3),
      dir: opts.dir ? resolve(opts.dir) : null, out: opts.out ? resolve(opts.out) : null, branch: opts.branch ?? null,
      // --profile selects the routing profile for this run only; omitted, runOpenItem's default (argo) applies.
      checked: opts.checked, runOpts: { seatOverrides, ...(opts.profile ? { profile: opts.profile } : {}) }, practice,
      progress: ev => {
        if (ev.from !== "pipeline") console.error(JSON.stringify(ev));
        else if (["stage.start", "ship", "run.end", "run.error"].includes(ev.event)) console.error(`  [${ev.stage}] ${ev.event} ${ev.detail ?? ""}`);
      } });
    console.log(JSON.stringify({ bundle: `${r.dir}/evidence.json`, proposal: r.proposal ? `${r.dir}/proposal.json` : null, why: r.why ?? null,
      shipped: r.bundle.run.shipped, commit: r.bundle.commit, branch: r.bundle.branch, cycle: r.bundle.review?.cycle ?? null,
      outcome: r.bundle.review?.outcome ?? null, findings: r.bundle.review?.reviews.flatMap(x => x.findings) ?? [] }, null, 2));
    process.exit(r.proposal ? 0 : 1);
  }
  if (verb === "resume") {
    if (args.length !== 1) usage("resume names one item");
    if (!opts.out) usage("resume needs --out DIR, the run's evidence bundle");
    const turn = opts.turn ? await load(opts.turn) : await liveTurn();
    const r = await resumeBoardItem({ repo, item: args[0], dir: resolve(opts.out), statusRoot, anchor, turn,
      max_attempts: opts["max-attempts"] === undefined ? undefined : Number(opts["max-attempts"]), practice,
      progress: ev => console.error(JSON.stringify(ev)) });
    console.log(JSON.stringify({ bundle: `${r.dir}/evidence.json`, proposal: r.proposal ? `${r.dir}/proposal.json` : null, why: r.why ?? null,
      cycle: r.bundle.review?.cycle ?? null, outcome: r.bundle.review?.outcome ?? null, failed: r.bundle.review?.failed ?? [],
      resumes: r.bundle.review?.resumes ?? [], findings: r.bundle.review?.reviews.flatMap(x => x.findings) ?? [] }, null, 2));
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
  usage(`unknown verb: ${verb ?? "(none)"}`);
} catch (err) {
  console.log(JSON.stringify({ refused: err.message, code: err.code ?? null }, null, 2));
  process.exit(1);
}
