import test from 'node:test';
import assert from 'node:assert/strict';
import {chairModels,rankChairQuestions} from './chairs.mjs';

const hex=c=>c.repeat(64);
function projection({implRework=2,checkRework=1,reseats=0}={}){
  const row=(chair,metrics)=>({chair,occupants:[{vendor:'openai',model:'gpt-6-sol',entries:2}],metrics:{entries:2,reseats,...metrics}});
  return {schema:'pantheon.chair-contributions/v1',boardSha:hex('b'),projectionSha:hex('a'),
    limits:{ranksModels:false,authorizesSeatChange:false,basis:'derived'},
    chairs:[row('lead@orch',{plans:1,rework:0}),row('impl@build',{rework:implRework}),row('check@review',{rework:checkRework}),row('scout@opt',{forks:1})]};
}
const economics={expectedConvergences:10,applicability:0.8,confidence:0.7,decisionChangeProbability:0.5,
  avoidableLossMsPerConvergence:60000,expectedCandidateGainMsPerConvergence:null,rolloutMs:1000,regressionMs:1000,opportunityCostMs:1000,sourceSha:hex('c')};

test('each chair becomes one function whose observations are the board-derived counts',()=>{
  const models=chairModels(projection());
  assert.deepEqual(models.functions.map(fn=>fn.id),['lead.orch','impl.build','check.review','scout.opt']);
  assert.equal(models.traceSha,hex('a'));
  assert.deepEqual(models.functions.find(fn=>fn.id==='impl.build').observations.find(o=>o.metric==='rework').value,2);
  assert.equal(chairModels(projection({implRework:9})).scopeSha,models.scopeSha,'the scope is the arrangement, not one board');
});

test('rework seen in more than one chair raises an attribution question; without a forecast it stays unresolved',()=>{
  const {decision}=rankChairQuestions(projection());
  const question=decision.candidates.find(c=>c.id==='attribute.rework');
  assert.ok(question,JSON.stringify(decision.candidates.map(c=>c.id)));
  assert.deepEqual(question.componentIds,['check.review','impl.build']);
  assert.equal(question.outcome,'insufficient_evidence');
  assert.equal(decision.selected,null);
  assert.deepEqual(decision.limits,{executionAuthorized:false,promotionAuthorized:false,modelCalls:0,replays:0,effects:0});
});

test('with a declared forecast the question is ranked by information value, still authorizing nothing',()=>{
  const {decision}=rankChairQuestions(projection(),{economics});
  assert.equal(decision.outcome,'proposed');
  assert.equal(decision.selected.id,'attribute.rework');
  assert.ok(decision.selected.value.netInformationValueMs>0);
  assert.equal(decision.selected.design.method.stop.maxModelCalls,0);
  assert.equal(decision.limits.promotionAuthorized,false);
});

test('rework in only one chair is not an attribution question',()=>{
  const {decision}=rankChairQuestions(projection({checkRework:0}),{economics});
  assert.equal(decision.candidates.some(c=>c.id==='attribute.rework'),false);
});

test('a projection carrying seat-change authority, or missing a chair, is refused',()=>{
  assert.throws(()=>chairModels({...projection(),limits:{authorizesSeatChange:true}}),/seat-change authority/);
  assert.throws(()=>chairModels({...projection(),chairs:projection().chairs.slice(1)}),/one row per chair/);
  assert.throws(()=>chairModels({...projection(),projectionSha:'x'}),/board-derived/);
});

test('a broken occupancy trail blocks ranking and names the chair, even with no rework anywhere',()=>{
  const p=projection({implRework:0,checkRework:0});
  p.chairs[2].metrics.occupancy={inconsistent:[{instance:'slot:alpha',why:'entry 1 has gen 1, expected 2'}],unrecorded:[]};
  const {decision}=rankChairQuestions(p,{economics});
  assert.equal(decision.outcome,'blocked');
  assert.equal(decision.reason,'occupancy-trail-inconsistent');
  assert.deepEqual(decision.anomalies,[{chair:'check@review',instance:'slot:alpha',why:'entry 1 has gen 1, expected 2'}]);
  assert.equal(decision.selected,null);
  assert.equal(decision.limits.promotionAuthorized,false);
});
