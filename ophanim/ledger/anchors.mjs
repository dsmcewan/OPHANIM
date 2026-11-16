// K2: anchoring the ledgers that already exist, without changing them.
//
// The pinned TELOS proposal chains and the Pantheon board DAG stay exactly as they are. An anchor entry
// records a point in one of them (a TELOS proposal head after n events; a board commit on a ref), and
// re-derives by reading that ledger again: the anchored head must still be the n-th event of a chain
// TELOS itself verifies, and the anchored commit must still be reachable from the ref. Rewriting either
// underlying ledger then breaks the system chain's verification.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {TELOS_COMMIT, TELOS_PINS} from '../governance.mjs';
import {history} from '../../pantheon/src/board/dag.mjs';

const SHA = /^sha256:[0-9a-f]{64}$/;
const CID = /^commit:[0-9a-f]{64}$/;

/**
 * Kind specs for the two anchors. `telos.events(proposal_id)` returns the hashes of a chain TELOS has
 * verified, in order; `board.reaches(ref, commit)` says whether the commit is in the ref's history.
 * `authors` decides who may write anchors (by default, anyone in the keyring).
 */
export function anchorKinds({telos = null, board = null, authors = () => true} = {}) {
  const kinds = {};
  if (telos) kinds['telos.anchor'] = {
    authors,
    validate: p => (typeof p?.proposal_id === 'string' && Number.isInteger(p.events) && p.events > 0 && SHA.test(p.head) ? null
      : 'a TELOS anchor names {proposal_id, events, head}'),
    rederive: e => {
      let hashes;
      try { hashes = telos.events(e.payload.proposal_id); } catch (err) { return `TELOS chain does not verify: ${err.message}`; }
      if (hashes.length < e.payload.events) return `TELOS chain has ${hashes.length} events, fewer than the ${e.payload.events} anchored`;
      return hashes[e.payload.events - 1] === e.payload.head ? null : 'TELOS event at the anchored position is not the anchored head';
    },
  };
  if (board) kinds['board.anchor'] = {
    authors,
    validate: p => (typeof p?.ref === 'string' && CID.test(p.commit ?? '') ? null : 'a board anchor names {ref, commit}'),
    rederive: e => (board.reaches(e.payload.ref, e.payload.commit) ? null : `commit ${e.payload.commit.slice(0, 12)} is no longer in ${e.payload.ref}'s history`),
  };
  return kinds;
}

/** Board side: a commit is anchored while it stays in the ref's history. */
export function boardResolver({store, refs, limit = 100_000}) {
  return {
    reaches(ref, commit) {
      const head = refs.resolve(ref);
      return Boolean(head) && history(store, head, {limit}).commits.some(c => c.cid === commit);
    },
    head: ref => refs.resolve(ref),
  };
}

/**
 * TELOS side: read a proposal chain with TELOS's own pinned code. The source file is checked against
 * the pin before it is loaded, so the anchor is only ever re-derived by the reviewed TELOS.
 */
export async function telosResolver({telosRoot, dirFor, publicJwk}) {
  if (typeof telosRoot !== 'string' || !path.isAbsolute(telosRoot)) throw Error('an absolute pinned TELOS checkout is required');
  const rel = 'merkle-dag/proposal-ledger.mjs';
  const bytes = fs.readFileSync(path.join(telosRoot, rel));
  if (createHash('sha256').update(bytes).digest('hex') !== TELOS_PINS[rel]) throw Error(`TELOS ${rel} differs from the pin for ${TELOS_COMMIT}`);
  const telos = await import(pathToFileURL(path.join(telosRoot, rel)).href);
  return {
    events(proposalId) {
      const {events, errors} = telos.readProposalEvents(dirFor(proposalId));
      if (errors.length) throw Error(errors.join('; '));
      const chain = telos.verifyProposalChain(events, publicJwk, {proposalId});
      if (!chain.ok) throw Error(chain.errors.join('; '));
      // The file order is the chain order once TELOS has verified it (single root, no forks, parents earlier).
      return events.map(telos.proposalEventHash);
    },
    head(proposalId) { const h = this.events(proposalId); return {events: h.length, head: h.at(-1)}; },
  };
}
