// TARGETED REASSESSMENT OF WORK (knowledge graphs, Slice D part 1; KD1-5; demonstrations 2 and 7; docs/knowledge-graph/slice-d1.md).
//
// Purpose   Map a change onto the WORK graph: a change event (packages/graph `events`: a source observed changed,
//           unavailable or stale) or a Slice B impact (its seeds and affected nodes) -> the plans, units, tickets,
//           artifacts, QUALIFICATIONS (reviews, validations) and COMPLETION CLAIMS (unsigned outcome proposals) whose cited
//           evidence or requirements changed, each with why (its path from the change), RECORDED as a reassessment set: a
//           `derived` work/discovery of the registered reassessment rule, derived from what caused it. Unrelated work is
//           untouched: nothing outside the targeted closure is listed, invalidated, superseded or retracted.
// Inputs    An opened graph whose composition includes the work graph (ophanim/graph/work.mjs) beside the sources the
//           change is in (the repository, the capability graph, the status ledger, ...).
// Outputs   workReassessmentSet() (not recorded), reassessWork() (recorded); REASSESS_RULE.
// Must never  Claim completion (a completion claim resting on a changed input is UNSUPPORTED until re-checked; nothing here
//           is ever "complete"); invalidate, supersede or retract any work assertion; widen to work the change does not
//           reach; report a work fact of a source that cannot be read as current.
import {affected, parseId, entityId, assertion, RELATIONSHIPS, DEFAULTS, CEILINGS} from '../../packages/graph/index.mjs';
import {digest} from '../../packages/ledger/canonical.mjs';
import {CHANGE_TYPES} from './impact.mjs';

export const REASSESS_RULE = 'ophanim.reassess.rule';
export const REASSESS_ORIGIN = Object.freeze({kind: 'rule', basis: 'structural'});
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const kindOf = id => { try { const p = parseId(id); return `${p.domain}/${p.type}`; } catch { return null; } };
const keyOf = id => decodeURIComponent(parseId(id).key);
const isWork = id => kindOf(id)?.startsWith('work/') ?? false;
/** What each work entity is to a reassessment, and the status it is given. None of them is ever "complete". */
export const ROLES = Object.freeze({
  'work/plan': ['plan', 'stale: re-plan or re-validate against the changed input'],
  'work/work-unit': ['unit', 'stale with its plan'],
  'work/ticket': ['ticket', 're-derive from a re-validated plan'],
  'work/artifact': ['artifact', 'rests on an input to re-validate'],
  'work/review': ['qualification', 're-check: what it established rests on a changed input'],
  'work/validation': ['qualification', 're-check: what it established rests on a changed input'],
  'work/obligation': ['completion claim', 'unsupported until its chain is re-checked (not complete)'],
});
const roleOf = id => ROLES[kindOf(id)] ?? ['record', 'reassess'];
/** The relationships whose change reaches a work node: the change-carrying ones, and `verifies` (a check of a changed subject). */
const TYPES = Object.freeze([...CHANGE_TYPES, 'verifies']);
/** The dependent end of edge `e` when `n` changes (the registry's impact; a check of a changed subject for `verifies`), or null. */
function dependentOf(e, n) {
  if (e.type === 'verifies') return e.to === n ? e.from : null;
  const imp = RELATIONSHIPS[e.type]?.impact;
  if (imp === 'to->from') return e.to === n ? e.from : null;
  if (imp === 'from->to') return e.from === n ? e.to : null;
  return null;
}

/** What changed: {state, source, changed: Map(id -> {why, path}), coverage}. */
function changedBy(graph, input, bounds) {
  if (input.event) {
    const event = input.event, P = graph.projection;
    if (event.state === 'current') {
      const a = affected(P, event, {depth: bounds.depth ?? DEFAULTS.depth, maxNodes: bounds.maxNodes, maxEdges: bounds.maxEdges, types: [...CHANGE_TYPES]});
      if (a.unknown) return {state: 'current', source: event.source, changed: new Map(), coverage: {truncated: true}, unknown: a.why};
      const changed = new Map(a.nodes.map(n => [n.id, {why: n.path.length ? `reached from the change by ${n.path.map(p => p.type).join(' -> ')}` : 'changed by this observation',
        path: n.path.map(p => ({type: p.type, from: p.from, to: p.to}))}]));
      for (const s of a.seeds) if (!changed.has(s)) changed.set(s, {why: 'changed by this observation', path: []});
      return {state: 'current', source: event.source, changed, coverage: {truncated: a.coverage.truncated}};
    }
    // Unavailable or stale: the source's facts are as last observed; they cannot be re-checked.
    const view = graph.view(event.seq), changed = new Map();
    for (const s of view.subjects()) {
      if (s.includes('(') || s.includes('/evidence/source/')) continue;
      if (view.query(s, 'established').some(a => a.source.id === event.source && a.classification === 'authoritative')) changed.set(s, {why: `a fact of ${event.source}, which is ${event.state}: as last observed, not re-checked`, path: []});
    }
    return {state: event.state, source: event.source, changed, coverage: {truncated: false}};
  }
  const seeds = [...new Set([input.seeds ?? [], input.impact?.seeds ?? []].flat())];
  const changed = new Map(seeds.map(s => [s, {why: 'a changed seed', path: []}]));
  for (const n of Object.values(input.impact?.affected ?? {}).flat()) if (!changed.has(n.id)) changed.set(n.id, {why: `reached by impact: ${n.via.map(p => p.type).join(' -> ')}`, path: n.via.map(p => ({type: p.type, from: p.from, to: p.to}))});
  return {state: 'current', source: input.source ?? 'impact', changed, coverage: {truncated: Boolean(input.impact?.coverage?.truncated)}};
}

/**
 * The work reassessment set of `input` ({event} | {seeds, impact}): {state, members [{id, kind, role, status, why, path}],
 * roles, untouched, coverage, note}. Targeted: the work nodes a changed node reaches by an ESTABLISHED change-carrying
 * relationship (or a check of a changed subject), and from them, within the work domain only, what rests on them (a plan's
 * units and ticket, its artifact, the reviews and validations of that artifact, the completion claims on them). Bounded.
 */
export function workReassessmentSet(graph, input, bounds = {}) {
  const view = graph.view(input.event?.seq);
  const ch = changedBy(graph, input, bounds);
  const depth = Math.min(bounds.workDepth ?? 8, CEILINGS.depth), max = Math.min(bounds.maxNodes ?? DEFAULTS.maxNodes, CEILINGS.maxNodes);
  const unverifiable = ch.state !== 'current';
  const members = new Map();
  const visit = (id, why, path, d) => { if (!members.has(id) && members.size < max) { members.set(id, {id, why, path, depth: d}); return true; } return false; };
  // The start: work nodes that changed, and work nodes resting directly on a changed node.
  for (const [id, c] of ch.changed) {
    if (isWork(id)) visit(id, c.why, c.path, 0);
    for (const e of view.edgesOf(id, {mode: 'established', types: [...TYPES]})) {
      const dep = dependentOf(e, id);
      if (dep && isWork(dep)) visit(dep, `rests on ${keyOf(id)} (${e.type})`, [...c.path, {type: e.type, from: e.from, to: e.to}], 1);
    }
  }
  // Within the work domain, what rests on them.
  let frontier = [...members.values()].sort((a, b) => byString(a.id, b.id)), truncated = ch.coverage.truncated;
  for (let d = 1; frontier.length && d <= depth; d++) {
    const next = [];
    for (const m of frontier) for (const e of view.edgesOf(m.id, {mode: 'established', types: [...TYPES]})) {
      const dep = dependentOf(e, m.id);
      if (!dep || !isWork(dep) || members.has(dep)) continue;
      if (!visit(dep, `rests on ${keyOf(m.id)} (${e.type})`, [...m.path, {type: e.type, from: e.from, to: e.to}], d + 1)) { truncated = true; continue; }
      next.push(members.get(dep));
    }
    frontier = next.sort((a, b) => byString(a.id, b.id));
    if (d === depth && frontier.length) truncated = true;
  }
  const rows = [...members.values()].sort((a, b) => a.depth - b.depth || byString(a.id, b.id)).map(m => {
    const [role, status] = roleOf(m.id);
    return {id: m.id, kind: kindOf(m.id), role, status: unverifiable ? `unverifiable: ${ch.source} is ${ch.state}` : status, why: m.why, path: m.path};
  });
  const work = view.subjects().filter(s => isWork(s) && view.nodeIn(s, 'established'));
  const roles = {};
  for (const r of rows) roles[r.role] = (roles[r.role] ?? 0) + 1;
  return {state: ch.state, source: ch.source, members: rows, roles, untouched: work.filter(s => !members.has(s)).length,
    coverage: {truncated, depth, maxNodes: max, changed: ch.changed.size, unknown: ch.unknown ?? null},
    note: unverifiable ? `${ch.source} is ${ch.state}: its work facts, and what rests on them, cannot be re-checked; none is reported current`
      : 'targeted: only the work an established change-carrying relationship reaches from the change; every other work item is untouched'};
}

export const reassessmentId = key => entityId({domain: 'work', type: 'discovery', key});
const BYTES = 24_000, MAX = 200;
/**
 * RECORD the work reassessment set of `input` as a derived work/discovery of the reassessment rule. Its inputs: the
 * source observation that caused it (an event), or the established assertions of the impact's seeds. It states
 * `completion: 'not claimed'`, its members while they fit 24 KB, their total and the digest of every member's id. It
 * writes nothing else: no work assertion is invalidated, superseded or retracted. Returns {recorded, id, subject, set}.
 */
export function reassessWork(graph, input, {by, observed_at = new Date().toISOString(), bounds = {}} = {}) {
  const set = workReassessmentSet(graph, input, bounds), view = graph.view(input.event?.seq);
  let inputs, key, trigger;
  if (input.event) {
    const e = input.event;
    const obs = view.query(entityId({domain: 'evidence', type: 'source', key: e.source}), 'recorded').filter(a => a.admitted === e.seq).at(-1);
    if (!obs) throw Object.assign(new Error(`event ${e.key} is not a source observation of this graph`), {code: 'GRAPH_REFUSED'});
    inputs = [obs.id]; key = `reassess-work/event/${e.seq}`;
    trigger = {event: {seq: e.seq, key: e.key, source: e.source, state: e.state, from_version: e.from_version ?? null, to_version: e.to_version ?? null}};
  } else {
    const seeds = [...new Set([input.seeds ?? [], input.impact?.seeds ?? []].flat())].sort(byString);
    inputs = [...new Set(seeds.flatMap(s => view.query(s, 'established').map(a => a.id)))].sort(byString).slice(0, 1000);
    if (!inputs.length) throw Object.assign(new Error('a reassessment rests on an established seed'), {code: 'GRAPH_REFUSED'});
    key = `reassess-work/seeds/${digest(seeds).slice(0, 32)}`;
    trigger = {seeds: seeds.slice(0, 32), source: input.source ?? 'impact'};
  }
  const members = [];
  let bytes = 0;
  for (const m of set.members) {
    const row = {id: m.id, role: m.role, status: m.status, why: String(m.why).slice(0, 200)}, n = Buffer.byteLength(JSON.stringify(row));
    if (members.length >= MAX || bytes + n > BYTES) break;
    members.push(row); bytes += n;
  }
  const record = assertion({entity: reassessmentId(key), origin: REASSESS_RULE, classification: 'derived', observed_at, inputs, status: 'unverified',
    source: {id: 'ophanim.reassess', authority: 'the work reassessment rule (ophanim/graph/reassess.mjs): derived from a change event or an impact', ref: input.event?.key ?? key,
      version: input.event ? inputs[0] : 'sha256:' + digest(inputs)},
    missing_evidence: set.state === 'current' ? [] : [`${set.source} is ${set.state}: the work resting on it cannot be re-checked until it is observed current`],
    attributes: {...trigger, members, total: set.members.length, members_digest: 'sha256:' + digest(set.members.map(m => m.id).sort(byString)), roles: set.roles,
      untouched: set.untouched, truncated: members.length < set.members.length || set.coverage.truncated, completion: 'not claimed', note: set.note}});
  const w = graph.assert([record], by);
  return {recorded: Boolean(w.appended) || w.duplicates.includes(record.id), id: record.id, subject: record.subject, set};
}
