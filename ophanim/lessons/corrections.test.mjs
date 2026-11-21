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
  assert.match(one(none, {observed_by: 'mechanism', by_detector: true, date: '2026-11-17'}).join('; '), /k: an instance claims the class's registered check \(by_detector\), and the class has none/);
  assert.match(one(withTest, {observed_by: 'review', by_detector: true, date: '2026-11-17', detected_by: 'a reviewer'}).join('; '), /k: by_detector is for an instance the registered check found, not one a review or the owner found/);
  assert.match(one(withTest, {observed_by: 'owner', by_detector: true, date: '2026-11-17'}).join('; '), /k: by_detector is for an instance the registered check found/);
  assert.match(one(withTest, {observed_by: 'reviewer', date: '2026-11-17'}).join('; '), /k: instance observed_by must be owner, review or mechanism/);
  assert.match(one(withTest, {observed_by: 'review', date: '2026-11-17'}).join('; '), /k: an instance a review found says which review \(detected_by\)/);
  assert.deepEqual(one(withTest, {observed_by: 'review', date: '2026-11-17', detected_by: 'the third independent review'}), []);
});

// The ordering cases (owner criterion, 2026-11-17: a class the owner raised is LATER detected and corrected). Each case
// differs from the success case only in who came when, so counting instances without their dates cannot pass them.
// A date carries no time of day: a pair on the same day cannot be ordered, and an undated instance cannot be placed.
const raised = date => ({observed_by: 'owner', date});
const caught = date => ({observed_by: 'mechanism', by_detector: true, corrected_by: 'mechanism', date});
const ordered = (...instances) => report({classes: [{id: 'k', class: 'c', source: 's', fixed_in: 'x', detector: withTest, instances}]});

test('ordering: the owner raises a class, the registered check later detects it and the mechanism corrects it: success', () => {
  assert.deepEqual(ordered(raised('2026-11-17'), caught('2026-11-19')).success, {demonstrated: true, classes: ['k']});
});

test('ordering: the mechanism met a class first and the owner still had to raise it later: not success', () => {
  assert.equal(ordered(caught('2026-11-17'), raised('2026-11-19')).success.demonstrated, false);
});

test('ordering: owner, mechanism, then the owner again: not success, and the class is repeated', () => {
  const r = ordered(raised('2026-11-16'), caught('2026-11-17'), raised('2026-11-19'));
  assert.equal(r.success.demonstrated, false);
  assert.deepEqual(r.repeated_classes, ['k']);
});

test('ordering: the owner and the mechanism on the same day cannot be ordered, so it is not success, whatever order they are listed in', () => {
  assert.equal(ordered(raised('2026-11-17'), caught('2026-11-17')).success.demonstrated, false);
  assert.equal(ordered(caught('2026-11-17'), raised('2026-11-17')).success.demonstrated, false);
});

test('ordering: an owner instance on the day of the mechanism\'s correction counts as the owner raising it again, so it is not success', () => {
  assert.equal(ordered(raised('2026-11-16'), caught('2026-11-18'), raised('2026-11-18')).success.demonstrated, false);
});

test('ordering: an instance with no date cannot be placed, so it cannot support success or be ignored', () => {
  assert.equal(ordered(raised('2026-11-17'), caught(undefined)).success.demonstrated, false);
  assert.equal(ordered(raised(undefined), caught('2026-11-19')).success.demonstrated, false);
  assert.equal(ordered(raised('2026-11-16'), raised(undefined), caught('2026-11-19')).success.demonstrated, false);
});

test('ordering: after a repeat, a correction later than every owner instance is success, and the class stays repeated', () => {
  const r = ordered(raised('2026-11-16'), caught('2026-11-17'), raised('2026-11-18'), caught('2026-11-20'));
  assert.deepEqual(r.success, {demonstrated: true, classes: ['k']});
  assert.deepEqual(r.repeated_classes, ['k']);
});

test('the current record: repeated classes are named, and success is not claimed', () => {
  const r = report(load());
  assert.ok(r.repeated_classes.includes('unqualified-claim-as-measurement'), 'the owner raised it more than once');
  assert.equal(r.success.demonstrated, false);
  // What the independent reviews of this repository found is on the record as theirs. One class has been detected by
  // its own registered check: text-reader-misses-new-shape, whose detector (ophanim/graph/extract.test.mjs) failed on the
  // merged tree of PR #67's branch (2026-11-21). It is still no success: the integrator corrected it, not the
  // mechanism, and the owner never raised the class.
  assert.ok(r.review_found.length >= 3, JSON.stringify(r.review_found));
  assert.deepEqual(r.classes.filter(c => c.detected_by_own_check > 0).map(c => c.id), ['text-reader-misses-new-shape']);
  assert.equal(r.classes.find(c => c.id === 'text-reader-misses-new-shape').succeeded, false);
});

// ---- Findings of the independent review of a1d090f (2026-11-20) ---------------------------------------------------------
test('the success rule holds on its own, not only behind the registry\'s other checks: no detector, no success; dates are dates; a later owner raising undoes it; a recurrence check names a check', () => {
  const cls = (over, instances) => ({id: 'c', class: 'x', source: 's', detector: {kind: 'test', file: 'ophanim/lessons/corrections.test.mjs', name: 'the success rule'}, ...over, instances});
  const owner = date => ({observed_by: 'owner', date, ref: 'r', note: 'n'});
  const own = (date, over = {}) => ({observed_by: 'mechanism', by_detector: true, corrected_by: 'mechanism', date, ref: 'r', note: 'n', detected_by: 'the registered check', ...over});
  const ok = report({classes: [cls({}, [owner('2026-11-17'), own('2026-11-19')])]});
  assert.deepEqual([ok.success.demonstrated, ok.classes[0].succeeded], [true, true], 'the rule\'s own case: raised by the owner, then caught by the registered check and corrected');
  // 3.1 A class with NO registered check cannot have been detected by its own check, whatever an instance says.
  assert.equal(report({classes: [cls({detector: {kind: 'none', why: 'no test yet', next: 'write one'}}, [owner('2026-11-17'), own('2026-11-19')])]}).success.demonstrated, false);
  // 3.3 Dates are compared as dates: the 9th is before the 17th.
  assert.equal(report({classes: [cls({}, [owner('2026-11-17'), own('2026-11-09')])]}).success.demonstrated, false);
  assert.ok(problems({schema: 'ophanim.owner-corrections/v1', purpose: 'p', classes: [cls({}, [owner('2026-11-17'), own('2026-11-9')])]}).some(p => /date/.test(p)), 'a date that is not YYYY-MM-DD is a problem of the registry');
  // 3.4 The owner raising the class AGAIN after the detection is the mechanism missing a recurrence: not a success.
  const again = report({classes: [cls({}, [owner('2026-11-17'), own('2026-11-18'), owner('2026-11-20')])]});
  assert.deepEqual([again.success.demonstrated, again.classes[0].repeated], [false, true]);
  // 3.5 A recurrence is proven by a named check, not by any sentence in the field.
  const rec = text => report({classes: [cls({}, [{...owner('2026-11-17'), recurrence_check: text}])]}).classes[0].recurrence_proven;
  assert.deepEqual([rec('none yet: no reusable check exists'), rec('pantheon/tests/antigravity-gateway.test.mjs (the stop on arrival)'), rec('mutation W7 of ophanim/operate/sdk-intake.mutate.mjs killed on ea858a6')], [0, 1, 1]);
});
