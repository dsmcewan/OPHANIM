// Pantheon's ledger by default: the ledger home (packages/ledger) opened with Pantheon's kinds, and one
// recorder for the run path (escalations, turns and reviews, the board's runtime records, ship verdicts).
//
// The kinds and their rules are Pantheon's, and they are registered under the same names and authors
// in OPHANIM's full composition (ophanim/ledger/system.mjs `systemKinds`, which adds the efficiency
// kinds). So a ledger a Pantheon run writes verifies when OPHANIM opens it.
//
// The other direction (docs/ledger-provenance-evaluation.md, "Shared ledgers and the run-path gate"):
// Pantheon's kinds are the `pantheon` domain, declared in the ledger's authority (packages/ledger
// chain.mjs, "Domains"). On a ledger that also holds a domain Pantheon does not supply (OPHANIM's
// efficiency records), Pantheon checks those entries structurally (chain, signatures, keyring author,
// intact payload), never re-derives or appends them, and reports them in `verify().foreign`. A kind no
// domain declared is still refused: the registry stays closed.
import {openLedgerHome, defineKinds, OPERATOR, CONTROLLER} from '../../../packages/ledger/index.mjs';
import {pantheonKinds, escalationRecorder} from './kinds.mjs';
import {lineageKinds, lineageRecorder, seatKeyId} from './lineage-kinds.mjs';
import {gateKinds} from './gate-kind.mjs';
import {boardAnchorKinds, boardResolver} from './anchors.mjs';
import {boardKinds, boardRecorder} from './board-kinds.mjs';
import {cycleKinds, cycleRecorder} from './cycle-kinds.mjs';
import {practiceKinds, practiceRecorder} from './practice-kinds.mjs';
import {boardScopes} from './scopes.mjs';

export {OPERATOR, CONTROLLER};
export const PANTHEON_DOMAIN = 'pantheon';

/**
 * Every kind a Pantheon run records. The board-bound kinds (contribution, gate, ref.move) name the board
 * they belong to (`scope`, its root) and re-derive against it through one resolver (scopes.mjs): the
 * board the ledger was opened with, or another board read-only, or, with neither, only what needs no
 * board, noted in the verify result. `board.anchor` re-derives against the opened board only.
 * Returned unfrozen, so a composition can add its own kinds before defineKinds.
 */
export function pantheonLedgerKinds({board = null} = {}) {
  const op = a => a.key_id === OPERATOR, ctl = a => a.key_id === CONTROLLER;
  const scopes = boardScopes(board);
  return {
    ...pantheonKinds({authors: {inputs: op, decisions: ctl}, board, scopes}),
    ...lineageKinds(),
    ...boardKinds({authors: ctl, board, scopes}),
    ...cycleKinds({authors: ctl}),
    ...practiceKinds({authors: ctl}),
    ...gateKinds({authors: ctl, board, scopes}),
    ...(board ? boardAnchorKinds({board: boardResolver(board), authors: ctl}) : {}),
  };
}

/** Pantheon's kinds as a closed registry. */
export const pantheonSystemKinds = ({board = null} = {}) => defineKinds(pantheonLedgerKinds({board}));

/**
 * The domain Pantheon's kinds make up, as the ledger's authority declares it: every kind name, whether
 * or not this registry was built with a board (`board.anchor` is registered only with one).
 */
export const pantheonDomains = () => ({[PANTHEON_DOMAIN]: [...new Set([...Object.keys(pantheonLedgerKinds()), 'board.anchor'])].sort()});

/**
 * Open the ledger at `root` with Pantheon's kinds, creating it on first use. `anchor` (or
 * OPHANIM_LEDGER_ANCHOR, the variable the run path has always read) is the genesis hash the caller
 * expects. `kinds({board})` replaces the registry and `domains()` the kind sets it supplies: OPHANIM
 * passes its full composition here.
 */
export function openPantheonLedger({root, board = null, anchor = process.env.OPHANIM_LEDGER_ANCHOR ?? null, checkpointEvery, kinds = pantheonSystemKinds,
  domains = pantheonDomains} = {}) {
  const home = openLedgerHome({root, kinds: kinds({board}), anchor, checkpointEvery, domains: domains()});
  const {ledger, keys, operator, controller} = home;
  /** Rotate a seat occupancy's key: revoke the old public key, then admit the new one. */
  const rotateSeatKey = seat => home.rotateKey(seatKeyId(seat));

  /**
   * One recorder for the run path: escalations, turns and reviews. `board(scope)` is the board's
   * recorder (lease rows, budget limits, ref moves, ship verdicts) for openBoard's `ledger` option, with `scope` the
   * board root.
   */
  function recorder() {
    const escalation = escalationRecorder({ledger, controller, order: controller, operator});
    const lineage = lineageRecorder({ledger, operator, order: controller, keys});
    const board = scope => boardRecorder({ledger, controller, order: controller, scope});
    const cycle = cycleRecorder({ledger, controller, order: controller});
    const practice = practiceRecorder({ledger, controller, order: controller});
    return {...escalation, ...lineage, ...cycle, ...practice, board, verify: () => ledger.verify(), ledger, anchor: home.anchor, rotateSeatKey};
  }
  return {ledger, anchor: home.anchor, root: home.root, recorder, rotateSeatKey, keys, operator, controller};
}
