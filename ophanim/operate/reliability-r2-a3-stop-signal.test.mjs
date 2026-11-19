// Regression test for independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 9:
// the per-file implement path (argo/legacy: runOpenItem) was not given the stage's signal, so a stopped stage neither
// cancelled runOpenItem's in-flight provider request nor stopped it admitting new ones. Failed on e880a07.
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {tick} from './scheduler.mjs';
import {makeExecutors} from './stages.mjs';
import {fixture, scriptedTurn, LIMITS} from './test-fixtures.mjs';
import {statelessHooks} from './test-restart-child.mjs';
import {withDispatch} from '../../pantheon/tests/fixtures/dispatch.mjs';

const hook = (ctx, h) => { ctx.implement(h.implement); ctx.review(h.review); ctx.serve(h.serve); };
const HOLD_MS = 4000;
const promptOf = req => typeof req.input === 'string' ? req.input : req.input?.at(-1)?.content ?? '';

test('finding 9: a stopped implement stage cancels runOpenItem\'s in-flight request and admits no further provider call', async () => {
  // independent review round 2, assignment 3 (Google gemini-4-carbon, manual, 77480d6), finding 9: stages.mjs called
  // runOpenItem without ctx.signal.
  await withDispatch(async ctx => {
    const {dir: repo} = ctx;
    const f = fixture(repo, [{item: 'fresh'}]);
    hook(ctx, statelessHooks());
    ctx.agyMode('frozen');
    const stop = new AbortController();
    const seen = {inflight: null, after: [], abortedAt: null};
    // The implementer's request starts, then the stage is stopped; the provider holds the stream until the request's
    // own signal aborts (a cancelled fetch) or HOLD_MS.
    const makeClientFor = (vendor, o) => {
      const c = ctx.makeClientFor(vendor, o);
      const create = c.responses.create;
      return {...c, responses: {...c.responses, create: async (req, opts) => {
        const prompt = promptOf(req);
        if (stop.signal.aborted) seen.after.push(`${vendor}/${req.model}: ${prompt.slice(0, 40)}`);
        else if (/^Own the assigned artifact/.test(prompt)) {
          seen.inflight = opts?.signal ?? null;
          stop.abort(Object.assign(new Error('STAGE_ELAPSED: the test stopped the stage'), {code: 'STAGE_ELAPSED'}));
          seen.abortedAt = Date.now();
          await new Promise(res => {
            const t = setTimeout(res, HOLD_MS);
            seen.inflight?.addEventListener('abort', () => { clearTimeout(t); res(); }, {once: true});
          });
          seen.inflight?.throwIfAborted();
        }
        return create(req, opts);
      }}};
    };
    makeClientFor.providers = ctx.makeClientFor.providers;
    const ex = makeExecutors({repo, makeClientFor, turn: scriptedTurn(), stateDir: f.stateDir, independence: 'model', profile: 'argo'});
    let returnedAt = null;
    const executors = {...ex, implement: async c => {
      try { return await ex.implement({...c, signal: AbortSignal.any([c.signal, stop.signal].filter(Boolean))}); }
      finally { returnedAt = Date.now(); }
    }};
    await tick({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, executors, limits: {...LIMITS, iterations: 10}});
    assert.ok(seen.abortedAt, 'the implementer\'s request was reached');
    assert.equal(seen.inflight?.aborted, true, 'the in-flight request carried the stage\'s stop and was cancelled');
    assert.ok(returnedAt - seen.abortedAt < HOLD_MS / 2, `implement returned ${returnedAt - seen.abortedAt} ms after the stop`);
    assert.deepEqual(seen.after, [], 'no provider call is admitted after the stop');
  });
});
