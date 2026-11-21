// The CI verification summary's cancelled column (L-503): node:test counts a timed-out test, or a file cut off
// before its tests finished, as cancelled and not as fail, so the table must show cancelled beside fail.
// The recorded log is a real Node 22 run (scripts/test-gates/fixtures/node22-cancelled.spec.log).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {summary, suiteCounts} from './ci-summary.mjs';

const LOG = new URL('../../scripts/test-gates/fixtures/node22-cancelled.spec.log', import.meta.url);

test('the CI summary shows cancelled next to fail: a cancelled file is not hidden behind fail 0', () => {
  const text = fs.readFileSync(LOG, 'utf8');
  const [row] = suiteCounts(text, 'proof');
  assert.deepEqual([row.tests, row.pass, row.fail, row.cancelled], [5, 2, 0, 2]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-summary-'));
  try {
    const f = path.join(dir, 'p.log');
    fs.writeFileSync(f, text);
    const md = summary([{label: 'proof', file: f}, {label: 'gone', file: path.join(dir, 'none.log')}]);
    assert.match(md, /^\| Suite \| Tests \| Pass \| Fail \| Skipped \| Todo \| Cancelled \|$/m);
    assert.match(md, /^\| proof \| 5 \| 2 \| 0 \| 1 \| 0 \| \*\*2\*\* \|$/m);
    assert.match(md, /^\| gone \| no result \(the step did not run or did not finish\) \| \| \| \| \| \|$/m);
    // A clean suite shows a plain 0.
    fs.writeFileSync(f, 'ℹ tests 3\nℹ pass 3\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n');
    assert.match(summary([{label: 'ok', file: f}]), /^\| ok \| 3 \| 3 \| 0 \| 0 \| 0 \| 0 \|$/m);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
