// The ledger by default: one place that opens (or creates) a ledger with every kind registered, holds
// its keys, and hands the run paths a single recorder.
//
// Layout under `root`:
//   chain.jsonl, objects/     the chain (chain.mjs)
//   ANCHOR                    the genesis hash this ledger is read against
//   keys/ (0700)              private keys, one file each (0600): operator, controller, and one per
//                             seat occupancy. Keys never enter the chain; only public keys do, through
//                             genesis and operator-signed authority entries.
//
// Trust: a ledger is read against a pinned genesis hash. On first use the ledger is created and its
// genesis written to ANCHOR. If the caller (or OPHANIM_LEDGER_ANCHOR) names an expected anchor, the
// ledger must match it; a ledger that names its own authority otherwise is refused, as in K2.
//
// Custody is a local key store with owner-only permissions: it refuses keys anyone else can read. A
// hardware or remote signer would replace `keyStore` without changing the chain.
import fs from 'node:fs';
import path from 'node:path';
import {openLedger, createLedger, defineKinds, generateSigner, AUTHORITY} from './chain.mjs';
import {pantheonKinds, escalationRecorder} from './kinds.mjs';
import {lineageKinds, lineageRecorder, seatKeyId} from './lineage-kinds.mjs';
import {efficiencyKinds, efficiencyRecorder} from './efficiency-kinds.mjs';
import {gateKinds} from './gate-kind.mjs';
import {anchorKinds, boardResolver} from './anchors.mjs';
import {boardKinds, boardRecorder} from './board-kinds.mjs';

export const OPERATOR = 'operator';
export const CONTROLLER = 'controller';
const fail = why => { throw Object.assign(new Error(why), {code: 'LEDGER_REFUSED'}); };
const SHA = /^sha256:[0-9a-f]{64}$/;

/** Owner-only private key files. A key readable by anyone else is refused, not repaired. */
export function keyStore(dir) {
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  if ((fs.statSync(dir).mode & 0o077) !== 0) fail(`key directory ${dir} is readable by others`);
  const file = id => path.join(dir, encodeURIComponent(id) + '.json');
  return {
    get(id) {
      const f = file(id);
      if (!fs.existsSync(f)) return null;
      if ((fs.statSync(f).mode & 0o077) !== 0) fail(`private key ${id} is readable by others`);
      const k = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (k.key_id !== id || typeof k.privatePem !== 'string') fail(`key file for ${id} is not that key`);
      return k;
    },
    put(signer) {
      const f = file(signer.key_id);
      if (fs.existsSync(f)) fail(`a key for ${signer.key_id} is already held; rotate it instead`);
      fs.writeFileSync(f, JSON.stringify(signer), {mode: 0o600, flag: 'wx'});
      return signer;
    },
    replace(signer) {
      const f = file(signer.key_id), tmp = f + '.next';
      fs.writeFileSync(tmp, JSON.stringify(signer), {mode: 0o600});
      fs.renameSync(tmp, f);
      return signer;
    },
  };
}

/**
 * Every kind the system records, bound to the board it records for (contributions, gates, anchors).
 * The board's runtime records (lease, budget, ref.move) are always registered: their entries name the
 * board they belong to, and ref moves are checked against that board's store wherever it is.
 */
export function systemKinds({board = null} = {}) {
  const op = a => a.key_id === OPERATOR, ctl = a => a.key_id === CONTROLLER;
  return defineKinds({
    ...pantheonKinds({authors: {inputs: op, decisions: ctl}, board}),
    ...lineageKinds(),
    ...efficiencyKinds({authors: {promotion: ctl, events: ctl}}),
    ...boardKinds({authors: ctl, board}),
    ...(board ? gateKinds({authors: ctl, board}) : {}),
    ...(board ? anchorKinds({board: boardResolver(board), authors: ctl}) : {}),
  });
}

/**
 * Open the ledger at `root`, creating it on first use. `anchor` (or OPHANIM_LEDGER_ANCHOR) is the
 * genesis hash the caller expects; without one, the ledger's own ANCHOR file is used, which is only as
 * trustworthy as the directory holding it.
 */
export function openSystemLedger({root, board = null, anchor = process.env.OPHANIM_LEDGER_ANCHOR ?? null, checkpointEvery} = {}) {
  if (!root || !path.isAbsolute(root)) fail('an absolute ledger root is required');
  if (anchor !== null && !SHA.test(anchor)) fail('an expected anchor is a sha256 genesis hash');
  fs.mkdirSync(root, {recursive: true, mode: 0o700});
  const keys = keyStore(path.join(root, 'keys'));
  const anchorFile = path.join(root, 'ANCHOR');
  let pinned = fs.existsSync(anchorFile) ? fs.readFileSync(anchorFile, 'utf8').trim() : null;
  if (!pinned) {
    if (fs.existsSync(path.join(root, 'chain.jsonl'))) fail('a ledger without its ANCHOR is not opened: its genesis cannot be checked');
    if (anchor) fail('the expected anchor names a ledger that does not exist here');
    const operator = keys.put(generateSigner(OPERATOR)), controller = keys.put(generateSigner(CONTROLLER));
    pinned = createLedger({dir: root, operator, order: controller,
      authority: {keyring: {[OPERATOR]: operator.publicJwk, [CONTROLLER]: controller.publicJwk}, orderer: CONTROLLER, operators: [OPERATOR]}});
    fs.writeFileSync(anchorFile, pinned + '\n', {mode: 0o600});
  }
  if (anchor && anchor !== pinned) fail('this ledger is not the one the caller pinned');
  const ledger = openLedger({dir: root, kinds: systemKinds({board}), anchor: pinned, ...(checkpointEvery ? {checkpointEvery} : {})});
  const state = ledger.verify();
  if (!state.ok) fail(`ledger does not verify: ${state.why}`);
  const operator = keys.get(OPERATOR), controller = keys.get(CONTROLLER);
  if (!operator || !controller) fail('the operator and controller keys are not held here');
  const same = (a, b) => a && b && a.x === b.x && a.crv === b.crv;
  if (!same(state.authority.keys[OPERATOR], operator.publicJwk) || !same(state.authority.keys[CONTROLLER], controller.publicJwk)) {
    fail('the held operator or controller key is not the one the ledger\'s authority names');
  }

  /** Rotate a seat occupancy's key: revoke the old public key, then admit the new one. */
  function rotateSeatKey(seat) {
    const id = seatKeyId(seat), next = generateSigner(id);
    const by = {author: {key_id: OPERATOR}, signer: operator, order: controller};
    if (ledger.verify().authority.keys[id]) ledger.append({kind: AUTHORITY, payload: {revoke: [id]}, ...by});
    ledger.append({kind: AUTHORITY, payload: {add: {[id]: next.publicJwk}}, ...by});
    return keys.replace(next);
  }

  /**
   * One recorder for every run path: escalations, turns and reviews, and efficiency records.
   * `board(scope)` is the board's recorder (lease rows, budget limits, ref moves) for openBoard's
   * `ledger` option, with `scope` the board root.
   */
  function recorder() {
    const efficiency = efficiencyRecorder({ledger, controller, order: controller});
    const escalation = escalationRecorder({ledger, controller, order: controller, operator});
    const lineage = lineageRecorder({ledger, operator, order: controller, keys});
    const board = scope => boardRecorder({ledger, controller, order: controller, scope});
    return {...efficiency, ...escalation, ...lineage, board, verify: () => ledger.verify(), ledger, anchor: pinned, rotateSeatKey};
  }
  return {ledger, anchor: pinned, root, recorder, rotateSeatKey, keys};
}
