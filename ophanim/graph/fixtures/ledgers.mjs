// FIXTURES for Slice B's ledger extractors: a work ledger and a review-cycle ledger, written through their OWN writers
// (ophanim/operate/work-ledger.mjs, pantheon's review cycle) in a temporary directory with SYNTHETIC keys generated
// for the fixture, then read by ophanim/graph/extract/ledgers.mjs with no key at all. This container holds no work or
// cycle ledger (docs/knowledge-graph/inventory.md (a): 0 work-ledger entries), so these are SYNTHETIC records, labelled
// as such wherever a test uses them. No provider is called: the review turns are scripted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openWorkLedger} from '../../operate/work-ledger.mjs';
import {openPantheonLedger} from '../../../pantheon/src/ledger/system.mjs';
import {reviewCycle} from '../../../pantheon/src/ledger/review-cycle.mjs';

const T = minutes => new Date(Date.parse('2026-11-20T10:00:00.000Z') + minutes * 60_000).toISOString();
const REQ = 'sha256:' + 'a'.repeat(64);

/** A work ledger with one item's plan stage (claimed, recorded, released) and a second claim still open. */
export function fixtureWorkLedger(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-graph-work-'))) {
  const root = path.join(dir, 'work');
  const w = openWorkLedger({root});
  const budget = {provider_calls: 1, iterations: 1, elapsed_ms: 1000, retries: 1};
  const c1 = w.claim({item: 'co1-readability', stage: 'plan', attempt: 1, inputs: {}, holder: 'fixture-controller', budget, at: T(0)});
  const plan = w.recordStage({claim: c1, stage: 'plan', attempt: 1, status: 'passed', identity: {item: 'co1-readability', requirement: REQ}, inputs: {}, outputs: {plan: 'fixture'},
    team: [{role: 'planner'}], contributions: [], findings: [], usage: {provider_calls: 0}, next: {stage: 'implement', why: 'the plan passed'}, at: T(1)});
  w.release({claim: c1, item: 'co1-readability', stage: 'plan', outcome: 'completed', why: 'recorded', at: T(2)});
  const c2 = w.claim({item: 'fixture-other', stage: 'plan', attempt: 1, inputs: {}, holder: 'fixture-controller', budget, at: T(3)});
  fs.rmSync(path.join(root, 'keys'), {recursive: true, force: true});      // a reader holds no key
  return {dir, root, anchor: w.anchor, plan, claims: [c1, c2], ledger: () => openWorkLedger({root, create: false, anchor: w.anchor})};
}

const C = n => String(n).repeat(40).slice(0, 40);
const DIFF = 'diff --git a/src/x.mjs b/src/x.mjs\n--- a/src/x.mjs\n+++ b/src/x.mjs\n@@ -1 +1 @@\n-export const x = 1;\n+export const x = 2;\n';
const reply = (verdict, findings = []) => '```json\n' + JSON.stringify({verdict, findings}) + '\n```';
const scripted = replies => {
  let n = 0;
  return async ({vendor, model}) => ({text: replies[vendor] ?? reply('approve'), response_id: `resp_${vendor}_${++n}`, served_model: model});
};

/** A review-cycle ledger with one cycle of three labs and one finding (deferred); the keys removed for the reader. */
export async function fixtureCycleLedger(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-graph-cycle-'))) {
  const root = path.join(dir, 'cycles');
  const sys = openPantheonLedger({root}), rec = sys.recorder();
  const author = rec.recordTurn({seat: {seat_id: 'fixture-work@author', vendor: 'anthropic', mode: 'work', occupancy_gen: 1},
    requested_model: 'fixture-author-model', served_model: 'fixture-author-model', response_id: 'resp_author', reply: 'the change'});
  const r = await reviewCycle({ledger: rec, change: {scope: 'ophanim', base: C('a'), head: C('b'), diff: DIFF, files: ['src/x.mjs'], author_labs: ['anthropic'], author_turns: [author]},
    turn: scripted({xai: reply('request_changes', [{severity: 'minor', file: 'src/x.mjs', line: 1, claim: 'x changed without a test', reproduction: null}])})});
  const finding = r.reviews.find(x => x.lab === 'xai').findings[0];
  rec.deferFinding({finding: finding.hash, reason: 'fixture: scheduled for the next cycle'});
  fs.rmSync(path.join(root, 'keys'), {recursive: true, force: true});
  const anchor = fs.readFileSync(path.join(root, 'ANCHOR'), 'utf8').trim();
  return {dir, root, anchor, cycle: r.cycle, finding: finding.hash};
}
