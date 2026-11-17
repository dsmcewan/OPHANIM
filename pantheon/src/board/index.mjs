// One board: a content-addressed store, a set of mutable names, and the runtime chrome that must
// never be hashed into either.
import { openStore } from "./cas.mjs";
import { openRefs } from "./refs.mjs";
import { openRuntime } from "./runtime.mjs";

// `ledger` is a board recorder (pantheon/src/ledger/board-kinds.mjs boardRecorder, or the system ledger's
// `recorder().board(root)`): with one, lease changes, budget limits and ref moves are ledger entries first.
// It is injected, so this module never imports the ledger; `useLedger` attaches one after opening, for a
// ledger opened with this board.
export function openBoard(root, { ledger = null } = {}) {
  const store = openStore(root);
  const runtime = openRuntime(root, { store, ledger });  // spend is bound to commits in this store
  const refs = openRefs(root, { runtime, store, ledger }); // refs verify lease generations and diff commits themselves
  const useLedger = l => { runtime.useLedger(l); refs.useLedger(l); };
  return { root, store, refs, runtime, useLedger };
}

export * from "./canon.mjs";
export * from "./schema.mjs";
export * from "./dag.mjs";
export * from "./merge.mjs";
export * from "./project.mjs";
export * from "./controller.mjs";
export { REF_CLASSES, parseRef, maySwap, slotsAllowed } from "./refs.mjs";
