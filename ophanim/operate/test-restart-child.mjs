// Test helper: one scheduler tick in a FRESH PROCESS. Nothing is carried in memory from the process that ran the
// earlier ticks; the executors, the scripted providers and the ledgers are rebuilt from what is on disk.
//   node test-restart-child.mjs <repo> <statusRoot> <workRoot> <stateDir> [profile]
// `profile` is the routing profile the parent's executors were built with (omitted: the lifecycle default).
// The scripted hooks are stateless (they answer from the prompt alone), so the parent and this process behave alike.
import {pathToFileURL} from 'node:url';
import {scriptedClients, WORK} from '../../pantheon/tests/fixtures/dispatch.mjs';
import {tick} from './scheduler.mjs';
import {makeExecutors} from './stages.mjs';
import {scriptedTurn, LIMITS} from './test-fixtures.mjs';

export const PLAIN = 'export const ok = true;\n', REVISED = '// frozen: the importer reads it lazily\nexport const ok = true;\n';
export const FINDING = 'export ok as a frozen constant; a comment must say why';
/** Stateless scripted in-run hooks: the checker rejects bytes that are not marked frozen; the worker revises when told to. */
export function statelessHooks({alwaysReject = false} = {}) {
  return {
    implement: prompt => (/REQUESTED CHANGES/.test(prompt) ? REVISED : PLAIN),
    review: ({prompt}) => (WORK.test(prompt) ? (/REQUESTED CHANGES/.test(prompt) ? REVISED : PLAIN)
      : /^Attack the artifact/.test(prompt) && (alwaysReject || !prompt.includes('// frozen')) ? `${FINDING}\nVERDICT: request_changes` : null),
    serve: (_vendor, model) => model,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [repo, statusRoot, workRoot, stateDir, profile] = process.argv.slice(2);
  const h = statelessHooks(), calls = [];
  const makeClientFor = scriptedClients(calls, h.implement, () => null, h.review, h.serve);
  const executors = makeExecutors({repo, makeClientFor, turn: scriptedTurn(), stateDir, independence: 'model', ...(profile ? {profile} : {})});
  const r = await tick({repo, statusRoot, workRoot, executors, limits: LIMITS});
  console.log(JSON.stringify({pid: process.pid, dispatched: r.dispatched.map(d => [d.item, d.stage, d.status]), work_calls: calls.length,
    work_prompts: calls.filter(c => WORK.test(c.prompt)).map(c => ({model: c.model, told: c.prompt.includes(FINDING)}))}));
}
