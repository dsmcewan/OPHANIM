// The contract's static half: identity (KD3), the relationship registry and its document (KD6), and the record
// checks that need no graph state (KD4, KD5).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {idRefusal, parseId, entityId, decodeKey, encodeKey, versionOf, VERSION, RELATIONSHIPS, RELATIONSHIP_TYPES, admits, assertion,
  recordRefusal, relationshipRows, entityRows, defineOrigins, CONTRACT_VERSION, GRAPH_SCHEMA} from '../index.mjs';
import {ORIGINS, T0, src, RUN, V1, id, C, SYSTEM} from './fixture.mjs';

const DOC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/knowledge-graph/architecture.md');

test('identity: an id is <instance>/<domain>/<type>/<key>; one that does not parse, or names an unregistered domain or type, is refused', () => {
  for (const good of ['ophanim/learning/failure-class/stored-not-delivered', 'finance-1/systems/change/cbe0622', 'ophanim/systems/module/packages/ledger/chain.mjs']) {
    assert.equal(idRefusal(good), null, good);
  }
  const raw = 'pantheon/tests/output-cap-serialized.test.mjs#fit output';
  const t = entityId({domain: 'systems', type: 'test', key: raw});
  assert.equal(t, 'ophanim/systems/test/pantheon/tests/output-cap-serialized.test.mjs%23fit%20output');
  assert.deepEqual([idRefusal(t), decodeKey(parseId(t).key)], [null, raw], 'a source key round-trips through the encoding');
  assert.equal(encodeKey('a//b'), 'a%2F%2Fb', 'a key with an empty segment keeps its slashes encoded');
  const refusals = {
    '': /is not <instance>/, 'ophanim': /is not <instance>/, 'ophanim/learning/failure-class': /is not <instance>/,
    'ophanim/learning/failure-class/': /key "" is not/, 'Ophanim/learning/failure-class/x': /instance "Ophanim"/,
    'ophanim/finance/ledger/x': /domain "finance" is not one of capability, systems, evidence, learning, work/,
    'ophanim/learning/widget/x': /"widget" is not an entity type of domain "learning"/,
    'ophanim/systems/test/x': null, 'ophanim/learning/failure-class/a b': /not percent-encoded/, 'ophanim/learning/failure-class/a//b': /not percent-encoded/,
    'ophanim/learning/failure-class/x/../y': /"\.\." segment/, 'ophanim/learning/failure-class/%zz': /not percent-encoded/,
  };
  for (const [x, re] of Object.entries(refusals)) {
    if (re === null) assert.equal(idRefusal(x), null, x);
    else assert.match(idRefusal(x) ?? '(accepted)', re, x);
  }
  assert.throws(() => entityId({domain: 'learning', type: 'failure-class', key: ''}), TypeError);
  assert.match(versionOf({a: 1}), VERSION);
  for (const v of ['85a41a91e06f16640e62298b31c18a14f0e2b7c6', V1]) assert.match(v, VERSION);
  assert.doesNotMatch('main', VERSION, 'a branch name is not an immutable version');
});

// The table rows of the block between the two markers.
function tableRows(text, name) {
  const block = new RegExp(`<!-- ${name}:begin -->\\n([\\s\\S]*?)<!-- ${name}:end -->`).exec(text);
  assert.ok(block, `the contract document holds the ${name} table`);
  return block[1].trim().split('\n').slice(2).map(l => l.replace(/^\| | \|$/g, '').split(' | ').map(c => c.replace(/`/g, '').trim()));
}

test('registry: the contract document tabulates exactly the relationship registry and the entity types in code', () => {
  const text = fs.readFileSync(DOC, 'utf8');
  assert.match(text, new RegExp(`${GRAPH_SCHEMA.replace('/', '\\/')}.*contract version ${CONTRACT_VERSION.replace(/\./g, '\\.')}`));
  assert.deepEqual(tableRows(text, 'relationship-registry'), relationshipRows());
  assert.deepEqual(tableRows(text, 'entity-types'), entityRows());
});

test('registry: every relationship the directive names is registered with its meaning, direction, endpoints, symmetry, impact and admission', () => {
  const directive = ['implements', 'depends-on', 'consumes', 'produces', 'governs', 'authorizes', 'verifies', 'derived-from', 'supports', 'contradicts',
    'supersedes', 'introduced-because-of', 'invalidates', 'qualified-for', 'contributed-to', 'shares-failure-mechanism-with'];
  const examples = ['requires-capability', 'implemented-by', 'governed-by', 'verified-by', 'detects', 'documented-in', 'applies-to'];
  for (const t of [...directive, ...examples]) assert.ok(RELATIONSHIP_TYPES.includes(t), t);
  for (const [t, r] of Object.entries(RELATIONSHIPS)) {
    assert.ok(r.meaning.length > 10 && r.from.length && r.to.length && Object.keys(r.admits).length, t);
    assert.equal(r.symmetric, ['contradicts', 'shares-failure-mechanism-with'].includes(t), `${t} symmetry`);
  }
  const inverses = Object.entries(RELATIONSHIPS).filter(([, r]) => r.inverse !== null);
  assert.deepEqual(inverses.map(([t]) => t).sort(), ['governed-by', 'governs', 'implemented-by', 'implements', 'verified-by', 'verifies']);
  for (const [t, r] of inverses) {
    assert.equal(RELATIONSHIPS[r.inverse].inverse, t, `${t} and ${r.inverse} are each other's inverse`);
    assert.deepEqual([RELATIONSHIPS[r.inverse].from, RELATIONSHIPS[r.inverse].to], [r.to, r.from], `${t}: the inverse swaps the endpoints`);
    assert.equal(RELATIONSHIPS[r.inverse].impact, {'to->from': 'from->to', 'from->to': 'to->from'}[r.impact], `${t}: the inverse mirrors the impact`);
  }
  // Correlation, text and inference never become dependency, cause or qualification.
  for (const c of ['authoritative', 'observed', 'derived']) for (const b of ['textual', 'inferred']) {
    for (const t of ['depends-on', 'shares-failure-mechanism-with', 'qualified-for', 'introduced-because-of', 'applies-to']) assert.equal(admits(t, c, b), false, `${t} ${c} from ${b}`);
  }
  assert.equal(admits('depends-on', 'hypothetical', 'inferred'), true, 'a model may PROPOSE a dependency');
  assert.equal(admits('mentions', 'derived', 'textual'), true, 'text is a mention');
  assert.equal(admits('qualified-for', 'authoritative', 'declared'), false, 'a configured preference is not a measured qualification');
  assert.equal(admits('qualified-for', 'observed', 'measured'), true);
  for (const t of ['contradicts', 'supersedes', 'qualified-for', 'eligible-for', 'contributed-to', 'shares-failure-mechanism-with', 'mentions']) assert.equal(RELATIONSHIPS[t].impact, null, `${t} is not followed by impact`);
});

const rec = over => assertion({origin: 'synthetic.agent', classification: 'hypothetical', source: src('synthetic.notes'), observed_at: T0,
  missing_evidence: ['a proposal'], ...over});

test('refusals (static): an unregistered relationship type, a wrong endpoint type, an unregistered origin, a classification its origin may not admit', () => {
  const o = {origins: ORIGINS};
  const fc = id('learning', 'failure-class', 'f1'), test1 = id('systems', 'test', 't1'), lesson = id('learning', 'lesson', 'l1');
  assert.equal(recordRefusal(rec({type: 'detects', from: test1, to: fc}), o), null, 'a well-formed proposal is accepted');
  assert.match(recordRefusal(rec({type: 'causes', from: test1, to: fc}), o) ?? '(accepted)', /relationship type "causes" is not registered/);
  assert.match(recordRefusal(rec({type: 'detects', from: lesson, to: test1}), o) ?? '(accepted)', /detects does not join learning\/lesson to systems\/test/);
  assert.match(recordRefusal(rec({type: 'qualified-for', from: id('capability', 'model', 'm'), to: id('work', 'plan', 'p')}), o) ?? '(accepted)', /does not join/);
  assert.match(recordRefusal(rec({entity: id('learning', 'widget', 'x')}), o) ?? '(accepted)', /"widget" is not an entity type/);
  assert.match(recordRefusal(rec({entity: fc, origin: 'rogue.agent'}), o) ?? '(accepted)', /origin "rogue.agent" is not registered/);
  assert.match(recordRefusal(rec({entity: fc, classification: 'authoritative', source: src(SYSTEM, V1), missing_evidence: []}), o) ?? '(accepted)', /agent origin synthetic.agent may not admit an assertion classified authoritative/);
  assert.match(recordRefusal(rec({entity: fc, origin: 'synthetic.model', classification: 'observed', run: RUN, source: src('x.runs', V1)}), o) ?? '(accepted)', /model origin synthetic.model may not admit an assertion classified observed/);
  assert.match(recordRefusal(rec({entity: fc, origin: 'synthetic.extractor', classification: 'authoritative', source: src('synthetic.elsewhere', V1), missing_evidence: []}), o) ?? '(accepted)', /does not project source "synthetic.elsewhere"/);
  assert.match(recordRefusal(rec({type: 'depends-on', from: C('a'), to: C('b'), origin: 'synthetic.text-rule', classification: 'derived', inputs: [V1], missing_evidence: []}), o) ?? '(accepted)', /depends-on may not be admitted as derived from a textual basis/);
  assert.match(recordRefusal(rec({entity: fc, status: 'verified', verified_by: [V1]}), o) ?? '(accepted)', /a hypothetical assertion is never verified/);
  assert.match(recordRefusal(rec({entity: fc, missing_evidence: []}), o) ?? '(accepted)', /states its missing evidence/);
  assert.match(recordRefusal({...rec({entity: fc}), id: V1}, o) ?? '(accepted)', /assertion id is sha256:/, 'an id that is not its content digest');
  assert.match(recordRefusal({...rec({entity: fc}), extra: 1}, o) ?? '(accepted)', /"extra" is not in ophanim.graph\/v1/);
  assert.throws(() => defineOrigins({x: {kind: 'agent', basis: 'measured', keys: ['k']}}), /agent origins know by inferred, not "measured"/);
  assert.throws(() => defineOrigins({x: {kind: 'extractor', basis: 'declared', keys: ['k']}}), /names the sources it projects/);
});
