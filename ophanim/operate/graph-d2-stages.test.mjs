// Knowledge graphs, Slice D part 2 (docs/knowledge-graph/slice-d2.md): the REAL plan stage (stages.mjs) with the graph,
// over the scripted single-turn seats (test-fixtures.mjs scriptedTurn: no provider, no network). KD2-3: the planner is
// given the graph's and the learning graph's views through the dossier, its typed requirements are checked and bound by
// version, and the views it cites are re-derived at the graph cursor it was given, so its own later records never stale
// it. KD2-4: every stage records an ADVISORY team proposal of the seven queries beside its live seats, which are
// byte-identical with and without it; the graph causes no provider request. SYNTHETIC world (fixtures/graph-d2.mjs).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openWorkLedger} from './work-ledger.mjs';
import {tick} from './scheduler.mjs';
import {reconcile} from './reconcile.mjs';
import {makeExecutors, planRefusal} from './stages.mjs';
import {GRAPH_ABSENT} from './gates.mjs';
import {json, planFor, scriptedTurn} from './test-fixtures.mjs';
import {d2World, loopOf, LIMITS, OTHER, PREREQ} from './fixtures/graph-d2.mjs';

const noWorkSeat = () => { throw new Error('a plan-only test makes no work-seat call'); };
const idOf = (prompt, title) => new RegExp(`### \\[(S\\d+)\\] ${title}`).exec(prompt)?.[1] ?? null;

/** The plan stage of `item` through the scheduler, with or without the graph loop; the planner answers with `extra`. */
async function planOnce({graph, extra = () => ({})}) {
  const w = d2World(['p']);
  const prompts = [];
  const turn = scriptedTurn({planner: ({prompt}) => { prompts.push(prompt); return json(planFor(prompt, extra(prompt))); }});
  const loop = graph ? loopOf(w) : null;
  const ex = makeExecutors({independence: 'lab', repo: w.repo, makeClientFor: noWorkSeat, turn, stateDir: w.stateDir, checked: '2026-11-17'});
  const r = await tick({repo: w.repo, statusRoot: w.statusRoot, workRoot: w.workRoot, executors: {plan: ex.plan}, limits: {...LIMITS, stage_provider_calls: 40, iterations: 1}, ...(loop ? {graph: loop} : {})});
  const plan = openWorkLedger({root: w.workRoot}).stages('p').find(s => s.stage === 'plan');
  return {w, r, plan, turn, prompts, loop};
}

test('KD2-3 and KD2-4: the planner gets the graph and learning views and binds its typed requirements; the team proposal is recorded; the LIVE SEATS are byte-identical with and without it, and the graph makes no provider request', async () => {
  const A = await planOnce({graph: false});
  const B = await planOnce({graph: true, extra: prompt => ({requires: [{id: OTHER, why: 'the index the change reads, which the graph states exists'}, {id: PREREQ, why: 'the dispatch interface this plan builds', implements: true}],
    evidence: [{ref: 'alpha.mjs', why: 'the current export'}, {ref: 'verify.mjs', why: 'the acceptance check'}, {ref: idOf(prompt, 'Knowledge graph: references around'), why: 'what the graph relates to the item'},
      {ref: idOf(prompt, 'Learning reuse:'), why: 'earlier failures of the files in play'}]})});
  try {
    assert.equal(A.plan.status, B.plan.status);
    assert.equal(B.plan.status, 'passed', JSON.stringify(B.plan.outputs.refused ?? null));
    // THE LIVE SEATS: the planner's seat and its selection, and the plan reviewers, exactly as without the graph.
    assert.deepEqual(B.plan.outputs.planner, A.plan.outputs.planner, 'the planner seat is byte-identical');
    assert.deepEqual(B.plan.team, A.plan.team, 'every live seat is byte-identical');
    assert.equal(JSON.stringify(B.plan.team), JSON.stringify(A.plan.team));
    // No provider request is caused by the graph: the same seats were asked the same number of times.
    assert.deepEqual(B.turn.log.map(l => [l.kind, l.vendor, l.model]), A.turn.log.map(l => [l.kind, l.vendor, l.model]));
    assert.equal(B.r.spent.calls, A.r.spent.calls);
    // THE TEAM PROPOSAL: advisory, the seven queries, recorded beside the live seats on the stage record.
    const tp = B.plan.outputs.team_proposal;
    assert.equal(A.plan.outputs.team_proposal, undefined, 'without the graph there is none');
    assert.deepEqual([tp.schema, tp.advisory], ['ophanim.team-proposal/v1', true]);
    assert.deepEqual(Object.keys(tp.queries).sort(), ['capability', 'evidence', 'learning', 'systems', 'work']);
    assert.deepEqual(tp.queries.work.builds, [PREREQ], 'the unmet obligation it builds');
    assert.deepEqual(tp.queries.systems.requirements.map(r => [r.id, r.exists]), [[OTHER, true], [PREREQ, false]]);
    assert.ok(tp.queries.capability.planner.eligible.length > 0, 'C1\'s advisory eligibility for the planner role');
    assert.deepEqual(tp.team.map(t => t.role).sort(), ['plan-reviewer', 'planner']);
    assert.match(tp.live_seats, /unchanged/);
    assert.match(tp.recorded, /work ledger/);
    // THE PLANNER'S EVIDENCE: the graph's and the learning graph's views, in the dossier's budget and citation rules.
    const sources = B.plan.outputs.context.dossier.entries.map(e => e.source);
    assert.ok(sources.includes('graph:p#neighbourhood') && sources.includes('learning:p#reuse'), JSON.stringify(sources));
    assert.ok(!A.plan.outputs.context.dossier.entries.some(e => /^(graph|learning):/.test(e.source)));
    assert.match(B.prompts[0], /## Typed requirements \(the knowledge graph\)/);
    assert.match(B.prompts[0], /"op":"graph"/);
    assert.doesNotMatch(A.prompts[0], /Typed requirements|"op":"graph"/, 'without the graph the prompt is as before');
    // THE TYPED REQUIREMENTS, BOUND to the versions the graph states (the missing one as absent).
    const req = B.plan.outputs.plan.requires;
    const state = B.loop.executor().stateOf;
    assert.deepEqual(req.map(r => [r.id, r.version, r.implements ?? false]), [[OTHER, state(OTHER).version, false], [PREREQ, GRAPH_ABSENT, true]]);
    assert.match(req[0].version, /^sha256:/);
    assert.equal(B.plan.outputs.graph.requires.length, 2);
    assert.ok(Number.isInteger(B.plan.outputs.graph.cursor));
    // Its cited graph views are re-derived AT THE CURSOR it was given: its own later records (observed into the graph)
    // never make it stale; it implements the missing prerequisite itself, so it is not blocked.
    assert.ok(B.plan.outputs.evidence.some(e => e.source === 'graph:p#neighbourhood' && e.version), 'the graph view is cited, bound to its version');
    const gate = reconcile({repo: B.w.repo, statusRoot: B.w.statusRoot, workLedger: openWorkLedger({root: B.w.workRoot}), graph: loopOf(B.w).context()}).items[0].gate;
    assert.equal(gate.gate, 'implement', JSON.stringify(gate.stale ?? gate.blocker ?? null));
    assert.equal(gate.graph.requirements.find(r => r.prerequisite === PREREQ).implements, true);
  } finally { A.w.done(); B.w.done(); }
});

test('KD2-3 planRefusal checks typed requirements against the graph: graph ids of what work can require, the version the graph states; none without a graph', () => {
  const stateOf = id => ({version: id === OTHER ? 'sha256:' + 'a'.repeat(64) : GRAPH_ABSENT});
  const base = planFor('Mode: author');
  const why = (requires, graph = {stateOf}) => planRefusal({...base, requires}, {shown: ['alpha.mjs', 'verify.mjs'], graph});
  assert.deepEqual(why([{id: OTHER, why: 'the index the change reads'}]), []);
  assert.deepEqual(why([{id: OTHER, why: 'the index the change reads', version: 'sha256:' + 'a'.repeat(64)}]), []);
  assert.match(why([{id: OTHER, why: 'the index the change reads', version: 'sha256:' + 'b'.repeat(64)}]).join(), /cites version sha256:bbbb.*the graph states sha256:aaaa/);
  assert.match(why([{id: 'ophanim/learning/failure-class/x', why: 'a failure class, not a prerequisite'}]).join(), /not something a work item can require/);
  assert.match(why([{id: 'dynamic team construction', why: 'free text is not a typed requirement'}]).join(), /not a graph entity id/);
  assert.match(why([{id: OTHER, why: 'x'}]).join(), /requires\[0\] is \{id/);
  assert.match(why([{id: OTHER, why: 'the index the change reads'}, {id: OTHER, why: 'the index the change reads again'}]).join(), /names .* twice/);
  assert.match(why([{id: OTHER, why: 'the index the change reads'}], null).join(), /no knowledge graph is supplied/);
  assert.deepEqual(planRefusal(base, {shown: ['alpha.mjs', 'verify.mjs']}), [], 'a plan with no typed requirement is as before');
});
