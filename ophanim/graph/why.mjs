// WHY A COMPONENT EXISTS (knowledge graphs, Slice D part 1; KD1-6; the directive's section 10: OPHANIM is its own first
// built system; docs/knowledge-graph/slice-d1.md).
//
// Purpose   For a component, the requirement and the decision that introduced it, from what the sources STATE, joined
//           across sources by Slice B's cross-source join rule (docs/knowledge-graph/slice-b.md section 12): a registered
//           rule that admits `derived` introduced-because-of with its inputs, each join labelled with its basis:
//             ticket slot     a ticket names the path as its slot (Slice B's `implements`), the ticket names its item, and
//                             the status ledger states the item under the same id
//             plan slice      a passed plan of the work ledger names the path as one of its slices; the plan's item and the
//                             prompt the intake recorded the item from
//             commit message  the commit that INTRODUCED the path (its first commit in the ancestry, Slice B's structural
//                             `derived-from`) names a register id (L-nnn, KG-n) in its message, and the register defines it
//           A link no source states is a GAP, as Slice B's traceability reports it: never filled by resemblance.
// Inputs    A graph view composed of Slice B's sources (the repository, the register's records, the status ledger) and,
//           where there is one, the work graph.
// Outputs   whyJoins(), recordWhy() (the rule's derived assertions), whyExists() (the answer); WHY_RULE.
// Must never  Fill a gap by inference or resemblance; admit a join from a textual mention (a register entry that NAMES a
//           file is listed as textual, never as the reason it exists).
import {parseId, assertion} from '../../packages/graph/index.mjs';
import {digest} from '../../packages/ledger/canonical.mjs';
import {recordId, ENTRY_ID} from './extract/records.mjs';

export const WHY_RULE = 'ophanim.why.rule';
/** DECLARED: a join on an identity both sources state, never on similar text. */
export const WHY_ORIGIN = Object.freeze({kind: 'rule', basis: 'declared'});
export const REQUIREMENT_KINDS = Object.freeze(['ticket', 'status item', 'plan slice', 'prompt']);
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const kindOf = id => { try { const p = parseId(id); return `${p.domain}/${p.type}`; } catch { return null; } };
const keyOf = id => decodeURIComponent(parseId(id).key);
const sourceOf = a => ({source: a.source.id, version: a.source.version, ref: a.source.ref, assertion: a.id, classification: a.classification});
const established = (view, id) => view.query(id, 'established');
const out = (view, id, types) => view.edgesOf(id, {mode: 'established', types}).filter(e => e.from === id);

/** The commits of the ancestry that changed `subject`, oldest first (Slice B's structural `derived-from`). */
export function commitsOf(view, subject) {
  return out(view, subject, ['derived-from']).filter(e => kindOf(e.to) === 'systems/change')
    .map(e => ({id: e.to, edge: e, ...view.node(e.to).attributes})).sort((a, b) => byString(a.date ?? '', b.date ?? '') || byString(a.id, b.id));
}

/**
 * The cross-source joins that state why `subject` exists: [{to, kind, join, basis, inputs, sources}]. Each input is an
 * established assertion that states one side of the join.
 */
export function whyJoins(view, subject) {
  const joins = new Map(), add = j => { if (!joins.has(j.to)) joins.set(j.to, {...j, inputs: [...new Set(j.inputs)].sort(byString)}); };
  const statusOf = item => established(view, item).filter(a => a.source.id === 'ophanim.status');
  // A ticket names it as its slot; the ticket names its item; the status ledger states the item.
  for (const e of out(view, subject, ['implements']).filter(x => kindOf(x.to) === 'work/ticket')) {
    add({to: e.to, kind: 'ticket', basis: 'declared', join: 'the ticket names this path as its slot', inputs: e.assertions});
    for (const d of out(view, e.to, ['depends-on']).filter(x => kindOf(x.to) === 'work/item')) {
      const st = statusOf(d.to);
      if (!st.length) continue;
      add({to: d.to, kind: 'status item', basis: 'declared', inputs: [...e.assertions, ...d.assertions, ...st.map(a => a.id)],
        join: 'the ticket names this path as its slot and names its item; the status ledger states the item under the same id'});
    }
  }
  // A passed plan of the work ledger names it as a slice; the plan's item; the prompt that introduced the item.
  const p = kindOf(subject)?.startsWith('systems/') ? keyOf(subject) : null;
  if (p) for (const plan of view.subjects().filter(s => kindOf(s) === 'work/plan' && view.nodeIn(s, 'established')).sort(byString)) {
    const a = view.node(plan).attributes;
    if (!(a.slices ?? []).some(s => s.path === p)) continue;
    const planAs = established(view, plan).map(x => x.id), item = out(view, plan, ['derived-from']).find(e => kindOf(e.to) === 'work/item');
    if (!item) continue;
    add({to: item.to, kind: 'plan slice', basis: 'declared', inputs: [...planAs, ...item.assertions],
      join: `a passed plan of the work ledger (${keyOf(plan)}) names this path as a slice of its item`});
    for (const q of out(view, item.to, ['introduced-because-of']).filter(x => kindOf(x.to) === 'work/prompt')) {
      add({to: q.to, kind: 'prompt', basis: 'declared', inputs: [...planAs, ...item.assertions, ...q.assertions],
        join: 'the intake recorded the item the plan was made for from this prompt'});
    }
  }
  // The commit that introduced it names a register id; the register defines it.
  const first = commitsOf(view, subject)[0] ?? null;
  if (first) for (const id of [...new Set(String(first.subject ?? '').match(ENTRY_ID) ?? [])].sort(byString)) {
    const rec = recordId(id);
    if (!view.nodeIn(rec, 'established')) continue;
    add({to: rec, kind: 'register entry', basis: 'declared', inputs: [...first.edge.assertions, ...established(view, first.id).map(a => a.id), ...established(view, rec).map(a => a.id)],
      join: `the commit that introduced it (${String(first.commit ?? keyOf(first.id)).slice(0, 12)}) names ${id} in its message; the register defines ${id}`});
  }
  return [...joins.values()].map(j => ({...j, sources: j.inputs.map(id => view.assertion(id)).filter(Boolean).map(sourceOf)}));
}

/** RECORD each join as a derived introduced-because-of of the join rule (inputs: the assertions that state it). */
export function recordWhy(graph, subject, by, {observed_at = new Date().toISOString()} = {}) {
  const view = graph.view(), records = whyJoins(view, subject).map(j => assertion({type: 'introduced-because-of', from: subject, to: j.to, origin: WHY_RULE,
    classification: 'derived', observed_at, inputs: j.inputs,
    source: {id: 'ophanim.why', authority: 'the cross-source join rule (ophanim/graph/why.mjs; slice-b.md section 12): a stated identity both sources state', ref: `${keyOf(subject)} <- ${j.kind}`,
      version: 'sha256:' + digest(j.inputs)},
    attributes: {kind: j.kind, join: j.join, basis: j.basis}}));
  return records.length ? graph.assert(records, by) : {appended: false, ids: [], duplicates: []};
}

/**
 * WHY `subject` EXISTS: the requirement(s) and decision(s) that introduced it, its introducing commit, and the joins the
 * rule has recorded (established, or stale once an input is withdrawn), each with its basis and sources; register
 * entries that only NAME it, listed apart as textual; and every category no source fills, as a gap.
 */
export function whyExists(view, subject) {
  if (!view.nodeIn(subject, 'possible')) return {error: 'NOT_FOUND', why: `${subject} is not in the graph at cursor ${view.seq}`};
  const joins = whyJoins(view, subject), gaps = [];
  const requirements = joins.filter(j => REQUIREMENT_KINDS.includes(j.kind));
  const decisions = joins.filter(j => j.kind === 'register entry').map(j => ({...j, entry: keyOf(j.to).replace(/^register\//, ''), status: view.node(j.to).attributes.status ?? null,
    decisions: (view.node(j.to).attributes.decisions ?? []).length}));
  const commits = commitsOf(view, subject);
  // Recorded joins: what the rule admitted, and whether it still stands (a withdrawn input makes it stale, not established).
  const recorded = view.edgesOf(subject, {mode: 'possible', types: ['introduced-because-of']}).filter(e => e.from === subject)
    .map(e => ({to: e.to, established: e.assertions.some(id => view.established(id)), assertions: e.assertions.map(id => ({...sourceOf(view.assertion(id)), origin: view.assertion(id).origin,
      why: view.established(id) ? null : view.query(e.subject, 'possible').find(q => q.id === id)?.why ?? 'not established'}))}));
  // TEXTUAL, apart: register entries that name it.
  const register = view.edgesOf(subject, {mode: 'possible', types: ['mentions']}).map(e => (e.from === subject ? e.to : e.from)).filter(n => kindOf(n) === 'evidence/record')
    .sort(byString).map(n => ({id: n, status: view.node(n).attributes.status ?? null, decisions: (view.node(n).attributes.decisions ?? []).length,
      basis: 'textual: the text names it; not a statement that it introduced or decided it'}));
  if (!requirements.length) gaps.push({category: 'requirement', why: 'no source states the requirement that introduced it: no ticket or plan names it as its slot, and no status item or prompt is joined to it'});
  if (!decisions.length) gaps.push({category: 'decision', why: 'no decision is stated for it: the commit that introduced it names no register entry the register defines'});
  if (!commits.length) gaps.push({category: 'commits', why: 'no commit of the ancestry changed this path under this name (a rename is not followed)'});
  const used = new Set([...joins.flatMap(j => j.sources.map(s => s.source)), ...view.node(subject).assertions.map(a => a.source.id)]);
  return {query: 'why-exists', cursor: view.seq, subject, requirements, decisions,
    introduced_by: commits[0] ? {id: commits[0].id, commit: commits[0].commit ?? null, date: commits[0].date ?? null, subject: commits[0].subject ?? null} : null,
    recorded, textual: {register}, gaps, sources: [...used].sort(byString),
    note: 'every requirement and decision is a JOIN on an identity both sources state, labelled with its basis; a category no source fills is a gap, never filled by resemblance'};
}
