#!/usr/bin/env node
// A matched comparison of two routing profiles on the same tickets (src/practice/compare.mjs;
// CYCLE_CONTRACT.md step 6; docs/routing-task-profile.md, "Running the comparison").
//
//   node pantheon/bin/pantheon-compare.mjs --item NAME [--item NAME]... --max-provider-calls N --out FILE
//       (--clients MODULE [--turn MODULE] | --live) [--revisions R] [--baseline argo] [--candidate fit]
//       [--question TEXT] [--repo DIR] [--dir WORKDIR] [--n 3]
//   node pantheon/bin/pantheon-compare.mjs --measure plan-title --item NAME... --max-provider-calls N --total-provider-calls T
//       --out FILE (--clients MODULE | --live) [--profile argo] [--plan FILE] [--revisions R]
//
// Each --item is a ticket (<repo>/tickets/<item>.json, ophanim.ticket/v1, as pantheon-board reads it). Each
// runs through runOpenItem under the baseline and then the candidate profile, with the same declared bounds:
// --max-provider-calls (required, per run) and --revisions (default 3). With --turn, every shipped run also
// gets an independent review cycle on n labs (one attempt each), counted as coordination overhead.
//
// Providers: --clients MODULE (default export makeClientFor(vendor)) and --turn MODULE (default export the
// reviewer turn) are fakes as pantheon-board takes them; the record is then `synthetic: true` and names each
// module by its bytes. --live uses the live SDK clients and provider keys Pantheon already uses
// (OPENAI_API_KEY, XAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY, and an agy login): it is never the default,
// and it spends up to 2 x tickets x --max-provider-calls provider calls, plus n per shipped run with a cycle
// review. Live and --clients are exclusive.
//
// THE GEMINI BILLING POLICY (register L-136; docs/billing-policy.md), both OFF when absent:
//   --metered-gemini-failover N   the metered Gemini API may answer an Antigravity lane's quota refusal in a run's walk
//   --gemini-api-primary N        primary Gemini API execution: a Gemini API seat of a run (a ticket's pin), a Google
//                                 cycle reviewer (served by the API, no lane), a --turn module's Gemini API seat
// N, a positive integer, bounds the billed requests of that kind for the WHOLE comparison (every ticket, both arms, the
// cycle reviews), counted from <dir>/gemini-billing.jsonl, written before each request. Malformed or unbudgeted: a usage
// error. A GEMINI_API_KEY authorizes nothing; with --clients the fake clients' Gemini seats are admitted the same way.
//
// Writes the comparison record to --out and prints {record, digest, synthetic, evidence}: `evidence` is the
// citation a practice disposition carries. It records nothing on any ledger and never writes the status
// ledger. Exit codes: 0 written, 1 refused, 2 usage.
import { dirname, resolve, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { readTicket } from "../src/board/operate.mjs";
import { compareProfiles, compareArms, dispatchRunner, comparisonEvidence } from "../src/practice/compare.mjs";
import { billingFromFlags, geminiBilling, geminiUsageFile, billingRecord } from "../src/route/quota-failover.mjs";

const REPO_DEFAULT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const opts = {}, items = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) usage(`unexpected argument "${a}"`);
  const k = a.slice(2);
  if (k === "live") { opts.live = true; continue; }
  if (i + 1 >= argv.length) usage(`--${k} needs a value`);
  if (k === "item") items.push(argv[++i]); else opts[k] = argv[++i];
}
function usage(why) {
  console.error(`${why}\nusage: pantheon-compare --item NAME... --max-provider-calls N --out FILE (--clients MODULE [--turn MODULE] | --live) [--revisions R] [--baseline argo] [--candidate fit] [--question TEXT] [--repo DIR] [--dir WORKDIR] [--metered-gemini-failover N] [--gemini-api-primary N]`);
  process.exit(2);
}
const int = (k, dflt) => {
  if (opts[k] === undefined) return dflt;
  const n = Number(opts[k]);
  if (!Number.isSafeInteger(n) || n < 1) usage(`--${k} is a positive integer`);
  return n;
};
if (!items.length) usage("name at least one --item");
if (!opts.out) usage("--out FILE names where the comparison record is written");
const maxProviderCalls = int("max-provider-calls", null);
if (maxProviderCalls === null) usage("--max-provider-calls N is required: the comparison runs only under a declared provider-call bound");
if (opts.live && (opts.clients || opts.turn)) usage("--live and --clients/--turn are exclusive");
if (!opts.live && !opts.clients) usage("pass --clients MODULE (fake providers), or --live to spend on the live providers");
const revisions = int("revisions", 3), n = int("n", 3);
// --measure plan-title: the paired measurement declared in docs/reviews/2026-11-17-review-capacity/MEASUREMENT.md.
// Two arms on one profile (--profile, default argo): planTitle model (baseline) and planTitle ticket (candidate).
// It needs a TOTAL provider-call boundary (--total-provider-calls): a ticket count is not a spending cap.
const MEASURES = { "plan-title": profile => [{ label: "model-title", profile, runOpts: { planTitle: "model" } }, { label: "ticket-title", profile, runOpts: { planTitle: "ticket" } }] };
const measure = opts.measure ?? null;
if (measure !== null && !Object.hasOwn(MEASURES, measure)) usage(`--measure is one of ${Object.keys(MEASURES).join(", ")}`);
const totalProviderCalls = int("total-provider-calls", null);
if (measure !== null && totalProviderCalls === null) usage("--measure needs --total-provider-calls N: the boundary for the whole measurement (a ticket count is not a spending cap)");
if (measure !== null && opts.turn) usage("--measure measures in-run results; it takes no --turn cycle review");

const repo = resolve(opts.repo ?? REPO_DEFAULT);
const load = async file => (await import(pathToFileURL(resolve(file)).href)).default;
const moduleId = file => ({ path: resolve(file), sha256: "sha256:" + createHash("sha256").update(readFileSync(resolve(file))).digest("hex") });

async function liveClients() {
  const [{ default: OpenAI }, { GoogleGenAI }, { default: Anthropic }, { makeClient }] = await Promise.all([
    import("openai"), import("@google/genai"), import("@anthropic-ai/sdk"), import("../src/sdk/adapter.mjs")]);
  const clients = {};
  return (v, { pool = v, poolConfig } = {}) => (clients[`${v}:${pool}`] ??= makeClient(v, { OpenAI, GoogleGenAI, Anthropic, poolConfig }));
}
// The live cycle-review turn: the API seat (src/sdk/live.mjs apiTurn), every Gemini request of it admitted by the policy.
async function liveTurn(billing) {
  const { apiTurn } = await import("../src/sdk/live.mjs");
  return apiTurn({ label: "compare-cycle-review", billing });
}
// THE BILLING POLICY, resolved before any work.
let policy;
try { policy = billingFromFlags(opts); } catch (e) { usage(e.message); }

try {
  const tickets = items.map(item => {
    const t = readTicket({ repo, item });
    if (t.why) throw Object.assign(new Error(t.why), { code: "TICKET" });
    return { spec: t.spec, digest: t.digest };
  });
  const workDir = resolve(opts.dir ?? join(repo, "outputs", "compare", `compare-${Date.now()}`));
  mkdirSync(workDir, { recursive: true });
  // The comparison's Gemini usage record: one budget per kind across every run and cycle review of it.
  const billing = geminiBilling({ policy, ledger: geminiUsageFile(join(workDir, "gemini-billing.jsonl")) });
  const billingShown = () => (r => ({ policy: r.policy, where: r.where, used: { failover: billing.ledger.used("failover"), primary: billing.ledger.used("primary") }, refusals: r.refusals }))(billingRecord(billing));
  const makeClientFor = opts.live ? await liveClients() : await load(opts.clients);
  const { billedTurnModule } = await import("../src/sdk/live.mjs");
  const cycleTurn = opts.live ? await liveTurn(billing) : opts.turn ? billedTurnModule(await load(opts.turn), billing) : null;
  const providers = opts.live
    ? { kind: "live", clients: "live SDK clients (src/sdk/adapter.mjs makeClient)", turn: "live SDK reviewer turns" }
    : { kind: "fake", clients: moduleId(opts.clients), turn: opts.turn ? moduleId(opts.turn) : null };
  const bounds = { maxProviderCalls, revisions, ...(cycleTurn ? { cycle_review: { n, max_attempts: 1 } } : {}) };
  if (measure !== null) {
    // The declared plan is pinned by its bytes: the record carries its path and sha256.
    const planFile = opts.plan ? resolve(opts.plan) : resolve(repo, "docs/reviews/2026-11-17-review-capacity/MEASUREMENT.md");
    const plan = existsSync(planFile) ? { path: relative(repo, planFile), sha256: "sha256:" + createHash("sha256").update(readFileSync(planFile)).digest("hex") } : null;
    if (!plan) usage(`the declared measurement plan ${planFile} does not exist; a measurement runs only against a plan fixed beforehand`);
    const record = await compareArms({ tickets, arms: MEASURES[measure](opts.profile ?? "argo"), bounds: { maxProviderCalls, revisions }, totalProviderCalls,
      providers, plan, question: opts.question ?? "Does the work item's title from the ticket, instead of from a planner model, change in-run results, and at what cost?",
      runner: dispatchRunner({ makeClientFor, dir: workDir, runOpts: { billing } }) });
    const out = resolve(opts.out);
    writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
    console.log(JSON.stringify({ record: out, digest: record.digest, synthetic: record.synthetic, evidence: comparisonEvidence(record), plan,
      spent_provider_calls: record.spent_provider_calls, total_provider_calls: record.total_provider_calls,
      pairs: record.paired.pairs, not_paired: record.paired.unpaired, accepted: record.paired.all.accepted ?? null, gemini_billing: billingShown() }, null, 2));
    process.exit(0);
  }
  const record = await compareProfiles({ tickets, baseline: opts.baseline ?? "argo", candidate: opts.candidate ?? "fit", bounds, providers,
    question: opts.question ?? null, runner: dispatchRunner({ makeClientFor, dir: workDir, cycleTurn, n, runOpts: { billing } }) });
  const out = resolve(opts.out);
  writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify({ record: out, digest: record.digest, synthetic: record.synthetic, evidence: comparisonEvidence(record),
    accepted: { [record.profiles.baseline.profile]: record.aggregate.baseline.all.accepted, [record.profiles.candidate.profile]: record.aggregate.candidate.all.accepted }, gemini_billing: billingShown() }, null, 2));
  process.exit(0);
} catch (err) {
  console.log(JSON.stringify({ refused: err.message, code: err.code ?? null }, null, 2));
  process.exit(1);
}
