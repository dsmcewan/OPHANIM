// THE ACCEPTANCE of the request `marketMakerDay`: the strategy is replayed over each of the FIRST TWO of six blocks of
// a recorded day of trades, separately, and must hold every rule below in both. It exits 0 only when all hold. No order
// is sent anywhere: this is paper trading.
import assert from 'node:assert/strict';
import {createStrategy} from '../strategy.mjs';
import {replay, loadTape, blocks, CONFIG, ACCEPTANCE_BLOCKS} from './sim.mjs';

const windows = blocks(loadTape()).slice(0, ACCEPTANCE_BLOCKS), started = Date.now();
let all = true;
windows.forEach((w, i) => {
  const a = replay(createStrategy, w), b = replay(createStrategy, w), lossBound = -(CONFIG.max_inventory * (a.high - a.low)) / 2;
  const checks = [
    ['no quote broke a rule (price on the tick, size in bounds, bid at or below and ask at or above the previous trade, bid below ask, inventory within the limit)', a.violations === 0],
    ['inventory never exceeded max_inventory in either direction', a.max_abs_inventory_btc <= CONFIG.max_inventory],
    ['it makes a market: at least one side was quoted before 80% of the trades, and each side before at least 10% of them', a.quoted_share >= 0.8 && a.bid_share >= 0.1 && a.ask_share >= 0.1],
    ['it trades: at least 20 fills', a.fills >= 20],
    ['it is deterministic: two replays give the same report', (() => { try { assert.deepEqual(a, b); return true; } catch { return false; } })()],
    [`it controls its risk: the mark-to-market result is no worse than ${lossBound.toFixed(2)} USD, half of what holding max_inventory through this block's whole range would lose`, a.pnl_usd >= lossBound],
  ];
  for (const [what, ok] of checks) { console.log(`block ${i + 1}: ${ok ? 'ok  ' : 'FAIL'} ${what}`); all &&= ok; }
  console.log(JSON.stringify({block: i + 1, ...a}));
});
const ms = Date.now() - started, fast = ms < 20000;
console.log(`${fast ? 'ok  ' : 'FAIL'} the replays take under 20 seconds`);
process.exit(all && fast ? 0 : 1);
