// Child of exec-reliability.test.mjs. Binds a unit worktree, then hangs inside the implementer so the parent can SIGKILL it.
import { runPipeline } from '../pantheon/src/pipeline/index.mjs';
import { writeFileSync } from 'node:fs';
import { seats, unit, scripted, PLANNER } from '../pantheon/tests/fixtures/pipeline-stages.mjs';

const [repo, dir, marker] = process.argv.slice(2);
const plan = [unit('a')];
const turns = scripted({
  plan,
  implement: async args => {
    writeFileSync(marker, args.cwd);
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  },
}).turns;
await runPipeline({
  repo, base: 'main', plan: { work_units: plan }, seats: seats(), turns, dir, planner: PLANNER, run_id: 'killed',
});
