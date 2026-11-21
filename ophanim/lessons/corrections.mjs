#!/usr/bin/env node
// The owner-corrections registry (ophanim/lessons/corrections.json): what the owner has had to correct, as failure
// classes, and whether the work now catches them without the owner.
//
// Purpose: owner conditions 7 and 8 and the success criterion of 2026-11-17 (docs/self-evaluation.md). A
// correction must keep influencing later work; the owner's corrective intervention must decrease; and the
// self-improvement mechanism is not successful until it detects AND corrects a previously observed class without
// the owner pointing it out again.
// Inputs: the registry file. Outputs: report() -> per-class state, the intervention series, repeated classes, and
// the success verdict. Invariants: a class has a detector that is a named test in a tracked test file, or an explicit
// `none` with why and next step; success is never claimed from detections the owner had to correct.
//
// THREE THINGS KEPT APART (owner ruling 2026-11-20, PR 68): DISCOVERING a defect, REPAIRING it, and PROVING that a
// reusable mechanism would catch its recurrence.
//   who discovered it   an instance's `observed_by`: `owner` (an intervention), `review` (an independent review found
//                       it: evidence that the REVIEW worked, never a detection of this mechanism), or `mechanism`
//                       (anything else that is not the owner: a test, a mutation run, a suite, a reading of the code).
//                       `by_detector: true` says the class's OWN registered check (its `detector` test) is what found it.
//   who repaired it     `corrected_by` (owner, integrator, mechanism).
//   recurrence proven   `recurrence_check`: the reusable check that was SEEN to catch this instance again, and how.
// The mechanism is successful only when the class's own registered check detected a class the owner had already
// raised, and the mechanism corrected it, without the owner. A review's find, or another check's, is not that.
// Must never: count a class as covered because a document describes it, turn a missing detector into a pass, or count
// what a review found as a success of the registered check.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const REGISTRY = path.join(ROOT, 'ophanim/lessons/corrections.json');
export const SCHEMA = 'ophanim.owner-corrections/v1';

export function load(file = REGISTRY) {
  const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (reg.schema !== SCHEMA) throw new Error(`corrections: schema ${reg.schema}, expected ${SCHEMA}`);
  return reg;
}

/**
 * Problems with the registry itself: a class with no usable detector statement, or a test detector that does not
 * exist.
 */
export function problems(reg, {root = ROOT} = {}) {
  const out = [], ids = new Set();
  for (const c of reg.classes) {
    if (!c.id || ids.has(c.id)) out.push(`class id missing or duplicated: ${c.id}`);
    ids.add(c.id);
    if (!c.class || !c.source) out.push(`${c.id}: class and source are required`);
    if (!Array.isArray(c.instances) || !c.instances.length) out.push(`${c.id}: no recorded instance`);
    for (const i of c.instances ?? []) {
      if (!['owner', 'review', 'mechanism'].includes(i.observed_by)) out.push(`${c.id}: instance observed_by must be owner, review or mechanism`);
      if (i.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(i.date))) out.push(`${c.id}: an instance's date is YYYY-MM-DD (${i.date}): dates are compared as dates`);
      if (i.observed_by === 'review' && !(typeof i.detected_by === 'string' && i.detected_by.trim())) out.push(`${c.id}: an instance a review found says which review (detected_by)`);
      if (i.by_detector === true && i.observed_by !== 'mechanism') out.push(`${c.id}: by_detector is for an instance the registered check found, not one a review or the owner found`);
      else if (i.by_detector === true && c.detector?.kind !== 'test') out.push(`${c.id}: an instance claims the class's registered check (by_detector), and the class has none`);
    }
    const d = c.detector;
    if (d?.kind === 'test') {
      const f = path.join(root, d.file);
      if (!fs.existsSync(f)) out.push(`${c.id}: detector file ${d.file} does not exist`);
      else if (!d.name || !fs.readFileSync(f, 'utf8').includes(d.name))
        out.push(`${c.id}: no test named "${d.name}" in ${d.file}`);
    } else if (d?.kind === 'none') {
      if (!d.why || !d.next) out.push(`${c.id}: a missing detector states why and the next step`);
    } else out.push(`${c.id}: detector kind must be test or none`);
  }
  return out;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NAMES_A_CHECK = /[\w./-]+\.test\.mjs|\bmutation\s+[A-Z]+\d+\b/;
export function report(reg) {
  const classes = reg.classes.map(c => {
    const byOwner = c.instances.filter(i => i.observed_by === 'owner');
    const byReview = c.instances.filter(i => i.observed_by === 'review');
    const byMechanism = c.instances.filter(i => i.observed_by === 'mechanism');
    // "A previously observed class": the registered check's detection counts only from the owner's first raising on.
    const raised = byOwner.map(i => i.date).filter(Boolean).sort()[0] ?? null;
    // ITS OWN REGISTERED CHECK: a class with no detector has none, whatever an instance claims (independent review of
    // a1d090f, finding 3.1: report() counted such a claim; only problems() refused it).
    const byOwnCheck = c.detector.kind === 'test' ? byMechanism.filter(i => i.by_detector === true) : [];
    const day = d => (DATE.test(d ?? '') ? Date.parse(d) : NaN);
    return {id: c.id, detector: c.detector.kind === 'test' ? `${c.detector.file} :: ${c.detector.name}` : `none (${c.detector.why})`,
      fixed: Boolean(c.fixed_in), owner_interventions: byOwner.length, found_by_review: byReview.length, detections: byMechanism.length, detected_by_own_check: byOwnCheck.length,
      corrected_by_mechanism: byMechanism.filter(i => i.corrected_by === 'mechanism').length,
      // The three things, apart: every instance was discovered; one is repaired when it says who corrected it; its
      // recurrence is proven only when it names the reusable check that was seen to catch it.
      discovered: c.instances.length, repaired: c.instances.filter(i => typeof i.corrected_by === 'string' && i.corrected_by).length,
      // A recurrence is proven by a check that is NAMED (a test file, or a mutation of a runner), not by any text in the field (3.5).
      recurrence_proven: c.instances.filter(i => typeof i.recurrence_check === 'string' && NAMES_A_CHECK.test(i.recurrence_check)).length,
      // Dates are compared as dates (3.3). And the owner raising the class AGAIN after the check's detection means the
      // mechanism missed a recurrence: that detection is not a success (3.4).
      succeeded: raised !== null && byOwnCheck.some(i => i.corrected_by === 'mechanism' && day(i.date) >= day(raised) && !byOwner.some(o => day(o.date) > day(i.date))),
      // Condition 7: the owner raising the same class again is evidence the improvement process needs examination.
      repeated: byOwner.length > 1};
  });
  const series = {};
  for (const c of reg.classes) for (const i of c.instances) if (i.observed_by === 'owner') series[i.date] =
    (series[i.date] ?? 0) + 1;
  const dates = Object.keys(series).sort();
  // Success, per the owner: a previously observed class detected BY ITS OWN REGISTERED CHECK and corrected by the
  // mechanism, without the owner pointing it out. What a review found, or another check, is on the record and is not this.
  const success = classes.filter(c => c.succeeded).map(c => c.id);
  return {
    classes,
    interventions_by_date: dates.map(d => ({date: d, owner_interventions: series[d]})),
    repeated_classes: classes.filter(c => c.repeated).map(c => c.id),
    review_found: classes.filter(c => c.found_by_review > 0).map(c => ({class: c.id, instances: c.found_by_review})),
    without_detector: classes.filter(c => c.detector.startsWith('none')).map(c => c.id),
    success: success.length ? {demonstrated: true, classes: success}
      : {demonstrated: false, why: 'no previously observed class has yet been detected by its own registered check and corrected without the owner'},
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reg = load();
  const p = problems(reg);
  if (p.length) { console.error(p.join('\n')); process.exit(1); }
  const r = report(reg);
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
  for (const c of r.classes) {
    console.log(`${c.id}: owner ${c.owner_interventions}, found by review ${c.found_by_review}, detected otherwise ${c.detections} (by its own registered check ${c.detected_by_own_check}; corrected by mechanism ${c.corrected_by_mechanism})` +
      `; repaired ${c.repaired} of ${c.discovered}, recurrence proven ${c.recurrence_proven}${c.repeated ? ' REPEATED' : ''}${c.fixed ? '' : ' OPEN'}\n  detector: ${c.detector}`);
  }
  console.log(`interventions by date: ${r.interventions_by_date.map(x => `${x.date} ${x.owner_interventions}`).join(', ')}`);
  console.log(`repeated (owner had to raise again): ${r.repeated_classes.join(', ') || 'none'}`);
  console.log(`found by independent review (evidence the review worked, not a detection of this mechanism): ${r.review_found.map(x => `${x.class} ${x.instances}`).join(', ') || 'none'}`);
  console.log(`self-improvement success: ${r.success.demonstrated ? r.success.classes.join(', ') : `not demonstrated: ${r.success.why}`}`);
}
