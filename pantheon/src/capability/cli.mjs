#!/usr/bin/env node
// THE CAPABILITY GRAPH'S COMMAND LINE (knowledge graphs, Slice C1; docs/knowledge-graph/slice-c1.md).
//
//   node pantheon/src/capability/cli.mjs snapshot [--json]
//       the capability snapshot of this checkout: each source's version and counts, the executable capabilities and their bubble
//   node pantheon/src/capability/cli.mjs decide --role R [--mode automatic|preferred|pinned --vendor V --model M [--transport T]]
//       [--context N] [--effort E] [--feature F]... [--delegation N] [--avoid-lab L]... [--avoid V]... [--bubble required]
//       [--gemini-primary yes|no] [--json]
//       an ADVISORY eligibility decision, explained (nothing is selected or refused by it)
//   node pantheon/src/capability/cli.mjs metrics [--boards DIR]... [--runs PATH]... [--practice PATH]... [--work-stages FILE]...
//       [--work-ledger DIR]... [--transcripts PATH]... [--gemini-usage FILE]... [--relay-outcomes FILE]... [--synthetic] [--json]
//       the defined metrics per executable capability, with their sources and coverage. With no source named, the owner's
//       board records under $PANTHEON_HOME/boards are read (every run.json under it). `--synthetic` labels the report as
//       computed from fixtures. No qualified-for is printed: no owner-defined criterion exists.
//
// Reads only the records it is named (and the registries of this checkout). Calls no provider; writes nothing.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {capabilitySnapshot, currentRegistries, extractionCounts} from './graph.mjs';
import {decide} from './eligibility.mjs';
import {extractMetrics, loadRecords, METRIC_DEFINITIONS} from './metrics.mjs';
import {ARGO_SEATS} from '../route/frontier.mjs';
import {pantheonHome} from '../seat/store.mjs';

const flags = argv => {
  const out = {_: []};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2), boolean = ['json', 'synthetic'].includes(k);
    const v = boolean ? true : argv[++i];
    if (!boolean && v === undefined) throw new Error(`--${k} takes a value`);
    out[k] = out[k] === undefined ? v : [].concat(out[k], v);
  }
  return out;
};
const list = v => (v === undefined ? [] : [].concat(v));
const short = d => `${d.slice(0, 19)}…`;

function snapshotReport(snap, write) {
  write(`capability snapshot ${snap.digest} (contract ${snap.graph} ${snap.contract})\n`);
  const counts = extractionCounts(snap);
  for (const s of snap.sources) write(`  ${s.id.padEnd(20)} ${s.extractor.padEnd(30)} version ${short(s.version)}  ${String(s.count).padStart(4)} facts  ${Object.entries(counts[s.id].types).map(([t, n]) => `${t} ${n}`).join(', ')}\n`);
  write('executable capabilities (model x runtime x transport x tools x sandbox profile x credential scope):\n');
  for (const n of snap.index.ofType('capability').sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const a = n.attributes, b = Object.entries(a.bubble).map(([k, v]) => `${k} ${v.holds === true ? 'holds' : v.holds === false ? `DOES NOT HOLD${v.limitation ? ` (${v.limitation})` : ''}` : v.holds}`).join(', ');
    write(`  ${decodeURIComponent(n.id.split('/').slice(3).join('/')).padEnd(48)} ${a.availability.state}${a.use.value !== 'primary' ? `, ${a.use.value} only` : ''}; bubble: ${b}\n`);
  }
}

function metricsReport(m, {synthetic}, write) {
  write(`capability metrics ${m.digest}${synthetic ? '  [SYNTHETIC: computed from fixtures, not live operational evidence]' : ''}\n`);
  write(`  snapshot ${m.snapshot}; evidence type: measured (never a qualification)\n`);
  const c = m.coverage;
  write(`  coverage: ${c.runs} run(s) (${c.live_runs} live, ${c.synthetic_runs} synthetic or undeclared; ${c.practice_runs} from practice pairs), ${c.stages} work-ledger stage(s) (${c.stages_unattributed} not attributable to one seat), ${c.transcripts} review transcript(s), ${c.gemini_rows} Gemini usage row(s), ${c.relay_outcomes} relay outcome(s)${c.ledger_verification ? `; work ledger ${c.ledger_verification}` : ''}\n`);
  if (c.unreadable.length) write(`  unreadable: ${c.unreadable.map(u => `${u.source} (${u.why})`).join('; ')}\n`);
  for (const [cap, x] of Object.entries(m.capabilities)) {
    const o = {};
    for (const byTask of Object.values(x.outcomes)) for (const counts of Object.values(byTask)) for (const [k, v] of Object.entries(counts)) o[k] = (o[k] ?? 0) + v;
    write(`  ${cap}\n    attempts ${x.attempts}; provider requests ${x.provider_requests.value}${x.provider_requests.unknown_counted_as_one ? ` (${x.provider_requests.unknown_counted_as_one} unknown, counted as one)` : ''}; runs ${x.runs.live} live, ${x.runs.synthetic} synthetic\n`);
    write(`    outcomes: ${Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}\n`);
    for (const [role, byTask] of Object.entries(x.outcomes)) for (const [task, counts] of Object.entries(byTask)) write(`      ${role} @ ${task}: ${Object.entries(counts).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ')}\n`);
    if (Object.keys(x.stages).length) write(`    work-ledger stages: ${Object.entries(x.stages).map(([r, s]) => `${r} ${Object.entries(s).map(([k, v]) => `${k} ${v}`).join('/')}`).join('; ')}\n`);
    write(`    tokens: ${x.tokens.input === null ? `unknown (${x.tokens.missing} without usage)` : `in ${x.tokens.input}, out ${x.tokens.output} over ${x.tokens.n}${x.tokens.missing ? `, ${x.tokens.missing} without usage` : ''}`}; cost: ${x.cost_usd.value === null ? 'unknown (no price is estimated)' : `$${x.cost_usd.value}`}\n`);
    write(`    latency: ${x.latency_ms.n ? `median ${x.latency_ms.median} ms, p90 ${x.latency_ms.p90} ms, max ${x.latency_ms.max} ms (n ${x.latency_ms.n})` : 'unrecorded'}; billing refusals: ${Object.entries(x.billing_refusals).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}${Object.keys(x.gemini_requests).length ? `; billed Gemini requests: ${Object.entries(x.gemini_requests).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}\n`);
    write(`    sources: ${x.sources.join(', ')}\n`);
  }
  if (m.unmapped.length) write(`  not mapped to a capability: ${m.unmapped.length} record(s): ${[...new Set(m.unmapped.map(u => u.why))].join('; ')}\n`);
  write(`  qualified-for: none. ${m.qualification.why}\n`);
  write(`  definitions: ${METRIC_DEFINITIONS.map(d => d.id).join(', ')} (docs/knowledge-graph/slice-c1.md, "The metrics")\n`);
}

/** Run the command line: `argv` without the node and script names. Returns the exit code. */
export function run(argv, {write = s => process.stdout.write(s), env = process.env, snapshot = null} = {}) {
  const f = flags(argv), cmd = f._[0];
  const snap = snapshot ?? capabilitySnapshot(currentRegistries({argo: ARGO_SEATS}));
  if (cmd === 'snapshot') {
    if (f.json) write(JSON.stringify({...snap, records: undefined, index: undefined, counts: extractionCounts(snap)}, null, 2) + '\n'); else snapshotReport(snap, write);
    return 0;
  }
  if (cmd === 'decide') {
    if (!f.role) throw new Error('decide: --role is required');
    const mode = f.mode ?? 'automatic';
    const d = decide(snap, {role: f.role, mode, context: f.context === undefined ? null : Number(f.context), effort: f.effort ?? null, features: list(f.feature),
      delegation: f.delegation === undefined ? null : Number(f.delegation), avoid_labs: list(f['avoid-lab']), avoid: list(f.avoid), bubble: f.bubble ?? 'record',
      billing: {gemini_primary: f['gemini-primary'] === undefined ? null : f['gemini-primary'] === 'yes'},
      ...(mode === 'automatic' ? {} : {target: {vendor: f.vendor ?? null, model: f.model, transport: f.transport ?? null}})});
    if (f.json) write(JSON.stringify(d, null, 2) + '\n');
    else {
      write(`${d.explanation.join('\n')}\n  decision ${d.digest}\n  eligible: ${d.eligible.map(e => `${e.capability} [${e.lab}]`).join(', ') || 'none'}\n`);
      for (const x of d.excluded) write(`  excluded ${x.capability}: ${x.why.map(w => `${w.check}: ${w.why}`).join('; ')}\n`);
    }
    return 0;
  }
  if (cmd === 'metrics') {
    const spec = {boards: list(f.boards), runs: list(f.runs), practice: list(f.practice), workStages: list(f['work-stages']), workLedger: list(f['work-ledger']),
      transcripts: list(f.transcripts), geminiUsage: list(f['gemini-usage']), relayOutcomes: list(f['relay-outcomes'])};
    if (!Object.values(spec).some(v => v.length)) {
      const boards = path.join(pantheonHome(env), 'boards');
      if (fs.existsSync(boards)) spec.boards = [boards];
    }
    const m = extractMetrics(loadRecords(spec), {snapshot: snap});
    if (f.json) write(JSON.stringify({...m, synthetic: Boolean(f.synthetic)}, null, 2) + '\n'); else metricsReport(m, {synthetic: Boolean(f.synthetic)}, write);
    return 0;
  }
  write('usage: cli.mjs snapshot | decide --role R ... | metrics [--boards DIR] ... (see the header of pantheon/src/capability/cli.mjs)\n');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = run(process.argv.slice(2)); } catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 2; }
}
