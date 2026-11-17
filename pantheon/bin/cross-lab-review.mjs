#!/usr/bin/env node
// One independent reviewer turn per lab over a review folder's PROMPT.md + PACKET.md, run in parallel,
// each seeing only the packet (never another reviewer's output). One attempt each: a refusal is written
// down, not retried. Usage: node pantheon/bin/cross-lab-review.mjs <review-dir> [vendor/model ...]
// Default seats: openai/gpt-6.1-sol xai/grok-4.7 agy_google/gemini-4-carbon. Keys: see cycle-review-http-turn.mjs.
import turn from './cycle-review-http-turn.mjs';
import {readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
const [dirArg, ...seatArgs] = process.argv.slice(2);
if (!dirArg) { console.error('usage: cross-lab-review.mjs <review-dir> [vendor/model ...]'); process.exit(2); }
const D = resolve(dirArg);
const prompt = readFileSync(join(D, 'PROMPT.md'), 'utf8') + '\n\n' + readFileSync(join(D, 'PACKET.md'), 'utf8');
const seats = (seatArgs.length ? seatArgs : ['openai/gpt-6.1-sol', 'xai/grok-4.7', 'agy_google/gemini-4-carbon']).map(s => s.split('/'));
let failed = 0;
await Promise.all(seats.map(async ([vendor, model]) => {
  const t0 = Date.now();
  try {
    const r = await turn({vendor, model, prompt});
    writeFileSync(join(D, `review-${vendor}.md`), `<!-- vendor=${vendor} requested=${model} served=${r.served_model} response_id=${r.response_id} elapsed_ms=${Date.now() - t0} -->\n\n${r.text}\n`);
    console.log(`${vendor}: ok (served ${r.served_model}, ${r.text.length} chars)`);
  } catch (e) { failed++; console.log(`${vendor}: FAILED ${String(e.message).slice(0, 200)}`); }
}));
process.exit(failed ? 1 : 0);
