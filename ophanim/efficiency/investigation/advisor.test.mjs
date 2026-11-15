import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFunctionalModels} from './models.mjs';
import {planInvestigation} from './controller.mjs';
import {refineInvestigation} from './advisor.mjs';

const sha=character=>character.repeat(64);
const privatePath='/home/fixture/private-context/secret-token';
const route={vendor:'openai',model:'gpt-6-astra',effort:'low'};
const budget={maxWallMs:1000,maxInputTokens:1024,maxOutputTokens:350,estimatedCostMs:10,uncertaintyReserveMs:10};
const economics={expectedConvergences:10,applicability:.9,confidence:.8,decisionChangeProbability:.5,
  avoidableLossMsPerConvergence:150,expectedCandidateGainMsPerConvergence:700,rolloutMs:90,regressionMs:50,opportunityCostMs:15,sourceSha:sha('4')};
const stageHypothesis=(id,componentId,first,second)=>({id,componentId,explanation:`Input evidence text is not sent to the provider. ${privatePath}`,
  predictions:[{signal:'dispatch-persist-ms',direction:first},{signal:'persist-accept-ms',direction:second}]});
function fixture(){
  const trace={boardCommit:`commit:${sha('1')}`,stateSha:sha('2'),configuration:{slots:1,workerRegistry:[{id:'worker',version:'1',kinds:['step'],scopes:['department:ops']}],
    workerArtifactSha:sha('a'),policySha:sha('b'),inputRevision:privatePath},release:{id:'baseline'},window:{startedAt:0,endedAt:35},
    original:{convergence:'accepted_change',outputSha:sha('e'),effectSha:sha('f')},obligations:[{id:'a',kind:'step',scope:'department:ops',dependsOn:[],specSha:sha('1'),
      status:'accepted',acceptedAttempt:1,acceptedAt:30}],attempts:[{id:'a',attempt:1,startedAt:0,endedAt:20,inputSha:sha('3'),inputBytes:10,contextBytes:20}],
    verifications:[{id:'a',attempt:1,startedAt:21,endedAt:30,purpose:'accept',candidateSha:sha('4'),ok:true}],events:[]};
  const {scopeSha}=buildFunctionalModels({trace});
  const findings=[{id:'stages',scopeSha,evidenceSha:sha('1'),applicabilitySha:sha('2'),
    question:`Which span accounts for the changed tail overall? ${privatePath}`,decision:'Select one useful measurement.',
    metric:'stage-p95-ms',componentIds:['scheduling','review'],observations:[{signal:'dispatch-persist-ms',baseline:50,candidate:75,delta:25,raw:privatePath}],
    hypotheses:[
      stageHypothesis('dispatch','scheduling','increase','unchanged'),
      stageHypothesis('accept','review','unchanged','increase'),
      stageHypothesis('noise','review','unchanged','unchanged'),
    ],
  }];
  const methods=[
    {id:'retained-span',mode:'retained-observation',signals:['dispatch-persist-ms'],estimatedCostMs:20,stop:{maxWallMs:100,maxTrials:0,maxModelCalls:0}},
    {id:'acceptance-span',mode:'instrumentation',signals:['persist-accept-ms'],estimatedCostMs:80,stop:{maxWallMs:200,maxTrials:0,maxModelCalls:0}},
  ];
  return {trace,findings,methods,economics:{...economics},history:[]};
}

const useful={hypotheses:[{component:'F1',kind:'ordering',predictions:[{signal:'S1',direction:'decrease'},{signal:'S2',direction:'unchanged'}]}]};
const response=value=>({complete:true,usable_for_resume:true,tools:[],text:JSON.stringify(value)});
function options(input=fixture(),more={}){
  return {input,route,budget,client:{},countTokens:async()=>100,invoke:async()=>response(useful),...more};
}

test('one isolated model turn fits the explicit route and introduces only provisional hypotheses',async()=>{
  const input=fixture();
  const before=structuredClone(input);
  const calls=[];
  const client={responses:{create:async request=>{
    calls.push(request);
    assert.equal(request.model,route.model);
    assert.equal(request.reasoning.effort,route.effort);
    assert.equal(request.max_output_tokens,budget.maxOutputTokens);
    assert.equal(request.input.length,1);
    assert.equal(request.store,false);
    assert.equal(request.tools,undefined);
    assert.ok(request.input[0].content.includes('dispatch-persist-ms'));
    assert.ok(!request.input[0].content.includes(privatePath));
    assert.ok(!request.input[0].content.includes(input.trace.original.outputSha));
    return {id:'fixture-response',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(useful)}]}]};
  }}};
  let tokenCalls=0;
  const result=await refineInvestigation({input,route,budget,client,countTokens:async()=>{tokenCalls++;return 100;}});
  assert.equal(calls.length,1);
  assert.equal(tokenCalls,1);
  assert.equal(result.advice.status,'applied');
  assert.equal(result.advice.modelCalls,1);
  assert.equal(result.advice.chargeMs,20);
  assert.ok(result.advice.remainingMs>0);
  assert.equal(result.advice.executionAuthorized,false);
  assert.equal(result.advice.promotionAuthorized,false);
  const advisory=result.decision.selected.hypotheses.find(hypothesis=>hypothesis.origin==='advisory-model');
  assert.equal(advisory.status,'unresolved');
  assert.equal(result.decision.selected.uncertainty.resolved,false);
  assert.deepEqual(input,before);
});

test('baseline, declined value, resolved choice, and budget exhaustion use no model or token calls',async()=>{
  let calls=0;
  const unused=async()=>{calls++;throw Error('unexpected invoke');};
  const input=fixture();
  const none=await refineInvestigation(options({trace:input.trace},{invoke:unused,countTokens:unused}));
  assert.equal(none.advice.reason,'deterministic-investigation-not-proposed');
  const refused=await refineInvestigation(options({...input,economics:{...economics,avoidableLossMsPerConvergence:0}},{invoke:unused,countTokens:unused}));
  assert.equal(refused.decision.outcome,'no_change');
  const oneDesign=await refineInvestigation(options({...input,methods:[input.methods[0]]},{invoke:unused,countTokens:unused}));
  assert.equal(oneDesign.advice.reason,'no-positive-unresolved-design-tradeoff');
  const tooExpensive=await refineInvestigation(options(input,{budget:{...budget,estimatedCostMs:1000},invoke:unused,countTokens:unused}));
  assert.equal(tooExpensive.advice.reason,'no-positive-unresolved-design-tradeoff');
  const expanded=await refineInvestigation(options(input,{budget:{...budget,maxOutputTokens:3500},invoke:unused,countTokens:unused}));
  assert.equal(expanded.advice.reason,'explicit-bounded-advice-route-required');
  assert.equal(calls,0);
});

test('untrusted output cannot add observables, authority, command data, or complete an interrupted response',async()=>{
  const input=fixture();
  const original=planInvestigation(input).decision;
  const invalid=[
    response({...useful,authorization:true}),
    response({hypotheses:[{...useful.hypotheses[0],causalStatus:'proven'}]}),
    response({hypotheses:[{...useful.hypotheses[0],predictions:[{signal:'S9000',direction:'increase'}]}]}),
    {...response(useful),complete:false},
    {...response(useful),tools:['run']},
  ];
  for(const providerResult of invalid){
    const observed=await refineInvestigation(options(input,{invoke:async()=>providerResult}));
    assert.equal(observed.advice.status,'discarded');
    assert.equal(observed.advice.modelCalls,1);
    assert.deepEqual(observed.decision,original);
  }
});

test('token cap refuses before the model, and timeout cannot retry or expose provider errors',async()=>{
  const input=fixture();
  let calls=0;
  const large=await refineInvestigation(options(input,{countTokens:async()=>budget.maxInputTokens+1,invoke:async()=>{calls++;}}));
  assert.equal(large.advice.reason,'advice-turn-unavailable');
  assert.equal(large.advice.modelCalls,0);
  const timeout=await refineInvestigation(options(input,{budget:{...budget,maxWallMs:80},invoke:async()=>{calls++;return new Promise(()=>{});}}));
  assert.equal(timeout.advice.reason,'advice-turn-unavailable');
  assert.equal(timeout.advice.modelCalls,1);
  assert.equal(calls,1);
  const opaque=await refineInvestigation(options(input,{invoke:async()=>{throw Error(privatePath);}}));
  assert.ok(!JSON.stringify(opaque.advice).includes(privatePath));
});
