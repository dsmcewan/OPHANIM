import test from 'node:test';
import assert from 'node:assert/strict';
import {selectInvestigation} from './select.mjs';

const sha=character=>character.repeat(64);
const model={
  scopeSha:sha('a'),traceSha:sha('b'),registrySha:sha('c'),modelSha:sha('d'),
  system:{result:{convergence:'accepted_change',outputSha:sha('e')}},
  functions:[
    {id:'scheduling',controllableVariables:[{id:'scheduler-slots',status:'existing-candidate-contract',permittedRange:{kind:'allowed-levels',levels:[1,3]}}]},
    {id:'review',controllableVariables:[{id:'required-review',status:'protected',permittedRange:{kind:'fixed',value:'independent'}}]},
    {id:'effects',controllableVariables:[]},
    {id:'efficiency-admission',controllableVariables:[]},
  ],
};
const hypothesis=(id,componentId,signals)=>({id,componentId,explanation:'A possible explanation tied to the named observable.',
  predictions:Object.entries(signals).map(([signal,direction])=>({signal,direction}))});
const finding={
  id:'stages',scopeSha:model.scopeSha,evidenceSha:sha('1'),applicabilitySha:sha('2'),
  question:'Which stage explains the tail increase across paired traces?',
  decision:'Determine whether a narrower measurement discriminates between multiple explanations.',
  metric:'stage-p95-ms',componentIds:['scheduling','review'],
  observations:[{signal:'stage-p95-ms',unit:'ms',baseline:500,candidate:680}],
  hypotheses:[
    hypothesis('dispatch-gap','scheduling',{'dispatch-persist-ms':'increase','persist-accept-ms':'unchanged'}),
    hypothesis('acceptance-gap','review',{'dispatch-persist-ms':'unchanged','persist-accept-ms':'increase'}),
  ],
};
const retained={id:'retained-span',mode:'retained-observation',signals:['dispatch-persist-ms'],estimatedCostMs:20,
  stop:{maxWallMs:100,maxTrials:0,maxModelCalls:0},evidenceSha:sha('3')};
const instrumented={id:'acceptance-span',mode:'instrumentation',signals:['persist-accept-ms'],estimatedCostMs:80,
  stop:{maxWallMs:200,maxTrials:0,maxModelCalls:0}};
const paired={id:'compare-slots',mode:'paired-replay',signals:['dispatch-persist-ms','persist-accept-ms'],estimatedCostMs:800,
  variableIds:['scheduler-slots'],stop:{maxWallMs:1000,maxTrials:8,maxModelCalls:0}};
const economics={expectedConvergences:10,applicability:.9,confidence:.8,decisionChangeProbability:.5,
  avoidableLossMsPerConvergence:150,expectedCandidateGainMsPerConvergence:700,
  rolloutMs:90,regressionMs:50,opportunityCostMs:15,sourceSha:sha('4')};
function select(overrides={}){
  return selectInvestigation({models:model,findings:[finding],economics,methods:[paired,instrumented,retained],...overrides});
}

test('choose the cheapest equivalent discriminator with positive information value and preserve hard constraints',()=>{
  const result=select();
  assert.equal(result.outcome,'proposed');
  assert.equal(result.selected.design.method.id,retained.id);
  assert.deepEqual(result.selected.design.measurementSignals,['dispatch-persist-ms']);
  assert.equal(result.selected.value.grossInformationValueMs,540);
  assert.equal(result.selected.value.netInformationValueMs,365);
  assert.equal(result.selected.value.expectedCandidateGrossGainMs,6300);
  assert.equal(result.selected.uncertainty.resolved,false);
  assert.deepEqual(result.selected.design.manipulatedVariables,[]);
  assert.equal(result.selected.design.verification.independent,'TELOS');
  assert.ok(result.selected.design.verification.measures.includes('stage-p95-ms'));
  assert.equal(result.selected.design.verification.sameAcceptedOutputs,true);
  assert.equal(result.selected.design.verification.sameDestinationEffects,true);
  assert.deepEqual(result.limits,{executionAuthorized:false,promotionAuthorized:false,modelCalls:0,replays:0,effects:0});
});

test('a fast predicted candidate cannot make an economically unjustified investigation worthwhile',()=>{
  const unprofitable={...economics,avoidableLossMsPerConvergence:1,expectedCandidateGainMsPerConvergence:100000};
  const result=select({economics:unprofitable});
  assert.equal(result.outcome,'no_change');
  assert.equal(result.reason,'nonpositive-information-value');
  assert.equal(result.selected,null);
  assert.ok(result.candidates[0].value.expectedCandidateGrossGainMs>100000);
  assert.equal(result.historyEntries[0].outcome,'no_change');
  assert.equal(result.limits.replays,0);
});

test('different evidence-driven predictions select a different measurement capability',()=>{
  const changed={...finding,hypotheses:[
    hypothesis('dispatch-gap','scheduling',{'dispatch-persist-ms':'unchanged','persist-accept-ms':'unchanged'}),
    hypothesis('acceptance-gap','review',{'dispatch-persist-ms':'unchanged','persist-accept-ms':'increase'}),
  ]};
  assert.equal(select({findings:[changed]}).selected.design.method.id,instrumented.id);
  const neither=select({findings:[changed],methods:[retained]});
  assert.equal(neither.reason,'no-discriminating-measurement');
  assert.equal(neither.candidates[0].uncertainty.resolved,false);
});

test('missing economics leave a bounded proposal design without making up a reason to spend',()=>{
  const result=select({economics:null});
  assert.equal(result.outcome,'insufficient_evidence');
  assert.equal(result.reason,'information-value-unquantified');
  assert.equal(result.selected,null);
  assert.equal(result.candidates[0].value.netInformationValueMs,null);
  assert.ok(result.candidates[0].value.missing.includes('confidence'));
  assert.equal(result.candidates[0].design.method.id,retained.id);
});

test('scope retention suppresses stale inputs and permits independently sourced workload materiality',()=>{
  const before=select({economics:{...economics,expectedConvergences:1}});
  assert.equal(before.outcome,'no_change');
  const timingNoise={...finding,evidenceSha:sha('5')};
  const unchanged=select({findings:[timingNoise],history:before.historyEntries});
  assert.equal(unchanged.reason,'retained-applicable-decision');
  assert.deepEqual(unchanged.historyEntries,[]);
  const demandShift={...economics,sourceSha:sha('6')};
  const reconsidered=select({findings:[timingNoise],history:before.historyEntries,economics:demandShift});
  assert.equal(reconsidered.outcome,'proposed');
  const repeated=select({findings:[timingNoise],history:reconsidered.historyEntries,economics:demandShift});
  assert.equal(repeated.reason,'retained-applicable-decision');
  assert.equal(repeated.selected,null);
});

test('methods may investigate qualified variables, with fixed budgets and no delegated authority',()=>{
  const result=select({methods:[paired],economics:{...economics,avoidableLossMsPerConvergence:500}});
  assert.equal(result.outcome,'proposed');
  assert.deepEqual(result.selected.design.manipulatedVariables,[{id:'scheduler-slots',permittedRange:{kind:'allowed-levels',levels:[1,3]}}]);
  assert.equal(select({methods:[{...paired,variableIds:['required-review']}]}).reason,'no-discriminating-measurement');
  assert.equal(select({methods:[{...paired,stop:{maxWallMs:30001,maxTrials:8,maxModelCalls:0}}]}).outcome,'blocked');
  assert.equal(select({methods:[{...retained,stop:{maxWallMs:100,maxTrials:0,maxModelCalls:1}}]}).outcome,'blocked');
  assert.equal(select({economics:{...economics,overrideAuthority:true}}).outcome,'blocked');
});

test('controller investigations cannot bootstrap from routine optimization',()=>{
  const self={...finding,id:'controller-cost',componentIds:['efficiency-admission'],hypotheses:[]};
  assert.equal(select({findings:[self]}).reason,'separate-governed-controller-investigation-required');
});

test('advisory hypotheses remain provisional and cannot carry execution plans or authority',()=>{
  const hypothesisOnly={findingId:finding.id,hypothesis:hypothesis('evaluation-overlap','review',{'dispatch-persist-ms':'decrease'})};
  const advised=select({advisorHypotheses:[hypothesisOnly]});
  const interpretation=advised.selected.hypotheses.find(item=>item.id==='evaluation-overlap');
  assert.equal(interpretation.origin,'advisory-model');
  assert.equal(interpretation.status,'unresolved');
  assert.equal(select({advisorHypotheses:[{...hypothesisOnly,executionAuthorized:true}]}).outcome,'blocked');
});

test('ranking uses each decision’s evidence and value without prescribing a fixed order',()=>{
  const both=[finding,{...finding,id:'second',evidenceSha:sha('7')}];
  const result=select({findings:both,economicsByFinding:{stages:{...economics,avoidableLossMsPerConvergence:1}}});
  assert.equal(result.selected.id,'second');
  assert.deepEqual(result,select({findings:[...both].reverse(),economicsByFinding:{stages:{...economics,avoidableLossMsPerConvergence:1}}}));
});

test('shared trace observations can derive a concrete unresolved question without a supplied sequence',()=>{
  const observedMetric={metric:'context-bytes',unit:'bytes',value:2900,attribution:'shared'};
  const attributed={...model,functions:model.functions.map(fn=>['review','scheduling'].includes(fn.id)
    ?{...fn,observations:[observedMetric],uncertainty:[{metric:observedMetric.metric}]}:fn)};
  const result=selectInvestigation({models:attributed});
  assert.equal(result.reason,'no-discriminating-measurement');
  assert.equal(result.candidates[0].metric,'context-bytes');
  assert.equal(result.candidates[0].hypotheses.length,2);
  assert.equal(result.candidates[0].hypotheses[0].origin,'structural-alternative');
  assert.deepEqual(result.candidates[0].componentIds,['review','scheduling']);
});
