// A node:test reporter that writes one JSON line per finished test, per failed suite and per summary, with the file
// each came from. The gate (check.mjs run) adds it next to the spec reporter, so the human log is unchanged and the
// machine record attributes every pass, fail, skip, todo and cancellation to its test file -- which the spec and TAP
// text do not do for skips (they print a skipped test's name and reason, never its file).
//
//   node --test --test-reporter=spec --test-reporter-destination=stdout \
//               --test-reporter=./scripts/test-gates/events-reporter.mjs --test-reporter-destination=EVENTS.jsonl ...
//
// A failing suite (a describe() that throws while registering, or whose before() hook fails) is NOT counted by
// node:test under `fail` (Node 24.22.1 reports `fail 0`, exit 1); it is written here as {type: 'suite', status:
// 'fail'} so the gate can fail on it by name (L-506).
//
// Inputs:  the node:test event stream (Node >= 22).
// Outputs: JSON lines {type: 'test'|'suite'|'summary'|'interrupted', ...}.
// Must never: drop a test:fail (a test's or a suite's), or record a cancellation as a plain failure (failureType is kept).
const CANCELLED = new Set(['cancelledByParent', 'testTimeoutFailure']);

export default async function* eventsReporter(source) {
  for await (const event of source) {
    const d = event.data ?? {};
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      const failureType = d.details?.error?.failureType ?? null;
      const failure = failureType ? {failureType, message: String(d.details.error.message ?? '').slice(0, 300)} : {};
      // A suite's wrapper is not a test; node:test does not count it either. Its failure is still a failure.
      if (d.details?.type === 'suite') {
        if (event.type === 'test:fail') yield JSON.stringify({type: 'suite', status: 'fail', file: d.file ?? null, name: d.name, nesting: d.nesting, line: d.line ?? null, ...failure}) + '\n';
        continue;
      }
      const status = d.skip !== undefined ? 'skipped' : d.todo !== undefined ? 'todo'
        : event.type === 'test:pass' ? 'pass' : CANCELLED.has(failureType) ? 'cancelled' : 'fail';
      yield JSON.stringify({
        type: 'test', status, file: d.file ?? null, name: d.name, nesting: d.nesting, line: d.line ?? null,
        ms: typeof d.details?.duration_ms === 'number' ? Math.round(d.details.duration_ms) : null,
        ...(d.skip !== undefined ? {reason: d.skip === true ? '' : String(d.skip)} : {}),
        ...failure,
      }) + '\n';
    } else if (event.type === 'test:summary') {
      yield JSON.stringify({type: 'summary', file: d.file ?? null, success: d.success, counts: d.counts}) + '\n';
    } else if (event.type === 'test:interrupted') {
      yield JSON.stringify({type: 'interrupted', tests: (d.tests ?? []).map(t => ({file: t.file ?? null, name: t.name}))}) + '\n';
    }
  }
}
