// THE ADVISORY RECORD beside each live selection (knowledge graphs, Slice C1, KC4; owner decision 2026-11-20 "Keep the seats
// as we have them for now until we better understand the metrics").
//
// Purpose   route/frontier.mjs selectSeat calls adviseSelection on the choice it has ALREADY made. This adds, to every
//           candidate's selection record, the graph-derived eligibility verdict for that candidate's executable capability,
//           the decision's digest and the capability snapshot's digest; the seat's (rank 0) record also carries the whole
//           decision (eligibility.mjs). The record rides wherever the selection does (run.json turns, stage records).
// Must never  change which seat is selected, the candidates, their order, their pools or any other field of the live
//           choice: the returned choice is the live one with `selection.advisory` added and nothing else. The proof is
//           pantheon/tests/capability-advisory.test.mjs (the selection matrix is byte-identical with and without the
//           graph). An advisory that fails records its error and leaves the selection as it was.
import {digest} from '../../../packages/ledger/canonical.mjs';
import {capabilitySnapshot, currentRegistries, E} from './graph.mjs';
import {decide, judge, requirementsOf, capabilityOfSeat, compactDecision, MODE_OF_SOURCE} from './eligibility.mjs';

export const ADVISORY_SCHEMA = 'pantheon.capability-advisory/v1';
let DEFAULT = null;
/** The snapshot of the registries at this checkout, built once per process on first use (argo: route/frontier.mjs ARGO_SEATS). */
export function defaultSnapshot({argo = null} = {}) { return (DEFAULT ??= capabilitySnapshot(currentRegistries({argo}))); }
const decisions = new Map();

/** The requirements selectSeat's own inputs state, in the eligibility vocabulary (the mode from its precedence). */
export function requirementsOfSelection(role, opts, choice) {
  const seat = choice.candidates[0];
  const source = seat.selection.source;
  const mode = MODE_OF_SOURCE[source] ?? 'automatic';
  const t = seat.selection.task ?? null;
  const task = t ? Object.fromEntries(['difficulty', 'depth', 'output', 'stakes', 'ambiguity', 'latency', 'kind'].filter(k => t[k]).map(k => [k, t[k].value])) : {difficulty: opts.difficulty ?? 'medium'};
  return requirementsOf({role, mode, source, profile: seat.selection.profile, context: Number.isFinite(opts.needsContext) ? opts.needsContext : null,
    avoid: opts.avoid ?? [], avoid_labs: opts.avoidLabs ?? [], task, agy_transport: opts.env?.PANTHEON_AGY_TRANSPORT ?? process.env.PANTHEON_AGY_TRANSPORT ?? 'cli',
    ...(mode === 'automatic' ? {} : {target: {vendor: seat.vendor, model: seat.model, transport: seat.transport}})});
}

/** The decision for these requirements over this snapshot, memoized (it is a pure function of the two). */
export function decisionFor(snap, req) {
  const key = `${snap.digest}|${digest(req)}`;
  let d = decisions.get(key);
  if (!d) { if (decisions.size > 2000) decisions.clear(); d = decide(snap, req); decisions.set(key, d); }
  return d;
}

/**
 * The live choice with the advisory record on every candidate's selection. `opts.capability` (a snapshot) replaces the
 * default one (tests, demonstration 4); `opts.argo` is the ARGO seat table the default snapshot projects.
 */
export function adviseSelection(choice, role, opts = {}) {
  let tag;
  try {
    const snap = opts.capability ?? defaultSnapshot({argo: opts.argo ?? null});
    const req = requirementsOfSelection(role, opts, choice);
    const d = decisionFor(snap, req);
    const roleNode = snap.index.node(E('role', role));
    tag = (c, rank) => {
      const cap = capabilityOfSeat(snap.index, c, {role, agy_transport: req.agy_transport});
      const r = cap ? judge(snap.index, c.quota_failover ? {...req, quota_failover: true} : req, cap, {roleNode}) : null;
      const unresolved = d.unresolved.length ? [`unresolved: ${d.unresolved.join('; ')}`] : [];
      return {schema: ADVISORY_SCHEMA, advisory: true, mode: d.mode, snapshot: snap.digest, decision: d.digest,
        capability: cap ? decodeURIComponent(cap.split('/').slice(3).join('/')) : null,
        eligible: cap ? !r.why.length && !unresolved.length : false,
        why: cap ? [...unresolved, ...r.why.map(w => `${w.check}: ${w.why}`)] : [`${c.vendor}/${c.model} (${c.transport}) is not an executable capability of the capability graph`],
        ...(rank === 0 ? {record: compactDecision(d)} : {})};
    };
  } catch (e) {
    const error = String(e?.message ?? e).slice(0, 300);
    tag = () => ({schema: ADVISORY_SCHEMA, advisory: true, error});
  }
  const candidates = choice.candidates.map((c, rank) => ({...c, selection: {...c.selection, advisory: tag(c, rank)}}));
  return {...choice, seat: candidates[0], candidates, selection: candidates[0].selection};
}
