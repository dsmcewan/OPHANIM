// A ledger home: one directory that holds a chain, the genesis hash it is read against, and its keys.
// Kind-free: the caller passes the kind registry, so a domain (Pantheon's kinds, OPHANIM's) composes
// what it records without this package knowing any of them.
//
// Layout under `root`:
//   chain.jsonl, objects/     the chain (chain.mjs)
//   ANCHOR                    the genesis hash this ledger is read against
//   keys/ (0700)              private keys, one file each (0600): operator, controller, and any other
//                             key a domain admits (one per seat occupancy, for Pantheon). Keys never
//                             enter the chain; only public keys do, through genesis and operator-signed
//                             authority entries.
//
// Trust: a ledger is read against a pinned genesis hash. On first use the ledger is created and its
// genesis written to ANCHOR. If the caller names an expected anchor, the ledger must match it; a ledger
// that names its own authority otherwise is refused, as in K2.
//
// Custody is a local key store with owner-only permissions: it refuses keys anyone else can read. A
// hardware or remote signer would replace `keyStore` without changing the chain.
import fs from 'node:fs';
import path from 'node:path';
import {openLedger, createLedger, defineKinds, generateSigner, AUTHORITY} from './chain.mjs';

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
 * Open the ledger at `root` with the kind registry `kinds`, creating it on first use (genesis: the
 * operator and controller keys, the controller ordering). `anchor` is the genesis hash the caller
 * expects; without one, the ledger's own ANCHOR file is used, which is only as trustworthy as the
 * directory holding it.
 *
 * `domains` ({name: [kind]}, optional) names the kind sets this composition supplies; every kind of the
 * registry is in exactly one of them. A new ledger declares them in its genesis. On an existing ledger,
 * a supplied domain (or kind) the authority has not declared yet is declared by an operator-signed
 * authority entry just before its first entry is appended, so a reader that does not supply it can
 * tell its entries from unknown ones (chain.mjs, "Domains"). Opening never writes.
 */
export function openLedgerHome({root, kinds, anchor = null, checkpointEvery, domains = null} = {}) {
  if (!root || !path.isAbsolute(root)) fail('an absolute ledger root is required');
  if (anchor !== null && !SHA.test(anchor)) fail('an expected anchor is a sha256 genesis hash');
  if (!kinds || typeof kinds !== 'object') fail('a kind registry is required');
  if (domains !== null) {
    for (const kind of Object.keys(kinds)) {
      const n = Object.values(domains).filter(ks => ks.includes(kind)).length;
      if (n !== 1) fail(`kind "${kind}" is in ${n} of the supplied domains; every kind is in exactly one`);
    }
  }
  fs.mkdirSync(root, {recursive: true, mode: 0o700});
  const keys = keyStore(path.join(root, 'keys'));
  const anchorFile = path.join(root, 'ANCHOR');
  let pinned = fs.existsSync(anchorFile) ? fs.readFileSync(anchorFile, 'utf8').trim() : null;
  if (!pinned) {
    if (fs.existsSync(path.join(root, 'chain.jsonl'))) fail('a ledger without its ANCHOR is not opened: its genesis cannot be checked');
    if (anchor) fail('the expected anchor names a ledger that does not exist here');
    const operator = keys.put(generateSigner(OPERATOR)), controller = keys.put(generateSigner(CONTROLLER));
    pinned = createLedger({dir: root, operator, order: controller,
      authority: {keyring: {[OPERATOR]: operator.publicJwk, [CONTROLLER]: controller.publicJwk}, orderer: CONTROLLER, operators: [OPERATOR],
        ...(domains ? {domains} : {})}});
    fs.writeFileSync(anchorFile, pinned + '\n', {mode: 0o600});
  }
  if (anchor && anchor !== pinned) fail('this ledger is not the one the caller pinned');
  const chain = openLedger({dir: root, kinds: Object.isFrozen(kinds) ? kinds : defineKinds(kinds), anchor: pinned,
    ...(checkpointEvery ? {checkpointEvery} : {}), ...(domains ? {domains: Object.keys(domains)} : {})});
  const state = chain.verify();
  if (!state.ok) fail(`ledger does not verify: ${state.why}`);
  // Declared lazily, before the first entry of a supplied domain the authority does not name yet.
  let declared = state.authority.domains ?? {};
  const append = args => {
    const d = domains && args.kind !== AUTHORITY ? Object.entries(domains).find(([, ks]) => ks.includes(args.kind))?.[0] : null;
    if (d && !(declared[d] ?? []).includes(args.kind)) {
      const missing = domains[d].filter(k => !(declared[d] ?? []).includes(k));
      chain.append({kind: AUTHORITY, payload: {domains: {[d]: missing}}, author: {key_id: OPERATOR}, signer: operator, order: controller});
      declared = chain.verify({mode: 'frontier'}).authority.domains;
    }
    return chain.append(args);
  };
  const ledger = {...chain, append};
  const operator = keys.get(OPERATOR), controller = keys.get(CONTROLLER);
  if (!operator || !controller) fail('the operator and controller keys are not held here');
  const same = (a, b) => a && b && a.x === b.x && a.crv === b.crv;
  if (!same(state.authority.keys[OPERATOR], operator.publicJwk) || !same(state.authority.keys[CONTROLLER], controller.publicJwk)) {
    fail('the held operator or controller key is not the one the ledger\'s authority names');
  }

  /** Rotate a key the ledger's authority admits: revoke the old public key, then admit a new one. */
  function rotateKey(id) {
    const next = generateSigner(id);
    const by = {author: {key_id: OPERATOR}, signer: operator, order: controller};
    if (ledger.verify().authority.keys[id]) ledger.append({kind: AUTHORITY, payload: {revoke: [id]}, ...by});
    ledger.append({kind: AUTHORITY, payload: {add: {[id]: next.publicJwk}}, ...by});
    return keys.replace(next);
  }
  return {ledger, anchor: pinned, root, keys, operator, controller, rotateKey};
}
