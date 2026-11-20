// THE PROJECTOR AND THE EXTRACTORS (project.mjs, extract.mjs): the graph is read out of real sources and kept in step
// with them. The fixture is a real git repository with real ledgers; one test reads THIS repository as it is.
// Each test's comment names the defect it would catch.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {project, freshness, reconcile, recover, SOURCES} from './project.mjs';
import {mutationTargets} from './extract.mjs';
import {openGraph} from './store.mjs';
import {impact, trace, neighborhood} from './query.mjs';
import {graphFixture, REPO, AT, I, id, C, T} from './test-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIM = k => id('learning', 'limitation', k), FC = k => id('learning', 'failure-class', k);

test('THE GRAPH IS READ OUT OF THE SOURCES: components and their imports, tests, mutation targets, the register, the lessons registry, the capability configuration and the status ledger, each with the file or entry it was read from', async t => {
  const f = graphFixture(t);
  const {results, projection: p} = await project({...f, at: AT});
  assert.deepEqual(Object.fromEntries(Object.entries(results).map(([s, r]) => [s, r.state])), {repository: 'current', register: 'current', 'lessons-registry': 'current', config: 'current', 'status-ledger': 'current', 'work-ledger': 'unavailable'});
  // SYSTEMS: an import is a dependency; a test's import of a module is recorded as verification ON THAT BASIS, unverified.
  assert.deepEqual(p.out(C('src/turn.mjs'), 'depends-on').map(r => [r.a.to, r.a.class, r.a.source.ref]), [[C('src/gateway.mjs'), 'derived', 'src/turn.mjs']]);
  assert.deepEqual(p.in(C('src/gateway.mjs'), 'verifies').map(r => [r.a.from, r.a.attrs.basis, r.a.status]).sort(), [
    [T('src/gateway.test.mjs'), 'import', 'unverified'], [T('src/gateway.test.mjs'), 'mutation-target', 'unverified'], [id('systems', 'mutation', 'src/demo.mutate.mjs#D1'), 'mutation-target', 'unverified']].sort());
  const gw = p.entity(C('src/gateway.mjs'));
  assert.deepEqual([gw.attrs.exports, gw.assertions[0].a.source.authority, /^sha256:[0-9a-f]{64}$/.test(gw.assertions[0].a.source.version)], [['gateway', 'admit'], 'repository', true]);
  // The runner says two targets; one cannot be resolved and is COUNTED, not guessed.
  assert.deepEqual([p.entity(C('src/demo.mutate.mjs')).attrs.mutations_listed, p.entity(C('src/demo.mutate.mjs')).attrs.mutations_read], [2, 1]);
  // LEARNING: the register's rows and the files they name; the registry's classes, occurrences and detector.
  assert.deepEqual([p.entity(LIM('L-900')).attrs.register_status, p.entity(LIM('L-901')).attrs.register_status, p.entity(LIM('L-900')).class], ['open', 'repaired', 'authoritative']);
  assert.deepEqual(p.out(LIM('L-900'), 'applies-to').map(r => r.a.to).sort(), [C('src/gateway.mjs'), C('src/turn.mjs')], 'a path named in full, and one named by its only matching ending');
  assert.deepEqual(p.in(FC('bound-declared-not-enforced'), 'detects').map(r => [r.a.from, r.a.class]), [[T('src/gateway.test.mjs'), 'authoritative']]);
  assert.deepEqual(p.in(FC('bound-declared-not-enforced'), 'instance-of').map(r => p.entity(r.a.from).attrs.observed_by), ['owner']);
  assert.equal(p.entity(FC('claim-without-evidence')).attrs.detector, 'none', 'a class with no detector says so; no test is invented for it');
  // WORK: the owner's items and what each waits for, from the signed ledger.
  assert.deepEqual([p.entity(id('work', 'item', 'kg-b')).attrs.state, p.out(id('work', 'item', 'kg-b'), 'depends-on').map(r => r.a.to), p.entity(id('work', 'item', 'kg-b')).class], ['Ready', [id('work', 'item', 'kg-a')], 'authoritative']);
  // CAPABILITY: a model and its runtime are two things, and the pairing is what is assigned a role.
  const carbon = id('capability', 'model', 'google/gemini-4-carbon'), sdk = id('capability', 'executable', 'antigravity-sdk/gemini-4-carbon');
  assert.deepEqual(p.out(carbon, 'runs-in').map(r => r.a.to).sort(), [id('capability', 'runtime', 'agy-cli'), id('capability', 'runtime', 'antigravity-sdk'), id('capability', 'runtime', 'api')]);
  assert.deepEqual(p.out(sdk, 'qualified-for').map(r => [r.a.to.split(':').pop(), r.a.attrs.basis, r.a.attrs.measured]).sort(), [['explorer', 'owner-assigned', false], ['implementer', 'owner-assigned', false], ['researcher', 'owner-assigned', false], ['scout', 'owner-assigned', false]]);
  assert.deepEqual([p.entity(sdk).attrs.subagent_ceiling, p.entity(id('capability', 'executable', 'antigravity-sdk/gemini-4-hydrogen')).attrs.subagent_ceiling], [8, 0]);
  // Three configuration files each say which lab the model belongs to: three statements, one lab.
  assert.deepEqual([[...new Set(p.out(carbon, 'member-of').map(r => r.a.to))], p.out(carbon, 'member-of').map(r => r.a.source.ref.split('/').pop()).sort()], [[id('capability', 'lab', 'google')], ['antigravity-sdk.json', 'lanes.json', 'models.json']]);
  // Nothing was written anywhere but the graph, and the same reading again changes nothing.
  const again = await project({...f, at: AT});
  assert.deepEqual([Object.values(again.results).map(r => r.applied), again.projection.digest() === p.digest(), again.graph.batches().length], [[false, false, false, false, false, false], true, 5]);
});

test('A READING NEVER EXECUTES ITS SOURCE: a mutation runner without a main guard is read as text', async t => {
  // The defect: the runners were first read by importing them, and importing one started a mutation run.
  const f = graphFixture(t);
  await project({...f, at: AT});
  assert.equal(fs.existsSync(path.join(f.repo, 'src/IMPORTED')), false, 'the runner\'s top-level code did not run');
  assert.deepEqual(mutationTargets(fs.readFileSync(path.join(f.repo, 'src/demo.mutate.mjs'), 'utf8')), {listed: 2, targets: [{id: 'D1', what: 'the gateway admits without asking', file: 'src/gateway.mjs', tests: ['src/gateway.test.mjs']}]});
});

test('IMPACT PROPAGATION: a changed component is read again alone; what depends on it, verifies it or is governed with it is reached, and unrelated work is not touched', async t => {
  const f = graphFixture(t);
  const first = await project({...f, at: AT});
  const before = first.projection;
  f.write('src/gateway.mjs', 'import {util} from \'./util.mjs\';\nexport const gateway = util + 2;\n');
  // A TARGETED reading: only that file. Everything else the repository states is left exactly as it was.
  const r = await project({...f, at: AT, only: ['repository'], paths: ['src/gateway.mjs']});
  const p = r.projection, changed = p.changesSince(before.seq);
  // What that file states is stated again from its new version (the component and its one import); nothing else moves.
  assert.deepEqual([r.results.repository.applied, changed.began.map(x => x.a.id ?? x.a.rel).sort(), changed.ended.map(x => [x.a.id ?? x.a.rel, x.ended.by]).sort()],
    [true, ['depends-on', C('src/gateway.mjs')], [['depends-on', 'superseded'], [C('src/gateway.mjs'), 'superseded']]]);
  assert.ok(changed.began.concat(changed.ended).every(x => x.a.source.ref === 'src/gateway.mjs'));
  assert.deepEqual(p.entity(C('src/gateway.mjs')).attrs.exports, ['gateway'], 'the new version is what the graph now says');
  assert.equal(p.entity(C('src/unrelated.mjs')).assertions[0].from_seq, before.entity(C('src/unrelated.mjs')).assertions[0].from_seq, 'the unrelated file\'s assertion is the one from the first reading');
  // WHAT THE CHANGE REACHES, and through which relationship.
  const hit = impact(p, C('src/gateway.mjs')).affected.map(a => [a.id, a.via.rel]);
  assert.deepEqual(hit.sort(), [[T('src/gateway.test.mjs'), 'verifies'], [id('systems', 'mutation', 'src/demo.mutate.mjs#D1'), 'verifies'], [C('src/turn.mjs'), 'depends-on']].sort());
  assert.deepEqual([C('src/unrelated.mjs'), C('src/util.mjs'), id('work', 'item', 'kg-a')].map(x => hit.some(([h]) => h === x)), [false, false, false]);
  // The whole tree read again agrees with the targeted reading: nothing was missed and nothing invented.
  assert.deepEqual((await reconcile({...f, at: AT})).sources.filter(s => !s.same), []);
});

test('SOURCE INVALIDATION AND FRESHNESS: a source that moved is stale until it is read; one that is gone is unavailable and its last reading is kept, marked; nothing is called current that was not read', async t => {
  const f = graphFixture(t);
  await project({...f, at: AT});
  assert.deepEqual((await freshness(f)).map(x => [x.source, x.state]), [['repository', 'current'], ['register', 'current'], ['lessons-registry', 'current'], ['config', 'current'], ['status-ledger', 'current'], ['work-ledger', 'unavailable']]);
  f.write('docs/OPEN-LIMITATIONS.md', fs.readFileSync(path.join(f.repo, 'docs/OPEN-LIMITATIONS.md'), 'utf8').replace('open (future ticket)', 'repaired (`fff0000`)'));
  const stale = await freshness(f);
  assert.deepEqual(stale.filter(x => x.state !== 'current').map(x => [x.source, x.state]), [['repository', 'stale'], ['register', 'stale'], ['work-ledger', 'unavailable']]);
  assert.equal((await reconcile({...f, at: AT})).ok, false, 'a graph behind its sources does not reconcile, and says which source');
  // Read: the entry's new status supersedes the old one, and the old one is still in the history.
  const p = (await project({...f, at: AT})).projection, L = LIM('L-900');
  assert.deepEqual([p.entity(L).attrs.register_status, p.history().filter(r => r.a.id === L).map(r => [r.a.attrs.register_status, r.ended?.by ?? null])], ['repaired', [['open', 'superseded'], ['repaired', null]]]);
  // The registry is deleted: its reading is not applied as "nothing", it is reported unavailable and the graph says where it stood.
  fs.rmSync(path.join(f.repo, 'ophanim/lessons/corrections.json'));
  const gone = await project({...f, at: AT});
  assert.deepEqual([gone.results['lessons-registry'].state, gone.results['lessons-registry'].applied, gone.projection.has(FC('bound-declared-not-enforced'))], ['unavailable', false, true]);
  assert.equal((await freshness(f)).find(x => x.source === 'lessons-registry').state, 'unavailable');
});

test('RESTART AND REPLAY: a graph whose chain was torn by a crash is set aside whole and rebuilt from the sources; the rebuilt graph holds exactly what the sources state, and a killed writer changes nothing about that', async t => {
  const f = graphFixture(t);
  const clean = (await project({...f, graphRoot: path.join(f.repo, 'status', 'clean'), at: AT})).projection.digest();
  await project({...f, at: AT});
  // A crash in the middle of an append leaves a torn last line.
  const chain = path.join(f.graphRoot, 'chain.jsonl'), text = fs.readFileSync(chain, 'utf8');
  fs.writeFileSync(chain, text.slice(0, text.length - 40));
  assert.throws(() => openGraph({root: f.graphRoot, instance: I, create: false}));
  const r = await recover({...f, at: AT});
  assert.deepEqual([r.rebuilt, fs.existsSync(r.set_aside), r.graph.projection().digest() === clean, r.graph.verify().ok], [true, true, true, true]);
  assert.ok(r.graph.projection().records().every(x => SOURCES.includes(x.source)), 'every assertion of the rebuilt graph came from a source that was read; nothing was carried over from the broken one');
  // A healthy graph is opened as it is.
  assert.deepEqual([(await recover({...f, at: AT})).rebuilt, (await recover({...f, at: AT})).set_aside], [false, null]);
  // A REAL KILL: a process that keeps projecting is killed with SIGKILL; whatever it left, recovery and one reading end
  // at the same projection as a build that was never interrupted.
  const killed = path.join(f.repo, 'status', 'killed');
  const child = spawn(process.execPath, [path.join(HERE, 'test-project-child.mjs'), f.repo, killed], {stdio: ['ignore', 'pipe', 'ignore']});
  await new Promise(resolve => { child.stdout.once('data', resolve); child.once('close', resolve); });
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('close', resolve));
  const after = await recover({...f, graphRoot: killed, at: AT});
  const settled = (await project({...f, graphRoot: killed, at: AT, graph: after.graph})).projection;
  assert.equal(settled.digest(), clean);
  assert.equal(fs.existsSync(path.join(killed, 'chain.jsonl.lock')) && !after.graph.canWrite(), false, 'a lock the killed writer held does not keep the graph from being written');
});

test('THIS REPOSITORY, as it is: the graph is built from the real files, register, registry, configuration and status ledger, and answers questions that cross them', async t => {
  // Live evidence of this checkout, not a fixture: the counts are floors, the relationships are ones this code has.
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'ophanim-graph-real-'));
  t.after(() => fs.rmSync(scratch, {recursive: true, force: true}));
  const {results, projection: p} = await project({repo: REPO, graphRoot: path.join(scratch, 'g'), at: AT});
  assert.deepEqual(['repository', 'register', 'lessons-registry', 'config', 'status-ledger'].map(s => results[s].state), Array(5).fill('current'), JSON.stringify(results));
  const count = pred => p.records().filter(pred).length;
  assert.ok(count(r => r.a.kind === 'entity' && r.a.id.startsWith(`${I}:systems:component:`)) > 250 && count(r => r.a.rel === 'depends-on') > 900 && count(r => r.a.id?.startsWith(`${I}:learning:limitation:`)) > 120
    && count(r => r.a.id?.startsWith(`${I}:work:item:`)) > 50 && count(r => r.a.id?.startsWith(`${I}:capability:executable:`)) > 30);
  const gw = C('pantheon/src/antigravity/gateway.mjs');
  // What a change of the model gateway reaches: the transport that starts it, the seat session, and the tests that decide it.
  const reached = new Set(impact(p, gw, {depth: 2}).affected.map(a => a.id));
  assert.deepEqual([C('pantheon/src/antigravity/turn.mjs'), C('pantheon/src/antigravity/seat-session.mjs'), T('pantheon/tests/antigravity-gateway.test.mjs')].map(x => reached.has(x)), [true, true, true]);
  assert.equal(reached.has(C('packages/ledger/canonical.mjs')), false, 'the ledger\'s canonical form does not depend on the gateway');
  // Why it is as it is: the register entries that name it, and the mutations that decide its lines.
  const steps = trace(p, gw, {depth: 1}).steps;
  assert.ok(steps.some(s => s.id === LIM('L-724') && s.role === 'lesson'), 'the owner\'s decision that the gateway is the one mechanism names this file');
  assert.ok(steps.filter(s => s.type === 'mutation').length >= 30, 'the mutation targets of the gateway are on its record');
  // Which executables the owner assigned to the scout role, read from configuration and not from a table in source.
  assert.deepEqual(p.in(id('capability', 'role', 'scout'), 'qualified-for').map(r => r.a.from), [id('capability', 'executable', 'antigravity-sdk/gemini-4-carbon')]);
  // The neighbourhood of one failure class reaches its detector test and the code that test verifies.
  const near = neighborhood(p, FC('bound-declared-not-enforced'), {depth: 2, limit: 400});
  assert.ok(near.nodes.some(n => n.type === 'test') && near.nodes.some(n => n.type === 'defect'));
});
