// KG-11 diagnosability: when the descriptor closer refuses (exit 125), the preflight's reason names the closer's own
// `pantheon-fds:` line. At the 2026-11-20 integration two refusals surfaced only as "/usage did not print the JSON
// envelope (exit 125)": the record that held the jail's stderr went with its temp directory, so the cause was lost.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {closerLine, FDS_REFUSED} from '../src/agy/fd-exec.mjs';
import {usageAuthWhy} from '../src/board/agy-cli.mjs';

const REFUSAL = 'pantheon-fds: refused: descriptor(s) 7 still open after closing; the jail was not started';

test('closerLine: the last pantheon-fds line of a stderr, or null when the closer said nothing', () => {
  assert.equal(closerLine(`warming up\npantheon-fds: first\nnoise\n${REFUSAL}\n`), REFUSAL);
  assert.equal(closerLine('agy: some other failure\n'), null);
  assert.equal(closerLine(''), null);
  assert.equal(closerLine(undefined), null);
  assert.ok(closerLine(`pantheon-fds: ${'x'.repeat(5000)}`).length <= 400, 'the line is bounded');
});

test('usageAuthWhy: a closer refusal names the closer\'s reason beside the exit code', () => {
  const u = {exit_code: FDS_REFUSED, killed_for: null, raw: {stdout: '', stderr: `${REFUSAL}\n`}};
  const why = usageAuthWhy(u, null, false);
  assert.match(why, /did not print the JSON envelope \(exit 125/);
  assert.ok(why.includes(REFUSAL), `the reason is carried: ${why}`);
});

test('usageAuthWhy: the other outcomes are worded as before', () => {
  assert.equal(usageAuthWhy({exit_code: 0, killed_for: null, raw: {stdout: '', stderr: ''}}, {}, true), null);
  assert.equal(usageAuthWhy({exit_code: null, killed_for: 'timeout', raw: {stdout: '', stderr: ''}}, null, false), '/usage was stopped (timeout)');
  assert.equal(usageAuthWhy({exit_code: 1, killed_for: null, raw: {stdout: '', stderr: 'agy: boom\n'}}, null, false), '/usage did not print the JSON envelope (exit 1)');
  assert.equal(usageAuthWhy({exit_code: 0, killed_for: null, raw: {stdout: '', stderr: ''}}, {}, false), '/usage returned no quota group with buckets: the CLI has no usable session in the jail');
});
