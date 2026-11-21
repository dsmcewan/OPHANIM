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
// Must never: count a class as covered because a document describes it, or turn a missing detector into a pass.
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
    for (const i of c.instances ?? []) if (!['owner', 'mechanism'].includes(i.observed_by))
      out.push(`${c.id}: instance observed_by must be owner or mechanism`);
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

export function report(reg) {
  const classes = reg.classes.map(c => {
    const byOwner = c.instances.filter(i => i.observed_by === 'owner');
    const byMechanism = c.instances.filter(i => i.observed_by === 'mechanism');
    return {id: c.id,
      detector: c.detector.kind === 'test' ? `${c.detector.file} :: ${c.detector.name}` : `none (${c.detector.why})`,
      fixed: Boolean(c.fixed_in), owner_interventions: byOwner.length, detections: byMechanism.length,
      corrected_by_mechanism: byMechanism.filter(i => i.corrected_by === 'mechanism').length,
      // Condition 7: the owner raising the same class again is evidence the improvement process needs examination.
      repeated: byOwner.length > 1};
  });
  const series = {};
  for (const c of reg.classes) for (const i of c.instances) if (i.observed_by === 'owner') series[i.date] =
    (series[i.date] ?? 0) + 1;
  const dates = Object.keys(series).sort();
  // Success, per the owner: a previously observed class detected AND corrected without the owner pointing it out.
  const success = classes.filter(c => c.owner_interventions > 0 && c.corrected_by_mechanism > 0).map(c => c.id);
  return {
    classes,
    interventions_by_date: dates.map(d => ({date: d, owner_interventions: series[d]})),
    repeated_classes: classes.filter(c => c.repeated).map(c => c.id),
    without_detector: classes.filter(c => c.detector.startsWith('none')).map(c => c.id),
    success: success.length ? {demonstrated: true, classes: success}
      : {demonstrated: false,
        why: 'no previously observed class has yet been both detected and corrected without the owner'},
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reg = load();
  const p = problems(reg);
  if (p.length) { console.error(p.join('\n')); process.exit(1); }
  const r = report(reg);
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
  for (const c of r.classes) {
    console.log(`${c.id}: owner ${c.owner_interventions}, detected ${c.detections} (corrected by mechanism ${c.corrected_by_mechanism})` +
      `${c.repeated ? ' REPEATED' : ''}${c.fixed ? '' : ' OPEN'}\n  detector: ${c.detector}`);
  }
  console.log(`interventions by date: ${r.interventions_by_date.map(x => `${x.date} ${x.owner_interventions}`).join(', ')}`);
  console.log(`repeated (owner had to raise again): ${r.repeated_classes.join(', ') || 'none'}`);
  console.log(`self-improvement success: ${r.success.demonstrated ? r.success.classes.join(', ') : `not demonstrated: ${r.success.why}`}`);
}
