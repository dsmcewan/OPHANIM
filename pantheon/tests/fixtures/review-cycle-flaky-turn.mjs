// A scripted reviewer turn for the review-cycle resume tests: every lab approves, except the vendors named
// in REVIEW_CYCLE_DOWN (comma-separated), which fail as a provider 503 would. Each call appends its vendor
// to REVIEW_CYCLE_CALL_LOG, so a test can count calls across CLI processes. No network.
import {appendFileSync} from 'node:fs';

let n = 0;
export default async function turn({vendor, model}) {
  if (process.env.REVIEW_CYCLE_CALL_LOG) appendFileSync(process.env.REVIEW_CYCLE_CALL_LOG, `${vendor}\n`);
  if ((process.env.REVIEW_CYCLE_DOWN ?? '').split(',').includes(vendor)) {
    throw Object.assign(new Error(`${vendor}/${model}: 503 Service Unavailable`), {status: 503});
  }
  return {text: '```json\n{"verdict": "approve", "findings": []}\n```', response_id: `resp_flaky_${vendor}_${process.pid}_${++n}`, served_model: model};
}
