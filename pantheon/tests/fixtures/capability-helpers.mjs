// Shared fixtures of the capability-graph tests (knowledge graphs, Slice C1): the REAL registries of this checkout, data
// changes made on deep copies of them (never on the files), and a real packages/graph ledger with SYNTHETIC keys generated
// per test. No provider request is made and no real key is used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {generateSigner} from '../../../packages/ledger/chain.mjs';
import {createGraphLedger, openGraph} from '../../../packages/graph/kinds.mjs';
import {capabilityOrigins, capabilitySources, currentRegistries, DECLARED, STRUCTURAL, METRICS_TOOL, SOURCE_ORDER} from '../../src/capability/graph.mjs';
import {ARGO_SEATS} from '../../src/route/frontier.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
/** The SYNTHETIC execution records (one file: every record marked synthetic), laid out on disk by writeRecords. */
export const RECORDS = path.join(ROOT, 'pantheon/tests/fixtures/capability-records.json');
export const T0 = '2026-11-20T10:00:00.000Z';

/**
 * Lay the synthetic records out under `dir` as the real ones are laid out -- boards/<name>/run.json, a practice pair
 * (pairs/<id>/pair.json beside primary.run.json, its digest computed over the bytes written), the work-ledger stage
 * payloads, review transcripts, the Gemini usage record and the relay outcomes as JSON lines -- and return the paths the
 * metrics reader is given (metrics.mjs loadRecords).
 */
export function writeRecords(dir) {
  const r = JSON.parse(fs.readFileSync(RECORDS, 'utf8'));
  const w = (rel, text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), {recursive: true}); fs.writeFileSync(f, text); return f; };
  const jsonl = rows => rows.map(x => JSON.stringify(x)).join('\n') + '\n';
  for (const [name, run] of Object.entries(r.boards)) w(`boards/${name}/run.json`, JSON.stringify(run, null, 2) + '\n');
  for (const [id, p] of Object.entries(r.practice_pairs)) {
    const bytes = JSON.stringify(p.primary, null, 2) + '\n';
    w(`practice/pairs/${id}/primary.run.json`, bytes);
    w(`practice/pairs/${id}/pair.json`, JSON.stringify({...p.pair, primary: {run_digest: 'sha256:' + createHash('sha256').update(Buffer.from(bytes)).digest('hex')}}, null, 2) + '\n');
  }
  for (const [name, t] of Object.entries(r.transcripts)) w(`transcripts/${name}`, JSON.stringify(t, null, 2) + '\n');
  return {boards: path.join(dir, 'boards'), practice: path.join(dir, 'practice'), workStages: w('work-stages.jsonl', jsonl(r.work_stages)),
    transcripts: path.join(dir, 'transcripts'), geminiUsage: w('gemini-usage.jsonl', jsonl(r.gemini_usage)), relayOutcomes: w('relay-outcomes.jsonl', jsonl(r.relay_outcomes))};
}
export const registries = () => currentRegistries({argo: ARGO_SEATS});
const copy = v => structuredClone(v);
/** A data change: lane `name` retired (its availability flag), on a copy of `reg`. */
export function retireLane(reg, name, why = 'retired for the test: a data change only (lanes.json `retired`)') {
  const r = copy(reg);
  if (!r.lanes.agy_cli[name]) throw new Error(`no lane ${name}`);
  r.lanes.agy_cli[name].retired = why;
  return r;
}
/** A data change: lane `name` removed from lanes.json, on a copy of `reg`. */
export function removeLane(reg, name) {
  const r = copy(reg);
  if (!r.lanes.agy_cli[name]) throw new Error(`no lane ${name}`);
  delete r.lanes.agy_cli[name];
  return r;
}
/** A data change: limitation `id` of runtimes.json patched, on a copy of `reg`. */
export function changeLimitation(reg, id, patch) {
  const r = copy(reg);
  r.runtimes.limitations[id] = {...r.runtimes.limitations[id], ...patch};
  return r;
}

export const KEYS = Object.freeze({operator: 'graph-operator', declared: 'declared-key', structural: 'structural-key', metrics: 'metrics-key', model: 'model-key', agent: 'agent-key'});
export const ORIGINS = capabilityOrigins({keys: {[DECLARED]: [KEYS.declared], [STRUCTURAL]: [KEYS.structural], [METRICS_TOOL]: [KEYS.metrics]},
  extra: {'synthetic.model': {kind: 'model', basis: 'inferred', keys: [KEYS.model]}, 'synthetic.agent': {kind: 'agent', basis: 'inferred', keys: [KEYS.agent]}}});
const extractorKey = id => (id === 'pantheon.executable' ? KEYS.structural : KEYS.declared);

/**
 * A graph world over the capability sources of `reg` (and `history`): a fresh graph ledger with synthetic keys, removed
 * after the test. `observeAll()` observes every source in order; `advance(reg)` makes a data change current.
 */
export function capabilityWorld(t, {reg = registries(), history = []} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-graph-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const keys = Object.fromEntries(Object.values(KEYS).map(k => [k, generateSigner(k)]));
  const authority = {keyring: Object.fromEntries(Object.entries(keys).map(([k, s]) => [k, s.publicJwk])), orderer: KEYS.operator, operators: [KEYS.operator]};
  const anchor = createGraphLedger({dir, authority, operator: keys[KEYS.operator], order: keys[KEYS.operator]});
  const sources = capabilitySources(reg, {history});
  const open = () => openGraph({dir, anchor, origins: ORIGINS, sources});
  const graph = open();
  const by = key => ({signer: keys[key], order: keys[KEYS.operator]});
  const observeAll = (g = graph, at = T0) => Object.fromEntries(SOURCE_ORDER.map(id => [id, g.observe(id, {...by(extractorKey(id)), observed_at: at})]));
  return {dir, anchor, keys, by, graph, sources, open, observeAll, advance: r => sources.advance(r)};
}
