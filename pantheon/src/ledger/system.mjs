// Pantheon's ledger by default: the ledger home (packages/ledger) opened with Pantheon's kinds, and one
// recorder for the run path (escalations, turns and reviews, the board's runtime records).
//
// The kinds and their rules are Pantheon's, and they are registered under the same names and authors
// in OPHANIM's full composition (ophanim/ledger/system.mjs `systemKinds`, which adds the efficiency
// kinds). So a ledger a Pantheon run writes verifies when OPHANIM opens it. The reverse holds only for a
// ledger with no OPHANIM-only entries: a ledger that already carries efficiency records is opened with
// OPHANIM's composition (pass its recorder as `runOpenItem({ledger})`), since a closed registry refuses
// a kind it does not know.
import {openLedgerHome, defineKinds, OPERATOR, CONTROLLER} from '../../../packages/ledger/index.mjs';
import {pantheonKinds, escalationRecorder} from './kinds.mjs';
import {lineageKinds, lineageRecorder, seatKeyId} from './lineage-kinds.mjs';
import {gateKinds} from './gate-kind.mjs';
import {boardAnchorKinds, boardResolver} from './anchors.mjs';
import {boardKinds, boardRecorder} from './board-kinds.mjs';
import {cycleKinds, cycleRecorder} from './cycle-kinds.mjs';

export {OPERATOR, CONTROLLER};

/**
 * Every kind a Pantheon run records, bound to the board it records for (contributions, gates, anchors).
 * The board's runtime records (lease, budget, ref.move) are always registered: their entries name the
 * board they belong to, and ref moves are checked against that board's store wherever it is.
 * Returned unfrozen, so a composition can add its own kinds before defineKinds.
 */
export function pantheonLedgerKinds({board = null} = {}) {
  const op = a => a.key_id === OPERATOR, ctl = a => a.key_id === CONTROLLER;
  return {
    ...pantheonKinds({authors: {inputs: op, decisions: ctl}, board}),
    ...lineageKinds(),
    ...boardKinds({authors: ctl, board}),
    ...cycleKinds({authors: ctl}),
    ...(board ? gateKinds({authors: ctl, board}) : {}),
    ...(board ? boardAnchorKinds({board: boardResolver(board), authors: ctl}) : {}),
  };
}

/** Pantheon's kinds as a closed registry. */
export const pantheonSystemKinds = ({board = null} = {}) => defineKinds(pantheonLedgerKinds({board}));

/**
 * Open the ledger at `root` with Pantheon's kinds, creating it on first use. `anchor` (or
 * OPHANIM_LEDGER_ANCHOR, the variable the run path has always read) is the genesis hash the caller
 * expects. `kinds({board})` replaces the registry: OPHANIM passes its full composition here.
 */
export function openPantheonLedger({root, board = null, anchor = process.env.OPHANIM_LEDGER_ANCHOR ?? null, checkpointEvery, kinds = pantheonSystemKinds} = {}) {
  const home = openLedgerHome({root, kinds: kinds({board}), anchor, checkpointEvery});
  const {ledger, keys, operator, controller} = home;
  /** Rotate a seat occupancy's key: revoke the old public key, then admit the new one. */
  const rotateSeatKey = seat => home.rotateKey(seatKeyId(seat));

  /**
   * One recorder for the run path: escalations, turns and reviews. `board(scope)` is the board's
   * recorder (lease rows, budget limits, ref moves) for openBoard's `ledger` option, with `scope` the
   * board root.
   */
  function recorder() {
    const escalation = escalationRecorder({ledger, controller, order: controller, operator});
    const lineage = lineageRecorder({ledger, operator, order: controller, keys});
    const board = scope => boardRecorder({ledger, controller, order: controller, scope});
    const cycle = cycleRecorder({ledger, controller, order: controller});
    return {...escalation, ...lineage, ...cycle, board, verify: () => ledger.verify(), ledger, anchor: home.anchor, rotateSeatKey};
  }
  return {ledger, anchor: home.anchor, root: home.root, recorder, rotateSeatKey, keys, operator, controller};
}
