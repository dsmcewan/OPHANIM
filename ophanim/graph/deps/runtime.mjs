// THE RUNTIME'S RECORD IN ONE STATE DIRECTORY as a graph source: what OPHANIM's runtime was obliged to do there, what
// depended on what, which worker attempted it, what was accepted and what effect was applied.
//
// Purpose   The controller (ophanim/runtime.mjs) keeps its state -- `ophanim.runtime/v1`: obligations, effects,
//           repairs, releases, an append-only event list -- as controller commits on the board ref refs/board/ophanim
//           under <stateDir>/pantheon (ophanim/board.mjs). That record is the record of a system OPHANIM built. It is
//           projected here with a DECLARED basis: every fact is what the record itself states (a spec's dependsOn, a
//           history entry's worker, an accepted digest), never a reading of code and never a match by resemblance.
//           Declared is also the one basis from which an extractor may assert every relationship used below
//           (depends-on, produces, consumes, contributed-to; packages/graph/schema.mjs).
// Inputs    A state directory and a short lowercase NAME for it (the name, never the machine's path, is in every id and
//           reference, so two state directories never share a node). Read through board.mjs's read-only readers and a
//           read-only walk of the board's commits; nothing else.
// Outputs   runtimeSource(); runtimeFacts(state, {name, commit}) (pure: a materialized state in, drafts out);
//           versionOfCommit(); the id helpers.
// Version   A board commit id is `commit:<64 hex>`, which is not an admissible version as written, so the version is
//           `sha256:` + the sha256 of that id's text; the real id is the `commit` attribute of the state node. readAt
//           finds the commit a version names by walking the chain back from the head (the digest cannot be inverted)
//           and reads THAT commit's state; a version that names no commit of the head's chain is refused, never
//           answered from the head.
// Verified  Nothing is read from a chain that does not verify (board.mjs verifyRuntimeChain: one transition per
//           commit, nothing accepted or confirmed ever rewritten). current() verifies the head's chain and throws the
//           verifier's reason, which the graph records as the source being UNAVAILABLE (packages/graph/events.mjs);
//           readAt verifies the chain that ends at the commit it reads. So a version before a bad commit still reads as
//           it did (its own chain verifies), while the head after it gives nothing.
// Facts     evidence/record   runtime/<name>/state             the state: schema, real head commit id, revision, counts
//                                                              by status, event counts by type, the ACTIVE RELEASE and
//                                                              each release (id, artifact digest, plan reference,
//                                                              worker count), the release history (each change with
//                                                              the digest of its decision). Releases are attributes
//                                                              here: no registered type is a release.
//           work/obligation   runtime/<name>/obligation/<id>   kind, scope, status, reason, the spec's digest, the
//                                                              KEYS of its inputs, attempt counts, accepted digest
//           work/execution    runtime/<name>/execution/<id>/<n>  one attempt: outcome (accepted, gate-rejected,
//                                                              worker-failed, interrupted, or the row's status while
//                                                              in flight), worker id, candidate digest, its repair
//           work/artifact     runtime/<name>/output/<id>       an accepted output: its digest, attempt, worker, release
//                             runtime/<name>/effect/<key>      an effect: its digest and status; one the state records
//                                                              as intended but not confirmed is `unresolved`
//           capability/agent  runtime/<name>/worker/<id>       a worker, by its id across releases: version, kinds and
//                                                              scopes as the active release registers it, and every
//                                                              version any release gives it
//           work/plan         runtime/<name>/plan/<id>         an admitted plan: its planner and digests, no edge (the
//                                                              record does not list a plan's obligations by id)
//           depends-on        obligation -> obligation (each spec.dependsOn); execution -> its obligation
//           produces          obligation -> its accepted output and its effects; the accepted execution -> the output
//           consumes          the retained candidate's execution -> the accepted output of each dependency, when the
//                             digest the candidate recorded for it is the accepted one
//           contributed-to    worker -> each execution the record names it for
//           What a record names but the state does not hold -- a dependsOn or an effect naming no obligation, a worker
//           in no release, an attempt counted with no outcome -- is an `unresolved` entity with the reason, and the
//           edge to it is kept.
// Must never  Write the state or take its lock; start a worker or import a worker's `run`; put a VALUE of the state in
//           a fact (an input, an output, a payload, a proposal, a failure message: only digests, ids, kinds, statuses
//           and counts); read a commit whose chain does not verify; answer a version from another commit.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {entityId, encodeKey} from '../../../packages/graph/index.mjs';
import {openStore} from '../../../pantheon/src/board/cas.mjs';
import {STATE_SCHEMA, CHAIN_LIMIT, boardPath, readRuntimeSnapshot, verifyRuntimeChain, canonical, digest} from '../../board.mjs';

export const SOURCE_ID = 'ophanim.runtime';
export const EXTRACTOR = 'ophanim.runtime.extractor';
/** DECLARED: the record states each fact; the basis that admits contributed-to as well as depends-on, produces, consumes. */
export const RUNTIME_ORIGIN = Object.freeze({kind: 'extractor', basis: 'declared', sources: [SOURCE_ID]});
/** Attempts of one obligation that become executions; a row counting more is said so on the obligation. */
export const MAX_ATTEMPTS = 64;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const IN_FLIGHT = ['running', 'gating', 'effect_pending'];
const refuse = why => Object.assign(new Error(why), {code: 'RUNTIME_SOURCE_REFUSED'});
const need = (ok, why) => { if (!ok) throw refuse(why); };
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = v => (Array.isArray(v) ? v : []);
const entries = v => Object.entries(plain(v) ? v : {}).sort(([a], [b]) => byString(a, b));
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
/** A short text the record uses as an id, a kind or a status; anything else (an object, a long text) is not copied. */
const word = (v, n = 128) => (typeof v === 'string' ? cut(v, n) : null);
const int = v => (Number.isInteger(v) ? v : null);
const bounded = (xs, n = 32) => (xs.length > n ? [...xs.slice(0, n), `... ${xs.length - n} more`] : xs);
/** How many of each: the first 32 kinds by name, and the rest together as `other` (counted, never dropped). */
const tally = xs => {
  const out = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  const kinds = Object.entries(out).sort(([a], [b]) => byString(a, b)), rest = kinds.slice(32).reduce((n, [, c]) => n + c, 0);
  return Object.fromEntries([...kinds.slice(0, 32), ...(rest ? [['other', rest]] : [])]);
};
const sha256Of = v => (v === undefined ? null : digest(v));

/** The version a board commit id is observed as: the digest of the id's text (`commit:<hex>` is not a version). */
export const versionOfCommit = commit => 'sha256:' + createHash('sha256').update(String(commit)).digest('hex');

// One key segment: the record's own id, with `/` escaped too, so an id never reaches into another id's key.
const seg = raw => encodeKey(String(raw)).replace(/\//g, '%2F');
const keyed = (domain, type, name, ...rest) => { need(NAME.test(name ?? ''), `"${name}" is not a state name (a short lowercase name, e.g. proof-ops)`); return entityId({domain, type, key: ['runtime', name, ...rest].join('/'), encoded: true}); };
export const stateId = name => keyed('evidence', 'record', name, 'state');
export const obligationId = (name, id) => keyed('work', 'obligation', name, 'obligation', seg(id));
export const executionId = (name, id, attempt) => keyed('work', 'execution', name, 'execution', seg(id), String(attempt));
export const outputId = (name, id) => keyed('work', 'artifact', name, 'output', seg(id));
/** An effect by its key; a key too long for an id is named by its digest (the key itself stays an attribute). */
export const effectId = (name, key) => (seg(key).length <= 300 ? keyed('work', 'artifact', name, 'effect', seg(key)) : keyed('work', 'artifact', name, 'effect-digest', digest(String(key))));
export const workerId = (name, id) => keyed('capability', 'agent', name, 'worker', seg(id));
export const planId = (name, id) => keyed('work', 'plan', name, 'plan', seg(id));

/**
 * The facts of one materialized runtime state, as the extractor's drafts: entities sorted by id, then relationships
 * sorted by type and endpoints. `commit` is the board commit the state was read at (kept on the state node).
 */
export function runtimeFacts(state, {name, commit = null} = {}) {
  need(NAME.test(name ?? ''), `"${name}" is not a state name (a short lowercase name, e.g. proof-ops)`);
  need(plain(state) && state.schema === STATE_SCHEMA, `the state is not ${STATE_SCHEMA}`);
  const at = where => cut(`runtime/${name}#${where}`, 1000);
  const nodes = new Map(), links = new Map();
  const node = d => { if (!nodes.has(d.entity)) nodes.set(d.entity, d); };
  const link = (type, from, to, ref, attributes = {}) => { const k = `${type}\0${from}\0${to}`; if (!links.has(k)) links.set(k, {type, from, to, ref, attributes}); };
  // What a record names that the state may not hold: id -> who names it.
  const namedObligations = new Map(), namedWorkers = new Map();
  const names = (map, id, by) => (map.get(id) ?? map.set(id, []).get(id)).push(by);

  const rows = entries(state.obligations), events = list(state.events), repairs = entries(state.repairs), releases = entries(state.releases);
  for (const [id, row] of rows) need(plain(row) && plain(row.spec), `obligation ${cut(id, 128)} has no spec`);
  const obligations = new Map(rows);

  // The workers of each release (a release's registry is immutable once recorded).
  const registered = new Map();
  for (const [release, r] of releases) for (const w of list(r?.workers)) {
    if (typeof w?.id === 'string') names(registered, w.id, {release, version: word(w.version, 64), kinds: bounded(list(w.kinds).map(k => word(k))), scopes: bounded(list(w.scopes).map(s => word(s)))});
  }
  // Who started each attempt and which were interrupted: the event list is the only record of an attempt that left no
  // history entry (one still in flight, or one a later controller fenced).
  const started = new Map(), interrupted = new Set(), key = (id, n) => `${id}\0${n}`;
  for (const e of events) {
    if (e?.type === 'work.started') started.set(key(e.id, e.attempt), e.worker);
    else if (e?.type === 'work.interrupted') interrupted.add(key(e.id, e.attempt));
  }
  const repairOf = new Map(repairs.map(([, r]) => [key(r?.obligationId, r?.attempt), r]));

  let executions = 0, unread = 0;
  for (const [id, row] of rows) {
    const spec = row.spec, me = obligationId(name, id), where = `obligations/${id}`;
    const accepted = plain(row.accepted) ? row.accepted : null, candidate = plain(row.candidate) ? row.candidate : null;
    const count = Math.max(int(row.attempt) ?? 0, 0);
    // The attempts: every one the row counts, and every one its history records.
    const history = new Map();
    for (const h of list(row.history)) {
      if (Number.isInteger(h?.attempt) && h.attempt >= 1) names(history, h.attempt, h); else unread++;
    }
    const numbers = [...new Set([...history.keys(), ...Array.from({length: Math.min(count, MAX_ATTEMPTS)}, (_, i) => i + 1)])].sort((a, b) => a - b);
    const listed = numbers.slice(0, MAX_ATTEMPTS);
    node({entity: me, ref: at(where), attributes: {state: name, id, kind: word(spec.kind), scope: word(spec.scope), status: word(row.status, 32), reason: word(row.reason, 64),
      spec_sha256: digest(spec), output_key: word(spec.outputKey, 256), effect_key: word(spec.effectKey, 256), max_attempts: int(spec.maxAttempts), attempts: count,
      release_attempts: int(row.releaseAttempts), depends_on: bounded(list(spec.dependsOn).map(d => word(d))), input_keys: bounded(Object.keys(plain(spec.inputs) ? spec.inputs : {}).sort(byString).map(k => cut(k, 128))),
      accepted_sha256: word(accepted?.sha256, 80), ...(numbers.length > listed.length ? {attempts_not_listed: numbers.length - listed.length} : {})}});
    for (const dep of new Set(list(spec.dependsOn).filter(d => typeof d === 'string' && d))) {
      if (!obligations.has(dep)) names(namedObligations, dep, `dependsOn of ${id}`);
      link('depends-on', me, obligationId(name, dep), at(where), {basis: 'the obligation\'s spec names this dependency'});
    }
    if (accepted) {
      // The publication is the retained candidate's, when that candidate is the accepted one.
      const published = candidate?.candidate?.sha256 === accepted.sha256 && plain(candidate.published) ? candidate.published : null;
      node({entity: outputId(name, id), ref: at(`${where}/accepted`), attributes: {state: name, artifact: 'accepted-output', obligation: id, output_key: word(spec.outputKey, 256),
        sha256: word(accepted.sha256, 80), attempt: int(accepted.attempt), worker: word(accepted.worker?.id), release: word(accepted.release),
        plan_ref: word(accepted.planRef, 200), verification_sha256: sha256Of(accepted.verification), published_commit: word(published?.commit, 80), published_blob: word(published?.blob, 80)}});
      link('produces', me, outputId(name, id), at(`${where}/accepted`), {basis: 'the obligation\'s accepted output'});
    }
    for (const n of listed) {
      const records = history.get(n) ?? [], last = records.at(-1) ?? null, x = executionId(name, id, n), here = `${where}/attempts/${n}`;
      const acceptedHere = accepted?.attempt === n ? accepted : null, retained = candidate?.evidence?.totalAttempt === n ? candidate : null;
      const repair = repairOf.get(key(id, n)) ?? null;
      // The outcome the record states: its history entry's; else the row's own status while the attempt is in flight;
      // else its interruption. An attempt with none of these is counted by the row and otherwise unrecorded.
      const stated = last ? word(last.status, 64) : n === count && IN_FLIGHT.includes(row.status) ? row.status : interrupted.has(key(id, n)) ? 'interrupted' : null;
      const outcome = stated ?? 'unrecorded';
      const worker = [last?.worker, retained?.worker?.id, started.get(key(id, n))].map(w => word(w)).find(Boolean) ?? null;
      node({entity: x, ref: at(here),
        ...(stated ? {} : {status: 'unresolved', missing_evidence: [last ? `the history entry of attempt ${n} states no outcome`
          : `the obligation counts ${count} attempt(s) but the state holds no history entry, no interruption and no attempt in flight for attempt ${n}`]}),
        attributes: {state: name, obligation: id, attempt: n, outcome, worker, worker_version: word((acceptedHere ?? retained)?.worker?.version, 64),
          candidate_sha256: word(last?.candidateSha ?? retained?.candidate?.sha256, 80), release: word(acceptedHere?.release ?? retained?.release ?? repair?.release),
          // A failure's message is the worker's text: its digest, never the text.
          reason_sha256: typeof last?.reason === 'string' ? digest(last.reason) : null,
          repair: repair ? {status: word(repair.status, 32), reason: word(repair.reason, 64), resolved_by_attempt: int(repair.resolvedByAttempt)} : null,
          ...(records.length > 1 ? {recorded_outcomes: bounded(records.map(h => word(h?.status, 64)), 8)} : {})}});
      executions++;
      link('depends-on', x, me, at(here), {basis: 'an attempt at this obligation'});
      if (worker) {
        if (!registered.has(worker)) names(namedWorkers, worker, `${id} attempt ${n}`);
        link('contributed-to', workerId(name, worker), x, at(here), {basis: 'the record names this worker for the attempt'});
      }
      if (acceptedHere) link('produces', x, outputId(name, id), at(`${where}/accepted`), {basis: 'the accepted attempt'});
      for (const d of list(retained?.evidence?.dependencyVersions)) {
        const source = obligations.get(d?.id)?.accepted;
        if (plain(source) && typeof d.sha256 === 'string' && source.sha256 === d.sha256) link('consumes', x, outputId(name, d.id), at(here), {basis: 'the candidate\'s recorded dependency version', sha256: d.sha256});
      }
    }
  }

  for (const [k, e] of entries(state.effects)) {
    const confirmed = e?.status === 'confirmed', where = `effects/${cut(k, 300)}`;
    node({entity: effectId(name, k), ref: at(where),
      ...(confirmed ? {} : {status: 'unresolved', missing_evidence: [`the state records this effect as "${word(e?.status, 32) ?? 'no status'}", not as confirmed`]}),
      attributes: {state: name, artifact: 'effect', key: cut(k, 256), obligation: word(e?.obligationId), sha256: word(e?.sha256, 80), effect_status: word(e?.status, 32), receipt_sha256: sha256Of(e?.receipt)}});
    if (typeof e?.obligationId === 'string' && e.obligationId) {
      if (!obligations.has(e.obligationId)) names(namedObligations, e.obligationId, `effect ${cut(k, 128)}`);
      link('produces', obligationId(name, e.obligationId), effectId(name, k), at(where), {basis: 'the effect names this obligation'});
    }
  }

  for (const [id, regs] of [...registered].sort(([a], [b]) => byString(a, b))) {
    // Described as the active release registers it (a worker the active release no longer lists: as the last release
    // that lists it, by release id, does), with every version any release gives it: an id keeps its node across releases.
    const active = regs.find(r => r.release === state.activeRelease) ?? null, d = active ?? regs.at(-1);
    node({entity: workerId(name, id), ref: at(`releases/${d.release}/workers/${id}`), attributes: {state: name, id, version: d.version, kinds: d.kinds, scopes: d.scopes,
      versions: bounded([...new Set(regs.map(r => r.version ?? 'no version'))].sort(byString), 16), described_by_release: d.release, active: Boolean(active), releases: bounded(regs.map(r => r.release), 16),
      registrations_differ: new Set(regs.map(r => canonical([r.version, r.kinds, r.scopes]))).size > 1}});
  }
  for (const [id, by] of namedWorkers) {
    node({entity: workerId(name, id), ref: at('releases'), status: 'unresolved', missing_evidence: [`named as the worker of ${by.length} attempt(s) but registered in no release of the state at this commit`],
      attributes: {state: name, id, named_by: bounded(by.sort(byString))}});
  }
  for (const [id, by] of namedObligations) {
    node({entity: obligationId(name, id), ref: at(`obligations/${cut(id, 300)}`), status: 'unresolved', missing_evidence: [`named by ${by.length} record(s) of the state but not an obligation of the state at this commit`],
      attributes: {state: name, id: cut(id, 128), named_by: bounded(by.sort(byString))}});
  }
  for (const [id, p] of entries(state.plans)) {
    node({entity: planId(name, id), ref: at(`plans/${cut(id, 300)}`), attributes: {state: name, id: cut(id, 128), planner: word(p?.planner?.id), planner_version: word(p?.planner?.version, 64),
      request_sha256: word(p?.requestSha, 80), policy_sha256: word(p?.policySha, 80), proposal_sha256: word(p?.proposalSha, 80), obligations_sha256: word(p?.obligationsSha, 80),
      authorized: p?.authorization?.ok === true, authorization_sha256: sha256Of(p?.authorization)}});
  }

  const last = events.at(-1) ?? null, pending = plain(state.pendingRelease) ? state.pendingRelease : null, changes = list(state.releaseHistory);
  node({entity: stateId(name), ref: `runtime/${name}`, attributes: {state: name, schema: state.schema, commit: word(commit, 80), revision: int(state.revision),
    obligations: rows.length, by_status: tally(rows.map(([, r]) => word(r.status, 32) ?? 'no status')), executions,
    effects: tally(entries(state.effects).map(([, e]) => word(e?.status, 32) ?? 'no status')), repairs: tally(repairs.map(([, r]) => word(r?.status, 32) ?? 'no status')),
    events: events.length, event_types: tally(events.map(e => word(e?.type, 64) ?? 'no type')), last_event: last ? {sequence: int(last.sequence), type: word(last.type, 64)} : null,
    active_release: word(state.activeRelease), pending_release: pending ? {id: word(pending.release?.id), kind: word(pending.kind, 32)} : null,
    releases: releases.slice(0, 16).map(([id, r]) => ({id: cut(id, 128), artifact_sha256: word(r?.artifactSha, 80), plan_ref: word(r?.planRef, 200), workers: list(r?.workers).length})),
    release_count: releases.length,
    release_history: changes.slice(0, 16).map(c => ({kind: word(c?.kind, 32), from: word(c?.fromRelease), to: word(c?.toRelease), decision_sha256: sha256Of(c?.decision)})),
    release_history_count: changes.length,
    plans: entries(state.plans).length, workers: registered.size, history_unread: unread}});

  return [...[...nodes.values()].sort((a, b) => byString(a.entity, b.entity)),
    ...[...links.values()].sort((a, b) => byString(a.type, b.type) || byString(a.from, b.from) || byString(a.to, b.to))];
}

/**
 * The adapter: the state directory `stateDir` under the name `name`, at the commit its board ref names now. `id` lets a
 * second state directory be a second source of the same extractor (whose origin then lists both ids).
 */
export function runtimeSource({stateDir, name, id = SOURCE_ID, extractor = EXTRACTOR} = {}) {
  need(typeof stateDir === 'string' && stateDir.length > 0, 'a runtime source reads a state directory');
  need(NAME.test(name ?? ''), `"${name}" is not a state name (a short lowercase name, e.g. proof-ops)`);
  // A commit names its whole chain by content (every object is re-hashed when read), so a chain verified once for a
  // commit id is verified for that id; the head moving is a new id and a new verification.
  const verified = new Set();
  const verify = commit => { if (!verified.has(commit)) { verifyRuntimeChain(stateDir, {head: commit}); verified.add(commit); } };
  const head = () => {
    need(fs.existsSync(boardPath(stateDir)), `the runtime state "${name}" has no runtime board at its state directory`);
    const {commit} = readRuntimeSnapshot(stateDir);
    need(commit, `the runtime state "${name}" has no commit on its board ref`);
    return commit;
  };
  // The commit a version names: found on the chain of the head, or refused (never the head in its place).
  const commitOf = version => {
    const store = openStore(boardPath(stateDir), {readOnly: true});
    let steps = 0;
    for (let commit = head(); commit; commit = store.get(commit).parents?.[0] ?? null) {
      if (versionOfCommit(commit) === version) return commit;
      need(++steps < CHAIN_LIMIT, `the runtime state "${name}" has a chain longer than ${CHAIN_LIMIT} commits`);
    }
    throw refuse(`${version} names no commit on the chain of the state's head: it was never a version of the runtime state "${name}", or the state no longer holds it`);
  };
  return {
    id, extractor, ref: `runtime/${name}`,
    authority: `the runtime state "${name}" (${STATE_SCHEMA}: obligations, effects, repairs, releases and events, as controller commits on the board ref refs/board/ophanim), read only, at a commit whose chain verifies`,
    current: () => { const commit = head(); verify(commit); return {version: versionOfCommit(commit)}; },
    readAt: version => { const commit = commitOf(version); verify(commit); return runtimeFacts(readRuntimeSnapshot(stateDir, commit).state, {name, commit}); },
  };
}
