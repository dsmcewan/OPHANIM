// A strategy that never quotes, for testing the request `marketMakerDay`'s harness: it breaks no rule and must still fail.
export function createStrategy() { return {quote() { return {bid: null, ask: null}; }}; }
