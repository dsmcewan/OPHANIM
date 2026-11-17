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
import {LANES} from '../config/models.mjs';
import {promptSha, replySha} from '../context/chain.mjs';
import {generateSigner, AUTHORITY} from '../../../packages/ledger/chain.mjs';

const PLACEHOLDER = /^$|_self$|^self$|placeholder/i;           // TELOS's own rule (proposal-ledger.mjs)
const sha = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
export const seatKeyId = seat => `seat:${seat.seat_id}#${seat.occupancy_gen}`;
const LAB_OF_VENDOR = {agy_google: 'google'};
/** The lab that answered: a lane model names its lab (an agy seat may serve a Claude model). */
export function labOf(vendor, model) {
  for (const lane of Object.values(LANES)) if (lane[model]) return lane[model].lab;
  return LAB_OF_VENDOR[vendor] ?? vendor;
}
export const lineageKey = (vendor, responseId) =>
  typeof responseId === 'string' && !PLACEHOLDER.test(responseId) && typeof vendor === 'string' && vendor ? `${vendor.toLowerCase()}:${responseId}` : null;

const HEX = /^[0-9a-f]{64}$/;
// Optional: the digests the seat's conversation file records the exchange under (seat-sdk), so a seat
// file can be checked against the ledger. `prompt_sha` cannot be re-derived (the prompt is not kept);
// the reply's exchange digest is re-derived from the reply and tools.
const exchangeShape = p => (p.prompt_sha === undefined || HEX.test(p.prompt_sha))
  && (p.tools === undefined || (Array.isArray(p.tools) && p.tools.every(t => typeof t === 'string')));

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
  }
  return out;
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
        ? null : 'a review names its seat, model and verdict'),
      rederive: (e, view) => {
        const p = e.payload;
        if (e.author.key_id !== seatKeyId(p.seat)) return `signed by ${e.author.key_id}, not by the reviewing seat`;
        const targets = e.derived_from.filter(h => view.entry(h)?.kind === 'turn');
        if (!targets.length) return 'a review cites the turns it reviews';
        const lab = labOf(p.seat.vendor, p.served_model ?? p.model);
        const mine = lineageKey(p.seat.vendor, p.response_id);
        for (const {entry, payload: t} of lineageOf(view, e.derived_from)) {
          if (entry.author.key_id === e.author.key_id) return 'a seat may not review its own turn';
          if (t.seat && t.reply_sha && labOf(t.seat.vendor, t.served_model ?? t.requested_model) === lab) return `the ${lab} lab is in the lineage of what it reviews`;
          if (mine && lineageKey(t.seat.vendor, t.response_id) === mine) return 'the review response is part of the lineage it reviews';
        }
        return null;
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
    recordTurn({seat, requested_model, served_model = null, response_id = null, reply, purpose = null, cites = [], prompt = null, tools = []}) {
      const s = signerFor(seat);
      const prev = last.get(seat.seat_id);
      const payload = {seat, requested_model, served_model, response_id, reply, reply_sha: sha(reply), purpose,
        ...(typeof prompt === 'string' ? {prompt_sha: promptSha(prompt)} : {}), ...(tools?.length ? {tools: tools.map(String)} : {})};
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
    recordReview({seat, model, served_model = null, response_id = null, verdict, findings = '', targets}) {
      const s = signerFor(seat);
      return ledger.append({kind: 'review', payload: {seat, model, served_model, response_id, verdict, findings},
        author: {key_id: s.key_id}, signer: s, order, derivedFrom: targets}).hash;
    },
  };
}
