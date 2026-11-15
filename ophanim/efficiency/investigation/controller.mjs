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
const MAX_RECORDS = 32;
const MAX_ENTRIES = 64;
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
    estimates && Object.keys(estimates).every(key => ESTIMATE_KEYS.includes(key)), 'Exact scoped investigation forecast required');
  if (instrumentationCeilingMs !== undefined)
    requireThat(Number.isInteger(instrumentationCeilingMs) && instrumentationCeilingMs >= 1 && instrumentationCeilingMs <= 30000,
      'Instrumentation forecast exceeds fixed budget');
  return {...estimates, expectedConvergences:workload, sourceSha:digest({estimate, workload})};
}

export function planInvestigation({trace, registry, variables, findings, methods, economics, economicsByFinding, history = [],
  verifiedObservations = [], verifyObservation, advisorHypotheses, workload = 1, instrumentationCeilingMs = 30000} = {}) {
  const models = buildFunctionalModels({trace, registry, variables, verifiedObservations, verifyObservation});
  const inputs = {models, findings, economics:economics ?? {expectedConvergences:workload}, economicsByFinding, history, advisorHypotheses};
  if (methods === undefined) {
    // The first pass discovers supported attribution gaps. A method exists
    // only for observable differences between the alternatives it generated.
    const discovery = selectInvestigation(inputs);
    methods = discovery.candidates.filter(candidate => candidate.hypotheses.length > 1).map(candidate => ({
      id:`instrument.${candidate.questionSha.slice(0,16)}`, mode:'instrumentation',
      signals:[...new Set(candidate.hypotheses.flatMap(hypothesis => hypothesis.predictions.map(point => point.signal)))],
      estimatedCostMs:instrumentationCeilingMs, stop:{maxWallMs:30000, maxTrials:0, maxModelCalls:0},
      citations:['Reserved wall-time ceiling. Each span needs an independently checkable boundary before collection.'],
    }));
  }
  const decision = selectInvestigation({...inputs, methods});
  return {models, decision, workload};
}

function directory(dir) {
  fs.mkdirSync(dir, {recursive:true, mode:0o700});
  requireThat(fs.realpathSync(dir) === dir && fs.lstatSync(dir).isDirectory(), 'Canonical investigation evidence directory required');
  return dir;
}

function memoryDirectory(root, scope) {
  requireThat(path.isAbsolute(root) && path.resolve(root) === root && sha(scope), 'Exact investigation scope required');
  return path.join(root, 'scopes', scope, 'investigations');
}

function ownedRoot(root, stateDir) {
  const own = path.join(stateDir, 'efficiency');
  // A previous accepted state's private directory can supply comparison
  // evidence. It remains immutable during a fresh comparison.
  const previous = root !== own && path.basename(root) === 'efficiency' &&
    fs.existsSync(path.join(path.dirname(root), 'pantheon', 'refs', 'board', 'ophanim'));
  return previous ? own : root;
}

function readPacket(dir, id, scope) {
  requireThat(sha(id), 'Investigation evidence identifier differs');
  const file = path.join(dir, `${id}.json`);
  const stat = fs.lstatSync(file);
  requireThat(stat.isFile() && stat.size <= MAX_MEMORY_BYTES && fs.realpathSync(file) === file, 'Bounded canonical investigation evidence required');
  const packet = JSON.parse(fs.readFileSync(file, 'utf8'));
  requireThat(digest(packet) === id && packet.schema === MEMORY && packet.scopeSha === scope &&
    /^commit:[a-f0-9]{64}$/.test(packet.boardCommit) && sha(packet.traceSha) && path.isAbsolute(packet.stateDir) &&
    Array.isArray(packet.historyIds) && packet.historyIds.length <= MAX_RECORDS &&
    Array.isArray(packet.entries) && packet.entries.length <= 12, 'Retained investigation evidence differs');
  return packet;
}

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

function derive({trace, registry, variables, workload, traceTrusted, history, estimate}) {
  const fresh = traceTrusted && trace.original.convergence === 'accepted_change';
  const economics = fresh ? forecastEconomics(estimate, trace, workload) : undefined;
  const {models, decision} = planInvestigation({trace, registry, variables, workload, history, economics,
    instrumentationCeilingMs:fresh ? estimate?.instrumentationCeilingMs : undefined, ...fresh ? {} : {findings:[]}});
  if (fresh) return {modelSha:models.modelSha, decision};
  // A non-fresh, ambiguous or unsettled trace can describe the result but
  // cannot initiate research in the convergence path.
  const settled = trace.original.convergence === 'no_change';
  return {modelSha:models.modelSha, decision:{...decision, selected:null, candidates:[], historyEntries:[],
    outcome:settled ? 'no_change' : 'blocked', reason:settled ? 'no-new-accepted-evidence' : 'accepted-trace-binding-required'}};
}

export async function recordInvestigation({root, stateDir, trace, registry, variables, workload = 1, traceTrusted = false, estimate = null} = {}) {
  const started = performance.now();
  const cpuStart = process.cpuUsage();
  const traceSha = digest(trace);
  requireThat(trace.investigationEstimateSha === digest(estimate), 'Investigation forecast does not match retained trace');
  const evidenceRoot = ownedRoot(root, stateDir);
  const dir = memoryDirectory(evidenceRoot, trace.scopeSha);
  const make = ({modelSha, decision, historyIds, retained = null}) => {
    const cpu = process.cpuUsage(cpuStart);
    return {schema:RECEIPT, scopeSha:trace.scopeSha, traceSha, boardCommit:trace.boardCommit, modelSha, workload, estimate,
      evidenceRoot, historyIds, retained, decision, cost:{wallMs:performance.now()-started, cpuMicros:cpu.user+cpu.system}};
  };
  if (!traceTrusted || trace.original.convergence !== 'accepted_change') {
    return make({...derive({trace, registry, variables, workload, traceTrusted, history:[]}), historyIds:[]});
  }

  directory(dir);
  return withSeatLock('investigation', async () => {
    const names = fs.readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => name.slice(0,-5)).sort();
    requireThat(names.length <= MAX_RECORDS, 'Investigation evidence count bound');
    const packets = new Map(names.map(id => [id, readPacket(dir, id, trace.scopeSha)]));
    checkSources(packets);
    const existing = names.find(id => packets.get(id).boardCommit === trace.boardCommit) ?? null;
    const ownPacket = packets.get(existing);
    const historyIds = ownPacket ? ownPacket.historyIds : names;
    const history = historyIds.flatMap(id => packets.get(id).entries);
    const {modelSha, decision} = derive({trace, registry, variables, workload, traceTrusted, history, estimate});
    const entries = decision.historyEntries ?? [];
    if (ownPacket) {
      requireThat(ownPacket.traceSha === traceSha && ownPacket.workload === workload && canonical(ownPacket.estimate) === canonical(estimate) &&
        canonical(ownPacket.entries) === canonical(entries), 'Recovered investigation decision differs');
      return make({modelSha, decision, historyIds, retained:existing});
    }
    if (entries.length && (names.length === MAX_RECORDS || history.length + entries.length > MAX_ENTRIES)) {
      return make({modelSha, decision:{...decision, outcome:'blocked', selected:null, historyEntries:[], reason:'retained-evidence-capacity'}, historyIds});
    }
    const retained = entries.length ? writePacket(dir, {schema:MEMORY, scopeSha:trace.scopeSha, boardCommit:trace.boardCommit, traceSha, stateDir, workload, estimate, historyIds, entries}) : null;
    return make({modelSha, decision, historyIds, retained});
  }, {dir, timeoutMs:5000});
}

function checkSources(packets) {
  for (const [id, packet] of packets) {
    const stateDir = path.resolve(packet.stateDir);
    const file = path.join(stateDir,'efficiency','convergences',packet.boardCommit.replace(':','-'),'trace.json');
    const stat = fs.lstatSync(file);
    requireThat(stat.isFile() && stat.size <= 16 * 1024 * 1024 && fs.realpathSync(file) === file, 'Retained investigation source trace unavailable');
    const source = JSON.parse(fs.readFileSync(file,'utf8'));
    requireThat(digest(source) === packet.traceSha && source.scopeSha === packet.scopeSha && source.original.convergence === 'accepted_change' &&
      source.investigationEstimateSha === digest(packet.estimate) &&
      Number.isInteger(packet.workload) && packet.workload >= 1 && packet.workload <= source.policy.maxQualifiedConvergences &&
      !packet.historyIds.includes(id) && new Set(packet.historyIds).size === packet.historyIds.length &&
      packet.historyIds.every(previous => packets.has(previous)), 'Retained investigation source binding differs');
    verifyAdmissionTrace(source,readRuntimeSnapshot(stateDir,packet.boardCommit));
    const registry = buildContributionRegistry({trace:source});
    const variables = discoverVariables({trace:source,registry});
    const history = packet.historyIds.flatMap(previous => packets.get(previous).entries);
    const {decision} = derive({trace:source, registry, variables, workload:packet.workload, traceTrusted:true, history, estimate:packet.estimate});
    requireThat(canonical(decision.historyEntries) === canonical(packet.entries), 'Retained investigation history differs from source evidence');
  }
}

export function verifyInvestigationReceipt({receipt, trace, registry, variables, traceTrusted}) {
  requireThat(receipt?.schema === RECEIPT && receipt.scopeSha === trace.scopeSha && receipt.traceSha === digest(trace) && receipt.boardCommit === trace.boardCommit &&
    trace.investigationEstimateSha === digest(receipt.estimate) &&
    Number.isInteger(receipt.workload) && receipt.workload >= 1 && receipt.workload <= trace.policy.maxQualifiedConvergences &&
    Number.isFinite(receipt.cost?.wallMs) && receipt.cost.wallMs >= 0 && Number.isInteger(receipt.cost.cpuMicros) && receipt.cost.cpuMicros >= 0,
  'Investigation receipt binding differs');
  const dir = memoryDirectory(receipt.evidenceRoot, trace.scopeSha);
  const ids = receipt.historyIds;
  requireThat(Array.isArray(ids) && ids.length <= MAX_RECORDS && new Set(ids).size === ids.length && canonical(ids) === canonical([...ids].sort()), 'Bounded investigation history required');
  const packets = new Map(ids.map(id => [id, readPacket(dir, id, trace.scopeSha)]));
  checkSources(packets);
  const history = [...packets.values()].flatMap(packet => packet.entries);
  let {modelSha, decision} = derive({trace, registry, variables, workload:receipt.workload, traceTrusted, history, estimate:receipt.estimate});
  if (decision.historyEntries?.length && (ids.length === MAX_RECORDS || history.length + decision.historyEntries.length > MAX_ENTRIES)) {
    decision = {...decision, outcome:'blocked', selected:null, historyEntries:[], reason:'retained-evidence-capacity'};
  }
  const entries = decision.historyEntries ?? [];
  if (entries.length) {
    const retained = readPacket(dir, receipt.retained, trace.scopeSha);
    requireThat(retained.boardCommit === trace.boardCommit && retained.traceSha === receipt.traceSha &&
      retained.workload === receipt.workload && canonical(retained.estimate) === canonical(receipt.estimate) &&
      canonical({historyIds:ids, entries}) === canonical({historyIds:retained.historyIds, entries:retained.entries}), 'Retained investigation differs from decision');
  } else requireThat(receipt.retained === null, 'Unexpected retained investigation decision');
  requireThat(modelSha === receipt.modelSha && canonical(decision) === canonical(receipt.decision), 'Investigation decision differs from independently reconstructed evidence');
  return {ok:true, modelSha, outcome:decision.outcome};
}
