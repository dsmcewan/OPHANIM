// THE ACCEPTANCE of the request `marketMaker`: the strategy is replayed over the FIRST half of the recorded tape and
// must hold every rule below. It exits 0 only when all hold. No order is sent anywhere: this is paper trading.
import assert from 'node:assert/strict';
import {createStrategy} from '../strategy.mjs';
import {replay, loadTape, halves, CONFIG} from './sim.mjs';

const {first} = halves(loadTape());
const started = Date.now(), a = replay(createStrategy, first), b = replay(createStrategy, first), ms = Date.now() - started;
const range = a.high - a.low, lossBound = -(CONFIG.max_inventory * range) / 2;
const checks = [
  ['no quote broke a rule (price on the tick, size in bounds, bid at or below and ask at or above the previous trade, bid below ask, inventory within the limit)', a.violations === 0],
  ['inventory never exceeded max_inventory in either direction', a.max_abs_inventory_btc <= CONFIG.max_inventory],
  ['it makes a market: both a bid and an ask were quoted before at least half of the trades', a.two_sided_share >= 0.5],
  ['it trades: at least 10 fills', a.fills >= 10],
  ['it is deterministic: two replays give the same report', (() => { try { assert.deepEqual(a, b); return true; } catch { return false; } })()],
  [`it controls its risk: the mark-to-market result is no worse than ${lossBound.toFixed(2)} USD, half of what holding max_inventory through this window's whole range would lose`, a.pnl_usd >= lossBound],
  ['two replays of the window take under 5 seconds', ms < 5000],
];
for (const [what, ok] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
console.log(JSON.stringify({window: 'first half', ...a, first_violations: a.first_violations}));
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
