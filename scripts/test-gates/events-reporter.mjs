// A node:test reporter that writes one JSON line per finished test and per summary, with the file each came from.
// The gate (check.mjs run) adds it next to the spec reporter, so the human log is unchanged and the machine record
// attributes every pass, fail, skip, todo and cancellation to its test file -- which the spec and TAP text do not do
// for skips (they print a skipped test's name and reason, never its file).
//
//   node --test --test-reporter=spec --test-reporter-destination=stdout \
//               --test-reporter=./scripts/test-gates/events-reporter.mjs --test-reporter-destination=EVENTS.jsonl ...
//
// Inputs:  the node:test event stream (Node >= 22).
// Outputs: JSON lines {type: 'test'|'summary'|'interrupted', ...}.
// Must never: drop a test:fail, or record a cancellation as a plain failure (failureType is kept).
const CANCELLED = new Set(['cancelledByParent', 'testTimeoutFailure']);

export default async function* eventsReporter(source) {
  for await (const event of source) {
    const d = event.data ?? {};
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      // A suite's wrapper is not a test; node:test does not count it either.
      if (d.details?.type === 'suite') continue;
      const failureType = d.details?.error?.failureType ?? null;
      const status = d.skip !== undefined ? 'skipped' : d.todo !== undefined ? 'todo'
        : event.type === 'test:pass' ? 'pass' : CANCELLED.has(failureType) ? 'cancelled' : 'fail';
      yield JSON.stringify({
        type: 'test', status, file: d.file ?? null, name: d.name, nesting: d.nesting, line: d.line ?? null,
        ...(d.skip !== undefined ? {reason: d.skip === true ? '' : String(d.skip)} : {}),
        ...(failureType ? {failureType, message: String(d.details.error.message ?? '').slice(0, 300)} : {}),
      }) + '\n';
    } else if (event.type === 'test:summary') {
      yield JSON.stringify({type: 'summary', file: d.file ?? null, success: d.success, counts: d.counts}) + '\n';
    } else if (event.type === 'test:interrupted') {
      yield JSON.stringify({type: 'interrupted', tests: (d.tests ?? []).map(t => ({file: t.file ?? null, name: t.name}))}) + '\n';
    }
  }
}
