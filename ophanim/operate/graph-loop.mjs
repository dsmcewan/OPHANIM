// THE GRAPH IN THE FOUNDRY'S LOOP (knowledge graphs, Slice D part 2; KD2-1 to KD2-8; docs/knowledge-graph/slice-d2.md).
//
// Purpose   Make the work and learning graphs (Slice D part 1) part of the recurring loop the scheduler runs (directive
//           section 9: Observe -> Explore -> Investigate -> Determine Needs and Dependencies -> Plan -> Construct or
//           Operate -> Verify -> Learn and Reassess), never a passive index:
//             - the CURSOR (KD2-1): the graph ledger's head and its sources' observed versions, in the scheduler's input
//               signature, so a graph change wakes a tick; the graph opened from a signed snapshot once per tick, never
//               re-derived in full; the work source observed after a tick appends (idempotent: a repeated observation is
//               a no-op);
//             - the GATES (KD2-2): per item, the graph-derived input earliestGate reads (gates.mjs withGraph): a stage
//               after the plan is BLOCKED while the plan requires a prerequisite the graph shows MISSING (only an
//               ESTABLISHED requirement blocks; a hypothetical one is advisory), with the prerequisite's id and the plan
//               line; UNLOCKED when it is established; a prerequisite cycle is reported and refused, never looped; the
//               prerequisite's own work (a plan that IMPLEMENTS it) is not blocked and the others wait for it;
//             - the PLANNER (KD2-3): the version of each typed requirement (requirementState), the reassessment sets
//               (D1's reassessWork, recorded on each observation event) mapped onto planValidity and validationEvidence;
//             - TEAM PROPOSALS (KD2-4): the seven queries of directive section 5, recorded beside the live seat
//               selection, which is unchanged (owner decision 2026-11-20: "Keep the seats as we have them for now");
//             - WRITE-BACK (KD2-5): attempts update the work graph by observation; a discovery becomes an intake CANDIDATE
//               or a PROPOSAL to the coordinator, written as a record: never executed, never an edit of the lessons
//               registry or the register;
//             - BOUNDS (KD2-6): one snapshot open per tick, Slice A's traversal defaults, at most LOOP_BOUNDS.events
//               events reassessed per tick, no agent and no provider request caused by the graph.
// Inputs    createGraphLoop(config): the graph ledger (dir, anchor), its origin registry, a function composing its source
//           adapters (loopSources), the snapshot directory with its PINNED keys and signer, the writers of its registered
//           extractors and rules, and the operate state directory where candidates and proposals are recorded. Which keys
//           those are is the owner's decision (KG-4): this file names none; tests pass SYNTHETIC keys.
// Outputs   The loop handle the scheduler takes as `graph` (tick, watch, inputSignature); requirementState; teamProposal;
//           learningProposal; claimedPaths.
// Must never  Override the authoritative ledgers (it reads the work ledger and writes only the graph ledger, its snapshots
//           and unsigned records); execute a discovery; edit ophanim/lessons/** or docs/OPEN-LIMITATIONS.md; change a live
//           seat; merge two items because they share a prerequisite; spawn an agent or make a provider request; loop on a
//           prerequisite cycle.
import fs from 'node:fs';
import path from 'node:path';
import {openGraph, writeSnapshot, entityId, parseId, DEFAULTS} from '../../packages/graph/index.mjs';
import {digest} from '../../packages/ledger/canonical.mjs';
import {existenceOf, planId, recordSharedPrerequisites, NAMING_SOURCES, WORK_GRAPH_SOURCE, requirementsOf as d1Requirements} from '../graph/work.mjs';
import {workReassessmentSet, reassessWork, reassessmentId} from '../graph/reassess.mjs';
import {learningReuse} from '../graph/learning.mjs';
import {sourcesOf, WORK_SOURCE} from '../graph/extract/index.mjs';
import {GRAPH_ABSENT, graphRequiresOf, requirementOf, requirementDigest, requirableRefusal} from './gates.mjs';
import {defaultSnapshot, decisionFor} from '../../pantheon/src/capability/advisory.mjs';
import {requirementsOf as capabilityRequirements} from '../../pantheon/src/capability/eligibility.mjs';

export const GRAPH_LOOP_SCHEMA = 'ophanim.graph-loop/v1';
export const CANDIDATE_SCHEMA = 'ophanim.graph-candidate/v1';
export const PROPOSAL_SCHEMA = 'ophanim.coordinator-proposal/v1';
export const TEAM_PROPOSAL_SCHEMA = 'ophanim.team-proposal/v1';
/**
 * THE PER-TICK BOUNDS (KD2-6; directive section 12). Traversals use Slice A's defaults (packages/graph DEFAULTS: depth
 * 4, 500 nodes, 2000 steps); at most `events` change events are reassessed per tick (the rest the next tick, and the
 * report says so); a team proposal names at most `team` capabilities per role and `learning` components.
 */
export const LOOP_BOUNDS = Object.freeze({events: 64, requirements: 32, team: 5, learning: 2, paths: 64, traversal: DEFAULTS});
export {GRAPH_ABSENT};
/** The relationships by which a plan requires a prerequisite (D1 requirementsOf). */
const REQ_TYPES = Object.freeze(['requires-capability', 'depends-on']);
/** The work sources: their own events are the lifecycle's own consequences, never evidence against a plan. */
const WORK_SOURCES = Object.freeze([WORK_GRAPH_SOURCE, WORK_SOURCE]);
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cut = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const kindOf = id => { try { const p = parseId(id); return `${p.domain}/${p.type}`; } catch { return null; } };
const keyOf = id => decodeURIComponent(parseId(id).key);
const hashOfKey = key => (/^[0-9a-f]{64}$/.test(key) ? `sha256:${key}` : null);
const lastLine = f => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').at(-1) ?? ''; } catch { return ''; } };

/**
 * The adapters of a loop's graph: Slice D part 1's work graph over the work ledger at `workRoot` (its anchor read from the
 * ledger, the ledger opened READ ONLY by the source), plus the repository-backed sources named in `only` at HEAD, resolved
 * ONCE per composition (so each tick's open names the commit it observes), plus `extra` adapters.
 */
export function loopSources({repo, workRoot, only = [WORK_GRAPH_SOURCE], extra = [], lessons = false, deps = false} = {}) {
  let anchor = null;
  try { anchor = fs.readFileSync(path.join(workRoot, 'ANCHOR'), 'utf8').trim() || null; } catch { anchor = null; }
  const {sources} = sourcesOf({repo, status: null, work: anchor ? {root: path.resolve(workRoot), anchor} : null, lessons, deps, only});
  return [...sources, ...extra];
}

/**
 * THE STATE OF A REQUIREMENT in a view: whether a source other than the plans that name it states that it exists (D1
 * existenceOf) and its VERSION: the digest of what those sources state about it (its own established assertions and the
 * assertions that establish it), or GRAPH_ABSENT when nothing does. A plan binds each typed requirement to this version.
 */
export function requirementState(view, id) {
  const ex = existenceOf(view, id);
  if (!ex.exists) return {id, exists: false, version: GRAPH_ABSENT, basis: null, by: [], gap: ex.gap, established_at: null};
  const own = view.query(id, 'established').filter(a => !NAMING_SOURCES.includes(a.source.id)).map(a => a.id).sort(byString);
  const via = [...new Set(ex.sources.map(s => s.assertion))].sort(byString);
  const at = Math.max(0, ...via.map(x => view.assertion(x)?.admitted ?? 0));
  return {id, exists: true, version: 'sha256:' + digest({id, own, via, by: ex.by}), basis: ex.basis, by: ex.by.slice(0, 16), gap: null, established_at: at || null};
}

/** The paths an item's plan claims (its slices and its units' owned paths), as the graph's plan and unit nodes state them. */
export function claimedPaths(view, plan) {
  if (!view.nodeIn(plan, 'established')) return null;
  const out = new Set((view.node(plan).attributes.slices ?? []).map(s => s?.path).filter(p => typeof p === 'string'));
  for (const e of view.edgesOf(plan, {mode: 'established', types: ['derived-from']})) {
    if (e.to !== plan || kindOf(e.from) !== 'work/work-unit') continue;
    for (const p of view.node(e.from).attributes.owned_paths ?? []) if (typeof p === 'string') out.add(p);
  }
  return [...out].sort(byString).slice(0, LOOP_BOUNDS.paths);
}
const overlaps = (a, b) => a.some(x => b.some(y => x === y || x.startsWith(y.replace(/\*+$/, '')) && y.endsWith('*') || y.startsWith(x.replace(/\*+$/, '')) && x.endsWith('*')));

/**
 * The item-level waits a prerequisite creates, and their cycles: item B waits for item A when B's current plan requires a
 * MISSING prerequisite that A's current plan implements; a status dependency is a wait too. A cycle with at least one
 * graph wait is a PREREQUISITE CYCLE: reported and refused, never looped (and never broken silently).
 */
function waitCycles(waits, statusDeps) {
  const next = n => [...new Set([...(waits.get(n) ?? []).map(w => w.on), ...(statusDeps.get(n) ?? [])])].sort(byString);
  const graphEdge = (a, b) => (waits.get(a) ?? []).some(w => w.on === b);
  const nodes = [...new Set([...waits.keys(), ...statusDeps.keys()])].sort(byString);
  const color = new Map(), stack = [], cycles = [];
  const visit = n => {
    color.set(n, 1); stack.push(n);
    for (const m of next(n)) {
      if (cycles.length >= 50) break;
      if (color.get(m) === 1) {
        const c = stack.slice(stack.indexOf(m));
        if (c.some((x, i) => graphEdge(x, c[(i + 1) % c.length]))) cycles.push(c);
      } else if (!color.has(m)) visit(m);
    }
    stack.pop(); color.set(n, 2);
  };
  for (const n of nodes) if (!color.has(n)) visit(n);
  return cycles;
}

/**
 * The loop handle. `config`: {dir, anchor, origins, sources: () => adapters, snapshot: {dir, keys, signer} | null,
 * writers: {extractor: {signer, order}, rule: {signer, order}}, observe: [source ids observed at a tick's start] (the
 * work sources are always observed after an append), stateDir (where candidates and proposals are recorded),
 * observed_at: () => ISO time}.
 */
export function createGraphLoop(config) {
  const {dir, anchor, origins, sources, snapshot = null, writers = null, observe = [], stateDir = null, workRoot = null} = config ?? {};
  // `bounds` (optional): a LOWER per-tick bound than LOOP_BOUNDS (never a higher one).
  const bounds = Object.fromEntries(Object.entries(LOOP_BOUNDS).map(([k, v]) => [k, Number.isInteger(config?.bounds?.[k]) && config.bounds[k] >= 0 ? Math.min(v, config.bounds[k]) : v]));
  if (!dir || !path.isAbsolute(dir) || !anchor || !origins || typeof sources !== 'function') throw Object.assign(new Error('createGraphLoop: {dir (absolute), anchor, origins, sources()} are required'), {code: 'USAGE'});
  const now = config.observed_at ?? (() => new Date().toISOString());
  let graph = null, cache = null, cursorCache = null, lastSnapshot = null, lastShared = null;
  const stats = {opens: 0, opened: [], observations: [], recorded: {reassessments: 0, findings: 0, candidates: 0, proposals: 0}, events: {considered: 0, deferred: 0}, ms: {open: 0, prepare: 0, observe: 0, snapshot: 0}};
  const timed = (k, f) => { const t = process.hrtime.bigint(); try { return f(); } finally { stats.ms[k] += Number(process.hrtime.bigint() - t) / 1e6; } };
  const doOpen = () => openGraph({dir, anchor, origins, sources: sources(), lockTimeoutMs: 60_000, ...(snapshot ? {snapshot: {dir: snapshot.dir, keys: snapshot.keys}} : {})});

  /** THE ONE OPEN OF A TICK (KD2-1, KD2-6): from the newest acceptable signed snapshot, else in full (and the record says why). */
  function open() {
    graph = timed('open', doOpen);
    workLine = null; freshSets = 0;
    const s = graph.verification.snapshot ?? null;
    stats.opens++;
    if (s?.used) lastSnapshot = s.seq;      // a snapshot at this seq exists: the end of the tick writes one only if the graph moved
    stats.opened.push({mode: s?.used ? 'snapshot' : 'full', seq: graph.view().seq, rederived: graph.verification.rederived, snapshot_seq: s?.used ? s.seq : null, reason: s?.used ? null : s?.reason ?? 'no snapshot directory is configured'});
    cache = null;
    return graph;
  }
  // The graph as last opened (or refreshed by cursor()); opened here, uncounted, for a caller outside a tick (a signature).
  const current = () => graph ?? (graph = timed('open', doOpen));

  /** Observe registered sources (bounded: one observation each); a source already observed at its version is a no-op. */
  function observeSources(ids) {
    const g = current(), out = [];
    if (!writers?.extractor) return out;
    timed('observe', () => {
      for (const id of ids) {
        if (!g.projection.adapters.has(id)) continue;
        const r = g.observe(id, {...writers.extractor, observed_at: now()});
        const row = {source: id, recorded: r.recorded, state: r.state ?? null, version: r.record?.source.version ?? null, why: r.recorded ? null : r.why};
        out.push(row); stats.observations.push(row);
      }
    });
    if (out.some(r => r.recorded)) cache = null;
    return out;
  }
  /** THE WRITE-BACK (KD2-1, KD2-5): after the work ledger is appended, the work graph observes it. Idempotent. */
  // `workRoot` (optional): the work ledger's root; its head line is compared first, so an unchanged ledger is not re-verified.
  let workLine = null;
  const observeWork = () => {
    const line = workRoot ? lastLine(path.join(workRoot, 'chain.jsonl')) : null;
    if (line && line === workLine && graph) return WORK_SOURCES.filter(id => graph.projection.adapters.has(id)).map(id => ({source: id, recorded: false, state: null, version: null, why: 'the work ledger\'s head is the one this loop last observed'}));
    const out = observeSources(WORK_SOURCES);
    workLine = line;
    return out;
  };

  /** The cursor the input signature carries (KD2-1): the graph ledger head and every source's observed version. */
  function cursor() {
    const line = lastLine(path.join(dir, 'chain.jsonl'));
    if (cursorCache?.line === line) return cursorCache.cursor;
    let g = graph;
    if (!g) g = graph = timed('open', doOpen);
    else g.refresh();
    const v = g.view();
    const c = {schema: GRAPH_LOOP_SCHEMA, anchor, seq: v.seq, head: v.head, sources: v.sources().map(s => [s.id, s.state, s.version])};
    cursorCache = {line, cursor: c};
    return c;
  }

  /** Write a signed snapshot when the graph moved since the last one (KD2-1: the next tick opens from it). */
  function checkpoint() {
    if (!graph || !snapshot?.signer) return null;
    const seq = graph.view().seq;
    if (!seq || seq === lastSnapshot) return null;
    const w = timed('snapshot', () => writeSnapshot(graph, {dir: snapshot.dir, signer: snapshot.signer, retain: 2}));
    lastSnapshot = seq;
    return {seq: w.seq, bytes: w.bytes};
  }

  // ---- the graph-derived input of the gates (KD2-2, KD2-3) -------------------------------------------------------------
  /** The relevant observation events and the work records each reassessment set reached (D1 reassessWork, KD2-3). */
  // The reassessment set of each event, by its seq: a set is computed at the event's own cursor, so it never changes.
  const sets = new Map();
  let freshSets = 0;                          // sets computed since this tick's open: at most bounds.events
  /**
   * The relevant observation events and the work records each reassessment set reached (D1 reassessWork, KD2-3): every
   * observation of a source other than the work graph (the lifecycle's own records are not evidence against a plan)
   * that changed a source already observed (a first observation introduces it). Each set is RECORDED once when the
   * context writes; at most LOOP_BOUNDS.events sets are computed per tick (one open; the rest the next tick, counted).
   * A plan reached only through its requirement of a prerequisite it cited as MISSING is not made stale by it: that
   * prerequisite being established is the gate's UNLOCK (analyzePlan), not a change of what the plan rested on.
   */
  function reassessments(g, write, docOf) {
    const view = g.view(), out = new Map(), events = [];
    for (let after = 0; ;) {
      const page = g.events({after, limit: 1000});
      for (const e of page.events) if (e.source !== 'graph' && !WORK_SOURCES.includes(e.source) && e.from_version !== null && e.from_version !== undefined) events.push(e);
      if (!page.more) break;
      after = page.cursor;
    }
    stats.events.considered = events.length;
    stats.events.deferred = 0;
    for (const e of events) {
      let members = sets.get(e.seq);
      if (!members) {
        if (freshSets >= bounds.events) { stats.events.deferred++; continue; }
        freshSets++;
        members = workReassessmentSet(g, {event: e}).members.map(m => ({id: m.id, why: m.why, path: m.path}));
        sets.set(e.seq, members);
      }
      if (write && writers?.rule && members.length && !view.query(reassessmentId(`reassess-work/event/${e.seq}`), 'recorded').length) {
        const r = reassessWork(g, {event: e}, {by: writers.rule, observed_at: now()});
        if (r.recorded) stats.recorded.reassessments++;
      }
      for (const m of members) {
        const k = kindOf(m.id);
        if (k !== 'work/plan' && k !== 'work/validation') continue;
        const h = hashOfKey(keyOf(m.id));
        if (!h) continue;
        const last = m.path.at(-1);
        if (k === 'work/plan' && last && REQ_TYPES.includes(last.type) && last.from === m.id
          && graphRequiresOf(docOf(h)).some(r => r.id === last.to && r.version === GRAPH_ABSENT)) continue;
        if (!out.has(h)) out.set(h, []);
        out.get(h).push({key: `reassess-work/event/${e.seq}`, event: e.key, why: cut(`${e.source} changed (event ${e.seq}, ${e.key}): ${m.why}`, 300)});
      }
    }
    return out;
  }

  /**
   * prepare({items, byItem, stagesOf}) -> the gates' graph-derived inputs for this reconciliation: per item its current
   * plan's analysis, the version of each requirement, the reassessments, the waits and cycles, the shared prerequisites
   * and the candidates. With `write`, the discoveries are RECORDED (D1's shared-prerequisite findings and reassessment
   * sets on the graph ledger; candidates as unsigned records), each once.
   */
  function context({write = false} = {}) {
    return {
      prepare({items = [], byItem = new Map(), stagesOf = () => []} = {}) {
        const g = current(), all = stagesOf();
        const key = `${g.view().seq}|${all.at(-1)?.hash ?? ''}|${all.length}|${items.map(i => i.item + '@' + i.entry).join(',')}|${write}`;
        if (cache?.key === key) return cache.value;
        const value = timed('prepare', () => build(g, {items, byItem, stagesOf, write}));
        cache = {key: `${g.view().seq}|${all.at(-1)?.hash ?? ''}|${all.length}|${items.map(i => i.item + '@' + i.entry).join(',')}|${write}`, value};
        return value;
      },
    };
  }

  function build(g, {items, byItem, stagesOf, write}) {
    const states = new Map();
    const stateOf = id => { if (!states.has(id)) states.set(id, requirementState(g.view(), id)); return states.get(id); };
    // The current plan of each item: its latest passed plan for its present requirement.
    const current = new Map();
    for (const s of items) {
      const req = requirementOf(byItem.get(s.item) ?? [s]);
      const want = req ? requirementDigest(req) : null;
      const p = [...stagesOf(s.item)].reverse().find(x => x.stage === 'plan' && x.status === 'passed' && x.identity?.requirement === want) ?? null;
      if (p) current.set(s.item, p);
    }
    // Who requires and who implements each prerequisite (the plans' own declarations, the work ledger's records).
    const requiring = new Map();
    for (const [item, p] of current) for (const r of graphRequiresOf(p.outputs?.plan)) {
      if (requirableRefusal(r.id)) continue;          // a malformed id is no requirement the graph can hold
      if (!requiring.has(r.id)) requiring.set(r.id, []);
      requiring.get(r.id).push({item, implements: r.implements, line: r.line, why: r.why});
    }
    const implementers = (id, except = null) => [...new Set((requiring.get(id) ?? []).filter(x => x.implements && x.item !== except).map(x => x.item))].sort(byString);
    // The waits: B waits for A when B requires a missing prerequisite that A implements.
    const waits = new Map(), statusDeps = new Map(items.map(s => [s.item, (s.depends_on ?? []).filter(d => current.has(d) || items.some(i => i.item === d))]));
    for (const [id, rows] of requiring) {
      if (stateOf(id).exists) continue;
      for (const r of rows) if (!r.implements) for (const a of implementers(id, r.item)) {
        if (!waits.has(r.item)) waits.set(r.item, []);
        waits.get(r.item).push({on: a, prerequisite: id});
      }
    }
    const cycles = waitCycles(waits, statusDeps);
    const inCycle = new Map();
    for (const c of cycles) for (const m of c) if (!inCycle.has(m)) inCycle.set(m, c);
    const records = new Map(stagesOf().filter(x => x.stage === 'plan').map(x => [x.hash, x]));
    const reassessed = reassessments(g, write, h => records.get(h)?.outputs?.plan ?? null);
    // The analysis of one plan record (memoized): the block, the unlock, the basis of the attempt identity.
    const analyses = new Map();
    const analyze = (item, rec) => {
      if (!rec) return null;
      if (analyses.has(rec.hash)) return analyses.get(rec.hash);
      const a = analyzePlan(g.view(), {item, rec, stateOf, implementers, cycle: inCycle.get(item) ?? null, candidateOf});
      analyses.set(rec.hash, a);
      return a;
    };
    // The candidates: a missing prerequisite that some current plan requires by an established relationship and no
    // current plan implements (KD2-2, KD2-5): once per prerequisite, whatever the number of requiring items.
    const candidates = [];
    const candidateOf = id => `graph:prerequisite/${digest(id).slice(0, 32)}`;
    for (const [id, rows] of [...requiring].sort((x, y) => byString(x[0], y[0]))) {
      const s = stateOf(id);
      if (s.exists || implementers(id).length) continue;
      const needing = [...new Set(rows.filter(r => !r.implements && g.view().edgesOf(planId(current.get(r.item).hash), {mode: 'established', types: REQ_TYPES}).some(e => e.to === id)).map(r => r.item))].sort(byString);
      if (!needing.length) continue;
      candidates.push({ref: candidateOf(id), prerequisite: id, kind: kindOf(id), items: needing, gap: s.gap,
        why: cut(`a prerequisite the graph shows MISSING (${s.gap}), required by ${needing.join(', ')} and implemented by no item's plan: an intake candidate for the owner to classify; never executed without an owner-signed status entry`, 600)});
    }
    // D1's shared-prerequisite findings are RECORDED by its own rule (a scan of every plan the graph holds): once per loop
    // (a tick) and again only when the current plans' requirements or their existence changed (KD2-6: bounded).
    const sharedKey = digest([...requiring].map(([id, rows]) => [id, stateOf(id).version, rows.map(r => r.item)]));
    if (write && writers?.rule && sharedKey !== lastShared) {
      try { for (const f of recordSharedPrerequisites(g, writers.rule, {observed_at: now(), view: g.view()})) if (f.recorded) stats.recorded.findings++; lastShared = sharedKey; }
      catch (e) { stats.findings_error = cut(e.message, 300); }
    }
    // The queue's report of what the CURRENT plans share: each item listed apart, never merged.
    const shared = [...requiring].map(([id, rows]) => [id, [...new Set(rows.map(r => r.item))].sort(byString)]).filter(([, items]) => items.length >= 2)
      .sort((x, y) => byString(x[0], y[0])).map(([id, items]) => ({prerequisite: id, items, exists: stateOf(id).exists,
        report: 'shared, never merged: each item keeps its own objective, ticket, claims and ownership'}));
    const paths = new Map([...current].map(([item, p]) => [item, claimedPaths(g.view(), planId(p.hash))]));
    return {
      cursor: {seq: g.view().seq, head: g.view().head},
      // The graph as it stood at `seq` (a plan's dossier views are re-derived at the cursor the plan was made at: its own
      // later consequences on the graph are not new evidence, as reconcile.mjs rebuilds it against the work ledger then).
      at: seq => ({view: () => g.view(Number.isInteger(seq) && seq >= 0 && seq <= g.view().seq ? seq : undefined)}),
      gateInput: (item, stages) => ({
        version: id => stateOf(id).version,
        reassessed: hash => reassessed.get(hash) ?? [],
        plan: hash => analyze(item, stages.find(s => s.hash === hash) ?? null),
      }),
      dependsOn: item => [...new Set((waits.get(item) ?? []).map(w => w.on))].sort(byString),
      paths: item => paths.get(item) ?? null,
      report: () => ({cursor: {seq: g.view().seq, head: g.view().head}, shared, candidates, cycles, waits: Object.fromEntries([...waits].map(([k, v]) => [k, v])),
        reassessed: Object.fromEntries([...reassessed].map(([k, v]) => [k, v])), events: {...stats.events}}),
    };
  }

  /**
   * An intake CANDIDATE (KD2-2, KD2-5): ONE unsigned record per missing prerequisite, whatever the number of requiring
   * items (the items that require it are kept current on that one record), never executed. The scheduler records them at
   * the end of a tick, when every item has had its turn to plan (a prerequisite another item implements is no candidate).
   * Returns 'written', 'updated' or null.
   */
  function recordCandidate(c) {
    if (!stateDir) return null;
    const d = path.join(stateDir, 'graph-candidates'), f = path.join(d, `${digest(c.prerequisite).slice(0, 32)}.json`);
    let was = null;
    try { was = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { was = null; }
    if (was && JSON.stringify(was.required_by) === JSON.stringify(c.items)) return null;
    fs.mkdirSync(d, {recursive: true});
    const body = {schema: CANDIDATE_SCHEMA, classification: 'candidate', executable: false, ref: c.ref, prerequisite: c.prerequisite, kind: c.kind, required_by: c.items, gap: c.gap, why: c.why,
      authority: 'none: a candidate is never executed; the owner adds an item with a signed status entry (node packages/ledger/status.mjs set ...) or declines it',
      graph: {anchor, seq: current().view().seq, head: current().view().head}};
    const tmp = `${f}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n');
    fs.renameSync(tmp, f);
    return was ? 'updated' : 'written';
  }
  /** Record the candidates of a reconciliation (scheduler.mjs, at the end of a tick). */
  function recordCandidates(list = []) {
    const out = [];
    for (const c of list) { const r = recordCandidate(c); if (r) { stats.recorded.candidates++; out.push({prerequisite: c.prerequisite, required_by: c.items, recorded: r}); } }
    return out;
  }

  /** A PROPOSAL to the coordinator (KD2-5), recorded once as an unsigned record: never an edit of the registry or the register. */
  function propose(p) {
    if (!stateDir) return null;
    const d = path.join(stateDir, 'graph-proposals'), name = `${p.kind}-${digest({kind: p.kind, subject: p.subject, basis: p.basis}).slice(0, 24)}.json`, f = path.join(d, name);
    if (fs.existsSync(f)) return {file: f, recorded: false};
    fs.mkdirSync(d, {recursive: true});
    fs.writeFileSync(`${f}.tmp-${process.pid}`, JSON.stringify({schema: PROPOSAL_SCHEMA, to: 'coordinator', applied: false, ...p,
      authority: 'none: a proposal to the coordinator, who alone edits ophanim/lessons/** and docs/OPEN-LIMITATIONS.md'}, null, 2) + '\n');
    try { fs.linkSync(`${f}.tmp-${process.pid}`, f); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    fs.rmSync(`${f}.tmp-${process.pid}`, {force: true});
    stats.recorded.proposals++;
    return {file: f, recorded: true};
  }

  /**
   * THE WRITE-BACK OF ONE STAGE RECORD (KD2-5): the work graph observes the work ledger; a recorded finding on a file
   * the learning graph relates to an established failure class becomes a PROPOSAL to the coordinator.
   */
  function writeBack(record) {
    const observed = observeWork();
    const proposals = [];
    if (record && ['failed', 'returned', 'blocked'].includes(record.status)) {
      const files = [...new Set((record.findings ?? []).map(f => f?.file).filter(f => typeof f === 'string' && f))].slice(0, LOOP_BOUNDS.learning);
      for (const file of files) {
        const p = learningProposal(current().view(), {component: file, record});
        if (p) { const w = propose(p); if (w) proposals.push(w); }
      }
    }
    return {observed, proposals};
  }

  /** The graph handle the stage executors receive as ctx.graph (KD2-3, KD2-4). */
  const executor = () => ({
    graph: current(),
    get cursor() { const v = current().view(); return {seq: v.seq, head: v.head}; },
    stateOf: id => requirementState(current().view(), id),
    at: seq => ({view: () => current().view(seq)}),
    teamProposal: args => teamProposal(current().view(), args),
  });

  return {
    schema: GRAPH_LOOP_SCHEMA, dir, anchor, open, graph: () => graph, cursor, observe: ids => observeSources(ids ?? observe), observeWork, observeStart: () => observeSources([...observe]),
    context, checkpoint, writeBack, propose, executor, recordCandidates,
    stats: () => JSON.parse(JSON.stringify(stats)),
  };
}

/**
 * THE ANALYSIS OF ONE PLAN against the graph (KD2-2): its requirement relationships as the graph holds them (established
 * ones can block; possible-only ones are ADVISORY and never block), each with the plan line that states it, its present
 * state and who implements it. The block: a cycle, an unobserved plan, or an established requirement of a missing
 * prerequisite this plan does not implement. The unlock: a requirement the plan cited as absent that now exists.
 */
export function analyzePlan(view, {item, rec, stateOf, implementers, cycle = null, candidateOf}) {
  const P = planId(rec.hash), doc = rec.outputs?.plan, typed = graphRequiresOf(doc);
  const lines = new Map(typed.map(r => [r.id, r]));
  for (const t of d1Requirements(doc).typed) if (!lines.has(t.id)) {
    const i = (doc?.[t.field] ?? []).findIndex(x => (typeof x === 'string' ? x : x?.id) === t.id);
    lines.set(t.id, {id: t.id, version: null, why: t.why, implements: false, line: `${t.field}[${i}]`, statement: JSON.stringify(doc[t.field][i]).slice(0, 300)});
  }
  const edges = view.edgesOf(P, {mode: 'possible', types: REQ_TYPES}).filter(e => e.from === P);
  const rows = [], advisory = [];
  for (const e of edges.slice(0, LOOP_BOUNDS.requirements)) {
    const established = e.assertions.some(x => view.established(x));
    const l = lines.get(e.to) ?? {line: 'graph (no plan line)', why: null, implements: false, version: null, statement: null};
    if (!established) {
      advisory.push({prerequisite: e.to, relationship: e.type, line: l.line, assertions: e.assertions.slice(0, 8), classification: 'hypothetical',
        advisory: 'a hypothetical requirement is recorded as advisory and never blocks'});
      continue;
    }
    const s = stateOf(e.to);
    rows.push({prerequisite: e.to, relationship: e.type, line: l.line, statement: l.statement, why: l.why, implements: l.implements, cited: l.version,
      exists: s.exists, version: s.version, basis: s.basis, by: s.by, gap: s.gap, established_at: s.established_at});
  }
  if (!typed.length && !rows.length) return {basis: null, block: null, report: null, advisory};
  const observed = view.nodeIn(P, 'established');
  const basis = 'sha256:' + digest({plan: rec.hash, observed, requirements: rows.map(r => [r.prerequisite, r.implements, r.exists, r.version])});
  const unlocked = rows.filter(r => r.exists && r.cited === GRAPH_ABSENT).map(r => ({prerequisite: r.prerequisite, line: r.line, basis: r.basis, by: r.by, established_at: r.established_at,
    why: `${r.prerequisite} was MISSING when the plan was made (${r.line}) and is now established (${r.basis}): unlocked`}));
  const report = {cursor: view.seq, plan: P, requirements: rows.map(r => ({...r, implementers: implementers(r.prerequisite, item)})), unlocked, advisory, basis};
  let block = null;
  if (!observed && typed.length) {
    block = {code: 'GRAPH_PLAN_UNOBSERVED', what: `GRAPH_PLAN_UNOBSERVED: the plan ${rec.hash.slice(0, 19)} states ${typed.length} typed requirement(s), and the graph has not observed it (the work graph source is behind or unavailable): nothing after the plan is dispatched on requirements the graph cannot check`,
      role: 'lead@orch', resume_when: 'the work graph source observes the work ledger (the scheduler does after each append)'};
  } else if (cycle) {
    block = {code: 'GRAPH_PREREQUISITE_CYCLE', cycle, what: cut(`GRAPH_PREREQUISITE_CYCLE: ${cycle.join(' -> ')} -> ${cycle[0]}: each waits for a prerequisite another implements; the cycle is reported and refused, never looped`, 600),
      role: 'lead@orch', resume_when: 'a plan in the cycle is revised so that one prerequisite no longer waits on another, or the owner records a new status entry'};
  } else {
    const missing = report.requirements.filter(r => !r.exists && !r.implements);
    if (missing.length) {
      const m = missing[0], by = m.implementers;
      block = {code: 'GRAPH_PREREQUISITE_MISSING', prerequisite: m.prerequisite, line: m.line, statement: m.statement, implementers: by, ...(by.length ? {} : {candidate: candidateOf(m.prerequisite)}),
        prerequisites: missing.map(r => ({prerequisite: r.prerequisite, line: r.line, implementers: r.implementers})),
        what: cut(`GRAPH_PREREQUISITE_MISSING: the plan requires ${m.prerequisite} (${m.line}${m.why ? `: "${m.why}"` : ''}) and the graph shows it MISSING (${m.gap}); ${by.length ? `item(s) ${by.join(', ')} implement it: this item waits for them` : 'no item implements it: it is proposed as an intake candidate for the owner'}`, 600),
        role: 'lead@orch', resume_when: `${m.prerequisite} is established in the graph (an implemented-by or implements a source states, or an executable capability), observed by the loop: the change wakes the tick`};
    }
  }
  return {basis, block, report, advisory};
}

/** The capability role a team row's role names (the capability graph's role ids, pantheon/src/role/roles.mjs). */
const CAPABILITY_ROLE = Object.freeze({'plan-reviewer': 'reviewer', 'change-reviewer': 'reviewer', reviewer: 'reviewer', planner: 'planner', implementer: 'implementer',
  validator: 'validator', dispatcher: 'dispatcher', subagent: 'subagent', scout: 'scout', 'unit-reviewer': 'reviewer'});

/**
 * THE TEAM PROPOSAL of one task (KD2-4; directive section 5), ADVISORY: the seven queries, from the graphs, recorded
 * beside the live seat selection. It reads the live team AFTER the seats were chosen and never returns a seat to use:
 * the live seats are the owner-directed tables' (owner decision 2026-11-20).
 */
export function teamProposal(view, {item, stage, team = [], doc = null, requirement = null, difficulty = 'medium'} = {}) {
  const typed = graphRequiresOf(doc).filter(r => !requirableRefusal(r.id)), states = typed.map(r => ({...requirementState(view, r.id), line: r.line, implements: r.implements}));
  const slices = (Array.isArray(doc?.slices) ? doc.slices : []).map(s => s?.path).filter(p => typeof p === 'string').slice(0, LOOP_BOUNDS.learning);
  const fileNode = p => entityId({domain: 'systems', type: /\.test\.(mjs|js|cjs)$/.test(p) ? 'test' : /\.(mjs|js|cjs|ts)$/.test(p) ? 'module' : 'file', key: p});
  // 1. work: the unmet obligation.
  const work = {item, stage, requirement: requirement ? {title: cut(requirement.title, 200), basis: cut(requirement.basis, 300)} : null,
    unmet: states.filter(s => !s.exists && !s.implements).map(s => ({prerequisite: s.id, line: s.line, gap: s.gap})),
    builds: states.filter(s => s.implements).map(s => s.id)};
  // 2. systems: the existing capabilities and dependencies.
  const systems = {requirements: states.map(s => ({id: s.id, exists: s.exists, basis: s.basis, by: s.by.slice(0, 4)})),
    dependencies: slices.map(p => ({path: p, established: view.nodeIn(fileNode(p), 'established'),
      depends_on: view.edgesOf(fileNode(p), {mode: 'established', types: ['depends-on']}).filter(e => e.from === fileNode(p)).map(e => e.to).slice(0, 8)}))};
  // 3. evidence: what is known and what is uncertain.
  const evidence = {known: states.map(s => ({id: s.id, established: view.query(s.id, 'established').length})),
    uncertain: [...(Array.isArray(doc?.context?.uncertainty) ? doc.context.uncertainty.map(u => cut(u, 200)) : []),
      ...states.flatMap(s => view.query(s.id, 'possible').map(q => cut(`${s.id}: ${q.classification} (${q.why ?? 'not established'})`, 200)))].slice(0, 16)};
  // 4. learning: the relevant failure mechanisms and prior corrections.
  const learning = slices.map(p => { const r = learningReuse(view, {component: p}); return {component: p, classes: r.established.classes.map(c => c.id).slice(0, 8), run: r.next.run.slice(0, 8), gaps: r.gaps.map(x => x.category)}; });
  // 5. capability: C1's advisory eligibility for each live role; 6. the bounded team it would propose.
  const roles = [...new Set(team.map(t => t.role).filter(Boolean))].slice(0, 8);
  const eligible = {}, proposed = [];
  for (const role of roles) {
    const crole = CAPABILITY_ROLE[role] ?? role;
    try {
      const snap = defaultSnapshot(), d = decisionFor(snap, capabilityRequirements({role: crole, mode: 'automatic', task: {difficulty}}));
      const ids = d.eligible.map(e => e.capability).filter(x => typeof x === 'string');
      eligible[role] = {role: crole, snapshot: snap.digest, decision: d.digest, eligible: ids.slice(0, LOOP_BOUNDS.team), count: ids.length};
      const live = team.filter(t => t.role === role).map(t => ({vendor: t.vendor ?? null, model: t.model ?? null}));
      proposed.push({role, live, candidates: ids.slice(0, LOOP_BOUNDS.team), note: 'advisory: the live seat is the owner-directed tables\' choice and is not changed'});
    } catch (e) { eligible[role] = {error: cut(e.message, 200)}; }
  }
  return {schema: TEAM_PROPOSAL_SCHEMA, advisory: true, cursor: view.seq, live_seats: 'unchanged: chosen by the owner-directed seating tables and fit matrix (owner decision 2026-11-20)',
    queries: {work, systems, evidence, learning, capability: eligible}, team: proposed,
    recorded: 'outputs.team_proposal of this stage record, through the work ledger\'s writer (the existing authorized mechanism)'};
}

/**
 * A LEARNING PROPOSAL (KD2-5): a finding on `component` that the learning graph relates to an established failure class
 * becomes a proposal to the coordinator to record it as an instance; null when nothing established relates. Never an
 * edit of the registry.
 */
export function learningProposal(view, {component, record}) {
  const r = learningReuse(view, {component});
  if (!r.established.classes.length) return null;
  return {kind: 'lesson-instance', subject: component, basis: r.established.classes.map(c => c.id).sort(byString),
    why: cut(`a recorded ${record.stage} finding on ${component} is related by the learning graph to ${r.established.classes.length} established failure class(es); the coordinator may record it as an instance`, 600),
    classes: r.established.classes.map(c => ({id: c.id, class: c.class, detector: c.detector.test})), run: r.next.run, record: {item: record.identity?.item ?? null, stage: record.stage, hash: record.hash ?? null},
    findings: (record.findings ?? []).filter(f => f?.file === component).map(f => ({id: f.id ?? null, severity: f.severity ?? null, text: cut(f.text, 300)})).slice(0, 8),
    graph: {cursor: view.seq}};
}
