# Planning learning board

This is a learning-attention board using the existing Pantheon content-addressed store, schema and compare-and-swap write API. It contains one curriculum ticket, one plan and six phase work items. It is separate from OPHANIM's synthetic qualification obligations, which require known expected outputs. No new scheduler or educational acceptance oracle is supplied.

The owner requested initialization on 2026-11-16. The seed's `human` author means owner-delegated setup performed by the coordinator, not a human assessment. The final `human_ack` criterion remains unsatisfied. Phase feedback is provisional; final transfer still requires a separate assessor and recorded limits.

## Storage and handoff

- Local runtime root: `.ophanim/learning-board/` relative to this checkout; ignored by Git.
- Board ref: `refs/board/planning-fundamentals`.
- Portable initialization input: [board-seed.json](board-seed.json).
- Attempts, hints, assessments and mandatory next itineraries: [LEARNING_PROGRESS.md](LEARNING_PROGRESS.md).
- Initial read-back evidence: [board-initialization.json](board-initialization.json). This is a setup snapshot, not a live status feed.

Git transports the seed and instructions, not the mutable local board. A CLI on another machine must initialize its own local store. Existing progress must be preserved on resume; never rerun the seed as an update or use it to reset a board.

## Initialize once, or preserve existing state

Run from the OPHANIM repository root using Node 24. This invokes only local board storage APIs. It does not start a worker, provider, scheduler, watchdog or build pipeline. It creates private directories for a new store and requires canonical parent and board-root paths. It is not a filesystem isolation boundary: pre-existing nested store paths are not checked for symlinks. A malformed existing ref is an error, not permission to overwrite it.

```sh
node --input-type=module <<'JS'
import { mkdirSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { openBoard } from './pantheon/src/board/index.mjs';
import { publish } from './pantheon/src/board/dag.mjs';
import { boardState } from './pantheon/src/board/controller.mjs';
import { isCid, codecOf } from './pantheon/src/board/canon.mjs';

const seed = JSON.parse(readFileSync('docs/planning/board-seed.json', 'utf8'));
if (seed.schema_version !== 1 || seed.ref !== 'refs/board/planning-fundamentals') {
  throw Error('Unexpected learning-board seed');
}
const parent = resolve('.ophanim');
mkdirSync(parent, { recursive: true, mode: 0o700 });
if (realpathSync(parent) !== parent) throw Error('Canonical state parent required');
const root = join(parent, 'learning-board');
mkdirSync(root, { recursive: true, mode: 0o700 });
if (realpathSync(root) !== root) throw Error('Canonical board directory required');
const board = openBoard(root);
const current = board.refs.resolve(seed.ref);
if (existsSync(board.refs.refPath(seed.ref)) && (!isCid(current) || codecOf(current) !== 'commit')) {
  throw Error('Malformed existing board ref; inspect without resetting');
}
if (!current) {
  const result = await publish({
    ...board, ref: seed.ref, expect: null, author: { vendor: 'human' },
    msg: 'Owner-requested learning-board initialization; no assessment or dispatch',
    entries: seed.entries
  });
  if (!result.ok) throw Error(`${result.code}: ${result.why}`);
}
const state = boardState({ ...board, ref: seed.ref });
console.log(JSON.stringify({
  action: current ? 'preserved_existing' : 'initialized',
  root, ref: seed.ref, commit: state.commit,
  items: state.items.map(({ key, state, depends_on }) => ({ key, state, depends_on })),
  leases: state.leases, occupancy: state.occupancy
}, null, 2));
JS
```

## Read status without writing

```sh
node --input-type=module <<'JS'
import { resolve } from 'node:path';
import { openStore } from './pantheon/src/board/cas.mjs';
import { openRefs } from './pantheon/src/board/refs.mjs';
import { boardState, acceptanceStatus } from './pantheon/src/board/controller.mjs';
const root = resolve('.ophanim/learning-board');
const store = openStore(root, { readOnly: true });
const refs = openRefs(root, { store, readOnly: true });
const state = boardState({ store, refs, ref: 'refs/board/planning-fundamentals' });
if (!state.commit) throw Error('Learning board is not initialized in this checkout');
console.log(JSON.stringify({ commit: state.commit, items: state.items,
  acceptance: acceptanceStatus({ store, state }) }, null, 2));
JS
```

## Initial state and next action

| Item | Phase | Board state | Dependency |
| --- | --- | --- | --- |
| LF-001 | Frame the problem | ready | Unassisted learner attempt before hints |
| LF-002 | Ground the reasoning | blocked | LF-001 evidence and versioned fact packet |
| LF-003 | Derive necessary work | blocked | LF-002 evidence and flawed-plan exercise |
| LF-004 | Test adequacy and failure | blocked | LF-003 evidence and changed-condition exercise |
| LF-005 | Judge further investigation | blocked | LF-004 evidence and investigation-choice exercise |
| LF-006 | Demonstrate transfer | blocked | LF-005 evidence and separate assessor |

All learning statuses remain `not_attempted`. `ready` means eligible for the next supervised learning session, not active or passed. The generic board status label can say `executing` when an item is ready; that is not evidence of a running process. Read the item states and runtime activity separately.

The next action is OPHANIM's unassisted answer to the first lesson, followed by coach feedback and a saved next itinerary. The coordinator records the exact attempt and assessment reference before any phase transition. Use the public `publish` API with the observed `expect` commit to record justified transitions; retain history, and on a compare-and-swap refusal re-read instead of blindly retrying. Later phases remain blocked until both their dependency and stated input conditions have evidence. The coach cannot mark its own final transfer assessment accepted.

No background loop was started during initialization. No spend budget was invented. The board's default undeclared budget is not a technical execution block, so do not feed this board to a build runner. `publish` records one bookkeeping turn even for an operator write; this is not a model request or a dollar charge. Initialization makes no claim about a daemon or checkout on another machine.
