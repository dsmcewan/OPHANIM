// The OPHANIM CLI records on the ledger by default (<stateDir>/ledger), and `ledger: false` opts out.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {executeRequest} from '../cli.mjs';
import {openSystemLedger} from './system.mjs';

const base = {fixture: {count: 2, namespace: 'cli-default-ledger'}, slots: 1, workerOptions: {delayMs: 15}};

test('a run records its efficiency trace and assessment on the default ledger; opting out writes none', {timeout: 180000}, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-cli-ledger-')));
  const saved = process.env.OPHANIM_LEDGER;
  delete process.env.OPHANIM_LEDGER;
  try {
    const stateDir = path.join(root, 'on');
    const output = await executeRequest({...base, stateDir});
    assert.ok(output.efficiency.ledger?.trace && output.efficiency.ledger?.assessed, 'the record names its ledger entries');
    const L = openSystemLedger({root: path.join(stateDir, 'ledger')});
    const kinds = L.ledger.read().map(e => e.kind);
    assert.ok(kinds.includes('efficiency.trace') && kinds.includes('efficiency.assessed'));
    assert.equal(L.ledger.verify().ok, true);
    const off = path.join(root, 'off');
    const plain = await executeRequest({...base, stateDir: off}, {ledger: false});
    assert.equal(plain.efficiency.ledger, undefined);
    assert.equal(fs.existsSync(path.join(off, 'ledger')), false);
  } finally {
    if (saved === undefined) delete process.env.OPHANIM_LEDGER; else process.env.OPHANIM_LEDGER = saved;
    fs.rmSync(root, {recursive: true, force: true});
  }
});
