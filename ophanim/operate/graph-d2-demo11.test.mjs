// Knowledge graphs, Slice D part 2 (docs/knowledge-graph/slice-d2.md), KD2-7: DEMONSTRATION 11, SYNTHETIC. One unplanned
// work item, authorized by a status entry signed with a SYNTHETIC owner key in a FIXTURE status ledger (never the real
// one), goes through intake, investigation and planning with graph-derived relationships: a shared prerequisite found, a
// plan with typed requires, a gate that blocks and then unlocks. It then goes through scripted execution, verification and
// review -- the REAL stage executors (stages.mjs) over Pantheon's scripted clients and seats (no provider request, no
// network) -- and the resulting records update the graphs. The live run needs the owner's signed item and machine
// (docs/knowledge-graph/inventory.md (k)); its command is in slice-d2.md, section 9.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {openStatusLedger} from '../../packages/ledger/status.mjs';
import {entityId} from '../../packages/graph/index.mjs';
import {openWorkLedger} from './work-ledger.mjs';
import {tick, watch, inputSignature} from './scheduler.mjs';
import {makeExecutors} from './stages.mjs';
import {GRAPH_ABSENT} from './gates.mjs';
import {planId, artifactId, validationId, completionId, stageReviewId, sharedPrerequisiteId, promptId} from '../graph/work.mjs';
import {withDispatch} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {git, json, planFor, scriptedTurn, SIX} from './test-fixtures.mjs';
import {d2World, loopOf, REPO_SOURCE} from './fixtures/graph-d2.mjs';

/** The prerequisite: a contract no module carries yet (SYNTHETIC). */
const CONTRACT = entityId({domain: 'systems', type: 'contract', key: 'ophanim.graph-demo-dispatch/v1'});
const LIMITS = {total_provider_calls: 1000, stage_provider_calls: 40};

test('demonstration 11 (KD2-7), SYNTHETIC: an owner-authorized unplanned item is investigated and planned with graph-derived relationships, blocked on a shared missing prerequisite, unlocked when it lands, executed, verified and reviewed by scripted seats, and its records update the graph', async () => {
  await withDispatch(async ({dir: repo, makeClientFor}) => {
    // SYNTHETIC: the owner key of this fixture status ledger is generated for the test (test-fixtures.mjs fixture).
    const w = d2World(['graph-demo', 'graph-peer'], {repo});
    const statusBefore = openStatusLedger({root: w.statusRoot, create: false}).board();
    const prompts = [];
    const turn = scriptedTurn({planner: ({prompt}) => { prompts.push(prompt); return json(planFor(prompt, {requires: [{id: CONTRACT, why: 'the work routes through the dispatch contract no module carries yet'}]})); }});
    const ex = makeExecutors({independence: 'lab', repo, makeClientFor, turn, stateDir: w.stateDir, checked: '2026-11-20', ...SIX});
    const loop = () => loopOf(w, {repoSource: true});
    // 1. INTAKE, INVESTIGATION AND PLANNING, with the graph: both items are planned; both block after planning.
    const r1 = await tick({repo, statusRoot: w.statusRoot, workRoot: w.workRoot, executors: ex, limits: {...LIMITS, iterations: 6}, graph: loop()});
    assert.ok(r1.intake.includes('status:graph-demo'), 'intake: the owner-signed status entry');
    assert.deepEqual(r1.dispatched.map(d => `${d.item}:${d.stage}:${d.status}`), ['graph-demo:plan:passed', 'graph-peer:plan:passed']);
    const W = () => openWorkLedger({root: w.workRoot});
    const plan = W().stages('graph-demo').find(s => s.stage === 'plan');
    assert.deepEqual(plan.outputs.plan.requires.map(r => [r.id, r.version]), [[CONTRACT, GRAPH_ABSENT]], 'a plan with typed requires, bound: the contract is missing');
    assert.ok(plan.outputs.context.dossier.entries.some(e => e.source === 'graph:graph-demo#neighbourhood'), 'the planner was given the graph\'s view');
    assert.ok(plan.outputs.context.dossier.entries.some(e => e.source === 'learning:graph-demo#reuse'), 'and the learning graph\'s');
    assert.equal(plan.outputs.team_proposal.advisory, true, 'the team proposal is recorded beside the live seats');
    assert.match(prompts[0], /## Typed requirements/);
    for (const item of ['graph-demo', 'graph-peer']) {
      const b = r1.blocked.find(x => x.item === item)?.blocker;
      assert.deepEqual([b?.code, b?.prerequisite, b?.line], ['GRAPH_PREREQUISITE_MISSING', CONTRACT, 'requires[0]'], `${item} is blocked after planning`);
    }
    // The shared prerequisite: ONE finding naming both items (never a merge), and ONE intake candidate (never executed).
    const g1 = loop(), v1 = g1.open().view();
    assert.deepEqual(v1.node(sharedPrerequisiteId(CONTRACT)).attributes.items.map(i => i.item), ['graph-demo', 'graph-peer']);
    assert.equal(v1.node(sharedPrerequisiteId(CONTRACT)).attributes.existence.exists, false);
    const cands = fs.readdirSync(path.join(w.stateDir, 'graph-candidates'));
    assert.equal(cands.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.stateDir, 'graph-candidates', cands[0]), 'utf8')).required_by, ['graph-demo', 'graph-peer']);
    assert.ok(v1.nodeIn(promptId('status', 'status:graph-demo'), 'established'), 'the intake is in the work graph');
    // 2. THE PREREQUISITE LANDS (a SYNTHETIC commit by the fixture's owner: a module carrying the contract), an observer
    // observes the repository, and the change of the graph WAKES the tick.
    const state = {last: inputSignature({repo, statusRoot: w.statusRoot, workRoot: w.workRoot, graph: loop()})};
    fs.mkdirSync(path.join(repo, 'lib'), {recursive: true});
    fs.writeFileSync(path.join(repo, 'lib', 'dispatch.mjs'), "export const DISPATCH_SCHEMA = 'ophanim.graph-demo-dispatch/v1';\n");
    git(repo, 'add', 'lib/dispatch.mjs');
    git(repo, 'commit', '-q', '-m', 'SYNTHETIC: the dispatch contract lands');
    const observer = loop();
    observer.open();
    assert.equal(observer.observe([REPO_SOURCE])[0].recorded, true);
    const ticks = await watch({repo, statusRoot: w.statusRoot, workRoot: w.workRoot, executors: ex, limits: LIMITS, graph: loop(), once: true, state, only: 'graph-demo'});
    assert.equal(ticks.length, 1, 'the graph change woke a tick');
    // 3. UNLOCKED: scripted execution, verification and review.
    const r2 = ticks[0];
    assert.deepEqual(r2.dispatched.map(d => `${d.item}:${d.stage}:${d.status}`),
      ['graph-demo:implement:passed', 'graph-demo:review:passed', 'graph-demo:validate:passed', 'graph-demo:outcome:passed'], JSON.stringify(r2.blocked));
    assert.deepEqual(r2.dispatched[0].unlocked, [CONTRACT]);
    const impl = W().stages('graph-demo').find(s => s.stage === 'implement');
    assert.equal(impl.inputs.graph_unlocked[0].prerequisite, CONTRACT, 'the unlock is recorded on the attempt');
    // 4. The records update the graphs: the plan, the artifact, its review, its validation and the UNSIGNED completion claim.
    const v2 = loop().open().view();
    const [rev, val, out] = ['review', 'validate', 'outcome'].map(st => W().stages('graph-demo').find(s => s.stage === st));
    for (const id of [planId(plan.hash), artifactId(impl.hash), stageReviewId(rev.hash), validationId(val.hash), completionId(out.hash)]) assert.ok(v2.nodeIn(id, 'established'), `${id} is in the graph`);
    assert.equal(v2.node(completionId(out.hash)).attributes.signed, false, 'a completion CLAIM, never a completion');
    assert.equal(v2.node(sharedPrerequisiteId(CONTRACT)).attributes.existence.exists, true, 'the shared finding now records the prerequisite as existing');
    // Nothing is executed without the owner: the status ledger is unchanged, and the outcome is an unsigned proposal.
    assert.deepEqual(openStatusLedger({root: w.statusRoot, create: false}).board(), statusBefore);
    assert.equal(out.outputs.signed, false);
    // No provider request: every seat was the scripted one.
    assert.ok(turn.log.length > 0 && turn.log.every(l => ['planner', 'plan-review', 'review', 'validator', 'dispatcher', 'unit-review', 'subagent'].includes(l.kind)));
  });
});
