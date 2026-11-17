// K2, the board side: anchoring the Pantheon board DAG on the ledger, without changing it.
//
// A `board.anchor` entry records a board commit on a ref, and re-derives by reading the board again: the
// anchored commit must still be reachable from the ref. Rewriting the board's history then breaks the
// ledger's verification. The TELOS side (`telos.anchor`, read with TELOS's own pinned code) is OPHANIM's
// and lives in ophanim/ledger/anchors.mjs, which composes it with this one.
import {history} from '../board/dag.mjs';

const CID = /^commit:[0-9a-f]{64}$/;

/**
 * The `board.anchor` kind. `board.reaches(ref, commit)` says whether the commit is in the ref's history;
 * `authors` decides who may write anchors (by default, anyone in the keyring).
 */
export function boardAnchorKinds({board = null, authors = () => true} = {}) {
  if (!board) return {};
  return {
    'board.anchor': {
      authors,
      validate: p => (typeof p?.ref === 'string' && CID.test(p.commit ?? '') ? null : 'a board anchor names {ref, commit}'),
      rederive: e => (board.reaches(e.payload.ref, e.payload.commit) ? null : `commit ${e.payload.commit.slice(0, 12)} is no longer in ${e.payload.ref}'s history`),
    },
  };
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
