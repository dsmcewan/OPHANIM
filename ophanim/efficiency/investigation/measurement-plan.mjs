import {digest} from '../../board.mjs';
import {planInvestigation} from './controller.mjs';

export const MEASUREMENT_FORECAST='ophanim.measurement-forecast/v1';
export const PHASE_METHOD='phase-boundaries';
export const PROBE_REPEATS=4;
export const PROBE_WALL_MS=3000;
const MAX_WALL_MS=30000;
const RECEIPT='ophanim.historical-latency-investigation/v1';
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

const capability={
  id:PHASE_METHOD,
  signals:[
    {id:'timer-resume-lag-ms',purpose:'Measure excess time from timer scheduling to JavaScript callback entry after the requested wait.',unit:'ms',scope:'one timer in one matched obligation',
      collection:'Monotonic scheduling and callback entry marks, minus the configured delay.',limitation:'Includes timer precision and any delay before callback entry. Does not identify the source of the delay.'},
    {id:'transform-body-wall-ms',purpose:'Measure elapsed time inside the transformation boundary independently of timer resumption.',unit:'ms',scope:'one transform in one matched obligation',
      collection:'Monotonic transformation start and completion marks. Entry and return marks check callback ordering.',limitation:'Wall time includes time descheduled by the host. It is not CPU time.'},
  ],
};
const contextual=[
  ['event-loop-delay-and-utilization','Process-window signals pool other callbacks and cannot separate the two boundaries.'],
  ['process-cpu','Aggregate CPU cannot identify either phase. Process CPU is recorded for investigation cost only.'],
  ['queue-and-worker-wall-time','Retained dispatch and aggregate worker spans already bound the affected phase. They combine the two proposed explanations.'],
  ['verification-and-acceptance','Committed persistence, verification envelope, and acceptance marks are available as downstream context. They do not split the callback.'],
  ['contention-and-overlap','Concurrency and host contention are candidate context for later experiments. They do not identify either within-callback duration.'],
];

export function checkHistoricalReceipt(receipt,expectedSha) {
  const {receiptSha,...body}=receipt??{};
  if(!sha(expectedSha)||receiptSha!==expectedSha||body.schema!==RECEIPT||digest(body)!==receiptSha||
    !Array.isArray(body.probes)||body.probes.length<1||body.probes.length>4)throw Error('Exact independently retained historical receipt required');
  return receipt;
}

function economicsFor(forecast,probe) {
  if(forecast==null)return null;
  const {schema,scopeSha,basis,estimatedInvestigationMs,estimates}=forecast;
  const fields=['expectedConvergences','applicability','confidence','decisionChangeProbability','avoidableLossMsPerConvergence',
    'rolloutMs','regressionMs','opportunityCostMs'];
  if(schema!==MEASUREMENT_FORECAST||scopeSha!==probe.scopeSha||typeof basis!=='string'||!basis.trim()||basis.length>512||
    !Number.isSafeInteger(estimatedInvestigationMs)||estimatedInvestigationMs<=PROBE_WALL_MS+1||estimatedInvestigationMs>MAX_WALL_MS||
    Object.keys(forecast).some(key=>!['schema','scopeSha','basis','estimatedInvestigationMs','estimates'].includes(key))||
    !estimates||Object.keys(estimates).some(key=>!fields.includes(key)))throw Error('Exact scoped measurement forecast required');
  return {...estimates,sourceSha:digest(forecast)};
}

function findingOf({id,scopeSha,evidenceSha,applicabilitySha,question,decision,metric,componentIds,observations,hypotheses}) {
  return {id,scopeSha,evidenceSha,applicabilitySha,question,decision,metric,componentIds,observations,
    hypotheses:hypotheses.map(({id,componentId,explanation,predictions})=>({id,componentId,explanation,predictions}))};
}

function targetFor(candidate) {
  const matched=candidate?.observations.find(row=>row.signal==='matched-candidate-tail-phase-deltas')?.samples??[];
  if(!Array.isArray(matched)||matched.some(row=>typeof row.id!=='string'||!Number.isFinite(row.stageMs)))throw Error('Exact historical tail boundaries required');
  return [...matched].sort((a,b)=>b.stageMs-a.stageMs||a.id.localeCompare(b.id))[0]?.id??null;
}

export function planMeasurement({receipt,expectedSha,probeIndex=0,forecast=null,history=[]}={}) {
  checkHistoricalReceipt(receipt,expectedSha);
  const probe=receipt.probes[probeIndex];
  if(!Number.isInteger(probeIndex)||!probe)throw Error('Unknown retained probe');
  const findings=probe.selection.candidates.map(findingOf);
  const economics=economicsFor(forecast,probe);
  const methods=[{
    id:'retained-callback-envelope',mode:'retained-observation',signals:['worker-callback-ms'],estimatedCostMs:0,
    stop:{maxWallMs:1,maxTrials:0,maxModelCalls:0},evidenceSha:probe.evidenceSha,
  },{
    id:capability.id,mode:'instrumentation',signals:capability.signals.map(signal=>signal.id),
    estimatedCostMs:forecast?.estimatedInvestigationMs??MAX_WALL_MS,
    stop:{maxWallMs:MAX_WALL_MS,maxTrials:0,maxModelCalls:0},
    citations:['Single bound obligation. These boundaries require a separate controlled qualification. Cost includes source verification and measurement.'],
  }];
  const {decision}=planInvestigation({trace:probe.baselineTrace,findings,economics:economics??{},methods,history});
  const candidate=decision.selected??decision.candidates.find(row=>row.design?.method.id===capability.id);
  const target=targetFor(candidate);
  const discriminator=candidate?.design?.method.id===capability.id?candidate.design.discrimination:null;
  const signals=new Set(candidate?.design?.measurementSignals??[]);
  const requirements=capability.signals.filter(signal=>signals.has(signal.id)).map(signal=>({...signal,
    discriminatingPairs:discriminator?.distinguishable.filter(pair=>pair.contrasts.some(contrast=>contrast.signal===signal.id)).map(pair=>pair.hypotheses)??[],
    overhead:{status:'requires-matched-calibration',unit:'ns',scope:'one measured boundary and instrumented versus uninstrumented obligation'},
  }));
  const applicability={scopeSha:probe.scopeSha,sourceSha:probe.evidenceSha,questionSha:candidate?.questionSha??null,target,
    method:capability.id,protocol:'ophanim.measurement-probe/v1'};
  return {schema:'ophanim.measurement-plan/v1',receiptSha:expectedSha,probeIndex,forecast,decision,requirements,
    rejectedMeasurements:contextual.map(([id,reason])=>({id,reason})),
    identity:digest(applicability),applicability,
    calibration:target&&requirements.length?{synthetic:true,obligationId:target,repeats:PROBE_REPEATS,maxWallMs:PROBE_WALL_MS}:null,
    stageP95:probe.measurements.stageP95,authority:{execution:false,policyActivation:false}};
}
