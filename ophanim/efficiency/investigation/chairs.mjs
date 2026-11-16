// Q7 (measurement): rank which question about the 1 + 4 chairs is worth measuring, from Pantheon's
// board-derived contribution projection (pantheon/src/board/contributions.mjs).
//
// Each chair becomes one function of a functional model. Its observations are the projection's
// counts, so the ranking reads evidence the board can recompute, never an asserted score. The
// result is a ranked, bounded question with a measurement design: it executes nothing, spends no
// model call and authorizes no seat change. Changing who sits in a chair remains a signed, scoped
// decision through the pinned verifier, which this module does not reach.
import {digest} from '../../board.mjs';
import {selectInvestigation} from './select.mjs';

const PROJECTION_SCHEMA='pantheon.chair-contributions/v1';
const HEX=/^[a-f0-9]{64}$/;
const CHAIRS=['lead@orch','impl@build','check@review','scout@opt'];
// Work flows down the chain: scouts inform the plan, the plan assigns the build, the check reads the build.
const DEPENDS={'lead@orch':['scout@opt'],'impl@build':['lead@orch'],'check@review':['impl@build'],'scout@opt':[]};
const fnId=chair=>chair.replace('@','.');
const fail=message=>{throw Error(`Chair investigation: ${message}`);};
const count=value=>Number.isSafeInteger(value)&&value>=0;

export function chairModels(projection){
  if(projection?.schema!==PROJECTION_SCHEMA||!HEX.test(projection.projectionSha??'')||!HEX.test(projection.boardSha??''))fail('board-derived contribution projection required');
  if(projection.limits?.authorizesSeatChange!==false)fail('a projection may not carry seat-change authority');
  const byChair=new Map((projection.chairs??[]).map(row=>[row.chair,row]));
  if(byChair.size!==CHAIRS.length||!CHAIRS.every(chair=>byChair.has(chair)))fail('one row per chair of the 1 + 4 arrangement required');
  const registry={schema:'ophanim.chair-registry/v1',chairs:CHAIRS.map(chair=>({id:fnId(chair),dependencies:DEPENDS[chair].map(fnId)}))};
  const functions=CHAIRS.map(chair=>{
    const {metrics,occupants}=byChair.get(chair);
    const rework=metrics.rework??0;
    if(!count(rework)||!count(metrics.reseats))fail(`${chair} metrics must be non-negative counts`);
    const observations=[
      {metric:'rework',unit:'events',value:rework,attribution:'board-derived'},
      {metric:'reseats',unit:'events',value:metrics.reseats,attribution:'board-derived'},
    ];
    const anomalies=(metrics.occupancy?.inconsistent??[]).map(({instance,why})=>({chair,instance,why}));
    return {id:fnId(chair),observations,uncertainty:observations.map(({metric})=>({metric})),anomalies,
      unrecordedInstances:(metrics.occupancy?.unrecorded??[]).length,
      dependencies:DEPENDS[chair].map(fnId),interactions:[],controllableVariables:[],
      occupants:(occupants??[]).map(({vendor,model,entries})=>({vendor,model,entries}))};
  });
  const registrySha=digest(registry);
  // The scope is the arrangement, so decisions about it persist across boards; the trace is this board.
  return {schema:'ophanim.chair-models/v1',scopeSha:digest({schema:'ophanim.chair-scope/v1',registrySha}),
    traceSha:projection.projectionSha,registrySha,boardSha:projection.boardSha,functions};
}

/**
 * Rank the questions the projection raises. `economics` is a declared forecast (as for any
 * investigation); without one, the honest outcome is insufficient_evidence.
 */
export function rankChairQuestions(projection,{economics=null,history=[],instrumentationCeilingMs=30000}={}){
  const models=chairModels(projection);
  // A chair whose occupancy trail does not follow from its own entries is not a valid starting point:
  // its counts cannot be trusted, however low its rework looks. Ranking stops and names it, so the
  // record is verified before any question about it is valued.
  const anomalies=models.functions.flatMap(fn=>fn.anomalies);
  if(anomalies.length)return {models,decision:{schema:'ophanim.investigation-decision/v1',outcome:'blocked',reason:'occupancy-trail-inconsistent',
    anomalies,selected:null,candidates:[],historyEntries:[],
    limits:{executionAuthorized:false,promotionAuthorized:false,modelCalls:0,replays:0,effects:0}}};
  const discovery=selectInvestigation({models,history});
  // A method exists only for observable differences between the alternatives the discovery produced.
  const methods=discovery.candidates.filter(candidate=>candidate.hypotheses.length>1).map(candidate=>({
    id:`instrument.${candidate.questionSha.slice(0,16)}`,mode:'instrumentation',
    signals:[...new Set(candidate.hypotheses.flatMap(hypothesis=>hypothesis.predictions.map(point=>point.signal)))],
    estimatedCostMs:instrumentationCeilingMs,stop:{maxWallMs:30000,maxTrials:0,maxModelCalls:0},
    citations:['Board-derived counts per chair; each span needs an independently checkable boundary before collection.'],
  }));
  const decision=selectInvestigation({models,history,methods,...economics?{economics}:{}});
  return {models,decision};
}
