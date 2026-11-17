#!/usr/bin/env node
// A matched comparison of two routing profiles on the same tickets (src/practice/compare.mjs;
// CYCLE_CONTRACT.md step 6; docs/routing-task-profile.md, "Running the comparison").
//
//   node pantheon/bin/pantheon-compare.mjs --item NAME [--item NAME]... --max-provider-calls N --out FILE
//       (--clients MODULE [--turn MODULE] | --live) [--revisions R] [--baseline argo] [--candidate fit]
//       [--question TEXT] [--repo DIR] [--dir WORKDIR] [--n 3]
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
// Writes the comparison record to --out and prints {record, digest, synthetic, evidence}: `evidence` is the
// citation a practice disposition carries. It records nothing on any ledger and never writes the status
// ledger. Exit codes: 0 written, 1 refused, 2 usage.
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { readTicket } from "../src/board/operate.mjs";
import { compareProfiles, dispatchRunner, comparisonEvidence } from "../src/practice/compare.mjs";

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
  console.error(`${why}\nusage: pantheon-compare --item NAME... --max-provider-calls N --out FILE (--clients MODULE [--turn MODULE] | --live) [--revisions R] [--baseline argo] [--candidate fit] [--question TEXT] [--repo DIR] [--dir WORKDIR]`);
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

const repo = resolve(opts.repo ?? REPO_DEFAULT);
const load = async file => (await import(pathToFileURL(resolve(file)).href)).default;
const moduleId = file => ({ path: resolve(file), sha256: "sha256:" + createHash("sha256").update(readFileSync(resolve(file))).digest("hex") });

async function liveClients() {
  const [{ default: OpenAI }, { GoogleGenAI }, { default: Anthropic }, { makeClient }] = await Promise.all([
    import("openai"), import("@google/genai"), import("@anthropic-ai/sdk"), import("../src/sdk/adapter.mjs")]);
  const clients = {};
  return (v, { pool = v, poolConfig } = {}) => (clients[`${v}:${pool}`] ??= makeClient(v, { OpenAI, GoogleGenAI, Anthropic, poolConfig }));
}
async function liveTurn() {
  const [{ default: OpenAI }, { GoogleGenAI }, { default: Anthropic }, { makeClient, sendTurn }] = await Promise.all([
    import("openai"), import("@google/genai"), import("@anthropic-ai/sdk"), import("../src/sdk/adapter.mjs")]);
  const clients = new Map();
  return async ({ vendor, model, prompt }) => {
    if (!clients.has(vendor)) clients.set(vendor, makeClient(vendor, { OpenAI, GoogleGenAI, Anthropic }));
    const r = await sendTurn({ client: clients.get(vendor), vendor, model, prompt, label: `${vendor}-compare-cycle-review` });
    if (r.complete === false) throw new Error(`${vendor}/${model}: the reply did not complete (${r.terminal_state ?? "unknown"})`);
    return { text: r.text ?? "", response_id: r.response_id ?? null, served_model: r.served_model ?? null };
  };
}

try {
  const tickets = items.map(item => {
    const t = readTicket({ repo, item });
    if (t.why) throw Object.assign(new Error(t.why), { code: "TICKET" });
    return { spec: t.spec, digest: t.digest };
  });
  const makeClientFor = opts.live ? await liveClients() : await load(opts.clients);
  const cycleTurn = opts.live ? await liveTurn() : opts.turn ? await load(opts.turn) : null;
  const providers = opts.live
    ? { kind: "live", clients: "live SDK clients (src/sdk/adapter.mjs makeClient)", turn: "live SDK reviewer turns" }
    : { kind: "fake", clients: moduleId(opts.clients), turn: opts.turn ? moduleId(opts.turn) : null };
  const workDir = resolve(opts.dir ?? join(repo, "outputs", "compare", `compare-${Date.now()}`));
  mkdirSync(workDir, { recursive: true });
  const bounds = { maxProviderCalls, revisions, ...(cycleTurn ? { cycle_review: { n, max_attempts: 1 } } : {}) };
  const record = await compareProfiles({ tickets, baseline: opts.baseline ?? "argo", candidate: opts.candidate ?? "fit", bounds, providers,
    question: opts.question ?? null, runner: dispatchRunner({ makeClientFor, dir: workDir, cycleTurn, n }) });
  const out = resolve(opts.out);
  writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify({ record: out, digest: record.digest, synthetic: record.synthetic, evidence: comparisonEvidence(record),
    accepted: { [record.profiles.baseline.profile]: record.aggregate.baseline.all.accepted, [record.profiles.candidate.profile]: record.aggregate.candidate.all.accepted } }, null, 2));
  process.exit(0);
} catch (err) {
  console.log(JSON.stringify({ refused: err.message, code: err.code ?? null }, null, 2));
  process.exit(1);
}
