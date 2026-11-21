// FIXTURES for Slice D part 2's tests (docs/knowledge-graph/slice-d2.md): a SYNTHETIC world -- a git repository with a
// status ledger signed by a SYNTHETIC owner key generated for the fixture (ophanim/operate/test-fixtures.mjs fixture: the
// owner's real keys and ledger are never touched), its work ledger root, and a graph ledger created here with SYNTHETIC
// keys -- and the graph loop over it (graph-loop.mjs createGraphLoop). The graph's sources are D1's work graph over the
// world's work ledger and one SYNTHETIC registered source, `fixture.prerequisites`, whose versions are kept in a file so
// that another process re-reads the same facts: it states which interfaces exist (an `implemented-by` a module), so a test
// establishes a prerequisite by adding a version and observing it. No provider is called; the executors are scripted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generateSigner} from '../../../packages/ledger/index.mjs';
import {digest} from '../../../packages/ledger/canonical.mjs';
import {createGraphLedger, entityId, assertion} from '../../../packages/graph/index.mjs';
import {readTicket} from '../../../pantheon/src/board/operate.mjs';
import {originsOf, REPO_SOURCE} from '../../graph/extract/index.mjs';
import {WORK_GRAPH_SOURCE, planId} from '../../graph/work.mjs';
import {createGraphLoop, loopSources} from '../graph-loop.mjs';
import {fixture} from '../test-fixtures.mjs';

export const T0 = '2026-11-20T12:00:00.000Z';
const iface = key => entityId({domain: 'systems', type: 'interface', key});
/** The SYNTHETIC prerequisite two or more items require (the directive's shared model/runtime capability contract, by analogy). */
export const PREREQ = iface('graph-loop-dispatch');
/** A second SYNTHETIC prerequisite, for cycles. */
export const PREREQ2 = iface('graph-loop-ledger');
/** A SYNTHETIC interface that exists from the start (an unrelated, established capability). */
export const OTHER = iface('unrelated-index');
export {REPO_SOURCE};
export const PREREQ_SOURCE = 'fixture.prerequisites', PREREQ_EXTRACTOR = 'fixture.prerequisites.extractor', AGENT = 'fixture.agent';
export const EXTRA_ORIGINS = Object.freeze({
  [PREREQ_EXTRACTOR]: {kind: 'extractor', basis: 'declared', sources: [PREREQ_SOURCE], keys: ['graph-extractor']},
  [AGENT]: {kind: 'agent', basis: 'inferred', keys: ['graph-agent']},
});
const moduleOf = id => entityId({domain: 'systems', type: 'module', key: `lib/${decodeURIComponent(id.split('/').at(-1))}.mjs`});

/** The facts of one version of the synthetic source: each `established` interface `implemented-by` its module. */
function prereqFacts(spec) {
  const out = [];
  for (const [id, impl] of Object.entries(spec.established ?? {})) {
    const m = impl ?? moduleOf(id);
    out.push({entity: m, ref: `fixture#${m}`, attributes: {path: decodeURIComponent(m.split('/').slice(3).join('/')), synthetic: true}});
    out.push({entity: id, ref: `fixture#${id}`, attributes: {synthetic: true, note: 'SYNTHETIC: a fixture interface'}});
    out.push({type: 'implemented-by', from: id, to: m, ref: `fixture#${id}`, attributes: {basis: 'SYNTHETIC: the fixture states that this module implements it'}});
  }
  return out;
}
/** Record a new version of the synthetic source ({established: {id: module | null}}): the current version is it. */
export function setPrereqs(file, spec) {
  const db = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {current: null, versions: {}};
  const version = 'sha256:' + digest(spec);
  db.versions[version] = spec; db.current = version;
  fs.writeFileSync(file, JSON.stringify(db, null, 2) + '\n');
  return version;
}
/** The synthetic source's adapter: its facts at each recorded version, re-read from the file by every process. */
export function prereqSource(file) {
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  return {id: PREREQ_SOURCE, extractor: PREREQ_EXTRACTOR, ref: 'fixture', authority: 'a SYNTHETIC registered source of the test world (which interfaces exist)',
    current: () => ({version: read().current}),
    readAt: version => { const s = read().versions[version]; if (!s) throw new Error(`version ${version} is not recorded`); return prereqFacts(s); }};
}

/**
 * A SYNTHETIC world in a temporary directory: the git repository and ledgers of test-fixtures.mjs `fixture` (items
 * signed Ready by the fixture's SYNTHETIC owner key), the graph ledger with SYNTHETIC keys, the snapshot directory, and
 * the synthetic source (OTHER established). world.json and keys.json let a child process open the same world.
 */
export function d2World(items, {prefix = 'ophanim-graph-d2-', repo: given = null} = {}) {
  const repo = given ?? fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const f = fixture(repo, items.map(i => (typeof i === 'string' ? {item: i} : i)));
  const graphDir = path.join(repo, 'status', 'graph'), snapDir = path.join(repo, 'status', 'graph-snapshots'), prereqFile = path.join(repo, 'status', 'prerequisites.json');
  fs.mkdirSync(snapDir, {recursive: true});
  const keys = {operator: generateSigner('graph-operator'), extractor: generateSigner('graph-extractor'), rule: generateSigner('graph-rule'), agent: generateSigner('graph-agent'),
    snapshot: generateSigner('graph-snapshot')};
  const anchor = createGraphLedger({dir: graphDir, operator: keys.operator, order: keys.operator, authority: {orderer: 'graph-operator', operators: ['graph-operator'],
    keyring: {'graph-operator': keys.operator.publicJwk, 'graph-extractor': keys.extractor.publicJwk, 'graph-rule': keys.rule.publicJwk, 'graph-agent': keys.agent.publicJwk}}});
  setPrereqs(prereqFile, {established: {[OTHER]: null}});
  const world = {repo, statusRoot: f.statusRoot, workRoot: f.workRoot, stateDir: f.stateDir, S: f.S, graphDir, snapDir, prereqFile, anchor, keys};
  fs.writeFileSync(path.join(repo, 'status', 'world.json'), JSON.stringify({repo, statusRoot: f.statusRoot, workRoot: f.workRoot, stateDir: f.stateDir, graphDir, snapDir, prereqFile, anchor}) + '\n');
  fs.writeFileSync(path.join(repo, 'status', 'keys.json'), JSON.stringify(keys) + '\n');
  return {...world, done: () => { if (!given) fs.rmSync(repo, {recursive: true, force: true}); }};
}
/** Re-open a world a parent process made (a child process). */
export function openWorld(repo) {
  const w = JSON.parse(fs.readFileSync(path.join(repo, 'status', 'world.json'), 'utf8'));
  return {...w, keys: JSON.parse(fs.readFileSync(path.join(repo, 'status', 'keys.json'), 'utf8'))};
}

/**
 * The graph loop of a world: the work graph and the synthetic source (and, with `repoSource`, the world's git repository
 * at HEAD, observed at each tick's start), a signed snapshot, the synthetic writers.
 */
export function loopOf(world, {snapshot = true, observe = null, extra = [], repoSource = false, bounds = undefined} = {}) {
  const k = world.keys;
  observe ??= repoSource ? [REPO_SOURCE, PREREQ_SOURCE] : [PREREQ_SOURCE];
  return createGraphLoop({dir: world.graphDir, anchor: world.anchor, origins: originsOf(EXTRA_ORIGINS),
    sources: () => loopSources({repo: world.repo, workRoot: world.workRoot, only: repoSource ? [REPO_SOURCE, WORK_GRAPH_SOURCE] : [WORK_GRAPH_SOURCE], extra: [prereqSource(world.prereqFile), ...extra]}),
    snapshot: snapshot ? {dir: world.snapDir, keys: {[k.snapshot.key_id]: k.snapshot.publicJwk}, signer: k.snapshot} : null,
    writers: {extractor: {signer: k.extractor, order: k.operator}, rule: {signer: k.rule, order: k.operator}},
    observe, stateDir: world.stateDir, workRoot: world.workRoot, bounds, observed_at: () => T0});
}

/** A SYNTHETIC agent's HYPOTHETICAL claim that the plan `record` requires `target` (never established). */
export function hypotheticalRequirement(loop, world, record, target) {
  const g = loop.graph() ?? loop.open();
  const source = {id: AGENT, authority: 'a SYNTHETIC agent\'s inference', ref: 'inference', version: null};
  const node = assertion({entity: target, origin: AGENT, classification: 'hypothetical', observed_at: T0, source, missing_evidence: ['an inference: no source states it'], attributes: {why: 'SYNTHETIC: the agent guesses it exists to be needed'}});
  const a = assertion({type: 'requires-capability', from: planId(record), to: target, origin: AGENT, classification: 'hypothetical', observed_at: T0,
    source, missing_evidence: ['an inference: no source states it'], attributes: {why: 'SYNTHETIC: the agent guesses'}});
  return g.assert([node, a], {signer: world.keys.agent, order: world.keys.operator});
}

/**
 * SCRIPTED executors for the controller-core graph tests: the plan stage writes the ticket and a plan whose typed
 * `requires` (plans[item]: [{id, why, implements?}], read when the item is planned) are bound to the versions the graph
 * handle states (ctx.graph, as stages.mjs binds them) on the record (outputs.graph.requires) and in the plan document;
 * every other stage passes. `seen` logs each call. Options: `stated` -- the plan DOCUMENT keeps each requirement as the
 * planner stated it (no version) and the binding is on the record only, so a test shows which one a consumer reads;
 * `paths` -- {item: [path or glob]}, the plan's slice paths (the paths it claims; default `lib/<item>.mjs`).
 */
export function graphExecutors(world, plans = {}, {stated = false, paths = {}} = {}) {
  const seen = [];
  const plan = async ctx => {
    seen.push({stage: 'plan', item: ctx.item, graph: Boolean(ctx.graph)});
    const ticket = {schema: 'ophanim.ticket/v1', item: ctx.item, slice: 'all', proposes: {state: 'Resolved', basis: 'done'}, title: ctx.gate.requirement.title,
      goal: 'g', question: 'q', repo_root: '.', slot: 'a', path: `lib/${ctx.item}.mjs`, copy: [], acceptance_cmd: 'true'};
    fs.writeFileSync(path.join(world.repo, 'tickets', `${ctx.item}.json`), JSON.stringify(ticket));
    const t = readTicket({repo: world.repo, item: ctx.item});
    const bound = (plans[ctx.item] ?? []).map(r => ({...r, ...(ctx.graph ? {version: ctx.graph.stateOf(r.id).version} : {})}));
    const requires = stated ? (plans[ctx.item] ?? []).map(r => ({...r})) : bound;
    const slices = (paths[ctx.item] ?? [`lib/${ctx.item}.mjs`]).map((p, i) => ({id: `s${i + 1}`, title: ctx.item, slot: 'a', path: p}));
    const doc = {problem: {statement: `SYNTHETIC: the objective of ${ctx.item}`}, dependencies: [], capabilities: ['a synthetic capability, as free text'], requires,
      slices, acceptance: [{id: 'a1', criterion: 'synthetic', test: {cmd: 'true'}}]};
    // test-lint: allow scripted-terminal-status -- a scripted plan, the INPUT of these graph-loop tests: they assert the gate, the queue and the graph, not a stage's own outcome
    return {status: 'passed', identity: {ticket: {path: t.path, digest: t.digest}}, outputs: {plan: doc, ticket: {path: t.path, digest: t.digest}, deps: {}, evidence: [],
      ...(ctx.graph ? {graph: {cursor: ctx.graph.cursor.seq, head: ctx.graph.cursor.head, requires: bound}} : {})},
      team: [{role: 'planner', vendor: 'synthetic', model: 'synthetic-planner', lab: 'synthetic'}], contributions: [], findings: [], usage: {provider_calls: 1}, next: {stage: 'implement', why: 'approved'}};
  };
  const pass = stage => async ctx => {
    seen.push({stage, item: ctx.item, graph: Boolean(ctx.graph), unlocked: ctx.gate.graph?.unlocked?.map(u => u.prerequisite) ?? []});
    // test-lint: allow scripted-terminal-status -- a scripted stage, the INPUT of these graph-loop tests: they assert the gate, the queue and the graph, not a stage's own outcome
    return {status: 'passed', outputs: {[`${stage}_done`]: true, item: ctx.item}, team: [{role: stage}], contributions: [], findings: [], usage: {provider_calls: 1}, next: {stage: null, why: 'ok'}};
  };
  const ex = {plan, implement: pass('implement'), review: pass('review'), validate: pass('validate'), outcome: pass('outcome')};
  return {ex, seen};
}
export const LIMITS = Object.freeze({total_provider_calls: 1000, stage_provider_calls: 10});
export const stagesOf = (r, item) => r.dispatched.filter(d => !item || d.item === item).map(d => `${d.item}:${d.stage}:${d.status}`);
