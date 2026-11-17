// K4: model turns and reviews on the ledger, with observed lineage and per-seat keys.
//
// From TELOS, applied to every model-produced entry, not only review packets:
//   - provider-scoped lineage: a turn is identified by `vendor:response_id`, with the SERVED model (what
//     the provider reported answering) beside the requested one; placeholder ids are refused;
//   - cold review: a review may not be made by a lab, a seat, or a response anywhere in the lineage of
//     what it reviews, so a model never attests to its own work, directly or through a citation chain.
// And beyond TELOS's shared-secret packets:
//   - per-seat keys: a turn is signed by the key of the seat occupancy that made it
//     (`seat:<seat_id>#<occupancy_gen>`), admitted to the ledger by an operator's authority entry. A
//     forged turn or review needs that seat's private key, not a secret every seat shares.
import {createHash} from 'node:crypto';
import {reviewerRefusal, reviewerIdentity, resolveModel, policyRefusal, policyDigest} from '../review/identity.mjs';
import {labOf} from '../config/models.mjs';
import {promptSha, replySha} from '../context/chain.mjs';
import {generateSigner, AUTHORITY} from '../../../packages/ledger/chain.mjs';

const PLACEHOLDER = /^$|_self$|^self$|placeholder/i;           // TELOS's own rule (proposal-ledger.mjs)
const sha = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
export const seatKeyId = seat => `seat:${seat.seat_id}#${seat.occupancy_gen}`;
/** The lab that answered: a lane model names its lab (an agy seat may serve a Claude model). */
export {labOf};
export const lineageKey = (vendor, responseId) =>
  typeof responseId === 'string' && !PLACEHOLDER.test(responseId) && typeof vendor === 'string' && vendor ? `${vendor.toLowerCase()}:${responseId}` : null;

const HEX = /^[0-9a-f]{64}$/;
// Optional: the digests the seat's conversation file records the exchange under (seat-sdk), so a seat
// file can be checked against the ledger. `prompt_sha` cannot be re-derived (the prompt is not kept);
// the reply's exchange digest is re-derived from the reply and tools.
const exchangeShape = p => (p.prompt_sha === undefined || HEX.test(p.prompt_sha))
  && (p.tools === undefined || (Array.isArray(p.tools) && p.tools.every(t => typeof t === 'string')))
  && (p.selection === undefined || (p.selection && typeof p.selection === 'object' && typeof p.selection.policy === 'string'
    && typeof p.selection.policy_hash === 'string' && typeof p.selection.source === 'string'));

const seatShape = s => s && typeof s.seat_id === 'string' && typeof s.vendor === 'string' && Number.isInteger(s.occupancy_gen) && s.occupancy_gen > 0;

// Every turn reachable from the cited entries, through turn and review citations.
function lineageOf(view, hashes) {
  const out = [], seen = new Set(), queue = [...hashes];
  while (queue.length) {
    const h = queue.pop();
    if (seen.has(h)) continue;
    seen.add(h);
    const e = view.entry(h);
    if (!e) continue;
    if (e.kind === 'turn' || e.kind === 'review') { out.push({entry: e, payload: view.payload(h)}); queue.push(...e.derived_from); }
    else if (e.kind === 'cycle') queue.push(...e.derived_from);    // a cycle's lineage is the author turns it cites
  }
  return out;
}

// A review of a cycle (cycle-kinds.mjs): never by the lab that authored the change, answered by a turn of
// the same seat that was given exactly the cycle's prompt, one review per lab, and none once it is closed.
function cycleReview(e, view, cycle, lab) {
  const c = view.payload(cycle), p = e.payload;
  // v1 and v2: the reviewer's LAB did not author the change. v3 (pantheon.cycle/v3): the reviewer is not a contributing
  // MODEL, by identity, whatever the effort, alias, session or route (cycle-kinds.mjs, review/identity.mjs).
  if (c.contract === 'pantheon.cycle/v3') {
    const refused = reviewerRefusal({vendor: p.seat?.vendor, model: p.model, served_model: p.served_model ?? null}, {models: c.author_models, labs: c.excluded_labs}, c.identity_policy.rules);
    if (refused) return refused;
  } else if (c.author_labs.includes(lab)) return `the ${lab} lab authored the change under review`;
  const t = typeof p.turn === 'string' ? view.entry(p.turn) : null;
  if (t?.kind !== 'turn' || t.author.key_id !== e.author.key_id || !t.derived_from.includes(cycle)) return 'a cycle review names the turn that answered it, by the same seat, on this cycle';
  const a = view.payload(p.turn);
  if (a.prompt_sha !== c.prompt_sha) return 'the answering turn was not given the cycle\'s change and brief';
  if ((a.response_id ?? null) !== (p.response_id ?? null) || a.requested_model !== p.model || (a.served_model ?? null) !== (p.served_model ?? null)) {
    return 'the review does not name its answering turn\'s response and model';
  }
  const hs = view.entries();
  if (hs.some(h => view.entry(h).kind === 'cycle.close' && view.entry(h).derived_from.includes(cycle))) return 'the cycle is closed';
  for (const h of hs) {
    const x = view.entry(h);
    if (x.kind === 'review' && x.derived_from.includes(cycle)) {
      const q = view.payload(h);
      const theirs = c.contract === 'pantheon.cycle/v3' ? reviewerIdentity({vendor: q.seat.vendor, model: q.model, served_model: q.served_model ?? null}, c.identity_policy.rules).lab
        : labOf(q.seat.vendor, q.served_model ?? q.model);
      if (theirs === lab) return `the ${lab} lab has already reviewed this cycle`;
    }
  }
  return null;
}

export function lineageKinds() {
  return {
    turn: {
      // Only the seat occupancy that made the turn signs it.
      authors: () => true,
      validate: p => (seatShape(p?.seat) && typeof p.requested_model === 'string' && typeof p.reply === 'string' && typeof p.reply_sha === 'string'
        && (p.served_model === null || typeof p.served_model === 'string') && exchangeShape(p) ? null : 'a turn names its seat, requested and served model, and reply'),
      rederive: (e, view) => {
        const p = e.payload;
        if (e.author.key_id !== seatKeyId(p.seat)) return `signed by ${e.author.key_id}, not by the seat that answered (${seatKeyId(p.seat)})`;
        if (sha(p.reply) !== p.reply_sha) return 'the reply is not the one its digest names';
        if (p.response_id != null && !lineageKey(p.seat.vendor, p.response_id)) return `response id "${p.response_id}" is a placeholder`;
        // A seat's turns chain by citation; the same occupancy may not change the model it runs.
        for (const h of e.derived_from) {
          const prev = view.entry(h);
          if (prev?.kind !== 'turn') continue;
          const q = view.payload(h);
          if (q.seat.seat_id === p.seat.seat_id && q.seat.occupancy_gen === p.seat.occupancy_gen && q.requested_model !== p.requested_model) {
            return `the seat changed model (${q.requested_model} -> ${p.requested_model}) without a new occupancy`;
          }
        }
        return null;
      },
    },
    review: {
      authors: () => true,
      validate: p => (seatShape(p?.seat) && ['approve', 'request_changes'].includes(p.verdict) && typeof p.model === 'string'
        && (p.turn === undefined || typeof p.turn === 'string')
        ? null : 'a review names its seat, model and verdict'),
      rederive: (e, view) => {
        const p = e.payload;
        if (e.author.key_id !== seatKeyId(p.seat)) return `signed by ${e.author.key_id}, not by the reviewing seat`;
        const targets = e.derived_from.filter(h => view.entry(h)?.kind === 'turn');
        const cycles = e.derived_from.filter(h => view.entry(h)?.kind === 'cycle');
        if (!targets.length && !cycles.length) return 'a review cites the turns it reviews';
        if (cycles.length > 1) return 'a review cites at most one cycle';
        const mine = lineageKey(p.seat.vendor, p.response_id);
        // The MODEL rule applies to a review of a pantheon.cycle/v3 cycle, and to a review outside a cycle that carries
        // its own identity policy (an in-run review made under the model rule). Every other review -- every one
        // recorded before this existed -- is checked by LAB, exactly as before.
        const own = !cycles.length && p.independence === 'model' ? p.identity_policy : null;
        if (own && (policyRefusal(own.rules) !== null || policyDigest(own.rules) !== own.digest)) return 'a model-rule review carries its identity policy {digest, rules}, and the digest is of those rules';
        const v3 = Boolean(own) || (cycles.length === 1 && view.payload(cycles[0])?.contract === 'pantheon.cycle/v3');
        // Under the model rule every name is resolved by the RECORDED identity policy; an unresolved reviewer does not qualify.
        const pinned = own ? own.rules : v3 ? view.payload(cycles[0]).identity_policy.rules : null;
        const who = v3 ? reviewerIdentity({vendor: p.seat.vendor, model: p.model, served_model: p.served_model ?? null}, pinned) : null;
        if (who?.why) return who.why;
        const lab = v3 ? who.lab : labOf(p.seat.vendor, p.served_model ?? p.model);
        for (const {entry, payload: t} of lineageOf(view, e.derived_from)) {
          if (entry.author.key_id === e.author.key_id) return 'a seat may not review its own turn';
          // Cold review. Under v1 and v2 (and for any review outside a cycle) no reviewer's LAB is in the lineage of what
          // it reviews. Under pantheon.cycle/v3 the reviewer is not one of the MODELS in that lineage, by identity
          // (the requested and the served model of each lineage turn, against the reviewer's own two names).
          if (t.seat && t.reply_sha) {
            if (v3) {
              const theirs = [t.requested_model, t.served_model].filter(Boolean).map(m => resolveModel(t.seat.vendor, m, pinned));
              const lost = theirs.find(x => !x.known);
              if (lost) return `a model in the lineage of what it reviews is unresolved (${lost.why})`;
              const same = who.ids.find(i => theirs.some(x => x.id === i));
              if (same) return `${same} is in the lineage of what it reviews`;
            } else if (labOf(t.seat.vendor, t.served_model ?? t.requested_model) === lab) return `the ${lab} lab is in the lineage of what it reviews`;
          }
          if (mine && lineageKey(t.seat.vendor, t.response_id) === mine) return 'the review response is part of the lineage it reviews';
        }
        return cycles.length ? cycleReview(e, view, cycles[0], lab) : null;
      },
    },
  };
}

/**
 * Records turns and reviews for a run. Seat keys are generated per occupancy on first use and admitted
 * by an operator authority entry before the seat's first entry, so every seat entry is signed by a key
 * the ledger's authority admitted.
 */
export function lineageRecorder({ledger, operator, order, keys: store = null}) {
  const keys = new Map(), last = new Map();
  // With a key store (system.mjs), a seat occupancy keeps its key across runs: it is admitted once,
  // and reused while the ledger's authority still names it. Without one, keys live for this recorder.
  const signerFor = seat => {
    const id = seatKeyId(seat);
    if (keys.has(id)) return keys.get(id);
    let s = store?.get(id) ?? null;
    const admitted = ledger.verify().authority?.keys?.[id];
    if (s && admitted && admitted.x === s.publicJwk.x) { keys.set(id, s); return s; }
    if (!s) s = store ? store.put(generateSigner(id)) : generateSigner(id);
    else if (admitted) s = store.replace(generateSigner(id));   // held key no longer admitted: a fresh one
    if (admitted) ledger.append({kind: AUTHORITY, payload: {revoke: [id]}, author: {key_id: operator.key_id}, signer: operator, order});
    ledger.append({kind: AUTHORITY, payload: {add: {[id]: s.publicJwk}}, author: {key_id: operator.key_id}, signer: operator, order});
    keys.set(id, s);
    return s;
  };
  return {
    recordTurn({seat, requested_model, served_model = null, response_id = null, reply, purpose = null, cites = [], prompt = null, tools = [], selection = null}) {
      const s = signerFor(seat);
      const prev = last.get(seat.seat_id);
      // `selection` (optional, additive): why this seat was chosen and under which policy version/hash
      // (pantheon/src/route/frontier.mjs selectSeat). Entries written before it existed verify unchanged.
      const payload = {seat, requested_model, served_model, response_id, reply, reply_sha: sha(reply), purpose,
        ...(typeof prompt === 'string' ? {prompt_sha: promptSha(prompt)} : {}), ...(tools?.length ? {tools: tools.map(String)} : {}),
        ...(selection ? {selection} : {})};
      const h = ledger.append({kind: 'turn', payload, author: {key_id: s.key_id}, signer: s, order, derivedFrom: [...(prev ? [prev] : []), ...cites]}).hash;
      last.set(seat.seat_id, h);
      return h;
    },
    /**
     * A seat's turns as its conversation file records them: per turn, the prompt digest (null when the
     * turn was recorded without one) and, when the reply has text or tools, the reply's exchange digest.
     * Read from a ledger that verifies, in chain order. seat-sdk checks a stored conversation against it.
     */
    exchanges(seat_id) {
      const state = ledger.verify({mode: 'frontier'});
      if (!state.ok) throw Object.assign(new Error(`ledger does not verify: ${state.why}`), {code: 'LEDGER_REFUSED'});
      const out = [];
      for (const e of ledger.read()) {
        if (e.kind !== 'turn') continue;
        const p = ledger.payloadOf(e);
        if (p?.seat?.seat_id !== seat_id) continue;
        out.push({role: 'user', sha: p.prompt_sha ?? null});
        if (p.reply !== '' || p.tools?.length) out.push({role: 'assistant', sha: replySha(p.reply, p.tools ?? [])});
      }
      return out;
    },
    // `turn`: for a cycle review (cycle-kinds.mjs), the seat's turn that answered it.
    recordReview({seat, model, served_model = null, response_id = null, verdict, findings = '', targets, turn = undefined, identity_policy = undefined}) {
      const s = signerFor(seat);
      // `identity_policy` (a review outside a cycle, made under the model rule): the policy travels with the review.
      return ledger.append({kind: 'review', payload: {seat, model, served_model, response_id, verdict, findings, ...(turn !== undefined ? {turn} : {}),
        ...(identity_policy ? {independence: 'model', identity_policy: {digest: policyDigest(identity_policy), rules: identity_policy}} : {})},
        author: {key_id: s.key_id}, signer: s, order, derivedFrom: targets}).hash;
    },
  };
}
