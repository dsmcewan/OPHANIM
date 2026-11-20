// The request `marketMakerDay` (ophanim/foundry/requests/market-maker-day): its own harness, over a recorded day of
// public BTCUSD trades cut into six blocks. Nothing here sends an order or opens a network. SYNTHETIC strategies
// (ophanim/foundry/fixtures/market-maker-day) stand in for a built product.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readRequest} from '../foundry/request.mjs';
import {dependencyGate} from '../foundry/trial.mjs';
import {replay, loadTape, blocks, BLOCKS, ACCEPTANCE_BLOCKS} from '../foundry/requests/market-maker-day/seed/sim.mjs';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const FIXTURES = here('../foundry/fixtures/market-maker-day');
const {request, seed} = readRequest(here('../foundry/requests/market-maker-day/request.json'));
const product = (t, name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-mmd-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.cpSync(seed, path.join(dir, 'seed'), {recursive: true});
  fs.copyFileSync(path.join(FIXTURES, `${name}.mjs`), path.join(dir, 'strategy.mjs'));
  const run = cmd => { const [, ...args] = cmd.split(' '); const r = spawnSync(process.execPath, args, {cwd: dir, encoding: 'utf8'}); return {exit: r.status, out: r.stdout, report: JSON.parse(r.stdout.trim().split('\n').filter(l => l.startsWith('{')).at(-1))}; };
  return {accept: () => run(request.acceptance_cmd), operate: () => run(request.operate.cmd)};
};

test('the tape is a recorded day in time order with no trade twice; the acceptance replays the first two of six equal blocks and the operation the other four', () => {
  const tape = loadTape(), bs = blocks(tape);
  assert.deepEqual([tape.length, bs.length, BLOCKS, ACCEPTANCE_BLOCKS, [...new Set(bs.map(b => b.length))], tape.every((t, i) => i === 0 || t.ms >= tape[i - 1].ms)], [13387, 6, 6, 2, [2231], true]);
  const meta = JSON.parse(fs.readFileSync(path.join(seed, 'tape.json'), 'utf8'));
  assert.deepEqual([meta.count, Math.round((meta.last_ms - meta.first_ms) / 3.6e5) / 10, /recorded, not live/.test(meta.source)], [13387, 26.5, true]);
  assert.deepEqual([request.key, request.class, request.allowed, request.operate.score], ['marketMakerDay', 'build/trading-strategy', {builtins: []}, 'score']);
});

test('WHAT THE REQUEST TELLS THE BUILDER WAS MEASURED holds on the two acceptance blocks and is not taken from the blocks the product is scored on', () => {
  const two = blocks(loadTape()).slice(0, ACCEPTANCE_BLOCKS);
  const persistence = two.map(b => b.slice(1).filter((t, i) => t.side === b[i].side).length / (b.length - 1));
  const buys = two.map(b => b.filter(t => t.side === 'buy').length / b.length);
  // test-lint: allow truncated-sequence -- blocks(...).slice(0, ACCEPTANCE_BLOCKS) builds the INPUT (the two blocks the acceptance replays, which is what the request's claim is about); every value computed from those two blocks is compared whole
  assert.deepEqual([persistence.map(x => Math.round(x * 100)), buys.map(x => Math.round(x * 100))], [[82, 81], [81, 76]]);
  assert.match(request.goal, /The next taker is on the SAME side as the last one about 81% of the time\. About four trades in five are taker buys\./);
  assert.match(request.goal, /nothing below comes from the blocks you are scored on/);
});

test('THE ACCEPTANCE CAN BE MET and is not met by doing nothing: a hand-written reference that does not stand in front of the flow passes both blocks; a strategy that never quotes fails', t => {
  const ref = product(t, 'reference').accept();
  assert.deepEqual([ref.exit, ref.out.split('\n').filter(l => /FAIL/.test(l)).length, ref.out.split('\n').filter(l => /^block [12]: ok/.test(l)).length], [0, 0, 12]);
  const idle = product(t, 'never-quotes').accept();
  assert.deepEqual([idle.exit, idle.out.split('\n').filter(l => /FAIL/.test(l)).map(l => l.replace(/^(block \d): FAIL (it [a-z ]+):.*$/, '$1 $2'))], [1, ['block 1 it makes a market', 'block 1 it trades', 'block 2 it makes a market', 'block 2 it trades']]);
});

test('THE OPERATION runs on the four blocks the acceptance never replayed, reports each block and scores their sum; it is a paper result and says so', t => {
  const o = product(t, 'reference').operate();
  assert.deepEqual([o.exit, o.report.paper, o.report.window, o.report.pnl_by_block_usd.length, o.report.trades, o.report.violations], [0, true, 'blocks 3 to 6 of 6, not replayed by the acceptance', 4, 4 * 2230, 0]);
  assert.equal(o.report.score, Number(o.report.pnl_by_block_usd.reduce((a, b) => a + b, 0).toFixed(6)));
  const direct = blocks(loadTape()).slice(ACCEPTANCE_BLOCKS).map(w => replay(() => ({quote: () => ({bid: null, ask: null})}), w).pnl_usd);
  // test-lint: allow truncated-sequence -- blocks(...).slice(ACCEPTANCE_BLOCKS) builds the INPUT (the four blocks the operation replays); the result of every one of the four is compared
  assert.deepEqual(direct, [0, 0, 0, 0], 'a strategy that never quotes neither gains nor loses');
});

test('the reference needs nothing the request does not allow', () => {
  assert.equal(dependencyGate([{path: 'strategy.mjs', text: fs.readFileSync(path.join(FIXTURES, 'reference.mjs'), 'utf8')}], request.allowed).ok, true);
});
