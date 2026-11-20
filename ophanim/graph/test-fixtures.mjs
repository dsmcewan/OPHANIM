// A small repository for the graph tests: real git, a real status ledger and work ledger (the operate fixture's), the
// REAL capability configuration of this checkout, and a handful of files whose relationships are known.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture} from '../operate/test-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '../..');
export const AT = '2026-11-20T00:00:00.000Z';
export const I = 'ophanim';
export const id = (domain, type, key, instance = I) => `${instance}:${domain}:${type}:${key}`;
export const C = k => id('systems', 'component', k), T = k => id('systems', 'test', k), CAP = k => id('systems', 'capability', k), ITEM = k => id('work', 'item', k);

const write = (repo, f, text) => { fs.mkdirSync(path.dirname(path.join(repo, f)), {recursive: true}); fs.writeFileSync(path.join(repo, f), text); };
export const FILES = {
  'src/util.mjs': 'export const util = 1;\n',
  'src/gateway.mjs': 'import {util} from \'./util.mjs\';\nexport const gateway = util + 1;\nexport function admit() { return true; }\n',
  'src/turn.mjs': 'import {gateway} from \'./gateway.mjs\';\nexport const turn = gateway;\n',
  'src/unrelated.mjs': 'export const unrelated = 0;\n',
  'src/gateway.test.mjs': 'import {gateway} from \'./gateway.mjs\';\nif (gateway !== 2) process.exit(1);\n',
  // A runner WITHOUT a main guard: importing it would write the marker. The graph reads it as text.
  'src/demo.mutate.mjs': 'import fs from \'node:fs\';\nconst GW = \'src/gateway.mjs\';\nconst T = {gw: [\'src/gateway.test.mjs\']};\nexport const MUTATIONS = [\n  {id: \'D1\', what: \'the gateway admits without asking\', file: GW, tests: T.gw, from: \'return true\', to: \'return 1\'},\n  {id: \'D2\', what: \'a target this runner cannot resolve\', file: NOWHERE, tests: T.gw},\n];\nfs.writeFileSync(new URL(\'./IMPORTED\', import.meta.url), \'a reading executed its source\');\n',
  'docs/OPEN-LIMITATIONS.md': '# Register\n\n## Open, planned or active\n\n| ID | Item | Consequence | Routes | Status |\n|---|---|---|---|---|\n| L-900 | **The gateway admits every request.** No budget is asked. | Spend is unbounded. | `src/gateway.mjs`, `turn.mjs` | open (future ticket) |\n| L-901 | **The utility had no test.** | A change went unseen. | `src/util.mjs` | repaired (`abc1234`) |\n',
  'ophanim/lessons/corrections.json': JSON.stringify({schema: 'ophanim.owner-corrections/v1', purpose: 'fixture', classes: [
    {id: 'bound-declared-not-enforced', class: 'A bound is declared and nothing enforces it.', source: 'fixture', fixed_in: 'abc1234', detector: {kind: 'test', file: 'src/gateway.test.mjs', name: 'gateway'},
      instances: [{observed_by: 'owner', date: '2026-11-17', ref: 'abc1234', note: 'the gateway admitted without a budget', recurrence_check: 'src/gateway.test.mjs (the admission)'}]},
    {id: 'claim-without-evidence', class: 'A result is claimed that no run shows.', source: 'fixture', detector: {kind: 'none', why: 'no test yet', next: 'write one'}, instances: [{observed_by: 'review', date: '2026-11-19', ref: 'def5678', note: 'a pass was reported for a suite that was skipped', detected_by: 'an independent review'}]},
  ]}, null, 2) + '\n',
};

/** A fixture repository with status and work ledgers: {repo, statusRoot, workRoot, S, stateDir, graphRoot, write}. */
export function graphFixture(t, {items = [{item: 'kg-a'}, {item: 'kg-b', depends_on: ['kg-a']}], files = FILES} = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ophanim-graph-fixture-'));
  t.after(() => fs.rmSync(repo, {recursive: true, force: true}));
  for (const [f, text] of Object.entries(files)) write(repo, f, text);
  for (const f of ['models.json', 'capability-facts.json', 'lanes.json', 'model-identity.json', 'antigravity-sdk.json']) write(repo, `pantheon/src/config/${f}`, fs.readFileSync(path.join(REPO, 'pantheon/src/config', f), 'utf8'));
  const f = fixture(repo, items);
  return {repo, ...f, graphRoot: path.join(repo, 'status', 'graph'), write: (file, text) => write(repo, file, text)};
}
