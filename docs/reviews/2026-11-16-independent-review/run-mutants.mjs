// Reviewer harness (review evidence, not product code): hand-picked single-line mutants on trust-critical checks.
// A mutant is KILLED when the suite gains a failing test relative to the unmutated baseline.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repo = process.argv[2], outFile = process.argv[3];
const here = fs.realpathSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../../..'));
if (!repo || !outFile) { console.error('usage: node run-mutants.mjs /abs/scratch-copy /abs/results.json [ids]'); process.exit(2); }
if (fs.realpathSync(repo) === here) { console.error('Refusing to mutate the checkout this script lives in. Pass a scratch copy.'); process.exit(2); }
const only = process.argv[4] ? new Set(process.argv[4].split(',')) : null;
const PROOF = 'node --test ophanim/governance/*.test.mjs ophanim/efficiency/*.test.mjs ophanim/efficiency/investigation/*.test.mjs ophanim/tests/*.test.mjs ophanim/ledger/*.test.mjs';
const SUITES = {
  proof: PROOF,
  pantheon: 'cd pantheon && node --test --test-concurrency=2',
  route: 'cd pantheon && node --test tests/route-protocol.test.mjs',
  client: 'cd packages/model-client && node --test tests/*.test.mjs',
};
const C = 'ophanim/ledger/chain.mjs', B = 'ophanim/board.mjs', R = 'ophanim/runtime.mjs';
const I = 'pantheon/src/board/integrate.mjs', T = 'packages/model-client/terminal.mjs';
const MUTANTS = [
  // --- ledger core (K1/K2)
  {id: 'L1', file: C, what: 'author signature not checked', find: 'if (!e.author_sig || !verifyBytes(bodyOf(e), e.author_sig, authorKey)) return', to: 'if (false) return', suites: ['proof', 'route']},
  {id: 'L2', file: C, what: 'order (co-)signature not checked', find: 'if (!e.order_sig || !verifyBytes(orderOf(e), e.order_sig, orderKey)) return', to: 'if (false) return', suites: ['proof', 'route']},
  {id: 'L3', file: C, what: 'parent linkage not checked', find: 'if (e.parent !== (prev ? hashOf(prev) : null)) return', to: 'if (false) return', suites: ['proof', 'route']},
  {id: 'L4', file: C, what: 'genesis anchor not checked', find: 'if (hashOf(e) !== anchor) return', to: 'if (false) return', suites: ['proof', 'route']},
  {id: 'L5', file: C, what: 'checkpoint commitment not checked', find: 'if (payload.through !== i || payload.root !== rootOf(before)) return', to: 'if (false) return', suites: ['proof', 'route']},
  {id: 'L6', file: C, what: 're-derivation result ignored', find: 'if (why) return `entry ${i}: does not re-derive', to: 'if (false) return `entry ${i}: does not re-derive', suites: ['proof', 'route']},
  {id: 'L7', file: C, what: 'kind authorship rule ignored', find: 'if (!k.authors(e.author)) return', to: 'if (false) return', suites: ['proof', 'route']},
  {id: 'L8', file: C, what: 'authority change not limited to operators', find: 'if (!auth.operators.includes(e.author.key_id)) return', to: 'if (false) return', suites: ['proof', 'route']},
  // --- controller chain (P2/P6)
  {id: 'B1', file: B, what: 'accepted row may change between commits', find: "if(row.status==='accepted'&&!same(next,row))fail", to: 'if(false)fail', suites: ['proof']},
  {id: 'B2', file: B, what: 'delta result digest not checked', find: "if(digest(next)!==delta.stateSha)throw", to: 'if(false)throw', suites: ['proof']},
  {id: 'B3', file: B, what: 'revision may skip', find: "if(state.revision!==parent.revision+1)fail", to: 'if(false)fail', suites: ['proof']},
  {id: 'B4', file: B, what: 'assignment ready-set digest not recomputed', find: 'a.readySetSha!==digest(ready)||', to: '', suites: ['proof']},
  // --- runtime gates
  {id: 'R1', file: R, what: 'gate rejection ignored: every candidate accepted', find: 'if(result?.ok!==true){', to: 'if(false){', suites: ['proof']},
  {id: 'R2', file: R, what: 'handoff re-verification result ignored', find: 'if(result?.ok!==true)fail(`Accepted dependency verification refused', to: 'if(false)fail(`Accepted dependency verification refused', suites: ['proof']},
  {id: 'R3', file: R, what: 'release decision verification ignored', find: "if(valid?.ok!==true)fail('Release decision refused');", to: "if(false)fail('Release decision refused');", suites: ['proof']},
  {id: 'R4', file: R, what: 'effect confirmation ignored', find: "if(!observed||observed.key!==key||digest(observed.payload)!==sha256)fail", to: 'if(false)fail', suites: ['proof']},
  // --- Pantheon ship gates and laws
  {id: 'P1', file: I, what: 'REVIEW gate always green', find: 'gate("REVIEW", artifacts.length > 0 && reviews.every(r => r.ok),', to: 'gate("REVIEW", true,', suites: ['pantheon', 'proof']},
  {id: 'P2', file: I, what: 'TESTS gate always green', find: 'gate("TESTS", artifacts.length > 0 && acceptance.every(r => r.ok),', to: 'gate("TESTS", true,', suites: ['pantheon', 'proof']},
  {id: 'P3', file: I, what: "maker's own lab counts as a cross-lab ack", find: 'const crossLab = approvals.filter(c => c.author.vendor !== maker);', to: 'const crossLab = approvals;', suites: ['pantheon', 'proof']},
  {id: 'P4', file: I, what: 'LEASE gate always green', find: 'gate("LEASE", held.length === 0,', to: 'gate("LEASE", true,', suites: ['pantheon', 'proof']},
  {id: 'P5', file: I, what: 'ACTOR gate always green', find: 'gate("ACTOR", cls === "controller" || cls === "human",', to: 'gate("ACTOR", true,', suites: ['pantheon', 'proof']},
  {id: 'P6', file: I, what: 'blocking findings do not block', find: 'ok: crossLab.length > 0 && blocks.length === 0,', to: 'ok: crossLab.length > 0,', suites: ['pantheon', 'proof']},
  {id: 'P7', file: 'pantheon/src/team/law.mjs', what: 'law 3 same-lab check removed', find: 'if (a.producer.vendor === a.checker.vendor) {', to: 'if (false) {', suites: ['pantheon']},
  {id: 'P8', file: 'pantheon/src/role/seating.mjs', what: 'assertReviewCutsAcross same-vendor check removed', find: 'if (reviewer.vendor === producer.vendor) {', to: 'if (false) {', suites: ['pantheon']},
  // --- model client terminal state
  {id: 'C1', file: T, what: 'max_tokens counts as a successful stop', find: "Object.freeze(['end_turn','tool_use','stop_sequence'])", to: "Object.freeze(['end_turn','tool_use','stop_sequence','max_tokens'])", suites: ['client', 'pantheon']},
  {id: 'C2', file: T, what: 'incomplete Responses status accepted', find: "return status==='completed'?", to: "return status!=='failed'?", suites: ['client', 'pantheon']},
];

function failing(cmd) {
  const r = spawnSync('sh', ['-c', cmd], {cwd: repo, encoding: 'utf8', timeout: 900000, maxBuffer: 64 * 1024 * 1024});
  const text = (r.stdout ?? '') + (r.stderr ?? '');
  const names = new Set();
  for (const line of text.split('\n')) {
    const m = /^\s*✖ (.+?) \(\d[\d.]*ms\)/.exec(line);
    if (m) names.add(m[1]);
  }
  const tests = Number(/^ℹ tests (\d+)/m.exec(text)?.[1] ?? NaN), fail = Number(/^ℹ fail (\d+)/m.exec(text)?.[1] ?? NaN);
  return {names, tests, fail, crashed: r.status === null};
}

const baseline = {};
const results = [];
const flush = () => fs.writeFileSync(outFile, JSON.stringify({baseline: Object.fromEntries(Object.entries(baseline).map(([k, v]) => [k, {tests: v.tests, fail: v.fail, names: [...v.names]}])), results}, null, 2));
for (const m of MUTANTS) {
  if (only && !only.has(m.id)) continue;
  const file = path.join(repo, m.file), original = fs.readFileSync(file, 'utf8');
  const count = original.split(m.find).length - 1;
  if (count !== 1) { results.push({id: m.id, what: m.what, file: m.file, status: 'NOT_APPLIED', occurrences: count}); flush(); continue; }
  for (const s of m.suites) if (!baseline[s]) baseline[s] = failing(SUITES[s]);
  fs.writeFileSync(file, original.replace(m.find, m.to));
  let killers = [], ran = {};
  try {
    for (const s of m.suites) {
      const run = failing(SUITES[s]);
      ran[s] = {tests: run.tests, fail: run.fail};
      killers.push(...[...run.names].filter(n => !baseline[s].names.has(n)).map(n => `${s}: ${n}`));
    }
  } finally { fs.writeFileSync(file, original); }
  results.push({id: m.id, what: m.what, file: m.file, suites: m.suites, status: killers.length ? 'KILLED' : 'SURVIVED', killers: killers.length, firstKillers: killers.slice(0, 3), ran});
  console.log(`${m.id} ${killers.length ? 'KILLED  ' : 'SURVIVED'} ${m.what}${killers.length ? ` [${killers.length} test(s)]` : ''}`);
  flush();
}
flush();
console.log('done');
