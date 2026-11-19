// The real-bwrap suites and the bwrap capability of this machine.
//
// A real-bwrap suite is a test file that gates itself on `sandboxAvailable("bwrap")` (pantheon/src/agy/sandbox.mjs):
// such a file SKIPS when bwrap does not work, so a green run where bwrap does work must show zero skips in it. The
// list is derived from the source on every run, never hand-kept; real-bwrap-suites.json is only the recorded
// baseline, and any difference is printed as NEW or GONE so a reviewer sees a suite join or leave the gate.
// A test file that names bwrap but is not gated is listed separately (`ungated`): it cannot skip on bwrap (it fails
// instead), so it needs no skip gate, but it is shown so a new skip mechanism is noticed.
//
// Inputs:  the suites' test files (suites.mjs); `bwrap` on PATH (or OPHANIM_GATE_BWRAP).
// Outputs: designated(), probeBwrap(), baselineDrift().
// Must never: call bwrap "working" without running it, or treat an unrun probe as a pass.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ROOT} from './suites.mjs';

export const GATE = /\bsandboxAvailable\(\s*["'`]bwrap["'`]\s*\)/;
const MENTIONS = /\bbwrap\b/;
export const BASELINE = path.join(ROOT, 'scripts/test-gates/real-bwrap-suites.json');

/** {gated: [file], ungated: [file]} among the given test files (absolute paths). */
export function designated(files) {
  const gated = [], ungated = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    if (GATE.test(src)) gated.push(f);
    else if (MENTIONS.test(src)) ungated.push(f);
  }
  return {gated: gated.sort(), ungated: ungated.sort()};
}

/**
 * Run `bwrap --ro-bind / / true` (the smallest namespace bwrap can make) and record what happened.
 * {works: boolean, bin, command, status, signal, error, stderr, version}
 */
export function probeBwrap({bin = process.env.OPHANIM_GATE_BWRAP || 'bwrap'} = {}) {
  const args = ['--ro-bind', '/', '/', 'true'];
  const r = spawnSync(bin, args, {encoding: 'utf8', timeout: 20_000});
  const v = r.error ? null : spawnSync(bin, ['--version'], {encoding: 'utf8', timeout: 20_000});
  return {
    works: !r.error && r.status === 0 && r.signal === null,
    bin, command: [bin, ...args].join(' '), status: r.status, signal: r.signal,
    error: r.error ? `${r.error.code ?? ''} ${r.error.message}`.trim() : null,
    stderr: (r.stderr ?? '').trim().slice(0, 500), version: v?.stdout?.trim() || null,
  };
}

/** NEW / GONE against the recorded baseline (repo-relative paths). */
export function baselineDrift(gated, {root = ROOT, baseline = BASELINE} = {}) {
  const now = gated.map(f => path.relative(root, f)).sort();
  let was = [];
  try { was = JSON.parse(fs.readFileSync(baseline, 'utf8')).gated; } catch { was = null; }
  if (!was) return {now, new: now, gone: [], baseline: 'missing'};
  return {now, new: now.filter(f => !was.includes(f)), gone: was.filter(f => !now.includes(f)), baseline: path.relative(root, baseline)};
}
