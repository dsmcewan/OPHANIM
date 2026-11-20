// THE LEARNING GRAPH (knowledge graphs, Slice D part 1; the directive's Graph D; KD1-3, KD1-4; docs/knowledge-graph/slice-d1.md).
//
// Purpose   Give OPHANIM institutional memory of observed failures, their mechanisms and the corrections that worked, by
//           EXTENDING (never duplicating) Slice A's lessons adapter (ophanim/graph/lessons.mjs: classes, detectors, fixes)
//           and Slice B's records and cycle sources (register rows with their status; review findings):
//             ophanim.learning        the lessons registry, read only, at its blob id: each INSTANCE of a class as an observed
//                                     defect (`documented-in` its class), each fix as a repair (`introduced-because-of` the
//                                     class, `derived-from` the commit, `verified-by` the class's detector), and each class
//                                     without an executable detector as a DETECTION GAP (with its why and next step)
//             ophanim.cycle-learning  the review-cycle LEDGER through its own reader (a finding is a ledger entry): each
//                                     finding's reproduction and its repair (`fixed`: the commit and the test shown failing
//                                     before and passing after)
//             mutation outcomes       OBSERVED by a registered tool from a runner's own summary (its --log summary.json), with
//                                     the run's identity: killed (its deciding tests `detect` it) or survived (a detection gap)
//           and admitting `shares-failure-mechanism-with` ONLY from a graph.assert of the declared-basis learning rule whose
//           inputs STATE the basis; textual similarity yields at most a HYPOTHETICAL candidate, labelled, never established.
//           learningReuse(): given a newly observed defect (a test failure or a finding on a component), the related
//           ESTABLISHED failure classes and mechanisms, their detectors, previous repairs and the applicable lessons, each
//           with its path; similarity apart, as hypothesis.
// Inputs    The repository root (the registry's path in it); a cycle ledger root and its pinned anchor; a runner's summary.
// Must never  Read a withheld path (`findings-*`: recorded review findings are withheld; only what the cycle LEDGER
//           records is used); write the registry or any ledger; admit a shared mechanism from similar text or symptoms;
//           show a hypothetical link as established.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {entityId, parseId, idRefusal, assertion} from '../../packages/graph/index.mjs';
import {digest} from '../../packages/ledger/canonical.mjs';
import {blobId, REGISTRY_PATH, REGISTRY_SCHEMA, ROOT, SOURCE_ID as LESSONS_SOURCE} from './lessons.mjs';
import {readCycleLedger} from './extract/ledgers.mjs';
import {listCycles} from '../public/provenance.mjs';
import {deriveCycle} from '../../pantheon/src/ledger/cycle-kinds.mjs';
import {fileId, changeId} from './extract/repo.mjs';
import {mutationId} from './extract/verification.mjs';
import {recordId, ENTRY_ID} from './extract/records.mjs';

export const LEARNING_SOURCE = 'ophanim.learning', LEARNING_EXTRACTOR = 'ophanim.learning.extractor';
export const LEARNING_ORIGIN = Object.freeze({kind: 'extractor', basis: 'declared', sources: [LEARNING_SOURCE]});
export const CYCLE_LEARNING_SOURCE = 'ophanim.cycle-learning', CYCLE_LEARNING_EXTRACTOR = 'ophanim.cycle-learning.extractor';
export const CYCLE_LEARNING_ORIGIN = Object.freeze({kind: 'extractor', basis: 'declared', sources: [CYCLE_LEARNING_SOURCE]});
/** The rule that admits a shared failure mechanism: DECLARED, from inputs that state it. */
export const LEARNING_RULE = 'ophanim.learning.rule';
export const LEARNING_RULE_ORIGIN = Object.freeze({kind: 'rule', basis: 'declared'});
/** Similar text: TEXTUAL, so the registry admits nothing from it but a hypothetical. */
export const SIMILARITY_RULE = 'ophanim.learning.similarity';
export const SIMILARITY_ORIGIN = Object.freeze({kind: 'rule', basis: 'textual'});
/** A mutation runner's recorded result: MEASURED, observed with its run. */
export const MUTATION_TOOL = 'ophanim.mutation-outcomes.tool';
export const MUTATION_TOOL_ORIGIN = Object.freeze({kind: 'tool', basis: 'measured'});
/** Recorded review findings (`findings-*`) are withheld: no path matching this is ever read. */
export const WITHHELD = /(^|[\\/])findings-[^\\/]*([\\/]|$)/;
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cut = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const hex = h => h.slice('sha256:'.length);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const L = (type, key) => entityId({domain: 'learning', type, key});
export const classId = id => L('failure-class', id);
export const findingId = hash => L('finding', hex(hash));
export const lessonsTestId = (file, name) => entityId({domain: 'systems', type: 'test', key: `${file}#${name}`});
const kindOf = id => { try { const p = parseId(id); return `${p.domain}/${p.type}`; } catch { return null; } };
const keyOf = id => decodeURIComponent(parseId(id).key);
const sourceOf = a => ({source: a.source.id, version: a.source.version, ref: a.source.ref, assertion: a.id, classification: a.classification, origin: a.origin});
/** Refuse a withheld path BEFORE anything is read from it. */
export function withheldRefusal(p) {
  if (typeof p === 'string' && WITHHELD.test(p)) throw Object.assign(new Error('a withheld path (recorded review findings, findings-*) is never read'), {code: 'WITHHELD'});
  return p;
}

// ---- the lessons registry, extended (ophanim.learning) --------------------------------------------------------------
const shaOf = text => /^[0-9a-f]{7,40}\b/.exec(String(text ?? ''))?.[0] ?? null;
/** The facts the learning source adds to Slice A's: defects, repairs, detection gaps. Throws on another schema. */
export function learningFacts(text, {file = REGISTRY_PATH} = {}) {
  const reg = JSON.parse(text);
  if (reg?.schema !== REGISTRY_SCHEMA || !Array.isArray(reg.classes)) throw new Error(`${file}: not ${REGISTRY_SCHEMA}`);
  const drafts = [];
  for (const c of reg.classes) {
    if (typeof c?.id !== 'string' || !c.id) throw new Error(`${file}: a class without an id`);
    const fc = classId(c.id), at = `${file}#${c.id}`, seen = new Map();
    // An instance is keyed by WHAT it records (observer, date, ref), never by its position in the file.
    for (const inst of Array.isArray(c.instances) ? c.instances : []) {
      if (!plain(inst)) continue;
      let k = digest({observed_by: inst.observed_by ?? null, date: inst.date ?? null, ref: inst.ref ?? null}).slice(0, 16);
      const n = (seen.get(k) ?? 0) + 1;
      seen.set(k, n);
      if (n > 1) k = `${k}-${n}`;
      const D = L('defect', `${c.id}/${k}`);
      drafts.push({entity: D, ref: `${at}/instances`, attributes: {class_id: c.id, observed_by: inst.observed_by ?? null, date: inst.date ?? null, ref: cut(inst.ref, 300),
        note: cut(inst.note, 600), detected_by: cut(inst.detected_by ?? '', 300) || null, corrected_by: inst.corrected_by ?? null}});
      drafts.push({type: 'documented-in', from: D, to: fc, ref: `${at}/instances`, attributes: {basis: 'the registry records this instance under the class'}});
    }
    if (c.fixed_in) {
      const R = L('repair', `lessons/${c.id}`), commit = shaOf(c.fixed_in);
      drafts.push({entity: R, ref: `${at}/fixed_in`, attributes: {class_id: c.id, fixed_in: cut(c.fixed_in, 300), commit},
        ...(commit ? {} : {missing_evidence: [`the registry names the fix as "${cut(c.fixed_in, 120)}", which is not a commit id`]})});
      drafts.push({type: 'introduced-because-of', from: R, to: fc, ref: `${at}/fixed_in`, attributes: {basis: 'the registry states this fix of the class'}});
      drafts.push({type: 'derived-from', from: R, to: changeId(c.fixed_in), ref: `${at}/fixed_in`, attributes: {basis: 'the fix the registry names'}});
      if (c.detector?.kind === 'test') drafts.push({type: 'verified-by', from: R, to: lessonsTestId(c.detector.file, c.detector.name), ref: `${at}/detector`,
        attributes: {basis: 'the registry names this detector of the class whose fix this is'}});
    }
    if (c.detector?.kind !== 'test') {
      const G = L('detection-gap', c.id);
      drafts.push({entity: G, ref: `${at}/detector`, attributes: {class_id: c.id, why: cut(c.detector?.why ?? 'no detector recorded', 600), next: cut(c.detector?.next ?? '', 600) || null},
        missing_evidence: ['no executable detector: a recurrence is found only by a person, as the registry states']});
      drafts.push({type: 'documented-in', from: G, to: fc, ref: `${at}/detector`, attributes: {basis: 'the registry records no executable detector for the class'}});
    }
  }
  return drafts;
}

/**
 * The adapter: the registry at its git blob id, like Slice A's (the working file when it is that version, else git's
 * object store). Its facts reference Slice A's (classes, changes, detectors): it is observed AFTER ophanim.lessons.
 */
export function learningSource({repo = ROOT, file = REGISTRY_PATH, extractor = LEARNING_EXTRACTOR} = {}) {
  const abs = path.join(withheldRefusal(repo), withheldRefusal(file));
  const bytesAt = version => {
    if (fs.existsSync(abs)) { const b = fs.readFileSync(abs); if (blobId(b) === version) return b; }
    let b;
    try { b = execFileSync('git', ['-C', repo, 'cat-file', 'blob', version], {stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26}); }
    catch { throw new Error(`${file} at ${version} is neither the working file nor in git's object store`); }
    if (blobId(b) !== version) throw new Error(`${file}: git returned bytes that are not blob ${version}`);
    return b;
  };
  return {
    id: LEARNING_SOURCE, extractor, ref: file, requires: [LESSONS_SOURCE],
    authority: `${file} (${REGISTRY_SCHEMA}; maintained by the coordinator, read only): its instances, fixes and detection gaps, beside Slice A's classes`,
    current: () => ({version: blobId(fs.readFileSync(abs))}),
    readAt: version => learningFacts(bytesAt(version).toString('utf8'), {file}),
  };
}

// ---- the review-cycle ledger's findings (ophanim.cycle-learning) ----------------------------------------------------
function cycleView(C, version) {
  if (!/^sha256:[0-9a-f]{64}$/.test(version ?? '')) throw new Error(`${version} is not a ledger entry hash`);
  const rows = [];
  for (const e of C.ledger.read()) {
    const h = C.ledger.hashOf(e);
    rows.push({hash: h, entry: e, payload: C.ledger.payloadOf(e)});
    if (h === version) {
      const by = new Map(rows.map(r => [r.hash, r]));
      return {entry: x => by.get(x)?.entry ?? null, payload: x => by.get(x)?.payload ?? null, entries: () => rows.map(r => r.hash)};
    }
  }
  throw new Error(`entry ${version} is not on this cycle ledger`);
}
/** The learning facts of the cycle ledger's chain that ends at `version`: reproductions and repairs of its findings. */
export function cycleLearningFacts(C, version) {
  const view = cycleView(C, version), drafts = [], changes = new Set(), tests = new Set();
  for (const c of listCycles(view)) {
    const st = deriveCycle(view, c.hash);
    for (const f of st.findings) {
      const F = findingId(f.hash), ref = `cycle#${f.hash}`;
      drafts.push({entity: F, ref, attributes: {finding: f.hash, cycle: c.hash, severity: f.payload.severity ?? null, file: f.payload.file ?? null}});
      const rp = f.payload.reproduction;
      if (plain(rp)) {
        drafts.push({entity: L('reproduction', hex(f.hash)), ref, attributes: {finding: f.hash, kind: rp.kind, run: cut(rp.run, 600)}});
        drafts.push({type: 'derived-from', from: L('reproduction', hex(f.hash)), to: F, ref, attributes: {basis: 'the reviewer\'s reproduction of this finding'}});
      }
      const res = st.resolutions.get(f.hash)?.payload ?? null;
      if (res?.status === 'fixed' && plain(res.fix)) {
        const R = L('repair', `finding/${hex(f.hash)}`), rref = `cycle#${st.resolutions.get(f.hash).hash ?? f.hash}`;
        drafts.push({entity: R, ref: rref, attributes: {finding: f.hash, commit: res.fix.commit, test: cut(res.fix.test, 300), before: res.fix.before ?? null, after: res.fix.after ?? null}});
        drafts.push({type: 'introduced-because-of', from: R, to: F, ref: rref, attributes: {basis: 'the resolution fixes this finding'}});
        if (!changes.has(res.fix.commit)) { changes.add(res.fix.commit); drafts.push({entity: changeId(res.fix.commit), ref: rref, attributes: {commit: res.fix.commit}}); }
        drafts.push({type: 'derived-from', from: R, to: changeId(res.fix.commit), ref: rref, attributes: {basis: 'the fix commit the resolution names'}});
        if (/\.test\.(mjs|js|cjs)$/.test(res.fix.test ?? '')) {
          if (!tests.has(res.fix.test)) { tests.add(res.fix.test); drafts.push({entity: fileId(res.fix.test), ref: rref, attributes: {path: res.fix.test}}); }
          drafts.push({type: 'verified-by', from: R, to: fileId(res.fix.test), ref: rref, attributes: {basis: 'the test the resolution shows failing before the fix and passing after', before: res.fix.before ?? null, after: res.fix.after ?? null}});
        }
      }
    }
  }
  return drafts;
}
export function cycleLearningSource({root, anchor, extractor = CYCLE_LEARNING_EXTRACTOR}) {
  const at = () => readCycleLedger({root: withheldRefusal(root), anchor});
  return {
    id: CYCLE_LEARNING_SOURCE, extractor, ref: 'cycle ledger',
    authority: 'a review-cycle ledger (pantheon/src/ledger/cycle-kinds.mjs; its findings and resolutions are ledger entries; read only against its pinned anchor)',
    current: () => ({version: at().head}),
    readAt: version => cycleLearningFacts(at(), version),
  };
}

// ---- mutation outcomes, OBSERVED from a runner's own summary ---------------------------------------------------------
/**
 * The observed records of one mutation run: `summary` is the runner's --log summary.json ({suites, mutations: [{id,
 * killed, ran, pass, fail, cancelled, failed, tests, files}]}), `runner` its repository path, `commit` the tree it ran on.
 * A killed mutation is `detect`ed by each deciding test file; a survivor is a DETECTION GAP. The run is identified by
 * the digest of the summary. The mutations themselves are Slice B's (systems/mutation, read from the runner's text).
 */
export function mutationOutcomeRecords(summary, {runner, commit, observed_at = new Date().toISOString()}) {
  if (!plain(summary) || !Array.isArray(summary.mutations)) throw new Error('a mutation summary is {suites, mutations: [...]}');
  const run = 'sha256:' + digest(summary), short = hex(run).slice(0, 16), records = [];
  const src = id => ({id: 'ophanim.mutation-runs', authority: `the mutation runner ${runner}'s own summary of a run (its --log summary.json), on ${commit}`, ref: `${runner}#${id}`, version: run});
  const obs = d => assertion({...d, origin: MUTATION_TOOL, classification: 'observed', observed_at, run: {id: `mutation-run:${hex(run)}`, runner, commit}});
  for (const m of summary.mutations) {
    if (!plain(m) || typeof m.id !== 'string') continue;
    const O = L('mutation-outcome', `${runner}#${m.id}/${short}`), testFiles = [...new Set((m.tests ?? []).map(t => (Array.isArray(t) ? t[0] : t)).filter(t => typeof t === 'string'))].sort(byString);
    records.push(obs({entity: O, source: src(m.id), attributes: {runner, mutation: m.id, commit, killed: m.killed === true, ran: m.ran ?? null, pass: m.pass ?? null, fail: m.fail ?? null,
      cancelled: m.cancelled ?? null, failed: (m.failed ?? []).slice(0, 12).map(x => cut(x, 200)), what: cut(m.what, 300), tests: testFiles}}));
    records.push(obs({type: 'derived-from', from: O, to: mutationId(runner, m.id), source: src(m.id), attributes: {basis: 'the outcome of this mutation in this run'}}));
    if (m.killed === true) for (const t of testFiles) records.push(obs({type: 'detects', from: fileId(t), to: O, source: src(m.id), attributes: {basis: 'a deciding test failed with the mutation applied'}}));
    else {
      const G = L('detection-gap', `mutation/${runner}#${m.id}/${short}`);
      records.push(obs({entity: G, source: src(m.id), attributes: {runner, mutation: m.id, commit, why: 'the mutation SURVIVED: its deciding tests stayed green with it applied'}}));
      records.push(obs({type: 'derived-from', from: G, to: O, source: src(m.id), attributes: {basis: 'the surviving outcome'}}));
    }
  }
  return records;
}
export const recordMutationOutcomes = (graph, opts, by) => graph.assert(mutationOutcomeRecords(opts.summary, opts), by);

// ---- shared failure mechanisms: declared only ------------------------------------------------------------------------
const NOT_A_BASIS = ['textual', 'inferred'];
/**
 * ADMIT `shares-failure-mechanism-with` between `a` and `b` (defects, classes or findings) as a derived assertion of the
 * declared-basis learning rule, ONLY from `inputs` that state the basis: each a current, established assertion whose
 * origin knows by a declared, structural or measured basis (never textual or inferred: similar text or symptoms are not a
 * mechanism). Refused otherwise (code LEARNING_BASIS).
 */
export function sharedMechanismRecord(view, origins, {a, b, basis, inputs, mechanism = null, observed_at = new Date().toISOString()}) {
  const refuse = why => { throw Object.assign(new Error(`LEARNING_BASIS ${why}`), {code: 'LEARNING_BASIS'}); };
  if (typeof basis !== 'string' || !basis.trim()) refuse('a shared mechanism states its basis');
  if (!Array.isArray(inputs) || !inputs.length) refuse('a shared mechanism is admitted only from the assertions that state it');
  for (const id of inputs) {
    const x = view.assertion(id);
    if (!x || !x.established) refuse(`${id} is not an established assertion`);
    const o = origins[x.origin];
    if (!o || NOT_A_BASIS.includes(o.basis)) refuse(`${x.origin} knows by a ${o?.basis ?? 'unknown'} basis: similar text or a model's inference is never a mechanism`);
  }
  for (const n of [a, b]) if (!view.nodeIn(n, 'established')) refuse(`${n} is not an established node`);
  return assertion({type: 'shares-failure-mechanism-with', from: a, to: b, origin: LEARNING_RULE, classification: 'derived', observed_at, inputs: [...new Set(inputs)].sort(byString),
    source: {id: 'ophanim.learning-rule', authority: 'the shared-mechanism rule (ophanim/graph/learning.mjs): admitted only from assertions that state the basis', ref: `${keyOf(a)} ~ ${keyOf(b)}`,
      version: 'sha256:' + digest([...new Set(inputs)].sort(byString))},
    attributes: {basis: cut(basis, 600), mechanism: mechanism ? cut(mechanism, 600) : null}});
}
export const assertSharedMechanism = (graph, spec, by) => graph.assert([sharedMechanismRecord(graph.view(), graph.projection.origins, spec)], by);

/** The registry's own declarations of one mechanism: two defects the registry records under the same class. */
export function registryMechanisms(view) {
  const out = [];
  for (const fc of view.subjects().filter(s => kindOf(s) === 'learning/failure-class' && view.nodeIn(s, 'established'))) {
    const members = view.edgesOf(fc, {mode: 'established', types: ['documented-in']})
      .filter(e => e.to === fc && kindOf(e.from) === 'learning/defect' && e.assertions.some(id => view.assertion(id).source.id === LEARNING_SOURCE))
      .sort((x, y) => byString(x.from, y.from));
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
      out.push({a: members[i].from, b: members[j].from, inputs: [...members[i].assertions, ...members[j].assertions].sort(byString), mechanism: keyOf(fc),
        basis: `the lessons registry records both as instances of the class ${keyOf(fc)}`});
    }
  }
  return out;
}
export function recordRegistryMechanisms(graph, by, {observed_at} = {}) {
  const view = graph.view(), recs = registryMechanisms(view).map(m => sharedMechanismRecord(view, graph.projection.origins, {...m, observed_at}));
  return recs.length ? graph.assert(recs, by) : {appended: false, ids: [], duplicates: []};
}

// ---- similarity: at most a hypothesis -------------------------------------------------------------------------------
const STOP = new Set(['that', 'this', 'with', 'from', 'when', 'which', 'what', 'have', 'been', 'into', 'than', 'then', 'they', 'their', 'there', 'were', 'only',
  'does', 'never', 'each', 'other', 'more', 'some', 'such', 'also', 'without', 'record', 'recorded', 'test', 'tests']);
const words = t => new Set((String(t ?? '').toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []).filter(w => !STOP.has(w)));
// The share of the claim's words the class text also uses (containment: a short claim against a long class text).
const containment = (a, b) => { let n = 0; for (const w of a) if (b.has(w)) n++; return a.size ? n / a.size : 0; };
/**
 * Failure classes whose text resembles `text`: HYPOTHETICAL candidates only, each labelled (classification hypothetical,
 * established false, the score and the shared words). Similar symptoms are not a shared cause.
 */
export function similarityCandidates(view, text, {limit = 5, min = 0.25} = {}) {
  const w = words(text), out = [];
  if (!w.size) return out;
  for (const fc of view.subjects().filter(s => kindOf(s) === 'learning/failure-class' && view.nodeIn(s, 'established'))) {
    const a = view.node(fc).attributes, cw = words(`${a.class ?? ''} ${a.source ?? ''}`), score = containment(w, cw);
    if (score >= min) out.push({id: fc, score: Math.round(score * 1000) / 1000, shared: [...w].filter(x => cw.has(x)).sort(byString).slice(0, 12),
      classification: 'hypothetical', established: false, basis: 'textual similarity only: no source states a shared mechanism; a candidate to investigate, never a cause'});
  }
  return out.sort((x, y) => y.score - x.score || byString(x.id, y.id)).slice(0, limit);
}
/** Record a similarity candidate between two learning nodes as a HYPOTHETICAL link of the textual similarity rule. */
export function similarityRecord(view, {a, b, score, shared = [], observed_at = new Date().toISOString()}) {
  const compared = [a, b].flatMap(n => view.query(n, 'established').map(x => x.id)).sort(byString);
  return assertion({type: 'shares-failure-mechanism-with', from: a, to: b, origin: SIMILARITY_RULE, classification: 'hypothetical', inputs: [], observed_at,
    source: {id: 'ophanim.learning-similarity', authority: 'textual similarity of the two nodes\' text (ophanim/graph/learning.mjs)', ref: `${keyOf(a)} ~ ${keyOf(b)}`, version: null},
    missing_evidence: ['similar text only: no source states that these fail by one mechanism'],
    attributes: {score: score ?? null, shared: shared.slice(0, 12), compared: compared.slice(0, 16)}});
}
export const proposeSimilarMechanism = (graph, spec, by) => graph.assert([similarityRecord(graph.view(), spec)], by);

// ---- learning reuse (KD1-4, demonstration 5) ------------------------------------------------------------------------
const edgeSources = (view, e) => e.assertions.map(id => view.assertion(id)).filter(Boolean).map(sourceOf);
const step = (view, e, extra = {}) => ({type: e.type, from: e.from, to: e.to, sources: edgeSources(view, e), ...extra});
/** The established mechanism links of a learning node (only established: a hypothesis is listed apart). */
const mechanismLinks = (view, id) => view.edgesOf(id, {mode: 'established', types: ['shares-failure-mechanism-with']});
/** The hypothetical (current, never established) mechanism links of a learning node. */
const hypotheticalLinks = (view, id) => view.edgesOf(id, {mode: 'possible', types: ['shares-failure-mechanism-with']})
  .filter(e => e.assertions.every(x => !view.established(x)));

/**
 * LEARNING REUSE: given a newly observed defect -- {component: a path or id, test: '<file>' or '<file>#<name>', claim:
 * text} (a test failure, or a finding on a component) -- the related ESTABLISHED learning, each with the path that
 * relates it: the failure classes whose detector is a test of the component (or the failing test itself), with their
 * recorded defects, previous repairs, detection gaps and established shared mechanisms; review findings on the same
 * file and their repairs; mutation outcomes on it. `next` names the tests to run and the investigations to follow
 * instead of rediscovering the problem. Register entries that NAME the component are listed apart as textual; text
 * similarity is listed apart as HYPOTHETICAL. Nothing is inferred into the established part.
 */
export function learningReuse(view, defect = {}) {
  const gaps = [], used = new Set(), note = xs => { for (const x of xs) for (const s of x.sources ?? []) used.add(s.source); return xs; };
  const comp = defect.component ? (idRefusal(defect.component) ? fileId(defect.component) : defect.component) : null;
  const failing = defect.test ? fileId(String(defect.test).split('#')[0]) : null;
  const failingName = defect.test && String(defect.test).includes('#') ? String(defect.test).slice(String(defect.test).indexOf('#') + 1) : null;
  if (comp && !view.nodeIn(comp, 'established')) gaps.push({category: 'component', why: `${defect.component} is not established in the graph at cursor ${view.seq}`});
  // The tests related to the defect: the failing test, and the tests the sources state check the component.
  const tests = new Map();
  if (failing) tests.set(failing, {id: failing, why: 'the failing test', path: []});
  if (comp) for (const e of view.edgesOf(comp, {mode: 'established', types: ['depends-on', 'verifies']})) {
    if (e.to !== comp || kindOf(e.from) !== 'systems/test' || tests.has(e.from)) continue;
    tests.set(e.from, {id: e.from, why: e.type === 'verifies' ? 'a mutation runner declares this test decides it' : 'the test imports it', path: [step(view, e)]});
  }
  // The failure classes those tests detect: the registry names a detector as <file>#<name substring> (a JOIN on the file).
  const classes = [];
  for (const fc of view.subjects().filter(s => kindOf(s) === 'learning/failure-class' && view.nodeIn(s, 'established')).sort(byString)) {
    const det = view.edgesOf(fc, {mode: 'established', types: ['detects']}).filter(e => e.to === fc && kindOf(e.from) === 'systems/test')
      .map(e => ({e, file: keyOf(e.from).split('#')[0], name: keyOf(e.from).split('#').slice(1).join('#')}))
      .filter(d => tests.has(fileId(d.file)));
    if (!det.length) continue;
    const a = view.node(fc).attributes, d = det[0], via = tests.get(fileId(d.file));
    const defects = view.edgesOf(fc, {mode: 'established', types: ['documented-in']}).filter(e => e.to === fc && kindOf(e.from) === 'learning/defect')
      .map(e => ({id: e.from, ...pick(view.node(e.from).attributes, ['observed_by', 'date', 'ref', 'note']), sources: edgeSources(view, e)}));
    const gap = view.edgesOf(fc, {mode: 'established', types: ['documented-in']}).filter(e => e.to === fc && kindOf(e.from) === 'learning/detection-gap')
      .map(e => ({id: e.from, ...pick(view.node(e.from).attributes, ['why', 'next']), sources: edgeSources(view, e)}));
    const repairs = view.edgesOf(fc, {mode: 'established', types: ['introduced-because-of']}).filter(e => e.to === fc && kindOf(e.from) === 'learning/repair')
      .map(e => ({id: e.from, ...pick(view.node(e.from).attributes, ['fixed_in', 'commit']), sources: edgeSources(view, e),
        verified_by: view.edgesOf(e.from, {mode: 'established', types: ['verified-by']}).filter(v => v.from === e.from).map(v => v.to)}));
    const mechanisms = [fc, ...defects.map(x => x.id)].flatMap(n => mechanismLinks(view, n).map(e => step(view, e, {with: e.from === n ? e.to : e.from}))).sort((x, y) => byString(x.with, y.with));
    classes.push({id: fc, class: a.class ?? null, detector: {test: d.e.from, file: d.file, name: d.name, exact: failingName ? failingName.includes(d.name) : null},
      path: [...via.path, step(view, d.e, {join: `the registry names its detector as ${d.file}#${d.name}; ${d.file} is ${via.why}`})],
      defects: note(defects), repairs: note(repairs), detection_gap: note(gap), mechanisms: note(mechanisms), sources: view.node(fc).assertions.map(sourceOf)});
  }
  for (const c of classes) note([{sources: c.sources}, ...c.path]);
  // Review findings on the same file, with their reproductions and repairs (a JOIN on the file the finding names).
  const path_ = comp ? keyOf(comp) : null, findings = [];
  if (path_) for (const f of view.subjects().filter(s => kindOf(s) === 'learning/finding' && view.nodeIn(s, 'established'))) {
    if (view.node(f).attributes.file !== path_) continue;
    const repairs = view.edgesOf(f, {mode: 'established', types: ['introduced-because-of']}).filter(e => e.to === f && kindOf(e.from) === 'learning/repair')
      .map(e => ({id: e.from, ...pick(view.node(e.from).attributes, ['commit', 'test']), sources: edgeSources(view, e)}));
    const reproductions = view.edgesOf(f, {mode: 'established', types: ['derived-from']}).filter(e => e.to === f && kindOf(e.from) === 'learning/reproduction')
      .map(e => ({id: e.from, ...pick(view.node(e.from).attributes, ['kind', 'run']), sources: edgeSources(view, e)}));
    findings.push({id: f, severity: view.node(f).attributes.severity ?? null, join: 'the finding names this file', repairs: note(repairs), reproductions: note(reproductions),
      mechanisms: note(mechanismLinks(view, f).map(e => step(view, e))), sources: note([{sources: view.node(f).assertions.map(sourceOf)}])[0].sources});
  }
  // Mutation outcomes of the mutations that edit it (observed, with their run).
  const mutations = [];
  if (comp) for (const e of view.edgesOf(comp, {mode: 'established', types: ['depends-on']})) {
    if (e.to !== comp || kindOf(e.from) !== 'systems/mutation') continue;
    const outcomes = view.edgesOf(e.from, {mode: 'established', types: ['derived-from']}).filter(o => o.to === e.from && kindOf(o.from) === 'learning/mutation-outcome')
      .map(o => ({id: o.from, ...pick(view.node(o.from).attributes, ['killed', 'commit', 'tests']), sources: edgeSources(view, o)}));
    mutations.push({mutation: e.from, outcomes: note(outcomes), result: outcomes.length ? null : 'no recorded run of this mutation'});
  }
  // TEXTUAL, apart: register entries that name it (a mention is not a lesson about it); their status as recorded.
  const register = comp ? view.edgesOf(comp, {mode: 'possible', types: ['mentions']}).map(e => (e.from === comp ? e.to : e.from)).filter(n => kindOf(n) === 'evidence/record')
    .map(n => ({id: n, status: view.node(n).attributes.status ?? null, established: view.nodeIn(n, 'established'), basis: 'textual: the text names it; not a statement that it applies'})) : [];
  // HYPOTHETICAL, apart: mechanism links no rule established, and classes whose text resembles the claim.
  const related = [...classes.map(c => c.id), ...classes.flatMap(c => c.defects.map(d => d.id)), ...findings.map(f => f.id)];
  const links = related.flatMap(n => hypotheticalLinks(view, n).map(e => ({...step(view, e), classification: 'hypothetical', established: false,
    why: view.query(e.subject, 'possible').map(q => q.why)[0] ?? 'not established'})));
  const similar = defect.claim ? similarityCandidates(view, defect.claim) : [];
  if (!classes.length && !findings.length) gaps.push({category: 'learning', why: 'no established failure class, finding or mechanism is related to it by a stated relationship; similar text, if any, is listed as hypothesis only'});
  return {query: 'learning', cursor: view.seq, defect: {component: comp, test: failing, name: failingName, claim: defect.claim ? cut(defect.claim, 300) : null},
    established: {tests: [...tests.values()], classes, findings, mutations},
    next: {run: [...new Set(classes.map(c => c.detector.test))].sort(byString),
      investigate: classes.flatMap(c => c.detection_gap.map(g => ({class: c.id, next: g.next}))).filter(x => x.next)},
    textual: {register}, hypothetical: {links: [...new Map(links.map(l => [`${l.from}|${l.to}`, l])).values()], similar},
    gaps, sources: [...used].sort(byString),
    note: 'established: related by relationships the sources state (a join on a stated identity is labelled); textual and hypothetical are listed apart and never as established'};
}
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o?.[k] ?? null]));
/** The register ids a failure class's text names (a TEXTUAL join, labelled): the entries and their status. */
export function registerNamedBy(view, fc) {
  const a = view.node(fc).attributes, ids = [...new Set(`${a.source ?? ''} ${(a.instances ?? []).map(i => i.note).join(' ')}`.match(ENTRY_ID) ?? [])].sort(byString);
  return ids.map(id => ({id, record: recordId(id), status: view.nodeIn(recordId(id), 'possible') ? view.node(recordId(id)).attributes.status ?? null : null,
    defined: view.nodeIn(recordId(id), 'established'), basis: 'textual: the class text names this entry'}));
}
