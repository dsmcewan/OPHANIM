// A SYNTHETIC BOARD for Slice B2's board source: a runtime state with obligations and their dependsOn, written on
// `refs/board/ophanim` through the board's OWN writer (ophanim/board.mjs withRuntimeBoard) in a temporary state
// directory. This container holds no runtime board, so these are SYNTHETIC records, labelled as such wherever a test
// uses them. No provider, no worker runs: the state is written as the controller writes it, one transition a commit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {withRuntimeBoard, STATE_SCHEMA, digest} from '../../board.mjs';

const spec = (id, dependsOn, scope = 'fixture') => ({id, kind: 'synthetic', scope, outputKey: `out-${id}`, dependsOn, expected: {fixture: true}, inputs: {seed: 'synthetic-input-value'}, maxAttempts: 3});
const row = s => ({spec: s, status: 'pending', attempt: 0, releaseAttempts: 0, candidate: null, history: [], reason: null});

/**
 * A board with obligations `plan` <- `build` <- `ship` and `docs` <- `ship` (four obligations, three dependsOn edges
 * besides `docs`'s none), written in two controller commits (a full snapshot, then a delta). Returns {dir, stateDir,
 * obligations, edges}.
 */
export async function fixtureBoard(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-graph-board-'))) {
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, {recursive: true});
  const workers = [{id: 'fixture-worker', version: '1', kinds: ['synthetic'], scopes: ['fixture']}];
  await withRuntimeBoard(stateDir, async ({save}) => {
    const state = {schema: STATE_SCHEMA, revision: 0, obligations: {}, effects: {}, repairs: {}, events: [], activeRelease: 'baseline',
      releases: {baseline: {id: 'baseline', artifactSha: digest(workers), stateSchema: STATE_SCHEMA, workers, planRef: null}}, pendingRelease: null, releaseHistory: []};
    for (const s of [spec('plan', []), spec('build', ['plan']), spec('docs', [])]) state.obligations[s.id] = row(s);
    await save(state, {type: 'fixture.admitted', obligations: 3});
    state.obligations.ship = row(spec('ship', ['build', 'docs']));
    await save(state, {type: 'fixture.admitted', obligations: 1});
  });
  return {dir, stateDir, obligations: ['build', 'docs', 'plan', 'ship'], edges: [['build', 'plan'], ['ship', 'build'], ['ship', 'docs']]};
}
