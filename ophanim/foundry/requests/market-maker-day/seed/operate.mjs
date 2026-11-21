// THE OPERATION of the request `marketMakerDay`: the accepted strategy is run over each of the LAST FOUR of six blocks
// of the recorded day, which its acceptance never replayed, and what it did is reported as one JSON line. Paper trading:
// no order is sent. `score` is the sum of the blocks' mark-to-market results in USD after the simulator's assumed fee.
// It exits 1 if any quote broke a rule.
import {createStrategy} from '../strategy.mjs';
import {replay, loadTape, blocks, ACCEPTANCE_BLOCKS} from './sim.mjs';

const rs = blocks(loadTape()).slice(ACCEPTANCE_BLOCKS).map(w => replay(createStrategy, w)), sum = k => rs.reduce((a, r) => a + r[k], 0);
console.log(JSON.stringify({window: 'blocks 3 to 6 of 6, not replayed by the acceptance', paper: true, score: Number(sum('pnl_usd').toFixed(6)), pnl_by_block_usd: rs.map(r => r.pnl_usd), blocks_in_profit: rs.filter(r => r.pnl_usd > 0).length,
  trades: sum('trades'), fills: sum('fills'), volume_btc: Number(sum('volume_btc').toFixed(8)), fees_usd: Number(sum('fees_usd').toFixed(6)), max_abs_inventory_btc: Math.max(...rs.map(r => r.max_abs_inventory_btc)),
  quoted_share: Number((sum('quoted') / sum('trades')).toFixed(4)), violations: sum('violations')}));
process.exit(sum('violations') === 0 ? 0 : 1);
