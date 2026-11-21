#!/usr/bin/env node
// One independent reviewer turn per lab over a review folder's PROMPT.md + PACKET.md, run in parallel,
// each seeing only the packet (never another reviewer's output). One attempt each: a refusal is written
// down, not retried. Usage: node pantheon/bin/cross-lab-review.mjs <review-dir> [vendor/model ...] [--gemini-api-primary N]
// Default seats: openai/gpt-6.1-sol xai/grok-4.7 agy_google/gemini-4-carbon. Keys: see cycle-review-http-turn.mjs.
//
// THE GEMINI BILLING POLICY (register L-146; docs/billing-policy.md), OFF when absent: every agy_google seat here is a
// request to the metered Gemini API (the module declares it, whatever the model is named), so it runs only with
// --gemini-api-primary N, at most N billed requests counted from <review-dir>/gemini-billing.jsonl (written before each
// request; a re-run on the same directory counts what was already spent). --metered-gemini-failover N is accepted and
// authorizes nothing here: no seat fails over from a lane. A key in the environment, or the proxy placeholder sent when
// none is set, authorizes nothing. A refused seat is recorded in review-<vendor>.refused.json (its code, provider_requests
// 0), never as a review; the other labs still run; a later run of that seat with the policy declared completes it.
// Exit: 0 every seat reviewed, 1 a seat failed or was refused, 2 usage.
import turn from './cycle-review-http-turn.mjs';
import {readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {billedTurnModule, operatorGemini} from '../src/sdk/live.mjs';
import {isGeminiBillingRefusal} from '../src/route/gemini-billing.mjs';
const gemini = operatorGemini(process.argv.slice(2), {script: 'cross-lab-review', runDir: a => (a[0] ? resolve(a[0]) : null)});
const [dirArg, ...seatArgs] = gemini.argv;
if (!dirArg) { console.error('usage: cross-lab-review.mjs <review-dir> [vendor/model ...] [--gemini-api-primary N]'); process.exit(2); }
const D = resolve(dirArg);
const prompt = readFileSync(join(D, 'PROMPT.md'), 'utf8') + '\n\n' + readFileSync(join(D, 'PACKET.md'), 'utf8');
const seats = (seatArgs.length ? seatArgs : ['openai/gpt-6.1-sol', 'xai/grok-4.7', 'agy_google/gemini-4-carbon']).map(s => s.split('/'));
const review = billedTurnModule(turn, gemini.billing, {purpose: 'cross-lab review'});
let failed = 0;
await Promise.all(seats.map(async ([vendor, model]) => {
  const t0 = Date.now(), refused = join(D, `review-${vendor}.refused.json`);
  try {
    const r = await review({vendor, model, prompt});
    writeFileSync(join(D, `review-${vendor}.md`), `<!-- vendor=${vendor} requested=${model} served=${r.served_model} response_id=${r.response_id} elapsed_ms=${Date.now() - t0} -->\n\n${r.text}\n`);
    rmSync(refused, {force: true});   // the seat is reviewed now; its earlier refusals stay in gemini-billing-runs.jsonl
    console.log(`${vendor}: ok (served ${r.served_model}, ${r.text.length} chars)`);
  } catch (e) {
    failed++;
    if (!isGeminiBillingRefusal(e)) { console.log(`${vendor}: FAILED ${String(e.message).slice(0, 200)}`); return; }
    // THE REFUSAL IS EVIDENCE, NOT A REVIEW: no review file is written, and running this seat again with the policy
    // declared completes it.
    writeFileSync(refused, JSON.stringify({vendor, requested: model, code: e.code, provider_requests: 0, why: e.message, billing: e.billing,
      recover: `node pantheon/bin/cross-lab-review.mjs ${dirArg} ${vendor}/${model} --gemini-api-primary N`}, null, 2) + '\n');
    console.log(`${vendor}: REFUSED ${e.code} (no request sent; recorded in ${refused})`);
  }
}));
process.exit(failed ? 1 : 0);
