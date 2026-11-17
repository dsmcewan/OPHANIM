// OPHANIM's chair ranking read from real Pantheon boards. These checks used to sit in Pantheon's own tests
// (board-contributions, board-swarm), which made Pantheon import OPHANIM; they live here so the
// dependency runs one way (OPHANIM -> Pantheon). The boards are built exactly as those tests build them.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {rankChairQuestions} from './chairs.mjs';
import {openBoard} from '../../../pantheon/src/board/index.mjs';
import {runOpenItem} from '../../../pantheon/src/board/run-item.mjs';
import {chairContributions} from '../../../pantheon/src/board/contributions.mjs';
import {publish} from '../../../pantheon/src/board/dag.mjs';
import {merge} from '../../../pantheon/src/board/merge.mjs';
import {runSwarmLayer} from '../../../pantheon/src/board/run-swarm.mjs';
import {withPipeline} from '../../../pantheon/tests/fixtures/pipeline.mjs';
import {withBoard, seeded, seat, HUMAN, CONTROLLER} from '../../../pantheon/tests/board-helper.mjs';

test('the ranking reads a refused-then-revised ticket\'s real projection; rework in one chair is not an attribution question', async () => {
  await withPipeline(async ({repo, opts, implement}) => {
    writeFileSync(join(repo, 'alpha.mjs'), 'export const ok = false;\n');
    writeFileSync(join(repo, 'beta.mjs'), 'export const ok = false;\n');
    writeFileSync(join(repo, 'verify.mjs'), 'import assert from "node:assert/strict"; import {ok as a} from "./alpha.mjs"; import {ok as b} from "./beta.mjs"; assert.equal(a && b, true);');
    implement(prompt => /Your revision/.test(prompt) ? 'export const ok = true;\n' : 'export const ok = false;\n');
    const spec = {key: 'contribKey', repo_root: repo, title: 'two files', goal: 'both pass', question: 'fixture',
      copy: ['alpha.mjs', 'beta.mjs', 'verify.mjs'], acceptance_cmd: 'node verify.mjs',
      slots: [{slot: 'alpha', path: 'alpha.mjs'}, {slot: 'beta', path: 'beta.mjs'}]};
    const first = await runOpenItem(spec, opts);
    assert.equal(first.shipped, false);
    // The first run's review recorded `stop` for the Astra seat; a stop is terminal (routing audit M2), and
    // retrying the same seat is its own explicit, recorded action.
    const second = await runOpenItem(spec, {...opts, resume: first.board, retryStopped: 'fixture: retry the same seat once'});
    assert.equal(second.shipped, true, JSON.stringify(second.error));
    const p = chairContributions(openBoard(second.board));
    const {models, decision} = rankChairQuestions(p);
    assert.equal(models.traceSha, p.projectionSha);
    assert.equal(decision.candidates.some(c => c.id === 'attribute.rework'), false);
    assert.equal(decision.limits.promotionAuthorized, false);
  });
});

const QUESTION = 'Why does the fenced lease keep timing out?';
const SEATING = {
  explorer: [
    {vendor: 'anthropic', model: 'claude-sonnet-5', basis: 'QUOTA', why: 'test'},
    {vendor: 'openai', model: 'gpt-6-sol', basis: 'QUOTA', why: 'test'},
  ],
  reviewer: [{vendor: 'xai', model: 'grok-4.6', band: 'medium', basis: 'ISOLATION', why: 'test'},
             {vendor: 'anthropic', model: 'claude-sonnet-5', band: 'easy', basis: 'ISOLATION', why: 'test'}],
  judge: [{vendor: 'anthropic', model: 'claude-sonnet-5', basis: 'ISOLATION', why: 'test'},
          {vendor: 'agy_google', model: 'gemini-4-carbon', basis: 'ISOLATION', why: 'test'}],
};
const turn = async ({vendor, model, role}) => ({text: `${vendor}/${model} as ${role}: the lease TTL is shorter than the slowest worker`, complete: true});

test('the ranking makes one function per chair of a swarm board\'s five-chair projection', () => withBoard(async board => {
  const s = await seeded(board);
  const blocked = await publish({...board, ref: s.wip, author: seat('anthropic', 'plan'), msg: 'block it', entries: [{kind: 'work_item',
    payload: {key: s.itemKey, title: 'implement the fenced lease', state: 'blocked', artifact_slots: [`artifact:${s.slot}`], block: {reason: 'timeouts'}}}]});
  assert.equal(blocked.ok, true, blocked.why);
  const m = await merge({...board, into: s.ref, from: s.wip, author: CONTROLLER, msg: 'carry the block'});
  assert.equal(m.ok, true, m.why);
  const ref = s.ref;
  await runSwarmLayer({board, ref, question: QUESTION, turn, seating: SEATING});
  const d = await publish({...board, ref, author: HUMAN, msg: 'split', entries: [{kind: 'decision',
    payload: {key: 'lease-ttl', question: QUESTION, options: [{id: 'longer-ttl'}, {id: 'heartbeat'}], resolution: {type: 'split', recorded: true}}}]});
  assert.equal(d.ok, true, d.why);
  await runSwarmLayer({board, ref, question: QUESTION, turn, seating: SEATING});
  await runSwarmLayer({board, ref, question: QUESTION, turn, seating: SEATING});
  const p = chairContributions(board);
  assert.deepEqual(p.chairs.map(c => c.chair), ['lead@orch', 'impl@build', 'check@review', 'scout@opt', 'arbiter@judge']);
  assert.equal(rankChairQuestions(p).models.functions.length, 5);
}));
