// A REFERENCE market-making strategy, hand-written, for testing the request `marketMaker`'s own harness: it shows the
// acceptance can be met. It is NOT in the request's seed and no builder is shown it.
export function createStrategy(config) {
  const {tick, max_inventory, max_order_size} = config, round = (p, dir) => Math[dir](p / tick + (dir === 'floor' ? 1e-9 : -1e-9)) * tick;
  return {quote({last_price, recent, inventory}) {
    const prices = recent.slice(-20).map(t => t.price), mean = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : last_price;
    const vol = prices.length > 1 ? Math.sqrt(prices.reduce((a, p) => a + (p - mean) ** 2, 0) / prices.length) : 5;
    const half = Math.max(2, Math.min(40, vol * 0.6)), skew = (inventory / max_inventory) * half * 1.5, size = Number((max_order_size / 2).toFixed(8));
    const bidPrice = Number(Math.min(round(last_price - half - skew, 'floor'), last_price).toFixed(2)), askPrice = Number(Math.max(round(last_price + half - skew, 'ceil'), last_price).toFixed(2));
    return {bid: inventory + size <= max_inventory ? {price: bidPrice, size} : null, ask: inventory - size >= -max_inventory ? {price: askPrice, size} : null};
  }};
}
