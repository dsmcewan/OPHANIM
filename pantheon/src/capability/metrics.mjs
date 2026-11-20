// THE METRICS per executable capability (knowledge graphs, Slice C1, KC5; owner decision 2026-11-20: "Keep the seats as we
// have them for now until we better understand the metrics" -- the metrics are recorded so they can be understood first).
//
// Purpose   Extract EXPLICITLY DEFINED metrics (METRIC_DEFINITIONS, and docs/knowledge-graph/slice-c1.md) from the
//           execution records that hold them, per executable capability of the capability graph, with their sources and
//           coverage; and state them as OBSERVED graph assertions (a registered tool, measured basis, with the run identity
//           of the records read) joined to the capability by `measures`.
// Inputs    board run.json records (attempts, turns and their selections, escalations, revisions, gates), the practice
//           records (pantheon.pair/v1 pairs and their run copies, read with practice/evaluate.mjs loadRuns), work-ledger
//           stage payloads (ophanim.work/v1 work.stage: team and usage), review transcripts (ophanim.review-transcript/v1),
//           Gemini usage rows (ophanim.gemini-billing/v1) and metering-relay outcomes (ophanim.gemini-relay-outcome/v1).
// Evidence  three types, never merged (graph.mjs EVIDENCE_TYPES): documented capability, owner direction, measured. These
//           metrics are the MEASURED ones; they say what was recorded, not what a capability is good at.
// Must never  emit `qualified-for`: it is admitted only from measurements under a criterion THE OWNER defines, and none is
//           defined (QUALIFICATION_CRITERION is null); report a value it did not observe as 0 (unobserved is null); estimate
//           a cost; read a record it was not given (nothing under docs/reviews is read by default).
import fs from 'node:fs';
import path from 'node:path';
import {digest} from '../../../packages/ledger/canonical.mjs';
import {assertion} from '../../../packages/graph/schema.mjs';
import {entityId} from '../../../packages/graph/identity.mjs';
import {loadRuns} from '../practice/evaluate.mjs';
import {E, METRICS_TOOL, ROOT} from './graph.mjs';
import {capabilityOfSeat} from './eligibility.mjs';

export const METRICS_SCHEMA = 'pantheon.capability-metrics/v1';
/** The owner-defined qualification criterion. NONE IS DEFINED: no `qualified-for` is emitted until the owner defines one. */
export const QUALIFICATION_CRITERION = null;
export const OUTCOMES = Object.freeze(['answered', 'accepted', 'revised', 'refused', 'failed', 'identity-mismatch']);
const REFUSED = new Set(['refused_preflight', 'refused_metered', 'refused_seat', 'quota']);
const FAILED = new Set(['error', 'transient', 'incomplete']);
const ROLE_OF_PURPOSE = Object.freeze({plan: 'planner', work: 'implementer', critique: 'reviewer', scout: 'scout'});
const H = v => 'sha256:' + digest(v);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Every metric, defined: what it counts, from which records, and what it never claims. */
export const METRIC_DEFINITIONS = Object.freeze([
  {id: 'attempts', unit: 'provider-call attempts', sources: ['run.json attempts', 'review transcripts'],
    definition: 'every row of a run\'s `attempts` (each provider call the run made, failed ones included) whose seat is this capability; a review transcript counts as one assignment of its requested model on the api transport, with its provider_calls'},
  {id: 'provider_requests', unit: 'billed provider requests', sources: ['run.json attempts', 'review transcripts', 'work-ledger stages'],
    definition: 'the sum of each attempt\'s provider_requests, an attempt whose count is unknown counting ONE (board/run-item.mjs providerCallsOf); a transcript\'s provider_calls; a work-ledger stage\'s usage.provider_calls only when its team is exactly one seat (else listed, not attributed)'},
  {id: 'outcomes', unit: 'count per role and task profile', sources: ['run.json attempts, turns, escalations, revisions and gates', 'work-ledger stages', 'review transcripts'],
    definition: 'role = the purpose (plan planner, work implementer, critique reviewer, scout scout); task profile = the selection\'s recorded task profile (stakes and depth) or its difficulty, else "unrecorded". answered: an attempt with outcome ok. accepted: a work turn of the run\'s final revision when the run shipped through its REVIEW gate (the practice metrics\' `accepted`). revised: an implementer seat an escalation record names after a rejection (a critique that did not approve, an acceptance command that failed): its output was sent back. refused: an attempt refused before an answer (refused_preflight, refused_metered, refused_seat, quota). failed: an attempt that ended error, transient or incomplete. identity-mismatch: an attempt that failed closed on AGY_MODEL_MISMATCH. A work-ledger stage of one seat adds its status (passed, returned, failed, blocked, pending) under `stages`; a transcript adds its status'},
  {id: 'tokens', unit: 'tokens', sources: ['run.json attempts usage', 'review transcripts usage_totals', 'work-ledger stage usage.tokens'],
    definition: 'input and output tokens summed over the attempts that reported both; null (never 0) when none did, with `missing` the attempts that reported none'},
  {id: 'cost_usd', unit: 'USD', sources: ['run.json attempts', 'Gemini usage rows'],
    definition: 'the sum of a stated usd / cost_usd; null unless every attempt states one. No price is estimated'},
  {id: 'latency_ms', unit: 'milliseconds', sources: ['run.json attempts ms'],
    definition: 'over the answered attempts that recorded `ms`: n, median, p90 (nearest rank) and max'},
  {id: 'billing_refusals', unit: 'count by code', sources: ['run.json attempts (refused_metered)', 'Gemini relay outcomes', 'review transcripts gemini_billing'],
    definition: 'billed-Gemini requests refused at their point of spend by the billing policy or the metering relay, by refusal code'},
  {id: 'gemini_requests', unit: 'billed Gemini requests', sources: ['Gemini usage rows'],
    definition: 'rows of the Gemini usage record (each one billed request, recorded before it was sent), by kind (primary, failover)'},
]);

// ---- reading the records -------------------------------------------------------------------------------------------------
const readJsonl = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l, i) => { try { return JSON.parse(l); } catch { return {unreadable: `${file}:${i + 1}`}; } });
/**
 * A packages/ledger chain read STRUCTURALLY (chain.jsonl and its content-addressed payload objects, each checked against
 * its digest): the payloads of entries of `kinds`. Signatures are not verified here: the coverage says so, and the
 * ledger's own verification belongs to its owner's tooling (pantheon/ may not import ophanim/).
 */
export function ledgerPayloads(dir, kinds) {
  const file = path.join(dir, 'chain.jsonl'), out = [], unreadable = [];
  if (!fs.existsSync(file)) return {payloads: [], unreadable: [{source: file, why: 'no chain.jsonl'}]};
  for (const [i, line] of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).entries()) {
    let e; try { e = JSON.parse(line); } catch { unreadable.push({source: `${file}:${i + 1}`, why: 'not JSON'}); continue; }
    if (!kinds.includes(e.kind)) continue;
    const ref = String(e.payload_ref ?? ''), p = path.join(dir, 'objects', ref.replace(/^sha256:/, '') + '.json');
    let v; try { v = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { unreadable.push({source: p, why: 'payload missing or unreadable'}); continue; }
    if (H(v) !== ref) { unreadable.push({source: p, why: 'payload does not match its digest'}); continue; }
    out.push({payload: v, source: `${file}#${i + 1}`, kind: e.kind});
  }
  return {payloads: out, unreadable};
}
/** The records named by `spec` ({boards, runs, practice, workStages, workLedger, transcripts, geminiUsage, relayOutcomes}: paths). */
export function loadRecords(spec = {}) {
  const arr = v => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
  const runs = [], unreadable = [], read = {};
  for (const s of [...arr(spec.boards), ...arr(spec.runs), ...arr(spec.practice)]) {
    const r = loadRuns(s);
    runs.push(...r.runs.map(x => ({run: x.run, source: x.source ?? String(s), practice: Boolean(x.pairCopy)})));
    unreadable.push(...r.unreadable);
  }
  const jsonl = (files, schema) => arr(files).flatMap(f => { try { return readJsonl(f).map(row => ({row, source: f})); } catch (e) { unreadable.push({source: f, why: e.message}); return []; } })
    .filter(x => { if (x.row?.schema === schema) return true; unreadable.push({source: x.source, why: `a row that is not ${schema}`}); return false; });
  const stages = jsonl(spec.workStages, 'ophanim.work/v1').map(x => ({payload: x.row, source: x.source}));
  for (const d of arr(spec.workLedger)) { const r = ledgerPayloads(d, ['work.stage']); stages.push(...r.payloads); unreadable.push(...r.unreadable); }
  const transcripts = [];
  for (const d of arr(spec.transcripts)) {
    const files = fs.statSync(d).isDirectory() ? fs.readdirSync(d).filter(f => f.endsWith('.transcript.json')).map(f => path.join(d, f)) : [d];
    for (const f of files) { try { const t = JSON.parse(fs.readFileSync(f, 'utf8')); if (t?.schema === 'ophanim.review-transcript/v1') transcripts.push({transcript: t, source: f}); else unreadable.push({source: f, why: 'not ophanim.review-transcript/v1'}); } catch (e) { unreadable.push({source: f, why: e.message}); } }
  }
  read.boards = arr(spec.boards); read.runs = arr(spec.runs); read.practice = arr(spec.practice); read.workStages = arr(spec.workStages); read.workLedger = arr(spec.workLedger);
  read.transcripts = arr(spec.transcripts); read.geminiUsage = arr(spec.geminiUsage); read.relayOutcomes = arr(spec.relayOutcomes);
  const gemini = jsonl(spec.geminiUsage, 'ophanim.gemini-billing/v1'), relay = jsonl(spec.relayOutcomes, 'ophanim.gemini-relay-outcome/v1');
  // A source inside this repository is named relative to its root, wherever the report runs from (no machine path in what
  // the report records); one outside it (the owner's PANTHEON_HOME) keeps the path it was named by.
  const named = x => { const r = path.relative(ROOT, path.resolve(String(x.source))); return {...x, source: r && !r.startsWith('..') && !path.isAbsolute(r) ? r : String(x.source)}; };
  return {runs: runs.map(named), stages: stages.map(named), transcripts: transcripts.map(named), gemini: gemini.map(named), relay: relay.map(named),
    unreadable: unreadable.map(named), read};
}

// ---- the extraction --------------------------------------------------------------------------------------------------
const taskKeyOf = sel => {
  const t = sel?.task;
  if (t?.stakes?.value || t?.depth?.value) return `stakes:${t.stakes?.value ?? '?'}/depth:${t.depth?.value ?? '?'}`;
  if (sel?.difficulty) return `difficulty:${sel.difficulty}`;
  return 'unrecorded';
};
function blank() {
  return {attempts: 0, provider_requests: 0, provider_requests_unknown: 0, outcomes: {}, stages: {}, tokens: {input: 0, output: 0, reported: 0, missing: 0},
    cost: {usd: 0, stated: 0, missing: 0}, latency: [], billing_refusals: {}, gemini_requests: {}, sources: new Set(), synthetic: new Set(), live: new Set()};
}
const bump = (o, role, task, outcome, n = 1) => { ((o[role] ??= {})[task] ??= Object.fromEntries(OUTCOMES.map(k => [k, 0])))[outcome] += n; };

/**
 * The metrics per executable capability over `records` (loadRecords), mapped by `snapshot` (graph.mjs capabilitySnapshot):
 * {schema, definitions, capabilities: {<capability>: {...}}, unmapped, coverage, qualification, digest}.
 */
export function extractMetrics(records, {snapshot}) {
  const ix = snapshot.index, per = new Map(), unmapped = [];
  const capOf = (seat, role) => {
    if (seat?.transport === 'agy') return {id: null, why: 'the attempt records transport agy, which does not say whether the CLI or the SDK seat served it'};
    const vendor = seat?.vendor === 'google' ? 'agy_google' : seat?.vendor ?? null;
    const id = seat?.model ? capabilityOfSeat(ix, {vendor, model: seat.model, transport: seat.transport ?? null}, {role}) : null;
    return id ? {id: decodeURIComponent(id.split('/').slice(3).join('/'))} : {id: null, why: `${seat?.vendor ?? '?'}/${seat?.model ?? '?'} is not an executable capability of the capability graph`};
  };
  const slot = (seat, role, source) => {
    const c = capOf(seat, role);
    if (!c.id) { unmapped.push({seat: {vendor: seat?.vendor ?? null, model: seat?.model ?? null, transport: seat?.transport ?? null}, role, source, why: c.why}); return null; }
    if (!per.has(c.id)) per.set(c.id, blank());
    const m = per.get(c.id); m.sources.add(source); return m;
  };
  const coverage = {runs: records.runs.length, practice_runs: records.runs.filter(r => r.practice).length, synthetic_runs: 0, live_runs: 0, stages: records.stages.length,
    stages_unattributed: 0, transcripts: records.transcripts.length, gemini_rows: records.gemini.length, relay_outcomes: records.relay.length,
    unreadable: records.unreadable, read: records.read, ledger_verification: records.read.workLedger?.length ? 'read structurally (payload digests checked; signatures not verified here)' : null};
  for (const {run, source} of records.runs) {
    const live = run?.providers?.kind === 'live';
    coverage[live ? 'live_runs' : 'synthetic_runs']++;
    const turns = run.turns ?? [], attempts = run.attempts ?? [];
    const selOf = (purpose, vendor, model) => turns.find(t => t.purpose === purpose && t.vendor === vendor && t.model === model)?.selection ?? turns.find(t => t.selection?.task)?.selection ?? null;
    for (const a of attempts) {
      const role = ROLE_OF_PURPOSE[a.purpose] ?? a.purpose ?? 'unknown', m = slot(a, role, source);
      if (!m) continue;
      m[live ? 'live' : 'synthetic'].add(source);
      const task = taskKeyOf(selOf(a.purpose, a.vendor, a.model));
      m.attempts++;
      if (Number.isInteger(a.provider_requests) && a.provider_requests >= 0) m.provider_requests += a.provider_requests; else { m.provider_requests += 1; m.provider_requests_unknown++; }
      const outcome = a.code === 'AGY_MODEL_MISMATCH' || a.identity ? 'identity-mismatch' : a.outcome === 'ok' ? 'answered' : REFUSED.has(a.outcome) ? 'refused' : FAILED.has(a.outcome) ? 'failed' : 'failed';
      bump(m.outcomes, role, task, outcome);
      if (a.outcome === 'refused_metered') m.billing_refusals[a.code ?? 'refused_metered'] = (m.billing_refusals[a.code ?? 'refused_metered'] ?? 0) + 1;
      const ti = num(a.usage?.input_tokens), to = num(a.usage?.output_tokens);
      if (ti !== null && to !== null) { m.tokens.input += ti; m.tokens.output += to; m.tokens.reported++; } else m.tokens.missing++;
      const usd = num(a.usd) ?? num(a.cost_usd) ?? num(a.cost?.usd);
      if (usd !== null) { m.cost.usd += usd; m.cost.stated++; } else m.cost.missing++;
      if (a.outcome === 'ok' && num(a.ms) !== null) m.latency.push(a.ms);
    }
    // accepted: the work turns of the final revision of a run that shipped through its REVIEW gate.
    const gates = Array.isArray(run.gates) ? Object.fromEntries(run.gates.map(g => [g.gate, g.ok === true])) : {};
    if (run.shipped === true && gates.REVIEW === true) {
      const work = turns.filter(t => t.purpose === 'work'), n = Math.max(1, run.revisions?.at(-1)?.slots?.length ?? 1);
      for (const t of work.slice(-n)) { const m = slot(t, 'implementer', source); if (m) bump(m.outcomes, 'implementer', taskKeyOf(t.selection), 'accepted'); }
    }
    // revised: a rejection the escalation protocol recorded against the seat that produced the work.
    for (const e of run.escalations ?? []) {
      const rejected = (e.outcome?.kind === 'critique' && e.outcome.verdict !== 'approve') || (e.outcome?.kind === 'acceptance' && e.outcome.exit !== 0);
      if (!rejected || !e.seat?.model) continue;
      const m = slot({vendor: e.seat.vendor, model: e.seat.model}, e.role ?? 'implementer', source);
      if (m) bump(m.outcomes, e.role ?? 'implementer', taskKeyOf(selOf('work', e.seat.vendor, e.seat.model)), 'revised');
    }
  }
  for (const {payload: p, source} of records.stages) {
    const team = (p.team ?? []).filter(t => t?.model);
    if (team.length !== 1) { coverage.stages_unattributed++; continue; }
    const t = team[0], m = slot({vendor: t.vendor ?? null, model: t.model}, t.role, source);
    if (!m) continue;
    ((m.stages[t.role] ??= {})[p.status] = (m.stages[t.role]?.[p.status] ?? 0) + 1);
    if (Number.isInteger(p.usage?.provider_calls)) m.provider_requests += p.usage.provider_calls;
  }
  for (const {transcript: t, source} of records.transcripts) {
    const m = slot({vendor: t.vendor, model: t.requested_model, transport: t.via === 'api' ? 'api' : null}, 'reviewer', source);
    if (!m) continue;
    m.attempts++;
    m.provider_requests += num(t.provider_calls) ?? 1;
    bump(m.outcomes, 'reviewer', 'change-review', t.status === 'complete' ? 'answered' : t.status === 'refused' ? 'refused' : 'failed');
    const u = t.usage_totals ?? {}, ti = num(u.input_tokens) ?? num(u.prompt_tokens), to = num(u.output_tokens) ?? num(u.completion_tokens);
    if (ti !== null && to !== null) { m.tokens.input += ti; m.tokens.output += to; m.tokens.reported++; } else m.tokens.missing++;
    m.cost.missing++;
    for (const r of t.gemini_billing?.refusals ?? []) m.billing_refusals[r.code ?? 'refused'] = (m.billing_refusals[r.code ?? 'refused'] ?? 0) + 1;
  }
  // A Gemini usage row is one billed request: of the python SDK seat (transport sdk) or of the metered API.
  for (const {row: r, source} of records.gemini) {
    const m = slot({vendor: r.vendor, model: r.model, transport: r.transport === 'sdk' ? 'agy-sdk' : 'api'}, r.role ?? r.purpose ?? 'unknown', source);
    if (m) m.gemini_requests[r.kind] = (m.gemini_requests[r.kind] ?? 0) + 1;
  }
  // A relay outcome with a refusal is a request the metering relay refused at its point of spend.
  for (const {row: r, source} of records.relay) {
    if (!r.refused) continue;
    const m = slot({vendor: 'agy_google', model: r.model ?? null, transport: 'agy-sdk'}, null, source);
    if (m) m.billing_refusals[r.refused.code ?? 'refused'] = (m.billing_refusals[r.refused.code ?? 'refused'] ?? 0) + 1;
  }
  const capabilities = Object.fromEntries([...per].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, m]) => [k, finish(m)]));
  const body = {schema: METRICS_SCHEMA, evidence_type: 'measured', definitions: METRIC_DEFINITIONS.map(d => d.id), snapshot: snapshot.digest, capabilities,
    unmapped, coverage, qualification: qualificationsOf(capabilities)};
  return {...body, digest: H(body)};
}
function finish(m) {
  const lat = [...m.latency].sort((a, b) => a - b), at = q => lat[Math.min(lat.length - 1, Math.ceil(q * lat.length) - 1)];
  return {attempts: m.attempts, provider_requests: {value: m.provider_requests, unknown_counted_as_one: m.provider_requests_unknown},
    outcomes: m.outcomes, stages: m.stages,
    tokens: m.tokens.reported ? {input: m.tokens.input, output: m.tokens.output, n: m.tokens.reported, missing: m.tokens.missing} : {input: null, output: null, n: 0, missing: m.tokens.missing},
    cost_usd: m.cost.stated && !m.cost.missing ? {value: m.cost.usd, n: m.cost.stated, missing: 0} : {value: null, n: m.cost.stated, missing: m.cost.missing, basis: 'unknown: not every record states its cost; no price is estimated'},
    latency_ms: lat.length ? {n: lat.length, median: at(0.5), p90: at(0.9), max: lat.at(-1)} : {n: 0, median: null, p90: null, max: null},
    billing_refusals: m.billing_refusals, gemini_requests: m.gemini_requests, sources: [...m.sources].sort(), runs: {synthetic: m.synthetic.size, live: m.live.size}};
}

/**
 * Qualification (`qualified-for`) is admitted ONLY from measurements under a criterion the owner defines. None is defined:
 * nothing is emitted, and the record says so. Defining one is the owner's (docs/knowledge-graph/slice-c1.md, "What C2 and
 * the owner must supply").
 */
export function qualificationsOf(capabilities, {criterion = QUALIFICATION_CRITERION} = {}) {
  if (criterion === null) return {criterion: null, emitted: [], why: 'no owner-defined qualification criterion exists: no qualified-for is emitted (the metrics are recorded so they can be understood first, owner decision 2026-11-20)'};
  return {criterion, emitted: [], why: 'a criterion was supplied, but only the owner defines one and this slice implements none: no qualified-for is emitted'};
}

/**
 * The metrics as OBSERVED graph assertions: one `evidence/observation` per capability (origin `origin`, a registered tool
 * with a measured basis; run: the digest of the records read) and `measures` to the capability. Validated by the graph
 * schema when appended (packages/graph kinds.mjs).
 */
export function observedAssertions(metrics, {origin = METRICS_TOOL, observed_at, run = {id: metrics.digest}, synthetic = false}) {
  const out = [];
  const source = {id: 'pantheon.capability.records', authority: 'the execution records each observation names in attributes.sources', ref: 'pantheon/src/capability/metrics.mjs', version: metrics.digest};
  for (const [cap, m] of Object.entries(metrics.capabilities)) {
    const obs = entityId({domain: 'evidence', type: 'observation', key: `capability-metrics/${cap}/${metrics.digest.slice(7, 23)}`});
    out.push(assertion({entity: obs, origin, classification: 'observed', source, run, observed_at,
      uncertainty: synthetic ? 'SYNTHETIC: computed from test fixtures, not live operational evidence' : null,
      attributes: {metrics_schema: METRICS_SCHEMA, capability: cap, evidence_type: 'measured', definitions: metrics.definitions, ...m, synthetic}}));
    out.push(assertion({type: 'measures', from: obs, to: E('capability', cap), origin, classification: 'observed', source, run, observed_at, attributes: {metrics_schema: METRICS_SCHEMA}}));
  }
  return out;
}
