// Actual TELOS primitives, pinned to a reviewed commit. This adapter grants only
// synthetic fixture authority: its locally generated reviewers are not providers.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const TELOS_COMMIT = '0c9b539ddbb08e1464603faf786e0d5cdfc33fb8';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE_SIGNER = 'fixture-node-controller';
const REVIEWERS = ['claude', 'agy', 'codex'];
const DOMAIN = 'ophanim.fixture.release-decision/v1\n';
const EFFICIENCY_DOMAIN = 'ophanim.fixture.scheduler-decision/v1\n';
const TELOS_PINS = Object.freeze({
  'build-gate/check-registry.mjs': '3abf5bf0c430987aec6d2ed2f671e8a07444a4d74eaeb36c001aaac0cbdf55b9',
  'build-gate/concerns.mjs': 'f264abdfeca4b93cc282570f7c13aa62cc37a90f5a8903defdb8a2a16224b647',
  'build-gate/proposal-gate.mjs': '8b441983ee692f9f445ddb6af09e8f5dac6850c71aa0f9b9be497b0c55ebc2a3',
  'build-gate/proposal-recorder.mjs': '88dcc31d3b1f44ffc56ff698302427de7c4a9e2133949089be6f74ebab5f20b9',
  'build-gate/sign.mjs': 'ca3b01d37ea733d24e6d607e812918b6cd197fa5d3bd4a69f8deac4044d73ad7',
  'merkle-dag/artifact.mjs': '9091e1cc56e3ff9efa91d6d4a94e382c5d15784c61b9cfc1db7899804283dce3',
  'merkle-dag/crypto.mjs': 'eccaed05167dfd46f9e5d7d6783c76928ec29d218f0cccbd9a94d2b89d5fe47d',
  'merkle-dag/ledger-gate.mjs': '49e543edbe0336ec32aaf59ecc4eaec96c3f42f9214a7bfe77a40fd0b31dd23d',
  'merkle-dag/merkle.mjs': 'd354181df9b2c896389eae71f97155a944f9af766ddc840f5a7fd638b50d9353',
  'merkle-dag/obligation.mjs': '3f54162b4cac06c827ace282c308b9fc35e9e1487553fbd427d2929d5fd7cae8',
  'merkle-dag/planner.mjs': '82ed0ad66788a7ab4d65c9654eea5fa1187d82a9d9b109a99c4fe2b017b4dedf',
  'merkle-dag/proposal-ledger.mjs': '8da512094966fe0c6121c303d70df870ac443530685f68d647a600005041cc5a',
  'merkle-dag/vendor.mjs': '082dc2b3f40e11637729e7a3503e19fc7fe0cc43310cb889c4e856eebb15e7ab',
});
const CHECK_PINS = Object.freeze({
  'check-contract.mjs': 'fe6429a9908b568c52f137fe7138fee52f0250aad74c8fbd175323706b9e0279',
  'check-artifact.mjs': 'ddfa339af1d3e446753c3b0c14a574df64a613056c9a63f81791928abd98ec8e',
  'check-release.mjs': 'a22b624442b5cb5c6ab23708a4978cb7f85e291ae3a08c5b9bddac835053dbde',
});
const EFFICIENCY_PINS = Object.freeze({
  'check-efficiency.mjs': 'd9fbc14848bf59ab0eaa911c9e572e04fe50dd7139c1949919a9f2bd7abc2d2b',
  'check-efficiency-artifact.mjs': '347379745549553339e4507fb0beabb06f59a76a6eda70b5e2520e548fdb054e',
});
const checksFor = request => request.obligation.kind==='synthetic-efficiency' ? {legacy:CHECK_PINS,efficiency:EFFICIENCY_PINS} : CHECK_PINS;
const rawHash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = text => { throw Error(text); };
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const refHex = ref => typeof ref === 'string' && /^sha256:[a-f0-9]{64}$/.test(ref) ? ref.slice(7) : fail('Exact plan reference required');

function regular(file, max = 1048576) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max || fs.realpathSync(file) !== file) fail('Canonical bounded regular file required');
  return fs.readFileSync(file);
}
function directory(dir) {
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  if (!fs.lstatSync(dir).isDirectory() || fs.realpathSync(dir) !== dir) fail('Canonical fixture directory required');
}
function writeOnce(file, bytes) {
  const value = Buffer.from(bytes);
  if (fs.existsSync(file)) {
    if (!regular(file).equals(value)) fail('Immutable governance record differs');
    return;
  }
  directory(path.dirname(file));
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export async function createGovernance({root, telosRoot, telosCommit = TELOS_COMMIT, fixtureOnly = true, readOnly = false} = {}) {
  if (typeof telosRoot !== 'string' || !path.isAbsolute(telosRoot)) fail('Explicit absolute TELOS checkout required: set OPHANIM_TELOS_ROOT or pass telosRoot');
  if (fixtureOnly !== true || telosCommit !== TELOS_COMMIT || !path.isAbsolute(root ?? '')) fail('Explicit absolute fixture root and pinned TELOS commit required');
  root = path.resolve(root); telosRoot = path.resolve(telosRoot);
  if (root === HERE || root.startsWith(HERE + path.sep)) fail('Fixture state cannot overwrite implementation source');
  const state = path.join(root, 'governance');
  const assertPins = () => {
    for (const [rel, sha] of Object.entries(TELOS_PINS)) if (rawHash(regular(path.join(telosRoot, rel))) !== sha) fail('Pinned TELOS source changed: ' + rel);
    for (const [rel, sha] of Object.entries(CHECK_PINS)) if (rawHash(regular(path.join(HERE, 'governance', rel))) !== sha) fail('Pinned local verifier changed: ' + rel);
    for (const [rel, sha] of Object.entries(EFFICIENCY_PINS)) if (rawHash(regular(path.join(HERE, 'governance', rel))) !== sha) fail('Pinned scheduler verifier changed: ' + rel);
  };
  assertPins();
  const own = await import(pathToFileURL(path.join(HERE, 'governance/check-contract.mjs')).href);
  const releaseCheck = await import(pathToFileURL(path.join(HERE, 'governance/check-release.mjs')).href);
  const efficiencyCheck = await import(pathToFileURL(path.join(HERE, 'governance/check-efficiency.mjs')).href);
  const {canonical, hash, validateRequest:validateLegacyRequest} = own;
  const validateRequest = request => request.obligation?.kind==='synthetic-efficiency' ? efficiencyCheck.validateEfficiencyRequest(request) : validateLegacyRequest(request);
  const load = rel => import(pathToFileURL(path.join(telosRoot, rel)).href);
  const [planner, merkle, keys, artifact, gate, proposal, recorder, lifecycle, signatures] = await Promise.all([
    load('merkle-dag/planner.mjs'), load('merkle-dag/merkle.mjs'), load('merkle-dag/crypto.mjs'),
    load('merkle-dag/artifact.mjs'), load('merkle-dag/ledger-gate.mjs'), load('merkle-dag/proposal-ledger.mjs'),
    load('build-gate/proposal-recorder.mjs'), load('build-gate/proposal-gate.mjs'), load('build-gate/sign.mjs'),
  ]);
  if (readOnly) {
    if (!fs.lstatSync(state).isDirectory() || fs.realpathSync(state) !== state) fail('Existing canonical fixture state required');
  } else directory(state);
  const json = file => JSON.parse(regular(file));
  const once = (file, value) => writeOnce(file, canonical(value));
  const authorityFile = path.join(state, 'fixture-authority.json');
  if (!fs.existsSync(authorityFile) && readOnly) fail('Existing fixture authority required for read-only verification');
  if (!fs.existsSync(authorityFile)) once(authorityFile, {
    schema: 'ophanim.fixture.authority/v1', fixtureOnly: true, telosCommit,
    proposal: keys.generateKeypair(), node: keys.generateKeypair(), operator: keys.generateKeypair(),
    reviewSecrets: Object.fromEntries(REVIEWERS.map(seat => [seat, crypto.randomBytes(32).toString('hex')])),
  });
  const authority = json(authorityFile);
  if ((fs.statSync(authorityFile).mode & 0o077) !== 0 || authority.schema !== 'ophanim.fixture.authority/v1' || authority.fixtureOnly !== true || authority.telosCommit !== telosCommit) fail('Private fixture authority identity refused');
  for (const kind of ['proposal', 'node', 'operator']) {
    const actual = crypto.createPublicKey(crypto.createPrivateKey(authority[kind].privatePem)).export({format: 'jwk'});
    if (canonical(actual) !== canonical(authority[kind].publicJwk)) fail('Fixture key pair differs');
  }
  const authoritySha = hash({proposal: authority.proposal.publicJwk, node: authority.node.publicJwk, operator: authority.operator.publicJwk});
  const binding = {schema: 'ophanim.fixture.governance/v1', authoritySha, telosCommit, sources: TELOS_PINS, checkers: CHECK_PINS, node: fs.realpathSync(process.execPath), fixtureOnly: true};
  if (readOnly) {
    if (canonical(json(path.join(state, 'binding.json'))) !== canonical(binding)) fail('Existing governance binding differs');
  } else once(path.join(state, 'binding.json'), binding);
  const checker = path.join(HERE, 'governance/check-artifact.mjs');
  const node = fs.realpathSync(process.execPath);
  const signerFor = id => id === proposal.PROPOSAL_KEY_ID ? authority.proposal.privatePem : id === NODE_SIGNER ? authority.node.privatePem : fail('Unknown fixture signer');
  const normalize = ({candidate, obligation, worker, evidence}) => JSON.parse(canonical({
    candidate: {id: candidate.id, sha256: candidate.sha256, output: candidate.output}, obligation, worker, evidence,
  }));
  const obligationFile = id => path.join(state, 'obligations', hash(id) + '.json');
  const acceptedFile = id => path.join(state, 'accepted', hash(id) + '.json');
  const planFile = ref => path.join(state, 'refs', refHex(ref) + '.json');
  const pathsFor = requestSha => ({workspace: path.join(state, 'runs', requestSha), telosDir: path.join(state, 'runs', requestSha, '.telos')});

  function compile(request, requestSha, workspace) {
    const proposalId = 'fixture-' + requestSha;
    const checks=checksFor(request),executable=request.obligation.kind==='synthetic-efficiency'?path.join(HERE,'governance/check-efficiency-artifact.mjs'):checker;
    const tasks = [{id: 'result', writes: ['artifacts/output.json'], reads: [], requirements: canonical({requestSha, obligation: request.obligation, fixtureOnly: true}), test: {cmd: node, args: [executable, 'inputs/request.json', 'artifacts/output.json', requestSha]}}];
    const defs = tasks.map(t => ({id: t.id, files: t.writes, requirements: t.requirements, test: t.test, dependencies: []}));
    const lifecycleBinding = {contract_ref: 'sha256:' + hash(checks), proposal_id: proposalId, predecessor_plan_hash: null, ...planner.assignNodeLineages(defs, {proposalId})};
    const compiled = planner.compileAndHashPlan({tasks, authorizedSigners: {[proposal.PROPOSAL_KEY_ID]: authority.proposal.publicJwk, [NODE_SIGNER]: authority.node.publicJwk}, repoRoot: workspace, strict: true,
      lifecycle: lifecycleBinding, obligations: [{obligation_id: 'fixture-required-result', concern_ref: 'sha256:' + hash(request.obligation), required_result: 'pass', check_contract_ref: 'sha256:' + hash(checks), discharge_node_id: 'result'}]});
    if (compiled.errors) fail('TELOS compilation refused: ' + canonical(compiled.errors));
    return compiled.plan;
  }

  function checkPackets(telosDir, planRef) {
    const packets = json(path.join(telosDir, 'fixture-review-packets.json'));
    if (!Array.isArray(packets) || packets.length !== REVIEWERS.length) fail('Required fixture reviewer missing');
    for (const seat of REVIEWERS) {
      const matches = packets.filter(p => p.model === seat);
      if (matches.length !== 1 || matches[0].decision !== 'approve' || matches[0].proposal_ref !== planRef || matches[0].required_edits.length || matches[0].fixtureOnly !== true || !signatures.verifyPacket(matches[0], authority.reviewSecrets[seat]).ok) fail('Signed fixture review refused');
    }
    const result = lifecycle.validateProposalLifecycle({telosDir, packets, requiredModels: REVIEWERS, signed: true, forceSignedDisjointness: true, baseDir: path.dirname(telosDir), nowMs: 0});
    if (!result.ok) fail('TELOS lifecycle refused: ' + result.blockers.join('; '));
    return {...result, checks: {...result.checks, packet_signatures: 'pass'}};
  }

  function checkAuthorization(telosDir, planRef) {
    const result = checkPackets(telosDir, planRef);
    const history = proposal.readProposalEvents(telosDir);
    if (history.errors.length || !proposal.verifyProposalChain(history.events, authority.proposal.publicJwk).ok) fail('Signed proposal history refused');
    const decision = proposal.latestDecisionForPlan(history.events, planRef);
    if (!decision || decision.decision !== 'authorized') fail('Exact plan is not authorized');
    const certificate = proposal.readProposalArtifact(telosDir, decision.policy_result_ref);
    if (!proposal.verifyAuthorizationResult(certificate, {planHash: planRef}).ok || canonical(certificate.checks) !== canonical(result.checks)) fail('Authorization certificate differs from reconstructed checks');
    return {proposalHead: proposal.proposalEventHash(history.events.at(-1)), policyResultRef: decision.policy_result_ref};
  }

  function prepareAuthorization(paths, plan, requestSha, request) {
    const ledgerFile = path.join(paths.telosDir, 'proposal.jsonl');
    if (fs.existsSync(ledgerFile)) {
      const bytes = regular(ledgerFile);
      if (bytes.length && bytes.at(-1) !== 10) fail('Incomplete proposal record requires inspection');
    }
    const history = proposal.readProposalEvents(paths.telosDir);
    if (history.errors.length || history.events.length > 7 || history.events.length && !proposal.verifyProposalChain(history.events, authority.proposal.publicJwk, {proposalId: plan.lifecycle.proposal_id}).ok) fail('Signed proposal history refused before recovery');
    const rec = recorder.makeProposalRecorder({telosDir: paths.telosDir, signerFor, proposalId: plan.lifecycle.proposal_id});
    const expected = [];
    const event = fields => {
      const next = proposal.makeProposalEvent({
        proposal_id: plan.lifecycle.proposal_id, sequence: expected.length + 1,
        stage: fields.stage, plan_hash: fields.plan_hash ?? null,
        parent_event_hash: expected.length ? proposal.proposalEventHash(expected.at(-1)) : null,
        artifact_refs: fields.artifact_refs ?? [], actor: fields.actor ?? {seat: 'controller', role: 'controller'},
        provenance: fields.provenance ?? null, policy_result: null, recorded_at: null, ...fields,
      }, authority.proposal.privatePem);
      expected.push(next);
      const existing = history.events[expected.length - 1];
      if (existing && canonical(existing) !== canonical(next)) fail('Signed proposal prefix differs from the fixed fixture initialization');
      return next;
    };
    event({stage: 'draft', artifact_refs: [rec.writeArtifact({kind: 'synthetic-input', requestSha, fixtureOnly: true}).ref]});
    event({stage: 'negotiation', actor: {seat: 'fixture-planner', role: 'planning'}, provenance: {provider: 'fixture-local', response_id: 'fixture-creation-' + requestSha}});
    event({stage: 'candidate', plan_hash: plan.plan_hash});
    const packets = REVIEWERS.map(seat => {
      const review = recorder.buildReviewManifest({telosDir: paths.telosDir, planHash: plan.plan_hash, seat, role: 'approver', reviewContract: {schema: 'ophanim.fixture.review/v1', fixtureOnly: true, checkers: checksFor(request)}, baseDir: paths.workspace, evidenceFiles: [{path: 'inputs/request.json', kind: 'evidence'}, {path: 'inputs/candidate-plan.json', kind: 'candidate-plan'}]});
      const provenance = {provider: 'fixture-local', response_id: 'fixture-review-' + seat + '-' + requestSha};
      event({stage: 'review', actor: {seat, role: 'approver'}, provenance, artifact_refs: [review.manifest_ref], review_input_hash: review.review_input_hash});
      return signatures.signPacket({model: seat, proposal_ref: plan.plan_hash, decision: 'approve', required_edits: [], provenance, fixtureOnly: true}, authority.reviewSecrets[seat]);
    });
    // Validate the entire available prefix before extending it. TELOS rereads
    // and verifies the chain under its lock; an intervening writer cannot cause
    // this recovery to append a duplicate stage or extend a different head.
    const append = next => proposal.atomicAppendProposalEvent(paths.telosDir, (parent, sequence) => {
      if (parent !== next.parent_event_hash || sequence !== next.sequence) fail('Proposal head changed during fixture recovery');
      return next;
    }, {publicJwk: authority.proposal.publicJwk});
    const packetFile = path.join(paths.telosDir, 'fixture-review-packets.json');
    if (fs.existsSync(packetFile) && canonical(json(packetFile)) !== canonical(packets)) fail('Retained fixture review packets differ');
    for (const next of expected.slice(history.events.length)) append(next);
    once(packetFile, packets);
    const checked = checkPackets(paths.telosDir, plan.plan_hash);
    const revision = {index: 1, maximum: 1};
    const outcome = proposal.deriveOutcome(checked.checks, checked.blockers, checked.findings, revision);
    if (outcome !== 'authorized') fail('Fixture proposal not authorized');
    const certificate = {policy_contract_ref: proposal.POLICY_CONTRACT_V1, plan_hash: plan.plan_hash, outcome, checks: checked.checks, blockers: checked.blockers, findings: checked.findings, revision};
    const policyRef = rec.writeArtifact(certificate).ref;
    const decision = event({stage: 'decision', plan_hash: plan.plan_hash, artifact_refs: [policyRef], decision: outcome, policy_result_ref: policyRef});
    if (history.events.length < expected.length) append(decision);
    checkAuthorization(paths.telosDir, plan.plan_hash);
  }

  function prepare(request) {
    validateRequest(request);
    once(obligationFile(request.obligation.id), request.obligation);
    const requestSha = hash(request), paths = pathsFor(requestSha), plan = compile(request, requestSha, paths.workspace);
    directory(paths.telosDir);
    const entry = {requestSha, planRef: plan.plan_hash, authoritySha, telosCommit, fixtureOnly: true};
    once(path.join(paths.workspace, 'inputs/request.json'), request);
    once(path.join(paths.workspace, 'inputs/candidate-plan.json'), plan);
    once(path.join(paths.telosDir, 'plans', plan.plan_hash.replace(':', '_') + '.json'), plan);
    once(path.join(paths.telosDir, 'plan.json'), plan);
    once(planFile(plan.plan_hash), entry);
    prepareAuthorization(paths, plan, requestSha, request);
    return {request, requestSha, paths, plan};
  }

  function verifyOne(planRef, ancestors = new Set()) {
    assertPins();
    if (ancestors.size >= 128 || ancestors.has(planRef)) fail('Governance dependency cycle or depth bound');
    const next = new Set([...ancestors, planRef]);
    const entry = json(planFile(planRef));
    if (!hex(entry.requestSha) || entry.planRef !== planRef || entry.authoritySha !== authoritySha || entry.telosCommit !== telosCommit) fail('Governance plan binding differs');
    const paths = pathsFor(entry.requestSha), bytes = regular(path.join(paths.workspace, 'inputs/request.json'));
    if (rawHash(bytes) !== entry.requestSha) fail('Immutable request changed');
    const request = JSON.parse(bytes); validateRequest(request);
    if (canonical(json(obligationFile(request.obligation.id))) !== canonical(request.obligation)) fail('Registered obligation changed');
    for (const dependency of request.evidence.dependencyVersions) {
      const accepted = json(acceptedFile(dependency.id));
      const proof = verifyOne(accepted.planRef, next);
      if (accepted.candidateSha !== dependency.sha256 || proof.candidateSha !== accepted.candidateSha || proof.obligationId !== dependency.id || proof.obligationSha !== accepted.obligationSha) fail('Accepted dependency differs');
    }
    const expected = compile(request, entry.requestSha, paths.workspace);
    const stored = merkle.readPlan(paths.telosDir);
    if (expected.plan_hash !== planRef || canonical(stored) !== canonical(expected) || canonical(json(path.join(paths.workspace, 'inputs/candidate-plan.json'))) !== canonical(expected) || canonical(json(path.join(paths.telosDir, 'plans', planRef.replace(':', '_') + '.json'))) !== canonical(expected)) fail('Stored TELOS plan differs from its fixed executable contract');
    const authorization = checkAuthorization(paths.telosDir, planRef);
    // Reject torn/extra ledger records instead of inheriting TELOS's tolerant reader.
    const lines = regular(path.join(paths.telosDir, 'ledger.jsonl')).toString().trim().split('\n');
    if (lines.length !== 1) fail('Exactly one signed node receipt required');
    const receipt = JSON.parse(lines[0]);
    if (receipt.task_id !== 'result' || receipt.key_id !== NODE_SIGNER || !keys.verifyTransaction(receipt, authority.node.publicJwk)) fail('Signed node receipt refused');
    // Only the reconstructed, pinned checker can reach this real TELOS verifier.
    const verification = gate.verify(paths.telosDir, {baseDir: paths.workspace});
    if (verification.merge_status !== 'ready') fail('TELOS final verification refused: ' + (verification.reason ?? verification.blockers.join('; ')));
    return {ok: true, fixtureOnly: true, planRef, verification, authorization, candidateSha: request.candidate.sha256, obligationId: request.obligation.id, obligationSha: hash(request.obligation), ...(request.efficiencyEvaluation?{efficiency:request.efficiencyEvaluation}:{}), evidenceRefs: [planRef, 'sha256:' + entry.requestSha, 'sha256:' + hash(receipt)], paths: {plan: path.join(paths.telosDir, 'plan.json'), ledger: path.join(paths.telosDir, 'ledger.jsonl')}};
  }

  async function verifyCandidate(input) {
    try {
      if (readOnly) fail('Read-only governance cannot accept candidates');
      assertPins();
      const request = normalize(input); validateRequest(request);
      if (request.obligation.kind === 'synthetic-release') request.releaseEvaluation = await releaseCheck.evaluateRelease(request);
      if (request.obligation.kind === 'synthetic-efficiency') {
        if (request.obligation.inputs.governanceContractSha !== hash(CHECK_PINS) || request.obligation.inputs.telosRoot !== telosRoot) fail('Scheduler verifier configuration differs');
        request.efficiencyEvaluation = await efficiencyCheck.evaluateEfficiency({policy:request.candidate.output,...request.obligation.inputs});
        if (!request.efficiencyEvaluation.eligible) return {ok:false,fixtureOnly:true,convergence:'no_change',reason:request.efficiencyEvaluation.blockers.join('; '),efficiency:request.efficiencyEvaluation,evidenceRefs:[]};
      }
      for (const dependency of request.evidence.dependencyVersions) {
        const accepted = json(acceptedFile(dependency.id));
        const proof = verifyOne(accepted.planRef);
        if (accepted.candidateSha !== dependency.sha256 || proof.candidateSha !== accepted.candidateSha || proof.obligationId !== dependency.id || proof.obligationSha !== accepted.obligationSha) fail('Dependency is not accepted at this version');
      }
      const {paths, plan} = prepare(request);
      once(path.join(paths.workspace, 'artifacts/output.json'), request.candidate.output);
      const ledgerFile = path.join(paths.telosDir, 'ledger.jsonl');
      if (!fs.existsSync(ledgerFile)) {
        const tree = artifact.computeDiskTreeHash(plan.nodes[0].files, paths.workspace);
        const receipt = keys.makeRecord({task_id: 'result', effective_hash: plan.nodes[0].effective_hash, artifact_tree_hash: tree.tree_hash, artifact_files: tree.files}, NODE_SIGNER, authority.node.privatePem);
        keys.appendLedger(ledgerFile, receipt);
      }
      const proof = verifyOne(plan.plan_hash);
      const accepted = {obligationSha: hash(request.obligation), candidateSha: request.candidate.sha256, planRef: plan.plan_hash};
      const file = acceptedFile(request.obligation.id);
      if (fs.existsSync(file)) {
        const old = json(file);
        if (old.obligationSha !== accepted.obligationSha || old.candidateSha !== accepted.candidateSha) fail('Accepted obligation outcome cannot be overwritten');
      } else once(file, accepted);
      return proof;
    } catch (error) { return {ok: false, fixtureOnly: true, reason: error.message, evidenceRefs: []}; }
  }

  async function verifyPlan({planRef} = {}) {
    try {
      if (planRef) return verifyOne(planRef);
      const directory = path.join(state, 'refs');
      const files = fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
      if (files.length < 1 || files.length > 4096) fail('Bounded nonempty plan collection required');
      const plans = files.map(name => { if (!/^[a-f0-9]{64}\.json$/.test(name)) fail('Unexpected plan reference'); return verifyOne('sha256:' + name.slice(0, -5)); });
      return {ok: true, fixtureOnly: true, plans, verifiedPlans: plans.length};
    } catch (error) { return {ok: false, fixtureOnly: true, reason: error.message}; }
  }

  async function authorizePlan({id, nodes} = {}) {
    if (readOnly) fail('Read-only governance cannot authorize plans');
    assertPins();
    if (typeof id !== 'string' || !id || !Array.isArray(nodes) || nodes.length < 1 || nodes.length > 4096 || new Set(nodes.map(n => n.id)).size !== nodes.length) fail('Bounded synthetic obligation registry required');
    for (const obligation of nodes) once(obligationFile(obligation.id), obligation);
    const registry = {id, nodes, fixtureOnly: true, telosCommit};
    const registryRef = 'sha256:' + hash(registry);
    once(path.join(state, 'registries', refHex(registryRef) + '.json'), registry);
    return {ok: true, fixtureOnly: true, registryRef, standing: 'Fixture input registry; each candidate still requires signed TELOS lifecycle and final verification.'};
  }

  function decisionBody(input) {
    const planRef = input.planRef ?? input.evidenceRefs?.find(ref => typeof ref === 'string' && /^sha256:[a-f0-9]{64}$/.test(ref) && fs.existsSync(planFile(ref)));
    const proof = verifyOne(planRef);
    const entry = json(planFile(planRef)), request = json(path.join(pathsFor(entry.requestSha).workspace, 'inputs/request.json'));
    const release = request.candidate.output;
    if (request.obligation.kind !== 'synthetic-release' || !['activate', 'rollback'].includes(input.kind) || typeof input.fromRelease !== 'string' || !input.fromRelease || typeof input.toRelease !== 'string' || !input.toRelease || input.fromRelease === input.toRelease || release.id !== input.toRelease || release.artifactSha !== input.artifactSha || release.stateSchema !== input.stateSchema || canonical(release.workers) !== canonical(input.workers)) fail('Release decision differs from accepted synthetic release');
    if (!Array.isArray(input.evidenceRefs) || !input.evidenceRefs.length || input.evidenceRefs.length > 64 || input.evidenceRefs.some(x => typeof x !== 'string' || x.length > 512)) fail('Bounded release evidence references required');
    return {schema: 'ophanim.fixture.release-decision/v1', fixtureOnly: true, authoritySha, telosCommit, kind: input.kind, planRef, fromRelease: input.fromRelease, toRelease: input.toRelease, artifactSha: input.artifactSha, stateSchema: input.stateSchema, workers: release.workers, evidenceRefs: [...new Set(input.evidenceRefs)].sort(), verificationSha: hash(proof.verification), releaseEvaluationSha: hash(request.releaseEvaluation)};
  }
  async function issueActivationDecision(input) {
    if (readOnly) fail('Read-only governance cannot issue decisions');
    assertPins();
    const body = decisionBody(input), decisionId = 'sha256:' + hash(body);
    const signature = crypto.sign(null, Buffer.from(DOMAIN + canonical(body)), authority.operator.privatePem).toString('base64');
    const decision = {body, decisionId, signature};
    once(path.join(state, 'decisions', refHex(decisionId) + '.json'), decision);
    return decision;
  }
  async function verifyActivationDecision({decision, expected} = {}) {
    try {
      assertPins();
      if (!decision || !expected || decision.decisionId !== 'sha256:' + hash(decision.body) || canonical(json(path.join(state, 'decisions', refHex(decision.decisionId) + '.json'))) !== canonical(decision)) fail('Release decision identity differs');
      const signature = Buffer.from(decision.signature, 'base64');
      if (signature.length !== 64 || signature.toString('base64') !== decision.signature || !crypto.verify(null, Buffer.from(DOMAIN + canonical(decision.body)), crypto.createPublicKey({key: authority.operator.publicJwk, format: 'jwk'}), signature)) fail('Fixture operator signature refused');
      if (canonical(decision.body) !== canonical(decisionBody(decision.body))) fail('Release decision reconstruction differs');
      for (const name of ['kind', 'fromRelease', 'toRelease', 'artifactSha', 'stateSchema']) if (expected[name] !== decision.body[name]) fail('Expected release binding differs: ' + name);
      if (canonical(expected.workers) !== canonical(decision.body.workers)) fail('Expected release worker registry differs');
      if (expected.planRef !== undefined && expected.planRef !== decision.body.planRef) fail('Expected release plan differs');
      return {ok: true, fixtureOnly: true, decisionId: decision.decisionId, planRef: decision.body.planRef, kind: decision.body.kind};
    } catch (error) { return {ok: false, fixtureOnly: true, reason: error.message}; }
  }
  async function verifyEfficiencyCandidate({candidate,evidenceRoot} = {}) {
    try {
      efficiencyCheck.validateEfficiencyPolicy(candidate);
      const id='efficiency:'+hash(candidate);
      return await verifyCandidate({
        candidate:{id:id+':1',sha256:hash(candidate),output:candidate,checks:[]},
        obligation:{id,kind:'synthetic-efficiency',scope:'fixture-scheduler',inputs:{evidenceRoot,telosRoot,governanceContractSha:hash(CHECK_PINS)},dependsOn:[],outputKey:id,expected:candidate,maxAttempts:1},
        worker:{id:'fixture-scheduler-proposer',version:'1',kinds:['synthetic-efficiency'],scopes:['fixture-scheduler']},
        evidence:{attempt:1,dependencyVersions:[],stateSchema:'ophanim.runtime/v1'},
      });
    } catch(error) {return {ok:false,fixtureOnly:true,convergence:'blocked',reason:error.message,evidenceRefs:[]};}
  }
  function retainedEfficiencyProof(planRef) {
    const entry=json(planFile(planRef));
    if(!hex(entry.requestSha)||entry.planRef!==planRef||entry.authoritySha!==authoritySha||entry.telosCommit!==telosCommit)fail('Scheduler proof identity differs');
    const paths=pathsFor(entry.requestSha),bytes=regular(path.join(paths.workspace,'inputs/request.json'));
    if(rawHash(bytes)!==entry.requestSha)fail('Scheduler signed request changed');
    const request=JSON.parse(bytes);efficiencyCheck.validateEfficiencyRequest(request);
    if(canonical(json(obligationFile(request.obligation.id)))!==canonical(request.obligation))fail('Scheduler obligation changed');
    const expected=compile(request,entry.requestSha,paths.workspace);
    if(expected.plan_hash!==planRef||canonical(merkle.readPlan(paths.telosDir))!==canonical(expected)||canonical(json(path.join(paths.workspace,'inputs/candidate-plan.json')))!==canonical(expected)||canonical(json(path.join(paths.telosDir,'plans',planRef.replace(':','_')+'.json')))!==canonical(expected))fail('Scheduler signed executable contract changed');
    checkAuthorization(paths.telosDir,planRef);
    const lines=regular(path.join(paths.telosDir,'ledger.jsonl')).toString().trim().split('\n');
    if(lines.length!==1)fail('Exactly one scheduler receipt required');
    const receipt=JSON.parse(lines[0]),tree=artifact.computeDiskTreeHash(expected.nodes[0].files,paths.workspace);
    if(receipt.task_id!=='result'||receipt.key_id!==NODE_SIGNER||receipt.effective_hash!==expected.nodes[0].effective_hash||receipt.artifact_tree_hash!==tree.tree_hash||!keys.verifyTransaction(receipt,authority.node.publicJwk)||canonical(json(path.join(paths.workspace,'artifacts/output.json')))!==canonical(request.candidate.output))fail('Scheduler signed artifact receipt changed');
    const manifestBytes=regular(path.join(request.obligation.inputs.evidenceRoot,'manifest.json'),8*1024*1024);
    if(rawHash(manifestBytes)!==request.candidate.output.evidenceSha)fail('Scheduler replay manifest changed');
    efficiencyCheck.verifyEfficiencySources(JSON.parse(manifestBytes).policy);
    return {efficiency:request.efficiencyEvaluation,evidenceRefs:[planRef,'sha256:'+entry.requestSha,'sha256:'+hash(receipt)]};
  }
  function efficiencyDecisionBody(input,{replayEvidence=true}={}) {
    const proof=replayEvidence?verifyOne(input.planRef):retainedEfficiencyProof(input.planRef),entry=json(planFile(input.planRef));
    const request=json(path.join(pathsFor(entry.requestSha).workspace,'inputs/request.json'));
    if(request.obligation.kind!=='synthetic-efficiency'||!proof.efficiency?.eligible||input.fromSlots!==1||input.toSlots!==3||input.release!=='baseline'||input.scopeSha!==request.candidate.output.scopeSha||canonical(input.policy)!==canonical(request.candidate.output)||!Array.isArray(input.evidenceRefs)||canonical(input.evidenceRefs)!==canonical(proof.evidenceRefs))fail('Scheduler decision differs from independently admitted policy');
    return {schema:'ophanim.fixture.scheduler-decision/v1',fixtureOnly:true,authoritySha,telosCommit,planRef:input.planRef,policy:request.candidate.output,scopeSha:input.scopeSha,fromSlots:1,toSlots:3,release:'baseline',evidenceRefs:proof.evidenceRefs,evaluationSha:hash(proof.efficiency)};
  }
  async function issueEfficiencyDecision(input) {
    if(readOnly)fail('Read-only governance cannot issue scheduler decisions');
    assertPins();
    const body=efficiencyDecisionBody(input),decisionId='sha256:'+hash(body);
    const signature=crypto.sign(null,Buffer.from(EFFICIENCY_DOMAIN+canonical(body)),authority.operator.privatePem).toString('base64');
    const decision={body,decisionId,signature};
    once(path.join(state,'decisions',refHex(decisionId)+'.json'),decision);
    return decision;
  }
  async function verifyEfficiencyDecision({decision,expected,replayEvidence=false}={}) {
    try {
      assertPins();
      if(!decision||!expected||decision.decisionId!=='sha256:'+hash(decision.body)||canonical(json(path.join(state,'decisions',refHex(decision.decisionId)+'.json')))!==canonical(decision))fail('Scheduler decision identity differs');
      const signature=Buffer.from(decision.signature,'base64');
      if(signature.length!==64||signature.toString('base64')!==decision.signature||!crypto.verify(null,Buffer.from(EFFICIENCY_DOMAIN+canonical(decision.body)),crypto.createPublicKey({key:authority.operator.publicJwk,format:'jwk'}),signature))fail('Scheduler operator signature refused');
      if(canonical(decision.body)!==canonical(efficiencyDecisionBody(decision.body,{replayEvidence})))fail('Scheduler decision reconstruction differs');
      for(const field of ['planRef','policy','scopeSha','fromSlots','toSlots','release','evidenceRefs'])if(canonical(expected[field])!==canonical(decision.body[field]))fail('Expected scheduler decision differs: '+field);
      return {ok:true,fixtureOnly:true,decisionId:decision.decisionId,planRef:decision.body.planRef,policy:decision.body.policy,replayEvidence};
    } catch(error) {return {ok:false,fixtureOnly:true,reason:error.message};}
  }
  return Object.freeze({verifyCandidate, verifyPlan, authorizePlan, issueActivationDecision, verifyActivationDecision, verifyEfficiencyCandidate, issueEfficiencyDecision, verifyEfficiencyDecision, identity: Object.freeze({fixtureOnly: true, telosCommit, authoritySha, governanceContractSha:hash(CHECK_PINS), stateRoot: state})});
}
