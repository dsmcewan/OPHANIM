// A REFERENCE strategy for testing the request `marketMakerDay`'s own harness, hand-written: it does not quote the side
// that faces the last taker, and leans its quotes against its inventory. It is NOT in the request's seed and no builder
// is shown it.
export function createStrategy(config) {
  const cents = p => Math.round(p * 100) / 100, size = 0.002;
  return {quote({last_price, recent, inventory}) {
    const ps = recent.slice(-20).map(t => t.price), mean = ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : last_price;
    const vol = ps.length > 1 ? Math.sqrt(ps.reduce((a, p) => a + (p - mean) ** 2, 0) / ps.length) : 5, half = Math.max(2, Math.min(60, vol * 0.6));
    const last = recent.at(-1), flow = last ? (last.side === 'buy' ? 1 : -1) : 0, center = last_price - (inventory / config.max_inventory) * half * 4;
    let bid = {price: cents(Math.min(center - half, last_price)), size}, ask = {price: cents(Math.max(center + half, last_price)), size};
    if (flow === -1 || inventory + size > config.max_inventory) bid = null;
    if (flow === 1 || inventory - size < -config.max_inventory) ask = null;
    return {bid, ask};
  }};
}
