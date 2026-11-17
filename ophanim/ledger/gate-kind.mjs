// K3 `gate`: a ship's gate verdicts as a ledger entry that re-derives after the board has moved on.
//
// `ship({dryRun})` / `shipClaim` read live state: two ref names, the content-addressed store, and the
// runtime lease table judged against the clock. A verdict over that cannot be re-derived later, because
// the refs move. So the entry NAMES what was read:
//   heads   the {name, cid} of the board ref and the offering branch, as resolved when judged. Commits
//           are content-addressed, so they still mean the same thing after both refs have moved.
//   leases  the active lease rows LEASE read (the runtime lease file is not content-addressed, so these
//           are a recorded input, signed by the author, like `facts`), and `now`, which LEASE is judged at.
// and re-derives by running the SAME gate evaluator a live ship runs (`gatesAt` in integrate.mjs),
// through a read-only refs view pinned to those heads, then comparing the claim canonically.
//
// With lease entries on the ledger (board-kinds.mjs), the lease rows stop being a bare signed input: a
// verdict that names `lease_scope` cites the latest lease entry of every lease active on that board, and
// its rows must be exactly the ones those entries derive. A row dropped, added or altered is refused.
import {gatesAt, shipClaim} from '../../pantheon/src/board/integrate.mjs';
import {boardResolver} from './anchors.mjs';
import {canonical} from '../board.mjs';
import {LEASE, leaseTableAt, leaseRows} from './board-kinds.mjs';

const CID = /^commit:[0-9a-f]{64}$/;
// The claim is plain JSON on the ledger; an absent field (an actor with no vendor) is dropped, not kept.
const plain = v => JSON.parse(JSON.stringify(v));

const validHeads = hs => Array.isArray(hs) && hs.every(h => h && typeof h.name === 'string' && typeof h.cid === 'string')
  && new Set(hs.map(h => h.name)).size === hs.length;

/** Only what LEASE reads of a lease row, for the rows that could hold. */
export function leaseSnapshot(table = {}) {
  return Object.fromEntries(Object.entries(table).filter(([, l]) => l?.state === 'active').sort(([a], [b]) => a.localeCompare(b))
    .map(([r, l]) => [r, {state: l.state, expires_at: l.expires_at, gen: l.gen, holder: {seat_id: l.holder?.seat_id ?? null}}]));
}

/**
 * Kind spec. `authors` decides who may record a verdict (the controller, typically). `board` is
 * {store, refs?}: the store re-derives the verdict; with `refs`, the recorded board head must also still
 * be in the board ref's history (the board moving on is fine; a rewrite is not).
 */
export function gateKinds({authors = () => true, board}) {
  if (!board?.store) throw Error('gate kind: a board store is required to re-derive verdicts');
  const reach = board.refs ? boardResolver({store: board.store, refs: board.refs}) : null;
  return {
    gate: {
      authors,
      validate: p => (typeof p?.ref === 'string' && typeof p.from === 'string' && validHeads(p.heads)
        && p.actor && typeof p.actor === 'object' && Number.isFinite(p.now)
        && (p.leases === undefined || (p.leases && typeof p.leases === 'object'))
        && (p.graft === undefined || Array.isArray(p.graft))
        && (p.lease_scope === undefined || typeof p.lease_scope === 'string')
        && p.claim?.kind === 'ship' && Array.isArray(p.claim.gates)
        ? null : 'a gate entry names {ref, from, heads, actor, now, claim}'),
      rederive: (e, view) => {
        const p = e.payload;
        for (const h of p.heads) {
          if (!CID.test(h.cid) || !board.store.has(h.cid)) return `the named heads are not on this board: ${h.name} -> ${h.cid}`;
        }
        const boardHead = p.heads.find(h => h.name === p.ref);
        if (reach && boardHead && !reach.reaches(p.ref, boardHead.cid)) return `${boardHead.cid.slice(0, 19)} is no longer in ${p.ref}'s history`;
        const cited = e.derived_from.filter(h => view?.entry(h)?.kind === LEASE);
        if (p.lease_scope !== undefined) {
          const table = leaseTableAt(view, p.lease_scope), rows = leaseRows(table);
          if (canonical(rows) !== canonical(p.leases ?? {})) return 'the lease rows are not the ones the ledger\'s lease entries derive';
          const active = Object.keys(rows).map(r => table.get(r).hash).sort();
          if (canonical(active) !== canonical([...cited].sort())) return 'the verdict does not cite exactly the latest lease entries it read';
        } else if (cited.length) return 'lease entries are cited without naming their lease_scope';
        let again;
        try {
          again = gatesAt({store: board.store, heads: p.heads, ref: p.ref, from: p.from, actor: p.actor,
            graft: p.graft ?? [], leases: p.leases ?? {}, now: p.now});
        } catch (err) { return `the gates do not evaluate at these heads: ${err.message}`; }
        return canonical(plain(again)) === canonical(p.claim) ? null : 'the claim is not the verdict these heads produce';
      },
    },
  };
}

/**
 * Build a `gate` payload from the live board, for the controller to append. The heads and leases are
 * read once; the claim is computed from THAT record through `gatesAt`, and must match what a live
 * `shipClaim` says at the same moment, or nothing is returned (the pinned view would have missed a read).
 */
export async function gateRecord({store, refs, runtime = null, ref, from, actor, graft = [], now = Date.now(), leaseLedger = null}) {
  const heads = [...new Set([ref, from])].map(name => ({name, cid: refs.resolve(name)})).filter(h => h.cid);
  const leases = leaseSnapshot(runtime?.leases() ?? {});
  // With a board recorder (board-kinds.mjs), the rows must be the ones the ledger's lease entries derive;
  // the caller appends the gate entry citing `gateLeaseCitations(leaseLedger)`.
  let lease_scope;
  if (leaseLedger) {
    const fromLedger = leaseLedger.leaseCitations();
    if (canonical(fromLedger.rows) !== canonical(leases)) throw Error('gateRecord: the runtime lease table is not the one the ledger\'s lease entries derive');
    lease_scope = fromLedger.scope;
  }
  const claim = plain(gatesAt({store, heads, ref, from, actor, graft, leases, now}));
  const live = plain(await shipClaim({store, refs, runtime, ref, from, actor, graft, now}));
  if (canonical(live) !== canonical(claim)) throw Error('gateRecord: the live board moved while the verdict was being recorded, or the pinned view missed a read');
  return {ref, from, heads, actor: plain(actor), now, ...(graft.length ? {graft: [...graft]} : {}), leases, ...(lease_scope !== undefined ? {lease_scope} : {}), claim};
}

/** The lease entries a gate entry recorded with `leaseLedger` cites. */
export const gateLeaseCitations = leaseLedger => leaseLedger.leaseCitations().hashes;
