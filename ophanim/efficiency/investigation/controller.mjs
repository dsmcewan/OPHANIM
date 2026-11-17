// ophanim/efficiency/investigation/controller.mjs -- the investigation step of an efficiency assessment.
//
// Purpose: after a convergence, decide what (if anything) is worth investigating about its cost, from
//   functional models of the trace plus the scope's retained investigation history, and retain that
//   decision as content-addressed evidence so the next convergence in the scope builds on it.
// Inputs:  recordInvestigation({root, stateDir, trace, registry, variables, workload, traceTrusted,
//   estimate}): the efficiency evidence root, this run's state directory, the retained trace and its
//   contribution registry and variables, the expected number of convergences, whether the trace's board
//   binding is complete, and an optional operator forecast (which must match the trace's estimate hash).
//   verifyInvestigationReceipt re-derives a receipt; planInvestigation is the pure planning step.
// Outputs: an `ophanim.investigation-receipt/v1` receipt (decision, model hash, the history it was made
//   from, the packet it retained, its cost). Packets are written to
//   <root>/scopes/<scopeSha>/investigations/<digest>.json.
// Invariants: packets are write-once and named by their digest; a scope has at most MAX_RECORDS active
//   packets (older ones are folded into a checkpoint, never deleted); every packet's source trace is
//   re-read and its decision re-derived before it is used (checkSources); only a trusted accepted trace
//   can start research -- any other trace yields no_change or blocked; writing is under the seat lock.
// Must never: run an investigation, call a model, treat an operator forecast as a measurement, or rely
//   on a retained packet that does not re-derive from its source trace.
import fs from 'node:fs';
import path from 'node:path';
import {canonical, digest, readRuntimeSnapshot} from '../../board.mjs';
import {withSeatLock} from '../../../pantheon/src/seat/lock.mjs';
import {buildContributionRegistry, discoverVariables} from '../contributions.mjs';
import {verifyAdmissionTrace} from '../trace-binding.mjs';
import {buildFunctionalModels} from './models.mjs';
import {selectInvestigation} from './select.mjs';

const RECEIPT = 'ophanim.investigation-receipt/v1';
const MEMORY = 'ophanim.investigation-scope-evidence/v1';
const CHECKPOINT = 'ophanim.investigation-scope-checkpoint/v1';
const MAX_RECORDS = 32;
const MAX_ENTRIES = 64;
const MAX_FILES = 1024;
const MAX_MEMORY_BYTES = 256 * 1024;
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const requireThat = (condition, reason) => { if (!condition) throw Error(reason); };
const ESTIMATE_SCHEMA = 'ophanim.investigation-estimate/v1';
const ESTIMATE_KEYS = ['applicability','confidence','decisionChangeProbability','avoidableLossMsPerConvergence',
  'expectedCandidateGainMsPerConvergence','rolloutMs','regressionMs','opportunityCostMs'];

// Operator forecasts are scoped decision inputs. They supply neither
// observed system measurements nor credentials to run an investigation.
function forecastEconomics(estimate, trace, workload) {
  if (estimate === null || estimate === undefined) return undefined;
  const {schema,scopeSha,basis,estimates,instrumentationCeilingMs} = estimate;
  requireThat(schema === ESTIMATE_SCHEMA && scopeSha === trace.scopeSha && typeof basis === 'string' &&
    basis.trim().length > 0 && basis.length <= 512 && Object.keys(estimate).every(key =>
      ['schema','scopeSha','basis','estimates','instrumentationCeilingMs'].includes(key)) &&
    estimates && Object.keys(estimates).every(key => ESTIMATE_KEYS.includes(key)),
    'Exact scoped investigation forecast required');
  if (instrumentationCeilingMs !== undefined)
    requireThat(
      Number.isInteger(instrumentationCeilingMs) && instrumentationCeilingMs >= 1 && instrumentationCeilingMs <= 30000,
      'Instrumentation forecast exceeds fixed budget');
  return {...estimates, expectedConvergences:workload, sourceSha:digest({estimate, workload})};
}

// Build the functional models and select an investigation. Without explicit `methods`, a first pass finds
// the candidate questions with competing hypotheses and offers one instrumentation method per question
// (observing the signals the hypotheses' predictions name, within the instrumentation ceiling).
export function planInvestigation(
  {trace, registry, variables, findings, methods, economics, economicsByFinding, history = [],
      verifiedObservations = [], verifyObservation, advisorHypotheses, workload = 1,
    instrumentationCeilingMs = 30000} = {}) {
  const models = buildFunctionalModels({trace, registry, variables, verifiedObservations, verifyObservation});
  const inputs = {
    models, findings, economics:economics ?? {expectedConvergences:workload}, economicsByFinding, history,
    advisorHypotheses};
  if (methods === undefined) {
    // The first pass discovers supported attribution gaps. A method exists
    // only for observable differences between the alternatives it generated.
    const discovery = selectInvestigation(inputs);
    methods = discovery.candidates.filter(candidate => candidate.hypotheses.length > 1).map(candidate => ({
      id:`instrument.${candidate.questionSha.slice(0,16)}`, mode:'instrumentation',
      signals:[
        ...new Set(candidate.hypotheses.flatMap(hypothesis => hypothesis.predictions.map(point => point.signal)))],
      estimatedCostMs:instrumentationCeilingMs, stop:{maxWallMs:30000, maxTrials:0, maxModelCalls:0},
      citations:['Reserved wall-time ceiling. Each span needs an independently checkable boundary before collection.'],
    }));
  }
  const decision = selectInvestigation({...inputs, methods});
  return {models, decision, workload};
}

// Create (if needed) a canonical directory: no symbolic link on its path.
function directory(dir) {
  fs.mkdirSync(dir, {recursive:true, mode:0o700});
  requireThat(
    fs.realpathSync(dir) === dir && fs.lstatSync(dir).isDirectory(),
    'Canonical investigation evidence directory required');
  return dir;
}

// Where a scope's investigation packets live under an evidence root.
function memoryDirectory(root, scope) {
  requireThat(path.isAbsolute(root) && path.resolve(root) === root && sha(scope), 'Exact investigation scope required');
  return path.join(root, 'scopes', scope, 'investigations');
}

// The evidence root this run may write to: its own <stateDir>/efficiency when `root` is another accepted
// state's private efficiency directory (recognised by that state's board ref), else `root` itself.
function ownedRoot(root, stateDir) {
  const own = path.join(stateDir, 'efficiency');
  // A previous accepted state's private directory can supply comparison
  // evidence. It remains immutable during a fresh comparison.
  const previous = root !== own && path.basename(root) === 'efficiency' &&
    fs.existsSync(path.join(path.dirname(root), 'pantheon', 'refs', 'board', 'ophanim'));
  return previous ? own : root;
}

// Read one packet by id and check it: a bounded regular file at its canonical path whose digest is its
// name, in this scope, and either a checkpoint (sorted unique retired ids, not itself) or a memory packet.
function readPacket(dir, id, scope) {
  requireThat(sha(id), 'Investigation evidence identifier differs');
  const file = path.join(dir, `${id}.json`);
  const stat = fs.lstatSync(file);
  requireThat(
    stat.isFile() && stat.size <= MAX_MEMORY_BYTES && fs.realpathSync(file) === file,
    'Bounded canonical investigation evidence required');
  const packet = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (packet?.schema === CHECKPOINT) {
    requireThat(
      digest(packet) === id && packet.scopeSha === scope &&
      Object.keys(packet).every(key => ['schema','scopeSha','retiredIds','entries'].includes(key)) &&
      Array.isArray(packet.retiredIds) && packet.retiredIds.length >= 1 && packet.retiredIds.length <= MAX_RECORDS &&
      packet.retiredIds.every(sha) &&
      canonical(packet.retiredIds) === canonical([...new Set(packet.retiredIds)].sort()) &&
      !packet.retiredIds.includes(id) &&
      Array.isArray(packet.entries) && packet.entries.length <= MAX_ENTRIES,
      'Retained investigation checkpoint differs');
    return packet;
  }
  requireThat(digest(packet) === id && packet.schema === MEMORY && packet.scopeSha === scope &&
    /^commit:[a-f0-9]{64}$/.test(packet.boardCommit) && sha(packet.traceSha) && path.isAbsolute(packet.stateDir) &&
    Array.isArray(packet.historyIds) && packet.historyIds.length <= MAX_RECORDS &&
    Array.isArray(packet.entries) && packet.entries.length <= 12, 'Retained investigation evidence differs');
  return packet;
}

// Write a packet at <digest>.json atomically: a private temporary file, fsync, hard link (an existing file
// with that name must read back as the same packet), then fsync the directory. Returns the id.
function writePacket(dir, packet) {
  const id = digest(packet);
  const file = path.join(dir, `${id}.json`);
  const bytes = canonical(packet);
  requireThat(Buffer.byteLength(bytes) <= MAX_MEMORY_BYTES, 'Investigation evidence byte bound');
  const temp = path.join(dir, `.packet-${id}-${process.pid}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try { fs.linkSync(temp, file); }
    catch (error) { if (error.code !== 'EEXIST') throw error; else readPacket(dir, id, packet.scopeSha); }
    const directoryFd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    return id;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

// A scope keeps at most MAX_RECORDS active packets. At capacity the active
// packets are folded into one content-addressed checkpoint that retires them
// and keeps the latest retained decision for each question. Retired packets
// stay on disk and the checkpoint is re-derived from them on verification.
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function activeIds(packets) {
  const retired = new Set(
    [...packets.values()].flatMap(packet => packet.schema === CHECKPOINT ? packet.retiredIds : []));
  const active = [...packets.keys()].filter(id => !retired.has(id)).sort();
  requireThat(
    active.filter(id => packets.get(id).schema === CHECKPOINT).length <= 1,
    'At most one active investigation checkpoint');
  requireThat(active.length <= MAX_RECORDS, 'Investigation evidence count bound');
  return active;
}
function chronological(ids, packets) {
  // Each packet lists every active packet before it, so the list length is its position.
  const rank = id => packets.get(id).schema === CHECKPOINT ? -1 : packets.get(id).historyIds.length;
  return [...ids].sort((a, b) => rank(a) - rank(b) || cmp(a, b));
}
// The latest entry for each question across the packets, oldest packet first; ordered by question.
function foldEntries(ids, packets) {
  const latest = new Map();
  for (const id of chronological(ids, packets)) for (const entry of packets.get(id).entries)
    latest.set(entry.questionSha, entry);
  return [...latest.values()].sort((a, b) => cmp(a.questionSha, b.questionSha));
}
// Retaining `entries` would exceed the bounds: too many active packets or too many history entries.
const atCapacity = (ids, history, entries) => entries.length > 0 &&
  (ids.length >= MAX_RECORDS || history.length + entries.length > MAX_ENTRIES);
// The decision replaced by a blocked outcome when even a checkpoint cannot make room.
const capacityBlocked = decision => (
  {...decision, outcome:'blocked', selected:null, historyEntries:[], reason:'retained-evidence-capacity'});
function historyOf(ids, packets) { return ids.flatMap(id => packets.get(id).entries); }
// Shared by recording and verification. `rederive(history)` returns
// {modelSha, decision}. The result names the history the decision was made
// from and, when the active packets had to be folded, the checkpoint to keep.
export function retainWithinCapacity({scopeSha, ids, packets, rederive}) {
  const first = rederive(historyOf(ids, packets));
  if (!atCapacity(ids, historyOf(ids, packets), first.decision.historyEntries ?? []))
    return {...first, historyIds:ids, checkpoint:null};
  const checkpoint = {schema:CHECKPOINT, scopeSha, retiredIds:ids, entries:foldEntries(ids, packets)};
  const folded = rederive(checkpoint.entries);
  if (atCapacity([digest(checkpoint)], checkpoint.entries, folded.decision.historyEntries ?? []))
    return {modelSha:first.modelSha, decision:capacityBlocked(first.decision), historyIds:ids, checkpoint:null};
  return {...folded, historyIds:[digest(checkpoint)], checkpoint};
}
export {activeIds as activeInvestigationIds, foldEntries as foldInvestigationHistory};
// Every packet reachable from `ids` through history and retired ids, each read once, bounded by MAX_FILES.
function closure(dir, ids, scope) {
  const packets = new Map(), queue = [...ids];
  while (queue.length) {
    const id = queue.pop();
    if (packets.has(id)) continue;
    requireThat(packets.size < MAX_FILES, 'Investigation evidence file bound');
    const packet = readPacket(dir, id, scope);
    packets.set(id, packet);
    queue.push(...(packet.schema === CHECKPOINT ? packet.retiredIds : packet.historyIds));
  }
  return packets;
}

// The decision for a trace given a history. Only a trusted accepted trace uses the operator forecast and
// findings; any other trace is planned without findings and its decision is reduced to no_change or blocked.
function derive({trace, registry, variables, workload, traceTrusted, history, estimate}) {
  const fresh = traceTrusted && trace.original.convergence === 'accepted_change';
  const economics = fresh ? forecastEconomics(estimate, trace, workload) : undefined;
  const {models, decision} = planInvestigation({trace, registry, variables, workload, history, economics,
    instrumentationCeilingMs:fresh ? estimate?.instrumentationCeilingMs : undefined,
    ...fresh ? {} : {findings:[]}});
  if (fresh) return {modelSha:models.modelSha, decision};
  // A non-fresh, ambiguous or unsettled trace can describe the result but
  // cannot initiate research in the convergence path.
  const settled = trace.original.convergence === 'no_change';
  return {modelSha:models.modelSha, decision:{...decision, selected:null, candidates:[], historyEntries:[],
    outcome:settled ? 'no_change' : 'blocked',
    reason:settled ? 'no-new-accepted-evidence' : 'accepted-trace-binding-required'}};
}

// The decision recordInvestigation makes without opening retained evidence: for a trace that cannot
// initiate research it is a pure function of the trace and workload, so it is always obtainable. Returns
// null when the decision depends on retained evidence (a trusted accepted trace), where a held receipt can
// be the honest outcome of a normal run (an unusable forecast, a retired source state, a lock timeout).
export function investigationWithoutEvidence({trace, registry, variables, workload = 1, traceTrusted = false}) {
  if (traceTrusted && trace.original.convergence === 'accepted_change') return null;
  return derive({trace, registry, variables, workload, traceTrusted, history:[]});
}

// Record the investigation decision for this convergence (see the header). An untrusted or non-accepted
// trace is decided without opening retained evidence. Otherwise, under the seat lock: re-check every
// packet, return the already-retained decision for this board commit if there is one (it must re-derive),
// else decide from the active history (folding at capacity) and retain the new entries.
export async function recordInvestigation(
  {root, stateDir, trace, registry, variables, workload = 1, traceTrusted = false, estimate = null} = {}) {
  const started = performance.now();
  const cpuStart = process.cpuUsage();
  const traceSha = digest(trace);
  requireThat(
    trace.investigationEstimateSha === digest(estimate), 'Investigation forecast does not match retained trace');
  const evidenceRoot = ownedRoot(root, stateDir);
  const dir = memoryDirectory(evidenceRoot, trace.scopeSha);
  const make = ({modelSha, decision, historyIds, retained = null}) => {
    const cpu = process.cpuUsage(cpuStart);
    return {
      schema:RECEIPT, scopeSha:trace.scopeSha, traceSha, boardCommit:trace.boardCommit, modelSha, workload, estimate,
      evidenceRoot, historyIds, retained, decision,
      cost:{wallMs:performance.now()-started, cpuMicros:cpu.user+cpu.system}};
  };
  if (!traceTrusted || trace.original.convergence !== 'accepted_change') {
    return make({...derive({trace, registry, variables, workload, traceTrusted, history:[]}), historyIds:[]});
  }

  directory(dir);
  return withSeatLock('investigation', async () => {
    const names = fs.readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(
      name => name.slice(0,-5)).sort();
    requireThat(names.length <= MAX_FILES, 'Investigation evidence file bound');
    const packets = new Map(names.map(id => [id, readPacket(dir, id, trace.scopeSha)]));
    checkSources(packets);
    const existing = names.find(
      id => packets.get(id).schema === MEMORY && packets.get(id).boardCommit === trace.boardCommit) ?? null;
    const ownPacket = packets.get(existing);
    const rederive = history => derive({trace, registry, variables, workload, traceTrusted, history, estimate});
    if (ownPacket) {
      const {modelSha, decision} = rederive(historyOf(ownPacket.historyIds, packets));
      requireThat(
        ownPacket.traceSha === traceSha && ownPacket.workload === workload &&
        canonical(ownPacket.estimate) === canonical(estimate) &&
        canonical(ownPacket.entries) === canonical(decision.historyEntries ?? []),
        'Recovered investigation decision differs');
      return make({modelSha, decision, historyIds:ownPacket.historyIds, retained:existing});
    }
    const {modelSha, decision, historyIds, checkpoint} = retainWithinCapacity(
      {scopeSha:trace.scopeSha, ids:activeIds(packets), packets, rederive});
    if (checkpoint)
      requireThat(writePacket(dir, checkpoint) === historyIds[0], 'Investigation checkpoint identity differs');
    const entries = decision.historyEntries ?? [];
    const retained = entries.length ?
      writePacket(dir, {schema:MEMORY, scopeSha:trace.scopeSha, boardCommit:trace.boardCommit, traceSha, stateDir,
        workload, estimate, historyIds, entries}) : null;
    return make({modelSha, decision, historyIds, retained});
  }, {dir, timeoutMs:5000});
}

// Re-check every packet against its source: a checkpoint must fold exactly the packets it retires; a memory
// packet's source trace must still be retained, accepted, bound to its board snapshot, and re-derive the
// entries the packet holds from the history it names.
function checkSources(packets) {
  for (const [id, packet] of packets) {
    if (packet.schema === CHECKPOINT) {
      requireThat(packet.retiredIds.every(previous => packets.has(previous)) &&
        canonical(packet.entries) === canonical(foldEntries(packet.retiredIds, packets)),
        'Retained investigation checkpoint differs from retired evidence');
      continue;
    }
    const stateDir = path.resolve(packet.stateDir);
    const file = path.join(stateDir,'efficiency','convergences',packet.boardCommit.replace(':','-'),'trace.json');
    const stat = fs.lstatSync(file);
    requireThat(
      stat.isFile() && stat.size <= 16 * 1024 * 1024 && fs.realpathSync(file) === file,
      'Retained investigation source trace unavailable');
    const source = JSON.parse(fs.readFileSync(file,'utf8'));
    requireThat(
      digest(source) === packet.traceSha && source.scopeSha === packet.scopeSha &&
      source.original.convergence === 'accepted_change' &&
      source.investigationEstimateSha === digest(packet.estimate) &&
      Number.isInteger(packet.workload) && packet.workload >= 1 &&
      packet.workload <= source.policy.maxQualifiedConvergences &&
      !packet.historyIds.includes(id) && new Set(packet.historyIds).size === packet.historyIds.length &&
      packet.historyIds.every(previous => packets.has(previous)), 'Retained investigation source binding differs');
    verifyAdmissionTrace(source,readRuntimeSnapshot(stateDir,packet.boardCommit));
    const registry = buildContributionRegistry({trace:source});
    const variables = discoverVariables({trace:source,registry});
    const history = packet.historyIds.flatMap(previous => packets.get(previous).entries);
    const {decision} = derive(
      {trace:source, registry, variables, workload:packet.workload, traceTrusted:true, history,
        estimate:packet.estimate});
    requireThat(
      canonical(decision.historyEntries) === canonical(packet.entries),
      'Retained investigation history differs from source evidence');
  }
}

// Re-derive a receipt from the trace and the packets it names: same binding, same model hash and decision,
// and, when the decision retained entries, the retained packet holding exactly them.
export function verifyInvestigationReceipt({receipt, trace, registry, variables, traceTrusted}) {
  requireThat(
    receipt?.schema === RECEIPT && receipt.scopeSha === trace.scopeSha && receipt.traceSha === digest(trace) &&
    receipt.boardCommit === trace.boardCommit &&
    trace.investigationEstimateSha === digest(receipt.estimate) &&
    Number.isInteger(receipt.workload) && receipt.workload >= 1 &&
    receipt.workload <= trace.policy.maxQualifiedConvergences &&
    Number.isFinite(receipt.cost?.wallMs) && receipt.cost.wallMs >= 0 && Number.isInteger(receipt.cost.cpuMicros) &&
    receipt.cost.cpuMicros >= 0,
    'Investigation receipt binding differs');
  const dir = memoryDirectory(receipt.evidenceRoot, trace.scopeSha);
  const ids = receipt.historyIds;
  requireThat(
    Array.isArray(ids) && ids.length <= MAX_RECORDS && new Set(ids).size === ids.length &&
    canonical(ids) === canonical([...ids].sort()), 'Bounded investigation history required');
  // Only the evidence this receipt depends on is reopened, each packet once.
  const packets = closure(dir, ids, trace.scopeSha);
  checkSources(packets);
  const rederive = history => derive(
    {trace, registry, variables, workload:receipt.workload, traceTrusted, history, estimate:receipt.estimate});
  const retention = retainWithinCapacity({scopeSha:trace.scopeSha, ids, packets, rederive});
  // A receipt at capacity must already name the checkpoint that folded it.
  requireThat(retention.checkpoint === null, 'Investigation receipt should have folded its retained history');
  const {modelSha, decision} = retention;
  const entries = decision.historyEntries ?? [];
  if (entries.length) {
    const retained = readPacket(dir, receipt.retained, trace.scopeSha);
    requireThat(retained.boardCommit === trace.boardCommit && retained.traceSha === receipt.traceSha &&
      retained.workload === receipt.workload && canonical(retained.estimate) === canonical(receipt.estimate) &&
      canonical({historyIds:ids, entries}) ===
        canonical({historyIds:retained.historyIds, entries:retained.entries}),
      'Retained investigation differs from decision');
  } else requireThat(receipt.retained === null, 'Unexpected retained investigation decision');
  requireThat(
    modelSha === receipt.modelSha && canonical(decision) === canonical(receipt.decision),
    'Investigation decision differs from independently reconstructed evidence');
  return {ok:true, modelSha, outcome:decision.outcome};
}
