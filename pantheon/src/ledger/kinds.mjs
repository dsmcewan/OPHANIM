// K3: the first ledger kinds, each re-derived by a verifier that already existed but was off the path.
//
//   facts         the cited capability facts, as a ledger input: every recorded figure carries its source
//                 and the quote it was read from (the evidence travels with the value)
//   seating       the seating table a decision was made under; every seated model is a fact or a lane
//   escalation    a routing/escalation decision; re-derived by the protocol's own verifyEscalation from the
//                 facts and seating entries it CITES (not from whatever the code holds today), and chained
//                 to the previous decision for the same work by citation
//   contribution  a chair-contribution projection; re-derived from the board heads it names, which are
//                 content-addressed, so it stays re-derivable after the board moves on
//
// Inputs are entries, never edits: a changed fact is a new `facts` entry, and decisions cite the one
// they used. That is the Merkle cascade, applied to routing.
import {verifyEscalation, PROTOCOL} from '../route/protocol.mjs';
import {chairContributions, CONTRIBUTIONS_SCHEMA} from '../board/contributions.mjs';
import {SEATING, candidatesFor} from '../role/seating.mjs';
import {LANES} from '../config/models.mjs';
import {FACTS} from '../config/facts.mjs';
import {canonical, digest} from '../../../packages/ledger/canonical.mjs';

// A figure is either UNRECORDED (never guessed) or carries the source and quote it was read from.
const isCited = f => f === 'UNRECORDED' || f === undefined
  || (f && typeof f === 'object' && ('value' in f || 'values' in f) && typeof f.source === 'string' && typeof f.quote === 'string');
const FIELDS = ['window', 'output', 'output_long_decode', 'efforts'];
const one = (view, hashes, kind) => {
  const found = hashes.filter(h => view.entry(h)?.kind === kind);
  return found.length === 1 ? {hash: found[0], payload: view.payload(found[0])} : null;
};

/** The current inputs, as payloads ready to record. */
export function currentFacts() { return JSON.parse(JSON.stringify(FACTS)); }
export function currentSeating() {
  return Object.fromEntries(Object.keys(SEATING).map(role => [role,
    candidatesFor(role).map(({vendor, model, band = null, basis, why}) => ({vendor, model, ...(band ? {band} : {}), basis, why}))]));
}

/**
 * Kind specs. `authors.inputs` decides who may record facts and seating (operators, typically);
 * `authors.decisions` who may record escalations and contributions (the controller, typically).
 * `board` is {store} for re-deriving contributions.
 */
export function pantheonKinds({authors = {}, board = null} = {}) {
  const inputs = authors.inputs ?? (() => true), decisions = authors.decisions ?? (() => true);
  return {
    facts: {
      authors: inputs,
      validate: p => (p?.models && typeof p.models === 'object' ? null : 'facts name their models'),
      rederive: e => {
        for (const [model, f] of Object.entries(e.payload.models)) {
          for (const field of FIELDS) if (!isCited(f[field])) return `${model}.${field} carries no source and quote`;
        }
        return null;
      },
    },
    seating: {
      authors: inputs,
      validate: p => (p && typeof p === 'object' && Object.values(p).every(Array.isArray) ? null : 'seating maps roles to candidate lists'),
      rederive: (e, view) => {
        const facts = one(view, e.derived_from, 'facts');
        if (!facts) return 'seating cites exactly one facts entry';
        const lane = m => Object.values(LANES).some(l => l[m]);
        for (const [role, cands] of Object.entries(e.payload)) for (const c of cands) {
          if (!c.model || (!facts.payload.models[c.model] && !lane(c.model))) return `${role}: ${c.model} is neither a cited fact nor a lane model`;
        }
        return null;
      },
    },
    escalation: {
      authors: decisions,
      validate: p => (p?.schema === PROTOCOL && typeof p.digest === 'string' ? null : 'an escalation is a protocol record'),
      rederive: (e, view) => {
        const facts = one(view, e.derived_from, 'facts'), seating = one(view, e.derived_from, 'seating');
        if (!facts || !seating) return 'an escalation cites the facts and the seating it was decided under';
        const prev = one(view, e.derived_from, 'escalation');
        const records = prev ? [prev.payload, e.payload] : [e.payload];
        try { verifyEscalation(records, {facts: facts.payload, seating: seating.payload}); }
        catch (err) { return err.message; }
        return null;
      },
    },
    ...(board ? {
      contribution: {
        authors: decisions,
        validate: p => (p?.projection?.schema === CONTRIBUTIONS_SCHEMA && Array.isArray(p.heads) ? null : 'a contribution names its board heads and projection'),
        rederive: e => {
          const refs = {list: () => e.payload.heads};
          let again;
          try { again = chairContributions({store: board.store, refs}); } catch (err) { return `the named heads are not on this board: ${err.message}`; }
          return again.projectionSha === e.payload.projection.projectionSha && canonical(again) === canonical(e.payload.projection)
            ? null : 'the projection is not the one these heads produce';
        },
      },
    } : {}),
  };
}

/**
 * A recorder the run path can use: records facts and seating once, then each escalation citing them and
 * the previous escalation for the same work. `verify()` is what a run calls before relying on its trail.
 */
export function escalationRecorder({ledger, controller, order, operator, facts = currentFacts(), seating = currentSeating()}) {
  const by = s => ({author: {key_id: s.key_id}, signer: s, order});
  // Inputs are recorded once: an identical facts or seating entry already on the chain is reused, so a
  // ledger shared across runs grows by what changed, not by a copy of the inputs per run.
  const ref = value => 'sha256:' + digest(value);
  const existing = (kind, value, cites) => {
    const e = ledger.read().findLast(x => x.kind === kind && x.payload_ref === ref(value) && cites.every(c => x.derived_from.includes(c)));
    return e ? ledger.hashOf(e) : null;
  };
  const f = existing('facts', facts, []) ?? ledger.append({kind: 'facts', payload: facts, ...by(operator)}).hash;
  const s = existing('seating', seating, [f]) ?? ledger.append({kind: 'seating', payload: seating, derivedFrom: [f], ...by(operator)}).hash;
  const last = new Map();
  return {
    inputs: {facts: f, seating: s},
    record(work, rec) {
      // The run annotates records (purpose, tier, slot, rev); those are notes, kept beside the record.
      const {purpose, tier, slot, rev, ...record} = rec;
      const prev = last.get(work);
      const h = ledger.append({kind: 'escalation', payload: record, derivedFrom: [f, s, ...(prev ? [prev] : [])], ...by(controller)}).hash;
      last.set(work, h);
      return h;
    },
    verify: () => ledger.verify(),
  };
}
