// Child of exec-reliability.test.mjs. Charges two provider calls, then hangs so the parent can SIGKILL it.
// Nothing here calls a provider.
import fs from 'node:fs';
import { tick } from '../ophanim/operate/scheduler.mjs';

const [repo, statusRoot, workRoot, marker] = process.argv.slice(2);
await tick({
  repo, statusRoot, workRoot,
  executors: {
    plan: async ctx => {
      ctx.charge(1);
      ctx.charge(1);
      // A pending promise does not keep Node alive, and the scheduler's stage timer is unref'd.
      setInterval(() => {}, 1000);
      fs.writeFileSync(marker, String(process.pid));
      await new Promise(() => {});
    },
  },
  limits: { total_provider_calls: 100, stage_provider_calls: 10, iterations: 2, lease_ms: 60_000, elapsed_ms: 120_000 },
});
