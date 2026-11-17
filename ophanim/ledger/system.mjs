// The ledger by default, for OPHANIM: the full composition. One place that opens (or creates) a ledger
// with EVERY kind registered, holds its keys, and hands the run paths a single recorder.
//
// Layering (docs/ledger-provenance-evaluation.md, "Layering"):
//   packages/ledger      the domain-free core: chain, genesis and authority, checkpoints, the ledger home
//                        (ANCHOR pinning, the key store, create/open, key rotation), the status board
//   pantheon/src/ledger  Pantheon's kinds (facts, seating, escalation, contribution, gate, turn/review,
//                        lease/budget/ref.move, board.anchor) and Pantheon's own composition, which a
//                        Pantheon run opens by default
//   ophanim/ledger       OPHANIM's kinds (efficiency.*, telos.anchor) and this composition: Pantheon's
//                        kinds, under the same names and rules, plus OPHANIM's
// Nothing in pantheon/ imports ophanim/, and packages/ledger imports neither.
//
// Layout under `root` and the trust rules are the ledger home's (packages/ledger/home.mjs).
import {defineKinds} from '../../packages/ledger/chain.mjs';
import {keyStore, OPERATOR, CONTROLLER} from '../../packages/ledger/home.mjs';
import {pantheonLedgerKinds, openPantheonLedger} from '../../pantheon/src/ledger/system.mjs';
import {efficiencyKinds, efficiencyRecorder} from './efficiency-kinds.mjs';

export {keyStore, OPERATOR, CONTROLLER};

/**
 * Every kind the system records, bound to the board it records for (contributions, gates, anchors):
 * Pantheon's kinds, and OPHANIM's efficiency kinds.
 */
export function systemKinds({board = null} = {}) {
  const ctl = a => a.key_id === CONTROLLER;
  return defineKinds({
    ...pantheonLedgerKinds({board}),
    ...efficiencyKinds({authors: {promotion: ctl, events: ctl}}),
  });
}

/**
 * Open the ledger at `root`, creating it on first use. `anchor` (or OPHANIM_LEDGER_ANCHOR) is the
 * genesis hash the caller expects; without one, the ledger's own ANCHOR file is used, which is only as
 * trustworthy as the directory holding it.
 */
export function openSystemLedger({root, board = null, anchor = process.env.OPHANIM_LEDGER_ANCHOR ?? null, checkpointEvery} = {}) {
  const home = openPantheonLedger({root, board, anchor, checkpointEvery, kinds: systemKinds});
  const {ledger, controller} = home;
  /**
   * One recorder for every run path: escalations, turns and reviews, the board's records (Pantheon's
   * recorder), and efficiency records.
   */
  function recorder() {
    const efficiency = efficiencyRecorder({ledger, controller, order: controller});
    const pantheon = home.recorder();
    return {...efficiency, ...pantheon};
  }
  return {ledger, anchor: home.anchor, root: home.root, recorder, rotateSeatKey: home.rotateSeatKey, keys: home.keys};
}
