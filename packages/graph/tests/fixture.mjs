// Shared fixtures for the graph foundation's tests: a REAL packages/ledger chain (its signing, hash chain and canonical
// JSON) with SYNTHETIC keys generated per test, a composed origin registry, and a synthetic source whose versions are
// the digests of JSON snapshots kept on disk (so another process sees the same source). No provider, no real key.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generateSigner} from '../../ledger/chain.mjs';
import {versionOf} from '../identity.mjs';
import {defineOrigins, assertion} from '../schema.mjs';
import {createGraphLedger, openGraph} from '../kinds.mjs';

export const OPERATOR = 'graph-operator';
export const KEY_OF = Object.freeze({extractor: 'extractor-key', tool: 'tool-key', rule: 'rule-key', text: 'text-rule-key', agent: 'agent-key', model: 'model-key', other: 'other-key'});
export const SYSTEM = 'synthetic.system';
export const ORIGINS = defineOrigins({
  'synthetic.extractor': {kind: 'extractor', basis: 'declared', keys: ['extractor-key'], sources: [SYSTEM, 'synthetic.other']},
  'synthetic.tool': {kind: 'tool', basis: 'measured', keys: ['tool-key']},
  'synthetic.rule': {kind: 'rule', basis: 'structural', keys: ['rule-key']},
  'synthetic.text-rule': {kind: 'rule', basis: 'textual', keys: ['text-rule-key']},
  'synthetic.agent': {kind: 'agent', basis: 'inferred', keys: ['agent-key']},
  'synthetic.model': {kind: 'model', basis: 'inferred', keys: ['model-key']},
  'synthetic.other-tool': {kind: 'tool', basis: 'measured', keys: ['other-key']},
});
export const T0 = '2026-11-20T10:00:00.000Z';
export const at = minutes => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

export const id = (domain, type, key) => `ophanim/${domain}/${type}/${key}`;
export const C = key => id('systems', 'component', key);

// A small system with every kind of link an impact question meets (architecture.md "Impact").
export const SYSTEM_SNAPSHOT = Object.freeze({
  entities: {
    [C('sdk-gateway')]: {version: 1}, [C('session')]: {}, [id('capability', 'capability', 'agy-transport')]: {},
    [id('work', 'work-unit', 'u1')]: {}, [id('work', 'plan', 'p1')]: {}, [id('systems', 'contract', 'k1')]: {},
    [id('systems', 'test', 't1')]: {}, [id('learning', 'failure-class', 'f1')]: {}, [id('systems', 'file', 'readme')]: {},
    [C('unrelated-a')]: {}, [C('unrelated-b')]: {},
  },
  relationships: [
    ['depends-on', C('session'), C('sdk-gateway')],
    ['implemented-by', id('capability', 'capability', 'agy-transport'), C('sdk-gateway')],
    ['requires-capability', id('work', 'work-unit', 'u1'), id('capability', 'capability', 'agy-transport')],
    ['depends-on', id('work', 'plan', 'p1'), id('work', 'work-unit', 'u1')],
    ['governs', id('systems', 'contract', 'k1'), C('sdk-gateway')],
    ['verifies', id('systems', 'test', 't1'), C('sdk-gateway')],
    ['detects', id('systems', 'test', 't1'), id('learning', 'failure-class', 'f1')],
    ['mentions', id('systems', 'file', 'readme'), C('sdk-gateway')],
    ['depends-on', C('unrelated-a'), C('unrelated-b')],
  ],
});

/** A snapshot as the extractor's drafts. `reverse` yields the same facts in the opposite order. */
export function draftsOf(snapshot, {reverse = false} = {}) {
  const out = [...Object.entries(snapshot.entities).map(([entity, attributes]) => ({entity, attributes, ref: `snapshot#${entity}`})),
    ...snapshot.relationships.map(([type, from, to, attributes = {}]) => ({type, from, to, attributes}))];
  return reverse ? out.reverse() : out;
}

/** Publish a snapshot of source `sourceId` under `root`: its version is the snapshot's digest; every version stays readable. */
export function publish(root, sourceId, snapshot) {
  const dir = path.join(root, sourceId), version = versionOf(snapshot);
  fs.mkdirSync(path.join(dir, 'versions'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'versions', version.slice(7) + '.json'), JSON.stringify(snapshot));
  fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify(snapshot));
  return version;
}
/** The adapter of a published source. `reverse`: yield facts in the opposite order; `gone`: every read fails. */
export function dirSource(root, sourceId = SYSTEM, {reverse = false, extractor = 'synthetic.extractor', gone = () => false} = {}) {
  const dir = path.join(root, sourceId);
  return {
    id: sourceId, extractor, authority: 'synthetic test source (a JSON snapshot on disk)', ref: `${sourceId}/current.json`,
    current() {
      if (gone()) throw new Error('the source is not reachable');
      return {version: versionOf(JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8')))};
    },
    readAt(version) {
      if (gone()) throw new Error('the source is not reachable');
      return draftsOf(JSON.parse(fs.readFileSync(path.join(dir, 'versions', version.slice(7) + '.json'), 'utf8')), {reverse});
    },
  };
}

export const tmp = (prefix = 'graph-test-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const publicOf = keys => Object.fromEntries(Object.entries(keys).map(([k, s]) => [k, s.publicJwk]));

/**
 * A graph world for one test: a fresh ledger with synthetic keys (saved beside it for child processes), the synthetic
 * system source published, and helpers. Removed after the test.
 */
export function world(t, {snapshot = SYSTEM_SNAPSHOT, checkpointEvery = 64} = {}) {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const keys = Object.fromEntries([OPERATOR, ...Object.values(KEY_OF)].map(k => [k, generateSigner(k)]));
  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify(keys));
  const ledgerDir = path.join(dir, 'ledger'), srcRoot = path.join(dir, 'src');
  fs.mkdirSync(ledgerDir, {recursive: true});
  publish(srcRoot, SYSTEM, snapshot);
  const authority = {keyring: publicOf(keys), orderer: OPERATOR, operators: [OPERATOR]};
  const anchor = createGraphLedger({dir: ledgerDir, authority, operator: keys[OPERATOR], order: keys[OPERATOR]});
  fs.writeFileSync(path.join(dir, 'anchor'), anchor);
  const by = name => ({signer: keys[KEY_OF[name]], order: keys[OPERATOR]});
  const open = (o = {}) => openGraph({dir: ledgerDir, anchor, origins: ORIGINS, sources: o.sources ?? [dirSource(srcRoot)], checkpointEvery, ...o});
  return {dir, ledgerDir, srcRoot, anchor, keys, authority, by, open, publish: s => publish(srcRoot, SYSTEM, s)};
}

/** Provenance for a record a test writes directly (a tool's observation, a rule's derivation, an agent's proposal). */
export const src = (sourceId, version = null) => ({id: sourceId, authority: 'synthetic test origin', ref: `${sourceId}#test`, version});
export const RUN = Object.freeze({id: 'run-1'});
export const V1 = 'sha256:' + '1'.repeat(64);

/** `n` distinct observations a tool would record, the same in every process. */
export const planned = (n, prefix = 'kill') => Array.from({length: n}, (_, i) => assertion({entity: id('evidence', 'observation', `${prefix}-${i}`),
  origin: 'synthetic.tool', classification: 'observed', source: src('synthetic.runs', V1), run: {id: `run-${prefix}-${i}`}, observed_at: T0, attributes: {i}}));
