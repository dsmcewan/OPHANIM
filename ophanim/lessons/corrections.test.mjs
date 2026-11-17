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

test('the current record: repeated classes are named, and success is not claimed', () => {
  const r = report(load());
  assert.ok(r.repeated_classes.includes('unqualified-claim-as-measurement'), 'the owner raised it more than once');
  assert.equal(r.success.demonstrated, false);
});
