export function createStrategy(config) {
  function roundPrice(p, tick) {
    let r = Math.round(p / tick) * tick;
    r = Math.round(r * 100) / 100;
    return r;
  }

  function roundSizeDown(s, step) {
    let r = Math.floor(s / step) * step;
    r = Math.round(r * 1e8) / 1e8;
    return r;
  }

  function quote(state) {
    const { last_price, recent, inventory } = state;
    const cfg = state.config || config;
    const tick = cfg.tick;
    const size_step = cfg.size_step;
    const min_size = cfg.min_size;
    const max_order_size = cfg.max_order_size;
    const max_inventory = cfg.max_inventory;
    const fee_bps = cfg.fee_bps;

    if (!(last_price > 0) || !isFinite(last_price)) {
      return { bid: null, ask: null };
    }

    // --- derive a dispersion-based volatility estimate from recent trades ---
    let vol;
    if (!recent || recent.length < 2) {
      // cold start: a sensible relative default, not an absolute dollar figure
      vol = last_price * 0.0008;
    } else {
      let sum = 0;
      let n = 0;
      for (let i = 1; i < recent.length; i++) {
        const d = Math.abs(recent[i].price - recent[i - 1].price);
        if (isFinite(d)) {
          sum += d;
          n++;
        }
      }
      vol = n > 0 ? sum / n : last_price * 0.0008;
    }
    if (!isFinite(vol) || vol <= 0) vol = last_price * 0.0008;

    // --- fee-aware floor: a round trip must clear both legs' fees with margin ---
    const feeFrac = (fee_bps || 0) / 1e4;
    const feeMargin = 2; // require roughly double the one-way fee as half-spread
    const feeFloor = last_price * feeFrac * feeMargin;

    const minHalf = Math.max(tick * 3, feeFloor);
    const maxHalf = last_price * 0.01; // relative cap, not an absolute USD constant

    let halfSpread = vol * 0.6;
    halfSpread = Math.min(Math.max(halfSpread, minHalf), maxHalf);

    // --- inventory skew: push the accumulating side's price away from the market
    // and pull the unwinding side's price toward it, so a one-sided run of fills
    // self-limits well before the inventory bound ---
    const invFrac = Math.max(-1, Math.min(1, inventory / max_inventory));
    const skewStrength = 0.9;

    let bidDistance = halfSpread * (1 + invFrac * skewStrength);
    let askDistance = halfSpread * (1 - invFrac * skewStrength);
    const minDistance = tick * 2;
    bidDistance = Math.max(bidDistance, minDistance);
    askDistance = Math.max(askDistance, minDistance);

    let rawBid = last_price - bidDistance;
    let rawAsk = last_price + askDistance;

    let bidPrice = roundPrice(rawBid, tick);
    let askPrice = roundPrice(rawAsk, tick);

    // enforce bid <= last_price <= ask (rounding can push a price across last_price)
    if (bidPrice > last_price) bidPrice = roundPrice(last_price - tick, tick);
    if (askPrice < last_price) askPrice = roundPrice(last_price + tick, tick);
    if (bidPrice <= 0) bidPrice = tick;

    if (bidPrice >= askPrice) {
      askPrice = roundPrice(bidPrice + tick, tick);
      if (askPrice < last_price) askPrice = roundPrice(last_price + tick, tick);
      if (bidPrice >= askPrice) bidPrice = roundPrice(askPrice - tick, tick);
    }

    // --- adaptive sizing: taper each accumulating side smoothly and drop it
    // entirely well before the inventory bound, so a run of one-sided fills
    // cannot reach the limit at once ---
    const base = max_order_size * 0.5;
    const cutoffFrac = 0.65;

    const longFrac = Math.max(0, invFrac);
    const shortFrac = Math.max(0, -invFrac);

    const bidScale = Math.max(0, Math.min(1, 1 - longFrac / cutoffFrac));
    const askScale = Math.max(0, Math.min(1, 1 - shortFrac / cutoffFrac));

    let bid = null;
    let ask = null;

    const headroomBid = max_inventory - inventory;
    if (
      bidScale > 0 &&
      headroomBid >= min_size &&
      bidPrice > 0 &&
      bidPrice < askPrice &&
      bidPrice <= last_price
    ) {
      let size = Math.min(base * bidScale, headroomBid, max_order_size);
      size = roundSizeDown(size, size_step);
      if (size >= min_size && size <= max_order_size) {
        bid = { price: bidPrice, size };
      }
    }

    const headroomAsk = max_inventory + inventory;
    if (
      askScale > 0 &&
      headroomAsk >= min_size &&
      askPrice > bidPrice &&
      askPrice >= last_price
    ) {
      let size = Math.min(base * askScale, headroomAsk, max_order_size);
      size = roundSizeDown(size, size_step);
      if (size >= min_size && size <= max_order_size) {
        ask = { price: askPrice, size };
      }
    }

    // final safety re-check against the inventory bound
    if (bid && inventory + bid.size > max_inventory) bid = null;
    if (ask && inventory - ask.size < -max_inventory) ask = null;

    return { bid, ask };
  }

  return { quote };
}
