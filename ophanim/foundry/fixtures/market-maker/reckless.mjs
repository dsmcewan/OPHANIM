// A strategy that ignores the inventory limit and the tick, for testing the request `marketMaker`'s harness.
export function createStrategy() { return {quote({last_price}) { return {bid: {price: last_price - 0.005, size: 1}, ask: {price: last_price - 1, size: 0.001}}; }}; }
