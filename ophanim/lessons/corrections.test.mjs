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

// OWNER RULING 2026-11-20 (PR 68): discovering a defect, repairing it, and proving that a reusable mechanism would catch
// its recurrence are three things. A review that finds one is evidence the REVIEW worked. The lesson mechanism succeeds
// only when the class's own registered check detects the class, and the mechanism corrects it, without the owner.
const withTest = {kind: 'test', file: 'ophanim/lessons/corrections.test.mjs', name: 'OWN registered check to have detected'};
const cls = (...later) => ({id: 'k', class: 'c', source: 's', fixed_in: 'x', detector: withTest, instances: [{observed_by: 'owner', date: '2026-11-16'}, ...later]});

test('success needs the class\'s OWN registered check to have detected a class the owner raised, and the mechanism to have corrected it; a detection the owner corrected, or one another check made, is not success', () => {
  const own = corrected => ({observed_by: 'mechanism', by_detector: true, corrected_by: corrected, date: '2026-11-17'});
  assert.equal(report({classes: [cls(own('owner'))]}).success.demonstrated, false, 'the owner corrected it');
  assert.deepEqual(report({classes: [cls(own('mechanism'))]}).success, {demonstrated: true, classes: ['k']});
  // Another check found it (a mutation run, a suite, a reading of the code): a detection, and not the registered one.
  const other = report({classes: [cls({observed_by: 'mechanism', corrected_by: 'mechanism', date: '2026-11-17', detected_by: 'a mutation run'})]});
  assert.equal(other.success.demonstrated, false);
  assert.deepEqual([other.classes[0].detections, other.classes[0].detected_by_own_check], [1, 0]);
  // The registered check fired BEFORE the owner ever raised the class: not "a previously observed class".
  const before = {...cls(), instances: [{...own('mechanism'), date: '2026-11-15'}, {observed_by: 'owner', date: '2026-11-16'}]};
  assert.equal(report({classes: [before]}).success.demonstrated, false);
});

test('an instance an independent review found is evidence that the review worked: it is counted apart from the mechanism\'s detections and never makes success, corrected or not', () => {
  const r = report({classes: [cls({observed_by: 'review', corrected_by: 'mechanism', date: '2026-11-18', detected_by: 'a fresh reviewer given the change'})]});
  assert.deepEqual([r.classes[0].found_by_review, r.classes[0].detections, r.classes[0].detected_by_own_check, r.classes[0].owner_interventions], [1, 0, 0, 1]);
  assert.equal(r.success.demonstrated, false);
  assert.deepEqual(r.review_found, [{class: 'k', instances: 1}]);
  // A review's find is not an intervention of the owner either: the owner's series does not count it.
  assert.deepEqual(r.interventions_by_date, [{date: '2026-11-16', owner_interventions: 1}]);
});

test('discovery, repair and proof of recurrence are reported apart: an instance is repaired when it says who corrected it, and its recurrence is proven only when it names the reusable check that was seen to catch it', () => {
  const r = report({classes: [cls({observed_by: 'review', date: '2026-11-18', detected_by: 'a reviewer'},
    {observed_by: 'mechanism', corrected_by: 'integrator', date: '2026-11-19', detected_by: 'a mutation run'},
    {observed_by: 'mechanism', corrected_by: 'integrator', date: '2026-11-20', detected_by: 'a mutation run', recurrence_check: 'x.test.mjs :: writes from inside the jail; seen to fail under mutation RS8'})]});
  assert.deepEqual([r.classes[0].discovered, r.classes[0].repaired, r.classes[0].recurrence_proven], [4, 2, 1]);
});

test('the registry refuses what would blur them: the registered check claimed for a class that has none, or claimed by an owner\'s or a review\'s instance; an observer that is not owner, review or mechanism; a review instance that does not say which review', () => {
  const base = {schema: 'ophanim.owner-corrections/v1'};
  const one = (detector, instance) => problems({...base, classes: [{id: 'k', class: 'c', source: 's', detector, instances: [instance]}]});
  const none = {kind: 'none', why: 'w', next: 'n'};
  assert.match(one(none, {observed_by: 'mechanism', by_detector: true, date: 'd'}).join('; '), /k: an instance claims the class's registered check \(by_detector\), and the class has none/);
  assert.match(one(withTest, {observed_by: 'review', by_detector: true, date: 'd', detected_by: 'a reviewer'}).join('; '), /k: by_detector is for an instance the registered check found, not one a review or the owner found/);
  assert.match(one(withTest, {observed_by: 'owner', by_detector: true, date: 'd'}).join('; '), /k: by_detector is for an instance the registered check found/);
  assert.match(one(withTest, {observed_by: 'reviewer', date: 'd'}).join('; '), /k: instance observed_by must be owner, review or mechanism/);
  assert.match(one(withTest, {observed_by: 'review', date: 'd'}).join('; '), /k: an instance a review found says which review \(detected_by\)/);
  assert.deepEqual(one(withTest, {observed_by: 'review', date: 'd', detected_by: 'the third independent review'}), []);
});

test('the current record: repeated classes are named, and success is not claimed', () => {
  const r = report(load());
  assert.ok(r.repeated_classes.includes('unqualified-claim-as-measurement'), 'the owner raised it more than once');
  assert.equal(r.success.demonstrated, false);
  // What the independent reviews of this repository found is on the record as theirs, and no class is counted as
  // detected by its own registered check: none has been.
  assert.ok(r.review_found.length >= 3, JSON.stringify(r.review_found));
  assert.deepEqual(r.classes.filter(c => c.detected_by_own_check > 0).map(c => c.id), []);
});
