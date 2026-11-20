// The owner-corrections registry must stay honest: every class names an existing detector test or says why it has
// none, and success is never reported from a detection the owner had to correct (owner conditions 2026-11-17).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {load, problems, report} from './corrections.mjs';

test('every correction class names an existing detector test, or states why it has none and the next step', () => {
  assert.deepEqual(problems(load()), []);
});

test('a detector that does not exist, or a missing detector without a reason, is a problem, not a pass', () => {
  const reg = {schema: 'ophanim.owner-corrections/v1', classes: [
    {id: 'a', class: 'c', source: 's', instances: [{observed_by: 'owner', date: '2026-11-17'}], detector: {kind: 'test', file: 'nope.test.mjs', name: 'x'}},
    {id: 'b', class: 'c', source: 's', instances: [{observed_by: 'owner', date: '2026-11-17'}], detector: {kind: 'none'}},
  ]};
  assert.equal(problems(reg).length, 2);
});

test('success needs a class the owner raised that the mechanism then detected AND corrected; a detection the owner corrected is not success', () => {
  const cls = corrected => ({id: 'k', class: 'c', source: 's', fixed_in: 'x', detector: {kind: 'none', why: 'w', next: 'n'},
    instances: [{observed_by: 'owner', date: '2026-11-16'}, {observed_by: 'mechanism', corrected_by: corrected, date: '2026-11-17'}]});
  assert.equal(report({classes: [cls('owner')]}).success.demonstrated, false);
  assert.deepEqual(report({classes: [cls('mechanism')]}).success, {demonstrated: true, classes: ['k']});
});

// The ordering cases. The criterion is about sequence (the owner raised it, LATER the mechanism handled it alone),
// so each case fixes who came first; counting instances without their dates reported success for the reverse order.
const owner = date => ({observed_by: 'owner', date});
const mechanism = date => ({observed_by: 'mechanism', corrected_by: 'mechanism', date});
const ordered = (...instances) => report({classes: [{id: 'k', class: 'c', source: 's', fixed_in: 'x',
  detector: {kind: 'none', why: 'w', next: 'n'}, instances}]});

test('owner raises a class, the mechanism later detects and corrects it: success', () => {
  assert.deepEqual(ordered(owner('2026-11-17'), mechanism('2026-11-19')).success, {demonstrated: true, classes: ['k']});
});

test('the mechanism met a class first and the owner still had to raise it later: not success', () => {
  assert.equal(ordered(mechanism('2026-11-17'), owner('2026-11-19')).success.demonstrated, false);
});

test('owner, mechanism, then the owner again: the owner had to raise it again, so not success, and the class is repeated', () => {
  const r = ordered(owner('2026-11-16'), mechanism('2026-11-17'), owner('2026-11-19'));
  assert.equal(r.success.demonstrated, false);
  assert.deepEqual(r.repeated_classes, ['k']);
});

test('owner and mechanism instances on the same day: the record cannot order them, so not success', () => {
  assert.equal(ordered(owner('2026-11-17'), mechanism('2026-11-17')).success.demonstrated, false);
  assert.equal(ordered(mechanism('2026-11-17'), owner('2026-11-17')).success.demonstrated, false, 'the order instances are listed in is not evidence');
});

test('an instance without a date cannot be ordered, so it cannot support success', () => {
  assert.equal(ordered({observed_by: 'owner'}, mechanism('2026-11-19')).success.demonstrated, false);
  assert.equal(ordered(owner('2026-11-17'), {observed_by: 'mechanism', corrected_by: 'mechanism'}).success.demonstrated, false);
});

test('after a repeat, a mechanism correction later than every owner instance is success, and the class stays repeated', () => {
  const r = ordered(owner('2026-11-16'), mechanism('2026-11-17'), owner('2026-11-18'), mechanism('2026-11-20'));
  assert.deepEqual(r.success, {demonstrated: true, classes: ['k']});
  assert.deepEqual(r.repeated_classes, ['k']);
});

test('the current record: repeated classes are named, and success is not claimed', () => {
  const r = report(load());
  assert.ok(r.repeated_classes.includes('unqualified-claim-as-measurement'), 'the owner raised it more than once');
  assert.equal(r.success.demonstrated, false);
});
