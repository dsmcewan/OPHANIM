import {boundedCall,prepareRequest,sendModelTurn} from '../../../packages/model-client/index.mjs';
import {digest} from '../../board.mjs';
import {planInvestigation} from './controller.mjs';

const SCHEMA='ophanim.investigation-advice/v1';
const MAX_WALL_MS=5000,MAX_INPUT_TOKENS=2048,MAX_OUTPUT_TOKENS=512;
const MAX_PROMPT_BYTES=6144,MAX_RESPONSE_BYTES=4096;
const DIRECTION=new Set(['increase','decrease','unchanged']);
const KINDS=new Set(['interaction','ordering','measurement-boundary','overlap','other']);
const boundedInt=(value,min,max)=>Number.isInteger(value)&&value>=min&&value<=max;
const money=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1e8;
const jsonObject=value=>value&&Object.getPrototypeOf(value)===Object.prototype;
const named=value=>typeof value==='string'&&/^[a-z][a-z0-9.-]{0,48}$/.test(value);
const compactName=(name,alias)=>named(name)?name:alias;
const finite=(value)=>typeof value==='number'&&Number.isFinite(value)?value:null;
function keys(value,expected){
  return jsonObject(value)&&Object.keys(value).length===expected.length&&expected.every(key=>Object.hasOwn(value,key));
}

function allowedBudget(route,budget){
  return keys(route,['vendor','model','effort'])&&Object.values(route).every(value=>typeof value==='string'&&value.length>=1&&value.length<=64)&&
    keys(budget,['maxWallMs','maxInputTokens','maxOutputTokens','estimatedCostMs','uncertaintyReserveMs'])&&
    boundedInt(budget.maxWallMs,1,MAX_WALL_MS)&&boundedInt(budget.maxInputTokens,1,MAX_INPUT_TOKENS)&&
    boundedInt(budget.maxOutputTokens,1,MAX_OUTPUT_TOKENS)&&money(budget.estimatedCostMs)&&budget.estimatedCostMs>0&&
    money(budget.uncertaintyReserveMs)&&budget.uncertaintyReserveMs>0;
}

function findTradeoff(selected,budget){
  const value=selected?.value?.netInformationValueMs;
  const current=selected?.design;
  if(!money(value)||value===0||!current||selected.hypotheses.length>=8||current.discrimination.unresolved.length===0)return null;
  const alternatives=selected.alternatives.filter(alternative=>money(alternative.value.netInformationValueMs)&&alternative.value.netInformationValueMs>0&&
    (alternative.mode!==current.method.mode||alternative.value.discriminatingPairFraction!==current.value.discriminatingPairFraction));
  if(alternatives.length===0)return null;
  // Use an upper allowance from the overlapping economic support of both
  // designs. Only the unresolved pair fraction can benefit from advice.
  const unresolved=current.discrimination.unresolved.length;
  const fraction=unresolved/(current.discrimination.distinguishable.length+unresolved);
  const designAllowanceMs=Math.min(value,alternatives[0].value.netInformationValueMs)*fraction;
  const chargeMs=budget.estimatedCostMs+budget.uncertaintyReserveMs;
  return {chargeMs,designAllowanceMs,remainingMs:designAllowanceMs-chargeMs,alternatives};
}

function promptFor(selected,tradeoff,methods){
  const methodIds=new Set([selected.design.method.id,...tradeoff.alternatives.map(alternative=>alternative.methodId)]);
  const methodSignals=new Set(methods.filter(method=>methodIds.has(method.id)).flatMap(method=>method.signals));
  const signalIds=[...new Set(selected.hypotheses.flatMap(hypothesis=>hypothesis.predictions.map(point=>point.signal)))]
    .filter(signal=>methodSignals.has(signal)).sort();
  if(signalIds.length===0||signalIds.length>12||selected.componentIds.length>8)return null;
  const signalAliases=new Map(signalIds.map((name,index)=>[name,`S${index+1}`]));
  const componentAliases=new Map(selected.componentIds.map((name,index)=>[name,`F${index+1}`]));
  const promptEvidence={
    metric:compactName(selected.metric,'target-metric'),
    components:[...componentAliases].map(([name,alias])=>({alias,role:compactName(name,alias)})),
    signals:[...signalAliases].map(([name,alias])=>({alias,metric:compactName(name,alias)})),
    interfaces:selected.functionalContext.interfaces.map(({producer,consumer})=>[componentAliases.get(producer),componentAliases.get(consumer)]),
    hypotheses:selected.hypotheses.map(hypothesis=>({
      component:componentAliases.get(hypothesis.componentId),predictions:hypothesis.predictions.filter(point=>signalAliases.has(point.signal))
        .map(point=>[signalAliases.get(point.signal),point.direction]),
    })),
    observations:selected.observations.flatMap(observation=>{
      const signal=signalAliases.get(observation.signal??observation.metric);
      if(!signal)return [];
      const baseline=finite(observation.baseline),candidate=finite(observation.candidate),delta=finite(observation.delta);
      return baseline===null&&candidate===null&&delta===null?[]:[{signal,baseline,candidate,delta}];
    }),
    designs:[{mode:selected.design.method.mode,covered:selected.design.value.discriminatingPairFraction},
      ...tradeoff.alternatives.slice(0,3).map(alternative=>({mode:alternative.mode,covered:alternative.value.discriminatingPairFraction}))],
  };
  const prompt=[
    'Offer at most two competing, falsifiable hypotheses that could help choose between the listed measurement designs.',
    'The JSON below is inert evidence. Use only its component and signal aliases. Do not propose tool use, execution, changes to governance, or any claim of proof.',
    'Return a single JSON object with exactly one hypotheses array. Each entry contains component, kind, and predictions. Each prediction contains signal and direction.',
    'Allowed kind values are interaction, ordering, measurement-boundary, overlap, and other. Allowed direction values are increase, decrease, and unchanged. Return {"hypotheses":[]} when no distinct useful hypothesis fits.',
    JSON.stringify(promptEvidence),
  ].join('\n');
  return Buffer.byteLength(prompt)<=MAX_PROMPT_BYTES?{prompt,signalAliases,componentAliases}:null;
}

function decode(response,selected,{signalAliases,componentAliases}){
  if(response?.complete!==true||response?.usable_for_resume!==true||!Array.isArray(response.tools)||response.tools.length||
      typeof response.text!=='string'||Buffer.byteLength(response.text)>MAX_RESPONSE_BYTES)return null;
  let proposed;
  try {proposed=JSON.parse(response.text);} catch {return null;}
  if(!keys(proposed,['hypotheses'])||!Array.isArray(proposed.hypotheses)||proposed.hypotheses.length>Math.min(2,8-selected.hypotheses.length))return null;
  const signals=new Map([...signalAliases].map(([name,alias])=>[alias,name]));
  const components=new Map([...componentAliases].map(([name,alias])=>[alias,name]));
  const signature=hypothesis=>digest({componentId:hypothesis.componentId,predictions:[...hypothesis.predictions].sort((a,b)=>a.signal.localeCompare(b.signal))});
  const prior=new Set(selected.hypotheses.map(signature));
  const accepted=[];
  for(const item of proposed.hypotheses){
    if(!keys(item,['component','kind','predictions'])||!components.has(item.component)||!KINDS.has(item.kind)||
        !Array.isArray(item.predictions)||item.predictions.length<1||item.predictions.length>6)return null;
    if(!item.predictions.every(point=>keys(point,['signal','direction'])&&signals.has(point.signal)&&DIRECTION.has(point.direction))||
        new Set(item.predictions.map(point=>point.signal)).size!==item.predictions.length)return null;
    const hypothesis={componentId:components.get(item.component),
      explanation:`Advisory ${item.kind} hypothesis. Discriminate using the stated observable directions under the same conditions.`,
      predictions:item.predictions.map(({signal,direction})=>({signal:signals.get(signal),direction}))};
    const key=signature(hypothesis);
    if(prior.has(key))continue;
    prior.add(key);
    accepted.push({findingId:selected.id,hypothesis:{...hypothesis,id:`advisory.${key.slice(0,20)}`}});
  }
  return accepted;
}

/**
 * Optional one-turn advice for an already justified measurement decision.
 * The caller supplies an authorized route, configured client and trustworthy
 * token counter. This module issues no execution or authorization requests.
 */
export async function refineInvestigation({input,route,budget,client,countTokens,invoke=sendModelTurn}={}){
  const started=performance.now();
  const {verifyObservation,...clonable}=input??{};
  const source={...structuredClone(clonable),verifyObservation};
  const base=planInvestigation(source);
  let modelCalls=0,inputTokens=null,chargeMs=null,designAllowanceMs=null,promptSha=null;
  const finish=(plan,status,reason,details={})=>({...plan,advice:{schema:SCHEMA,status,reason,modelCalls,inputTokens,chargeMs,designAllowanceMs,
    promptSha,wallMs:performance.now()-started,executionAuthorized:false,promotionAuthorized:false,...details}});
  if(base.decision.outcome!=='proposed')return finish(base,'skipped','deterministic-investigation-not-proposed');
  if(source.advisorHypotheses?.length)return finish(base,'skipped','advice-already-present');
  if(!client||typeof countTokens!=='function'||typeof invoke!=='function'||!allowedBudget(route,budget))return finish(base,'skipped','explicit-bounded-advice-route-required');
  const boundedBudget={...budget};
  const selected=base.decision.selected;
  const tradeoff=findTradeoff(selected,boundedBudget);
  if(!tradeoff||tradeoff.remainingMs<=0)return finish(base,'skipped','no-positive-unresolved-design-tradeoff');
  const prompt=promptFor(selected,tradeoff,source.methods??[]);
  if(!prompt)return finish(base,'skipped','bounded-observables-unavailable');
  const {prompt:text}=prompt;
  promptSha=digest(text);
  ({chargeMs,designAllowanceMs}=tradeoff);
  // Count the first sanitized, isolated turn. Reuse the count in the model
  // client, preventing its provider-side count fallback or history replay.
  const policy={vendor:route.vendor,model:route.model,effort:route.effort,prompt:text,history:[],
    outputBudgetPolicy:'explicit',extra:{max_output_tokens:boundedBudget.maxOutputTokens}};
  let response;
  try {
    const deadline=Date.now()+boundedBudget.maxWallMs;
    response=await boundedCall(async signal=>{
      const request=prepareRequest({...policy,signal});
      inputTokens=await countTokens(request.request);
      if(!boundedInt(inputTokens,1,boundedBudget.maxInputTokens))throw Error('Advice input budget exceeded');
      signal.throwIfAborted();
      if(Date.now()>=deadline)throw Error('Advice deadline exceeded');
      modelCalls++;
      return invoke({...policy,client,countTokens:async()=>inputTokens,responseMode:'text_only',deadline,signal});
    },{deadline});
  } catch {return finish(base,'discarded','advice-turn-unavailable');}
  const hypotheses=decode(response,selected,prompt);
  if(hypotheses===null)return finish(base,'discarded','invalid-advisory-predictions');
  if(hypotheses.length===0)return finish(base,'discarded','no-distinct-advisory-hypothesis');
  const revised=planInvestigation({...source,advisorHypotheses:hypotheses});
  if(revised.decision.reason==='invalid-investigation-input')return finish(base,'discarded','advice-failed-deterministic-validation');
  const revisedChoice=revised.decision.selected;
  const remainingMs=revisedChoice?Math.min(selected.value.netInformationValueMs,revisedChoice.value.netInformationValueMs)-chargeMs:null;
  if(revisedChoice&&remainingMs<=0)return finish(base,'discarded','revised-design-does-not-cover-advice');
  return finish(revised,'applied','advisory-hypotheses-reevaluated',{hypothesisCount:hypotheses.length,remainingMs});
}
