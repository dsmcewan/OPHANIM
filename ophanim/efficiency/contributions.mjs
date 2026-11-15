// An inspected implementation map, not a plugin loader or an optimization
// authority. Source links are relative to the repository root. Measurements
// refer to the supplied trace; shared measurements must not be added together.
import {canonical,digest,clone} from '../board.mjs';
import {analyzeTrace} from './analyze.mjs';

const source=(path,symbol)=>({path,symbol,href:`./${path}`,relativeTo:'repository-root'});
const runtime=symbol=>source('ophanim/runtime.mjs',symbol);
const governance=symbol=>source('ophanim/governance.mjs',symbol);
const fixture=symbol=>source('ophanim/fixtures.mjs',symbol);
const assessment=symbol=>source('ophanim/efficiency/assessment.mjs',symbol);
const COMPONENTS=[
  {id:'acceptance-contract',purpose:'Define which outputs and dependency versions count as completing each obligation.',mechanismClass:'immutable-acceptance',
    contract:{inputs:['typed immutable obligation','trusted expected result','accepted dependency identities'],outputs:['unchanged acceptance criteria'],invariants:['An efficiency candidate cannot change output bytes, scope, dependencies, effect keys or required checks.']},dependencies:[],
    sources:[runtime('specOf'),runtime('validateGraph'),source('ophanim/governance/check-contract.mjs','validateRequest')]},
  {id:'board-integrity',purpose:'Retain work and evidence across controller restarts and reject stale worker publications.',mechanismClass:'required-governance',
    contract:{inputs:['controller snapshot','worker candidate','fenced lease'],outputs:['immutable content-addressed publication','serialized controller head'],invariants:['Controller state and accepted evidence must remain traceable to exact committed bytes.']},dependencies:[],
    sources:[source('ophanim/board.mjs','withRuntimeBoard'),source('ophanim/board.mjs','publishWorkerCandidate'),source('pantheon/src/board/dag.mjs','publish')]},
  {id:'planning',purpose:'Turn raw synthetic requests into a typed dependency graph using a separately validated workflow template.',mechanismClass:'replaceable-mechanism',
    contract:{inputs:['raw request','bounded planning policy'],outputs:['validated obligations with explicit ownership and dependencies'],invariants:['The planning worker does not receive the trusted expected outputs; the controller independently validates its proposal.']},dependencies:['acceptance-contract'],
    sources:[fixture('createPlanning'),runtime('runRuntime')]},
  {id:'worker-routing',purpose:'Select a declared worker that supports the obligation kind and department scope.',mechanismClass:'replaceable-mechanism',
    contract:{inputs:['approved worker registry','obligation kind and scope','release attempt number'],outputs:['one eligible deterministic worker'],invariants:['Kind/scope filtering and the active release registry are required; this is not live provider selection.']},dependencies:['acceptance-contract','board-integrity'],
    sources:[runtime('execute'),runtime('metadata')]},
  {id:'context',purpose:'Give a worker its declared inputs and exact accepted upstream outputs without the answer oracle.',mechanismClass:'replaceable-mechanism',
    contract:{inputs:['declared inputs','accepted dependency output and hash'],outputs:['frozen JSON worker brief'],invariants:['Dependency versions and scope cannot be dropped; expected output is withheld from workers.']},dependencies:['acceptance-contract','accepted-reuse'],
    sources:[runtime('checkDependencyContext'),runtime('execute'),fixture('upstream')]},
  {id:'worker-reasoning',purpose:'Normalize, route and draft synthetic intake records using deterministic transformations.',mechanismClass:'replaceable-mechanism',
    contract:{inputs:['scoped worker brief'],outputs:['candidate JSON and optional draft effect proposal'],invariants:['Workers propose; their self-reported checks do not authorize acceptance. No model reasoning effort is configured here.']},dependencies:['worker-routing','context'],
    sources:[fixture('createWorkers'),runtime('execute')]},
  {id:'scheduling',purpose:'Expose obligations whose dependencies are accepted and dispatch a sorted batch of ready work.',mechanismClass:'replaceable-mechanism',
    contract:{inputs:['pending obligation graph','accepted dependency state','dispatch bound'],outputs:['bounded ready batch'],invariants:['A dependent obligation cannot run before its producers are accepted; the current loop waits for the batch to settle.']},dependencies:['planning','accepted-reuse','worker-routing'],
    sources:[runtime('runRuntime')]},
  {id:'concurrency',purpose:'Limit how many ready obligation attempts can overlap in the controller.',mechanismClass:'replaceable-mechanism',
    contract:{inputs:['ready batch','slots setting'],outputs:['at most slots concurrent attempts'],invariants:['The runtime accepts 1–8 slots, but the efficiency authority admits only the qualified baseline 1→3 experiment.']},dependencies:['scheduling'],
    sources:[runtime('runRuntime'),source('ophanim/governance/check-efficiency.mjs','validateEfficiencyPolicy')]},
  {id:'review',purpose:'Independently check candidate bytes, signed lifecycle evidence and upstream acceptance before controller acceptance.',mechanismClass:'required-governance',
    contract:{inputs:['candidate','immutable obligation','worker identity','dependency versions'],outputs:['verified TELOS plan and signed node evidence or refusal'],invariants:['Required checks and signatures cannot be removed by an efficiency proposal. Fixture reviewer identities are locally generated, not live provider reviews.']},dependencies:['acceptance-contract','board-integrity','worker-reasoning'],
    sources:[governance('verifyCandidate'),governance('verifyOne'),governance('checkPackets'),runtime('finish')]},
  {id:'accepted-reuse',purpose:'Reuse retained accepted outputs while rechecking their evidence before downstream consumption.',mechanismClass:'replaceable-mechanism',
    contract:{inputs:['retained candidate and accepted output','immutable publications','TELOS evidence'],outputs:['version-bound accepted dependency available without worker redispatch'],invariants:['Reuse is not a generic answer cache or a verification cache; retained evidence is reverified.']},dependencies:['board-integrity','review'],
    sources:[runtime('checkDependencyContext'),runtime('runRuntime'),governance('verifyCandidate')]},
  {id:'effects',purpose:'Confirm a synthetic draft effect by stable key and reconcile uncertain outcomes after interruption.',mechanismClass:'required-governance',
    contract:{inputs:['verified output','trusted effect key','durable intent'],outputs:['confirmed synthetic destination receipt'],invariants:['An effect must equal accepted output; uncertain outcomes are inspected before retry. No live business destination is connected.']},dependencies:['acceptance-contract','board-integrity','review'],
    sources:[runtime('effectsFor'),fixture('createSyntheticDestination')]},
  {id:'recovery',purpose:'Resume retained work and close interrupted assessments without inventing measurements or rerunning experiments.',mechanismClass:'required-governance',
    contract:{inputs:['committed runtime state','retained candidate or effect intent','retained trace'],outputs:['resumed bounded work or conservative interruption record'],invariants:['Accepted outputs and effect identity survive recovery. The watchdog and recovery path do not grant new authority.']},dependencies:['board-integrity','review','effects'],
    sources:[runtime('runRuntime'),source('ophanim/watchdog.mjs','guardWorker'),source('ophanim/efficiency/recovery.mjs','recoverInterruptedAssessment')]},
  {id:'efficiency-admission',purpose:'Estimate whether investigating a scheduler change can repay its cost and request bounded replay for plausible candidates.',mechanismClass:'replaceable-mechanism',
    contract:{inputs:['accepted convergence trace','exact applicability identity','expected same-scope workload','retained experiments'],outputs:['no change or request for controlled replay'],invariants:['Estimates and variable discovery confer no authorization. The experiment must preserve the acceptance contract and resource cap.']},dependencies:['acceptance-contract','concurrency','review','recovery'],
    sources:[assessment('assessConvergence'),source('ophanim/efficiency/admission.mjs','assessOptimizationAdmission'),source('ophanim/efficiency/replay.mjs','evaluateScheduler')]},
  {id:'optimization-authorization',purpose:'Independently qualify and authorize a scoped scheduling policy for reuse.',mechanismClass:'required-governance',
    contract:{inputs:['controlled replay and recovery evidence','exact proposed policy','independent TELOS verification'],outputs:['signed exact-scope policy or refusal'],invariants:['The proposer cannot change TELOS authority, acceptance criteria or the bounded reuse policy.']},dependencies:['acceptance-contract','efficiency-admission','review','recovery'],
    sources:[assessment('chooseEfficiencySlots'),governance('verifyEfficiencyCandidate'),governance('issueEfficiencyDecision'),governance('verifyEfficiencyDecision')]},
];
const INVARIANTS=[
  {id:'same-acceptance',class:'immutable-acceptance',statement:'Efficiency comparison keeps the obligation set, outputs, effect payloads and required verification unchanged.',sources:[source('ophanim/efficiency/replay.mjs','assertOutputs'),source('ophanim/governance/check-efficiency.mjs','validateEfficiencyPolicy')]},
  {id:'scope-and-version',class:'immutable-acceptance',statement:'Worker kind, department scope and exact accepted dependency versions constrain every dispatched obligation.',sources:[runtime('checkDependencyContext'),runtime('execute')]},
  {id:'controller-authority',class:'required-governance',statement:'The controller accepts work only after TELOS verification and changes scheduling policy only after exact signed authorization.',sources:[runtime('finish'),assessment('chooseEfficiencySlots')]},
  {id:'durable-effect-identity',class:'immutable-acceptance',statement:'Recovery preserves accepted outputs and stable draft keys; it reconciles unknown destination outcomes.',sources:[runtime('effectsFor'),runtime('transitionRelease')]},
];
const INTERACTIONS=[
  {id:'routing-context',components:['worker-routing','context'],constraint:'Changing worker selection must preserve allowed scope and dependency context.'},
  {id:'reasoning-review',components:['worker-reasoning','review','acceptance-contract'],constraint:'A different transformation still owes the same independently verified result; worker assertions are not substitute evidence.'},
  {id:'context-reuse',components:['context','accepted-reuse','board-integrity'],constraint:'Smaller or reused inputs must retain exact upstream identity and sufficient task evidence; byte repetition alone does not prove waste.'},
  {id:'slots-readiness',components:['concurrency','scheduling','review'],constraint:'More slots can overlap only ready work. Controller persistence and verification remain part of measured completion time.'},
  {id:'reuse-review',components:['accepted-reuse','review'],constraint:'Repeated verification can protect retained state; the current contract does not authorize skipping it.'},
  {id:'slots-recovery',components:['concurrency','recovery','effects'],constraint:'Wider overlap must retain bounded restart behavior and the same destination effects.'},
  {id:'admission-cost',components:['efficiency-admission','concurrency','review'],constraint:'A candidate reference is not a promotion. Independent evidence, full experiment cost and exact-scope authorization remain required.'},
];
const CANDIDATE={
  id:'scheduler.slots.1-to-3',policySchema:'ophanim.scheduler-policy/v1',
  change:{field:'slots',from:1,to:3},baselineRelease:'baseline',stateSchema:'ophanim.runtime/v1',maxQualifiedConvergences:20,
  authorization:'not-evaluated',mayApply:false,
  requiredEvidence:['exact scope, worker artifact and source policy digests','original accepted baseline result','controlled clean replays at widths 1 and 3','recovery equivalence at both widths','unchanged accepted output and destination effects','independent TELOS efficiency evidence and signed controller decision','positive savings after full assessment cost'],
  sources:[source('ophanim/governance/check-efficiency.mjs','validateEfficiencyPolicy'),assessment('eligible'),assessment('assessConvergence'),assessment('chooseEfficiencySlots')],
};

function checked({trace,analysis}){
  const actual=analyzeTrace(trace);
  if(analysis!==undefined&&canonical(actual)!==canonical(analysis))throw Error('Contribution analysis differs from the supplied trace');
  if(trace.scopeSha!==undefined&&trace.scopeSha!==actual.applicability.fingerprint)throw Error('Contribution scope differs from trace applicability');
  return actual;
}
function evidenceBinding(trace,analysis){
  for(const key of ['boardCommit','stateSha'])if(trace[key]!==undefined&&(typeof trace[key]!=='string'||trace[key].length>256))throw Error('Bounded contribution provenance required');
  return {scopeSha:analysis.applicability.fingerprint,analysisSha:digest(analysis),boardCommit:trace.boardCommit??null,stateSha:trace.stateSha??null};
}
function observations(trace,analysis){
  const unavailable=trace.recovery?.measurementCoverage==='unavailable';
  const attempts=unavailable?0:trace.attempts.length,checks=unavailable?0:(trace.verifications??[]).length;
  const measure=(metric,value,unit,available,interpretation,coverage='observed')=>({metric,value:available?value:null,unit,coverage:available?coverage:'unavailable',attribution:'shared',interpretation});
  const absent=(metric,interpretation)=>measure(metric,null,'unknown',false,interpretation);
  const worker=()=>measure('scheduling.workerMs',analysis.scheduling.workerMs,'ms',attempts>0,'Observed attempt duration is shared across dispatch, context and transformation; it is not a per-component CPU profile.');
  const context=()=>[
    measure('context.observedContextBytes',analysis.context.observedContextBytes,'bytes',!unavailable&&analysis.context.contextByteSamples>0,'Serialized brief bytes, not provider tokens.'),
    measure('context.repeatedInputBytes',analysis.context.repeatedInputBytes,'bytes',!unavailable&&analysis.context.repeatedInputByteSamples>0,'Exact input bytes replayed for the same obligation; no claim that reuse is safe or beneficial.'),
  ];
  const verification=()=>measure('verification.totalMs',analysis.verification.totalMs,'ms',checks>0,'Observed check intervals cover the verification wrapper; the trace does not separate signature, artifact, lifecycle and semantic-check costs.');
  return {
    'acceptance-contract':[measure('obligations.accepted',analysis.obligations.accepted,'obligations',true,'Retained accepted obligation count; criteria remain fixed.'),absent('acceptance-quality-comparison','No comparative quality change is authorized by these measurements.')],
    'board-integrity':[absent('persistence-and-lease-time','Persistence, lock and CAS costs are not separately instrumented.')],
    planning:[absent('planning-time','The trace has no separate planner execution interval.')],
    'worker-routing':[worker(),absent('routing-time','Worker selection has no separate timing sample.'),absent('provider-allocation','No live provider selection or provider performance observations exist in this synthetic trace.')],
    context:context(),
    'worker-reasoning':[worker(),absent('reasoning-effort','No model reasoning level, token usage or comparable model-quality measurement is supplied.')],
    scheduling:[measure('scheduling.readyWaitMs',analysis.scheduling.readyWaitMs,'ms',!unavailable&&analysis.scheduling.measuredWaits.length>0,'Delay after measured prerequisites; includes required controller work and does not prove avoidable idle.',analysis.scheduling.unmeasuredWaits.length?'partial':'observed'),
      measure('scheduling.noWorkerOrVerificationActivityMs',analysis.scheduling.noWorkerOrVerificationActivityMs,'ms',attempts+checks>0,'Time outside supplied worker/check intervals; other necessary work and missing samples can occupy it.')],
    concurrency:[measure('configuration.slots',analysis.configuration.slots,'slots',true,'Declared capacity; this value is not a measured benefit.'),measure('scheduling.maxConcurrentWorkers',analysis.scheduling.maxConcurrentWorkers,'attempts',attempts>0,'Maximum observed attempt overlap.'),measure('scheduling.workerSlotUnusedMs',analysis.scheduling.workerSlotUnusedMs,'slot-ms',attempts>0,'Unused declared worker capacity; not a prediction of reclaimable time.')],
    review:[verification(),measure('verification.repeatedCandidateMs',analysis.verification.repeatedCandidateMs,'ms',checks>0,'Repeated checks on the same candidate hash can be required; repetition is not dispensability.')],
    'accepted-reuse':[measure('verification.replayCalls',analysis.verification.replayCalls,'calls',checks>0,'Retained candidate checks, not cache-hit or redispatch-avoidance measurements.'),...context(),absent('cache-savings','No controlled cache intervention or provider cache telemetry is supplied.')],
    effects:[absent('destination-effect-time','The trace has no separately timed destination adapter interval.')],
    recovery:[measure('retries.observedRetryWorkMs',analysis.retries.observedRetryWorkMs,'ms',attempts>0,'Observed attempts after attempt one; this is not a complete restart-cost measurement.'),absent('recovery-overhead','Recovery comparisons require retained experiment evidence beyond this single trace.')],
    'efficiency-admission':[absent('assessment-cost','Assessment and replay costs occur after this convergence trace and must be accounted for separately.')],
    'optimization-authorization':[absent('policy-verification-cost','A convergence trace does not include the later replay verification or policy authorization interval.')],
  };
}

export function buildContributionRegistry({trace,analysis}={}){
  const verified=checked({trace,analysis}),measures=observations(trace,verified);
  const missingTiming=trace.recovery?.measurementCoverage==='unavailable';
  const noCriticalEvidence=missingTiming||verified.criticalPath.status==='no-evidence';
  const definitions=COMPONENTS.map(component=>({...component,consumers:COMPONENTS.filter(other=>other.dependencies.includes(component.id)).map(other=>other.id).sort()}));
  const catalog={schema:'ophanim.efficiency.contribution-catalog/v1',components:definitions,invariants:INVARIANTS,interactions:INTERACTIONS};
  return clone({schema:'ophanim.efficiency.contributions/v1',scopeSha:verified.applicability.fingerprint,registrySha:digest(catalog),evidenceBinding:evidenceBinding(trace,verified),
    components:definitions.map(component=>({...component,observations:measures[component.id]})),invariants:INVARIANTS,interactions:INTERACTIONS,
    criticalPath:{coverage:missingTiming?'unavailable':verified.criticalPath.status,
      obligationIds:noCriticalEvidence?null:verified.criticalPath.obligationIds,observedMs:noCriticalEvidence?null:verified.criticalPath.observedMs,
      nodeWork:verified.criticalPath.nodeWork.map(row=>({...row,
        workMs:missingTiming||!row.attempts?null:row.workMs,
        verificationMs:missingTiming||!(trace.verifications??[]).some(check=>check.id===row.id&&check.purpose==='accept')?null:row.verificationMs,
        acceptedAttemptWorkMs:missingTiming?null:row.acceptedAttemptWorkMs,
        priorAttemptWorkMs:missingTiming||!row.attempts?null:row.priorAttemptWorkMs})),
      missing:verified.criticalPath.missing,interpretation:verified.criticalPath.interpretation},
    limitations:['Component dependencies describe interface relationships, including feedback through accepted state; they are not an executable task DAG.',
      'Shared observations must not be summed as separate component costs. Missing resource attribution remains null.',
      'Source references describe the inspected local implementation; they do not establish live provider capability or production authorization.'],
    authorization:{policyChange:false,providerRecommendation:false}});
}

export function discoverVariables({trace,analysis,registry}={}){
  const verified=checked({trace,analysis}),expected=buildContributionRegistry({trace,analysis:verified});
  if(registry!==undefined&&canonical(registry)!==canonical(expected))throw Error('Contribution registry differs from the supplied trace and inspected catalog');
  const variable=(id,componentIds,currentValue,status,requiredEvidence,candidateRefs=[])=>({id,componentIds,currentValue,status,candidateRefs,requiredEvidence,
    interactionRefs:INTERACTIONS.filter(interaction=>interaction.components.some(id=>componentIds.includes(id))).map(interaction=>interaction.id),
    observations:componentIds.flatMap(id=>expected.components.find(component=>component.id===id).observations.map(observation=>({componentId:id,...observation})))});
  const variables=[
    variable('provider-allocation',['worker-routing'],null,'missing-evidence',['An explicit qualified provider connector and model-routing contract','Comparable task quality, latency, token and cost evidence; this trace contains none']),
    variable('worker-selection',['worker-routing'],'kind-and-scope-filtered-registry','requires-contract',['Exact scoped registry and implementation identity','Independent equivalence and recovery evidence for a proposed selection change']),
    variable('reasoning-method',['worker-reasoning'],'deterministic-synthetic-transformations','requires-contract',['A concrete alternative implementation under unchanged acceptance','Comparable scoped quality and resource evidence; no model reasoning knob is currently admitted']),
    variable('context-selection',['context'],'declared-inputs-plus-accepted-dependencies','requires-contract',['Proof that a proposed representation retains required evidence and exact dependency identities','Equivalent accepted output and effect behavior with measured context cost']),
    variable('scheduler-slots',['concurrency','scheduling'],verified.configuration.slots,'existing-candidate-contract',CANDIDATE.requiredEvidence,[CANDIDATE.id]),
    variable('ready-order-and-batching',['scheduling'],'lexicographic-ready-batches','requires-contract',['A separately authorized scheduling contract','Dependency safety, fairness, completion and recovery comparisons under fixed accepted results']),
    variable('accepted-result-reuse',['accepted-reuse'],'retained-outputs-with-evidence-reverification','requires-contract',['Exact content and dependency invalidation conditions','A qualified alternative reuse mechanism that preserves current acceptance requirements']),
    variable('verification-cache',['accepted-reuse','review'],null,'requires-contract',['An explicit authority contract for any proposed verification reuse','Independent invalidation, stale-evidence refusal and restart proof; repeated checks alone are insufficient']),
    variable('required-review-and-acceptance',['review','acceptance-contract'],'unchanged-required-checks-and-signed-evidence','protected',['A separate task authorization would be needed to change acceptance; the current efficiency contract cannot do so']),
    variable('recovery-and-retry',['recovery'],'bounded-resume-and-reconciliation','requires-contract',['Explicit proposed recovery or retry configuration and limits','Fault-injection evidence preserving accepted outputs, stable effects and bounded recovery cost']),
    variable('effect-identity',['effects','acceptance-contract'],'stable-key-and-exact-accepted-payload','protected',['The current efficiency contract requires unchanged effects and does not permit weakening idempotency or reconciliation']),
  ];
  const environmentalFactors=[
    {id:'future-exact-scope-workload',components:['efficiency-admission'],coverage:'forecast-required',effect:'The number of comparable convergences determines how many times a per-run saving can repay one-time assessment and rollout costs.'},
    {id:'host-and-storage-contention',components:['concurrency','board-integrity','review'],coverage:'unattributed',effect:'Host load and storage latency affect persistence, verifier startup and measured stage tails. A timing change alone does not identify the cause.'},
    {id:'provider-limits-and-cache-state',components:['worker-routing','worker-reasoning','accepted-reuse'],coverage:'out-of-scope',effect:'Provider capacity, rate limits, prices and cache warmth influence live routing economics. The synthetic qualification measures none of these.'},
  ];
  return clone({schema:'ophanim.efficiency.variables/v1',scopeSha:expected.scopeSha,registrySha:expected.registrySha,evidenceBinding:expected.evidenceBinding,
    variables,environmentalFactors,constraintRefs:INVARIANTS.map(invariant=>invariant.id),
    candidateReferences:[{...CANDIDATE,observedDomain:{baselineSlots:verified.configuration.slots===1,baselineRelease:trace.release?.id===undefined?null:trace.release.id==='baseline',completeApplicability:verified.applicability.complete}}],
    authorization:{candidateSelection:false,policyChange:false},
    interpretation:'Discovery records mechanisms, observations and missing evidence. Only the existing slots policy has an admission reference, and it still requires the original independent qualification and signed decision.'});
}
