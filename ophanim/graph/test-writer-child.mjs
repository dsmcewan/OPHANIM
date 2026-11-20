// A child process of the graph tests: one writer among several, or one that is killed while it writes.
//   node test-writer-child.mjs <root> <instance> <json>
// json: {source, to, assertions, repeat?}. With `repeat` it syncs a new cursor (and a changed attribute) that many times,
// printing a line per applied batch, so a test can kill it in the middle.
import {openGraph} from './store.mjs';

const [root, instance, json] = process.argv.slice(2);
const job = JSON.parse(json);
const g = openGraph({root, instance, create: false});
if (job.repeat) {
  for (let i = 1; i <= job.repeat; i += 1) {
    const r = g.sync(job.source, `${job.to}-${i}`, job.assertions.map(a => ({...a, attrs: {...(a.attrs ?? {}), n: i}, source: {...a.source, version: `v${i}`}})), {at: '2026-11-20T00:00:00.000Z'});
    process.stdout.write(JSON.stringify({i, applied: r.applied}) + '\n');
  }
} else {
  const r = g.sync(job.source, job.to, job.assertions, {at: '2026-11-20T00:00:00.000Z'});
  process.stdout.write(JSON.stringify({applied: r.applied, why: r.why ?? null}) + '\n');
}
