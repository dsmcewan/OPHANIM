// One ledger, several boards: which board an entry re-derives against.
//
// The board-bound kinds (contribution, gate, ref.move) name their board in the payload: `scope`, the
// board root. A resolver answers, per entry:
//   - the board the ledger was opened with, for its own scope (`board.root`), and for an entry that
//     names no scope (one recorded before entries carried it);
//   - otherwise the board at that root, opened read-only, when one is there;
//   - otherwise null: the kind then re-derives only what needs no store and says so (view.note), so the
//     verify result shows what was not re-derived (packages/ledger/chain.mjs, `partial`).
// An unscoped entry with no board opened has nothing to re-derive against and is refused by the kind.
import fs from 'node:fs';
import path from 'node:path';
import {openStore} from '../board/cas.mjs';
import {openRefs} from '../board/refs.mjs';

/**
 * `board` is the opened board ({root, store, refs?}) or null. Returns scope -> {store, refs, root,
 * opened} | null, where `opened` is true for the board the ledger was opened with.
 */
export function boardScopes(board = null) {
  const own = board?.store ? {store: board.store, refs: board.refs ?? null, root: board.root ?? null, opened: true} : null;
  const others = new Map();
  return scope => {
    if (scope === undefined || scope === null) return own;
    if (own && own.root === scope) return own;
    // Looked up every time: a board can appear or be removed while the ledger stays open.
    if (typeof scope !== 'string' || !path.isAbsolute(scope) || !fs.existsSync(path.join(scope, 'objects'))) return null;
    if (!others.has(scope)) {
      const store = openStore(scope, {readOnly: true});
      others.set(scope, {store, refs: openRefs(scope, {store, readOnly: true}), root: scope, opened: false});
    }
    return others.get(scope);
  };
}

/** The scope an entry names, or undefined for an entry recorded before entries carried one. */
export const scopeOf = p => (typeof p?.scope === 'string' ? p.scope : undefined);
export const validScope = p => p?.scope === undefined || (typeof p.scope === 'string' && path.isAbsolute(p.scope));
