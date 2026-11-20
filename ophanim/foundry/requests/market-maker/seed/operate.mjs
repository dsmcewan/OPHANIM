// THE OPERATION of the request `marketMaker`: the accepted strategy is run over the SECOND half of the recorded tape,
// which its acceptance never replayed, and what it did is reported as one JSON line. Paper trading: no order is sent.
// `score` is the mark-to-market result in USD after the simulator's assumed fee. It exits 1 if any quote broke a rule.
import {createStrategy} from '../strategy.mjs';
import {replay, loadTape, halves} from './sim.mjs';

const {second} = halves(loadTape()), r = replay(createStrategy, second);
console.log(JSON.stringify({window: 'second half, not replayed by the acceptance', paper: true, score: r.pnl_usd, ...r}));
process.exit(r.violations === 0 ? 0 : 1);
