// The request `marketMaker` (ophanim/foundry/requests/market-maker): its own harness, before any builder sees it.
// The simulator replays a RECORDED tape of public BTCUSD trades; nothing here sends an order or opens a network.
// SYNTHETIC strategies (ophanim/foundry/fixtures/market-maker) stand in for a built product.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readRequest} from '../foundry/request.mjs';
import {dependencyGate} from '../foundry/trial.mjs';
import {replay, loadTape, halves, CONFIG} from '../foundry/requests/market-maker/seed/sim.mjs';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const REQUEST = here('../foundry/requests/market-maker/request.json'), FIXTURES = here('../foundry/fixtures/market-maker');
const {request, seed} = readRequest(REQUEST);
const product = (t, name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-mm-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.cpSync(seed, path.join(dir, 'seed'), {recursive: true});
  fs.copyFileSync(path.join(FIXTURES, `${name}.mjs`), path.join(dir, 'strategy.mjs'));
  const run = cmd => { const [bin, ...args] = cmd.split(' '); const r = spawnSync(bin === 'node' ? process.execPath : bin, args, {cwd: dir, encoding: 'utf8'}); return {exit: r.status, out: r.stdout, report: JSON.parse(r.stdout.trim().split('\n').at(-1))}; };
  return {accept: () => run(request.acceptance_cmd), operate: () => run(request.operate.cmd)};
};
const strategyOf = quote => () => ({quote});

test('the request reads, names one file, allows no dependency and operates on a scored report; the tape is 500 recorded trades in time order', () => {
  assert.deepEqual([request.key, request.class, request.files, request.allowed, request.operate.score, request.tests_file], ['marketMaker', 'build/trading-strategy', [{slot: 'strategy', path: 'strategy.mjs'}], {builtins: []}, 'score', 'seed/acceptance.mjs']);
  const tape = loadTape(), {first, second} = halves(tape);
  assert.deepEqual([tape.length, first.length, second.length, tape.every((t, i) => i === 0 || t.ms >= tape[i - 1].ms), [...new Set(tape.map(t => t.side))].sort()], [500, 250, 250, true, ['buy', 'sell']]);
  assert.match(JSON.parse(fs.readFileSync(path.join(seed, 'tape.json'), 'utf8')).source, /recorded, not live/);
});

test('THE ACCEPTANCE CAN BE MET and is not met by doing nothing or by ignoring the rules: a hand-written reference passes, a strategy that never quotes fails, one that breaks the tick and the limit fails', t => {
  const ref = product(t, 'reference').accept();
  assert.deepEqual([ref.exit, ref.report.violations, ref.report.fills >= 10, ref.report.two_sided_share >= 0.5, ref.report.max_abs_inventory_btc <= CONFIG.max_inventory], [0, 0, true, true, true]);
  assert.equal(ref.out.split('\n').filter(l => l.startsWith('FAIL')).length, 0);
  const idle = product(t, 'never-quotes').accept();
  assert.deepEqual([idle.exit, idle.out.split('\n').filter(l => l.startsWith('FAIL')).map(l => l.replace(/^FAIL (it [a-z ]+):.*$/, '$1'))], [1, ['it makes a market', 'it trades']]);
  const reckless = product(t, 'reckless').accept();
  assert.deepEqual([reckless.exit, reckless.report.violations, reckless.report.first_violations[0].why], [1, 498, 'the price is not a positive multiple of the tick']);
});

test('THE OPERATION runs on the half of the tape the acceptance never replayed and reports a score; it is a paper result and says so', t => {
  const p = product(t, 'reference'), a = p.accept().report, o = p.operate();
  assert.deepEqual([o.exit, o.report.paper, o.report.window, typeof o.report.score, o.report.score === o.report.pnl_usd, o.report.first_price !== a.first_price], [0, true, 'second half, not replayed by the acceptance', 'number', true, true]);
  assert.equal(product(t, 'reckless').operate().exit, 1, 'an operation in which a quote broke a rule fails');
});

test('THE SIMULATOR: a fill needs a trade strictly through the quote on the right side, at the quote\'s own price, with the fee; the strategy never sees the trade that fills it; accounting is exact', () => {
  const tape = [{ms: 1, price: 100, amount: 1, side: 'buy'}, {ms: 2, price: 99, amount: 0.002, side: 'sell'}, {ms: 3, price: 99.5, amount: 1, side: 'sell'}, {ms: 4, price: 101, amount: 0.004, side: 'buy'}, {ms: 5, price: 101, amount: 1, side: 'sell'}];
  const seen = [];
  const r = replay(strategyOf(s => { seen.push([s.last_price, s.recent.length, s.inventory]); return {bid: {price: 99.5, size: 0.01}, ask: {price: 100.5, size: 0.01}}; }), tape);
  // Before trade 2 (index 1) both quotes stand; the sell at 99 is through the bid, which fills for the trade's 0.002. Before
  // the next, the price is 99 and the bid at 99.5 is above it: refused. Then the price is 99.5: both stand, and the buy at
  // 101 is through the ask, which fills for 0.004. Then the price is 101 and the ask at 100.5 is below it: refused.
  assert.deepEqual(seen, [[100, 0, 0], [99, 1, 0.002], [99.5, 2, 0.002], [101, 3, -0.002]]);
  assert.deepEqual([r.fills, r.volume_btc, r.inventory_btc, r.violations, r.two_sided], [2, 0.006, -0.002, 2, 2]);
  assert.deepEqual(r.first_violations, [{trade: 2, side: 'bid', why: 'the bid is above the previous trade price'}, {trade: 4, side: 'ask', why: 'the ask is below the previous trade price'}]);
  const fees = (0.002 * 99.5 + 0.004 * 100.5) * 0.0002, cash = -0.002 * 99.5 + 0.004 * 100.5;
  assert.deepEqual([r.fees_usd, r.pnl_usd], [Number(fees.toFixed(6)), Number((cash - 0.002 * 101 - fees).toFixed(6))]);
});

test('THE SIMULATOR refuses, and counts, a quote off the tick, out of the size bounds, crossed, past the inventory limit or malformed; a strategy that throws is a violation, not a crash', () => {
  const tape = [1, 2, 3, 4, 5, 6, 7].map(i => ({ms: i, price: 100, amount: 1, side: i % 2 ? 'buy' : 'sell'}));
  const answers = [{bid: {price: 99.995, size: 0.001}, ask: null}, {bid: {price: 99, size: 0.02}, ask: null}, {bid: {price: 100, size: 0.001}, ask: {price: 100, size: 0.001}},
    {bid: {price: '99', size: 0.001}, ask: null}, {bid: null, ask: {price: 101, size: 0.000001}}, null];
  let i = 0;
  const r = replay(strategyOf(() => { const a = answers[i++]; if (a === null) throw new Error('boom'); return a; }), tape);
  assert.deepEqual(r.first_violations.map(v => v.why).concat(r.violations), ['the price is not a positive multiple of the tick', 'the size is not a multiple of the size step between min_size and max_order_size',
    'the bid is not below the ask', 'a quote is null or {price, size} with numbers', 'the size is not a multiple of the size step between min_size and max_order_size', 6]);
  const limit = replay(strategyOf(s => ({bid: {price: 100, size: 0.01}, ask: null})), [100, 99, 99, 99, 99, 99, 99, 99].map((p, k) => ({ms: k, price: p, amount: 1, side: 'sell'})));
  assert.deepEqual([limit.max_abs_inventory_btc, limit.first_violations[0].why], [0.01, 'the bid is above the previous trade price'], 'a bid left above a fallen price is not placed');
  const full = replay(strategyOf(s => ({bid: {price: Math.round((s.last_price - 0.01) * 100) / 100, size: 0.01}, ask: null})), Array.from({length: 9}, (_, k) => ({ms: k, price: 100 - k, amount: 1, side: 'sell'})));
  assert.deepEqual([full.max_abs_inventory_btc, full.inventory_btc, full.violations, full.first_violations[0].why], [0.05, 0.05, 3, 'the quote would take inventory past max_inventory']);
});

test('the reference needs nothing the request does not allow; a strategy that reads the clock or the network would be refused by the dependency gate before it is operated', () => {
  const ref = fs.readFileSync(path.join(FIXTURES, 'reference.mjs'), 'utf8');
  assert.deepEqual(dependencyGate([{path: 'strategy.mjs', text: ref}], request.allowed), {ok: true, needs: {relative: [], builtins: [], packages: [], env: [], hosts: [], programs: [], reads: [], writes: [], unresolved: 0}, refused: []});
  const leaky = "import https from 'node:https';\n" + ref;
  assert.deepEqual(dependencyGate([{path: 'strategy.mjs', text: leaky}], request.allowed).refused, [{file: 'strategy.mjs', line: 1, kind: 'builtin', name: 'node:https'}]);
});
