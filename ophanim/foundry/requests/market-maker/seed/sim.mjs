// A PAPER-TRADING SIMULATOR for a market-making strategy over a RECORDED trade tape. No order is ever sent anywhere.
//
// Purpose   The acceptance and the operation of the request `marketMaker` both replay recorded trades (tape.json) and
//           ask the strategy, before each trade, what it would quote. This file is that replay and its bookkeeping.
// The rules, which the request's goal states to the builder word for word:
//   - Before each trade the strategy sees only the past: the previous trade's price, the recent trades, its own
//     inventory and cash, and the configuration. It never sees the trade it may be filled by.
//   - It answers {bid, ask}: each null (no quote) or {price, size}. A price is a positive multiple of the tick (0.01);
//     a size is a multiple of 0.00000001 between min_size and max_order_size; a bid is at or below the previous
//     trade's price and an ask at or above it; the bid is below the ask; a bid may not take inventory above
//     +max_inventory and an ask may not take it below -max_inventory. A quote that breaks a rule is a VIOLATION: it is
//     not placed, and it is counted.
//   - A resting bid fills only when the next trade is a taker SELL that prints strictly BELOW the bid's price; a
//     resting ask only when the next trade is a taker BUY strictly ABOVE the ask's price. The fill is at the quote's
//     own price, for the smaller of the quote's size and the trade's amount. Quotes last for one trade.
//   - A fee of fee_bps of the filled notional is charged. It is an assumption of this simulator, not an exchange's
//     schedule.
// Accounting is exact: prices in cents, sizes in satoshis, cash in cent-satoshis, all integers. The same strategy
// over the same trades gives the same report, byte for byte.
// Limits    A trade tape holds no queue: a real resting order may not have been filled where this replay fills it,
//           and the replay's own quotes move no price. A result here is a paper result on one recorded window.
import {readFileSync} from 'node:fs';

export const CONFIG = Object.freeze({symbol: 'BTCUSD', tick: 0.01, size_step: 0.00000001, min_size: 0.00001, max_order_size: 0.01, max_inventory: 0.05, fee_bps: 2, window: 50});
const CENTS = 100, SATS = 1e8;
const grid = (v, unit) => { const n = Math.round(v * unit); return Number.isFinite(v) && Math.abs(v * unit - n) < 1e-4 ? n : null; };

export function loadTape(url = new URL('./tape.json', import.meta.url)) {
  const t = JSON.parse(readFileSync(url, 'utf8'));
  return t.trades.map(([ms, price, amount, side]) => Object.freeze({ms, price: Number(price), amount: Number(amount), side}));
}

/** Replay `trades` against the strategy `createStrategy(config)` returns. The first trade only sets the reference price. */
export function replay(createStrategy, trades, config = CONFIG) {
  const strategy = createStrategy({...config});
  if (!strategy || typeof strategy.quote !== 'function') throw new Error('createStrategy(config) must return an object with a quote(state) function');
  const maxInv = Math.round(config.max_inventory * SATS), minSize = Math.round(config.min_size * SATS), maxSize = Math.round(config.max_order_size * SATS);
  let cash = 0n, fees = 0n, inv = 0, fills = 0, volume = 0, quotes = 0, twoSided = 0, maxAbs = 0, last = trades[0].price;
  const violations = [], recent = [];
  const violate = (i, side, why) => { violations.push({trade: i, side, why}); return null; };
  const checked = (i, side, q) => {
    if (q === null || q === undefined) return null;
    if (typeof q !== 'object' || typeof q.price !== 'number' || typeof q.size !== 'number') return violate(i, side, 'a quote is null or {price, size} with numbers');
    const price = grid(q.price, CENTS), size = grid(q.size, SATS), lastCents = Math.round(last * CENTS);
    if (price === null || price <= 0) return violate(i, side, 'the price is not a positive multiple of the tick');
    if (size === null || size < minSize || size > maxSize) return violate(i, side, 'the size is not a multiple of the size step between min_size and max_order_size');
    if (side === 'bid' ? price > lastCents : price < lastCents) return violate(i, side, side === 'bid' ? 'the bid is above the previous trade price' : 'the ask is below the previous trade price');
    if (side === 'bid' ? inv + size > maxInv : inv - size < -maxInv) return violate(i, side, 'the quote would take inventory past max_inventory');
    return {price, size};
  };
  for (let i = 1; i < trades.length; i++) {
    const t = trades[i];
    let q = null;
    try { q = strategy.quote(Object.freeze({ts: t.ms, last_price: last, recent: Object.freeze(recent.slice(-config.window)), inventory: inv / SATS, cash: Number(cash - fees) / (CENTS * SATS), config})); }
    catch (e) { violate(i, 'both', `quote threw: ${String(e?.message ?? e).slice(0, 120)}`); }
    if (q !== null && typeof q !== 'object') { violate(i, 'both', 'quote must return {bid, ask}'); q = null; }
    let bid = checked(i, 'bid', q?.bid), ask = checked(i, 'ask', q?.ask);
    if (bid && ask && bid.price >= ask.price) { violate(i, 'both', 'the bid is not below the ask'); bid = ask = null; }
    if (bid || ask) quotes++;
    if (bid && ask) twoSided++;
    const amount = Math.round(t.amount * SATS), price = Math.round(t.price * CENTS);
    const fill = (quote, sign) => {
      const size = Math.min(quote.size, amount), notional = BigInt(size) * BigInt(quote.price);
      inv += sign * size; cash -= BigInt(sign) * notional; fees += notional * BigInt(config.fee_bps) / 10000n; fills++; volume += size;
    };
    if (bid && t.side === 'sell' && price < bid.price) fill(bid, 1);
    if (ask && t.side === 'buy' && price > ask.price) fill(ask, -1);
    maxAbs = Math.max(maxAbs, Math.abs(inv));
    last = t.price;
    recent.push(Object.freeze({ms: t.ms, price: t.price, amount: t.amount, side: t.side}));
  }
  const mark = BigInt(inv) * BigInt(Math.round(last * CENTS)), usd = v => Number(v) / (CENTS * SATS);
  return {trades: trades.length - 1, quoted: quotes, two_sided: twoSided, two_sided_share: Number((twoSided / (trades.length - 1)).toFixed(4)), fills, volume_btc: volume / SATS,
    inventory_btc: inv / SATS, max_abs_inventory_btc: maxAbs / SATS, fees_usd: Number(usd(fees).toFixed(6)), pnl_usd: Number(usd(cash + mark - fees).toFixed(6)),
    last_price: last, first_price: trades[0].price, low: Math.min(...trades.map(t => t.price)), high: Math.max(...trades.map(t => t.price)), violations: violations.length, first_violations: violations.slice(0, 5)};
}

/** The tape in two halves: the acceptance replays the first, the operation the second, which the acceptance never touched. */
export const halves = trades => { const mid = Math.floor(trades.length / 2); return {first: trades.slice(0, mid), second: trades.slice(mid)}; };
