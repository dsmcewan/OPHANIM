// Selection is deterministic and advisory. Callers independently verify
// sources before supplying them; this function does not execute an experiment.
import {canonical,digest} from '../../board.mjs';

const SCHEMA='ophanim.investigation-decision/v1';
const HISTORY='ophanim.investigation-history/v1';
const MAX_WALL_MS=30000,MAX_TRIALS=8,MAX_CONVERGENCES=20;
const DIRECTIONS=new Set(['increase','decrease','unchanged']);
const MODES=new Set(['retained-observation','instrumentation','paired-replay','controlled-ablation']);
const EXPERIMENT=new Set(['paired-replay','controlled-ablation']);
const HISTORY_OUTCOMES=new Set(['proposed','no_change','insufficient_evidence','blocked']);
const ECONOMICS_FIELDS=['expectedConvergences','applicability','confidence','decisionChangeProbability',
  'avoidableLossMsPerConvergence','expectedCandidateGainMsPerConvergence','rolloutMs','regressionMs','opportunityCostMs','sourceSha'];
const CONTROLS=['same-acceptance','scope-and-version','controller-authority','durable-effect-identity'];
const PROTECTED_FUNCTIONS=new Set(['efficiency-admission','optimization-authorization']);
const SYSTEM_METRICS=['total-completion-ms','critical-path-ms','stage-p95-ms','resource-consumption',
  'verification-effort','recovery-behavior','accepted-output-quality','destination-effects'];
const ZERO={executionAuthorized:false,promotionAuthorized:false,modelCalls:0,replays:0,effects:0};
const cmp=(a,b)=>a<b?-1:a>b?1:0;
const sortedUnique=values=>[...new Set(values)].sort(cmp);
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,119}$/.test(value);
const string=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
const amount=(value,max=1e8)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=max;
const boundedList=(value,max)=>Array.isArray(value)&&value.length<=max;
const object=value=>value&&Object.getPrototypeOf(value)===Object.prototype;
function requireThat(condition,message){if(!condition)throw Error(message);}
function idList(value,max=32){return boundedList(value,max)&&value.every(id)&&new Set(value).size===value.length;}

function normalizeHypothesis(hypothesis,componentIds,origin){
  const {id:hypothesisId,componentId,explanation,predictions}=hypothesis;
  requireThat(id(hypothesisId)&&componentIds.includes(componentId)&&string(explanation,512)&&boundedList(predictions,12)&&predictions.length>0,'Bounded hypothesis and predictions required');
  const signals=predictions.map(point=>{
    requireThat(id(point.signal)&&DIRECTIONS.has(point.direction),'Hypotheses require typed observable directions');
    return {signal:point.signal,direction:point.direction};
  }).sort((a,b)=>cmp(a.signal,b.signal));
  requireThat(new Set(signals.map(point=>point.signal)).size===signals.length,'Each hypothesis must give one prediction per signal');
  return {id:hypothesisId,componentId,explanation,predictions:signals,origin,status:'unresolved'};
}

function normalizeFinding(finding,models,functions){
  const {id:findingId,scopeSha,evidenceSha,applicabilitySha,question,decision,metric,componentIds,observations,hypotheses=[]}=finding;
  requireThat(id(findingId)&&scopeSha===models.scopeSha&&hex(evidenceSha)&&hex(applicabilitySha)&&id(metric),'Finding must bind to the exact scope and evidence');
  requireThat(string(question,512)&&string(decision,512)&&idList(componentIds,14)&&componentIds.length&&componentIds.every(name=>functions.has(name)),'Known affected functions and a bounded decision question required');
  requireThat(boundedList(observations,16)&&Buffer.byteLength(canonical(observations))<=16384&&boundedList(hypotheses,8),'Bounded finding observations and hypotheses required');
  return {id:findingId,scopeSha,evidenceSha,applicabilitySha,question,decision,metric,componentIds:[...componentIds].sort(cmp),observations,
    hypotheses:hypotheses.map(hypothesis=>normalizeHypothesis(hypothesis,componentIds,'evidence-guided'))};
}

function inferredFindings(models,functions){
  const groups=new Map();
  for(const fn of models.functions){
    for(const unresolved of fn.uncertainty??[]){
      const observation=fn.observations?.find(row=>row.metric===unresolved.metric);
      if(!observation||!id(observation.metric)||!amount(observation.value)||observation.value===0)continue;
      const group=groups.get(observation.metric)??{functions:new Set(),observations:[]};
      group.functions.add(fn.id);
      group.observations.push({componentId:fn.id,metric:observation.metric,unit:observation.unit,value:observation.value,attribution:observation.attribution});
      groups.set(observation.metric,group);
    }
  }
  const groupsWithCompetition=[...groups].filter(([,group])=>group.functions.size>1).map(([metric,group])=>({
    metric,group,context:functionalContext([...group.functions].sort(cmp),functions),
  }));
  return groupsWithCompetition.sort((a,b)=>b.context.interfaces.length-a.context.interfaces.length||
    b.group.functions.size-a.group.functions.size||cmp(a.metric,b.metric)).slice(0,4).map(({metric,group})=>{
    const componentIds=[...group.functions].filter(name=>functions.has(name)).sort(cmp);
    return {id:`attribute.${metric}`,scopeSha:models.scopeSha,evidenceSha:models.traceSha,
      applicabilitySha:digest({scopeSha:models.scopeSha,registrySha:models.registrySha,metric,componentIds}),
      question:`Which contributing function accounts for the observed ${metric}?`,
      decision:`Decide whether a controlled change to a contributing function can be justified by attributed ${metric}.`,
      metric,componentIds,observations:group.observations.slice(0,16),hypotheses:[]};
  });
}

function functionalContext(componentIds,functions){
  const componentSet=new Set(componentIds),interfaces=[],interactions=new Set(),invariants=new Set();
  for(const name of componentIds){
    const component=functions.get(name);
    for(const dependency of component.dependencies??[]){
      if(componentSet.has(dependency))interfaces.push({producer:dependency,consumer:name,relationship:'declared-dependency'});
    }
    for(const interaction of component.interactions??[]){
      if(interaction.components.filter(member=>componentSet.has(member)).length>1)interactions.add(interaction.id);
    }
    for(const invariant of component.immutableRequirements?.systemInvariantRefs??[])invariants.add(invariant);
  }
  return {interfaces,interactions:[...interactions].sort(cmp),invariants:[...invariants].sort(cmp),causalStatus:'unresolved'};
}

function deriveHypotheses(finding){
  // Registry overlap is a reason to ask for discrimination, not a reason to
  // give one component causal credit. Each hypothesis names contrasting spans.
  return finding.componentIds.slice(0,6).map(componentId=>normalizeHypothesis({
    id:`component.${componentId}`,componentId,
    explanation:`A changed contribution from ${componentId} may dominate ${finding.metric} under the compared conditions.`,
    predictions:finding.componentIds.slice(0,6).map(other=>({
      signal:`${finding.metric}.${other}`,direction:other===componentId?'increase':'unchanged',
    })),
  },finding.componentIds,'structural-alternative'));
}

function normalizeMethod(method){
  const {id:methodId,mode,signals,estimatedCostMs,stop,controls=[],variableIds=[],citations=[],evidenceSha=null}=method;
  requireThat(id(methodId)&&MODES.has(mode)&&idList(signals,48)&&signals.length>0&&idList(controls)&&idList(variableIds,12),'Typed investigation method required');
  requireThat(boundedList(citations,12)&&citations.every(value=>string(value,512))&&(evidenceSha===null||hex(evidenceSha)),'Bounded method provenance required');
  requireThat(amount(estimatedCostMs,MAX_WALL_MS)&&object(stop)&&Object.keys(stop).every(key=>['maxWallMs','maxTrials','maxModelCalls'].includes(key))&&
    Number.isInteger(stop.maxWallMs)&&stop.maxWallMs>0&&stop.maxWallMs<=MAX_WALL_MS&&stop.maxWallMs>=estimatedCostMs&&
    Number.isInteger(stop.maxTrials)&&stop.maxTrials>=0&&stop.maxTrials<=MAX_TRIALS&&stop.maxModelCalls===0,'Investigation budget exceeds fixed bounds');
  requireThat(EXPERIMENT.has(mode)?stop.maxTrials>=2&&variableIds.length>0:stop.maxTrials===0&&variableIds.length===0,'Only a bounded controlled comparison may manipulate variables');
  return {id:methodId,mode,signals:[...signals].sort(cmp),estimatedCostMs,stop:{...stop},controls:sortedUnique([...CONTROLS,...controls]),
    variableIds:[...variableIds].sort(cmp),citations:sortedUnique(citations),evidenceSha};
}

function normalizeEconomics(input){
  if(input===null||input===undefined)return null;
  requireThat(object(input)&&Object.keys(input).every(key=>ECONOMICS_FIELDS.includes(key)),'Unexpected value-of-information or authority input');
  const result=Object.fromEntries(ECONOMICS_FIELDS.map(key=>[key,input[key]??null]));
  for(const [key,value] of Object.entries(result)){
    if(value===null)continue;
    if(key==='sourceSha')requireThat(hex(value),'Economics need a content-addressed source');
    else if(key==='expectedConvergences')requireThat(Number.isInteger(value)&&value>=1&&value<=MAX_CONVERGENCES,'Future applicable work outside fixed bound');
    else requireThat(amount(value,['applicability','confidence','decisionChangeProbability'].includes(key)?1:1e8),'Finite conservative decision inputs required');
  }
  return result;
}

function compareHypotheses(hypotheses,signals){
  const available=new Set(signals);
  const distinguishable=[],unresolved=[];
  for(let left=0;left<hypotheses.length;left++){
    const first=hypotheses[left];
    for(const second of hypotheses.slice(left+1)){
      const predictions=new Map(second.predictions.map(point=>[point.signal,point.direction]));
      const contrasts=first.predictions.filter(point=>available.has(point.signal)&&predictions.has(point.signal)&&predictions.get(point.signal)!==point.direction);
      const pair={hypotheses:[first.id,second.id],contrasts:contrasts.map(point=>({signal:point.signal,[first.id]:point.direction,[second.id]:predictions.get(point.signal)}))};
      (contrasts.length>0?distinguishable:unresolved).push(pair);
    }
  }
  return {distinguishable,unresolved};
}

function estimate(economics,method,coverage){
  const required=ECONOMICS_FIELDS.filter(key=>key!=='expectedCandidateGainMsPerConvergence');
  const missing=required.filter(key=>economics?.[key]===null||economics?.[key]===undefined);
  if(missing.length)return {status:'insufficient_evidence',missing,expectedConvergences:economics?.expectedConvergences??null,
    sourceSha:economics?.sourceSha??null,netInformationValueMs:null};
  // Conservative expected value of information uses a separately sourced
  // avoidable decision loss. It does not assume the proposed change works.
  const future=economics.expectedConvergences*economics.applicability;
  const grossInformationValueMs=future*economics.avoidableLossMsPerConvergence*economics.decisionChangeProbability*economics.confidence*coverage;
  const costs={investigationMs:method.estimatedCostMs,rolloutMs:economics.rolloutMs,regressionMs:economics.regressionMs,opportunityMs:economics.opportunityCostMs};
  const totalCostMs=Object.values(costs).reduce((sum,cost)=>sum+cost,0);
  const expectedCandidateGrossGainMs=economics.expectedCandidateGainMsPerConvergence===null?null:future*economics.expectedCandidateGainMsPerConvergence;
  return {status:'estimated',expectedConvergences:economics.expectedConvergences,applicability:economics.applicability,
    confidence:economics.confidence,decisionChangeProbability:economics.decisionChangeProbability,
    avoidableLossMsPerConvergence:economics.avoidableLossMsPerConvergence,sourceSha:economics.sourceSha,
    discriminatingPairFraction:coverage,grossInformationValueMs,costs,totalCostMs,netInformationValueMs:grossInformationValueMs-totalCostMs,
    expectedCandidateGrossGainMs,estimated:true};
}

function makeDesign(method,hypotheses,variables,economics){
  const controllable=new Map(variables.map(variable=>[variable.id,variable]));
  if(method.variableIds.some(name=>controllable.get(name)?.permittedRange?.kind!=='allowed-levels'))return null;
  const discrimination=compareHypotheses(hypotheses,method.signals);
  if(!discrimination.distinguishable.length)return null;
  const {distinguishable,unresolved}=discrimination;
  const achievedSignals=sortedUnique(distinguishable.flatMap(pair=>pair.contrasts.map(contrast=>contrast.signal)));
  const value=estimate(economics,method,distinguishable.length/(distinguishable.length+unresolved.length));
  return {method,measurementSignals:achievedSignals,manipulatedVariables:method.variableIds.map(name=>({id:name,permittedRange:controllable.get(name).permittedRange})),
    discrimination,value,verification:{boundToRetainedEvidence:true,independent:'TELOS',sameAcceptedOutputs:true,sameDestinationEffects:true,
      measures:SYSTEM_METRICS,decisiveOnlyIfPredictionsDiverge:true,causalClaimFromObservation:false,preserveIndeterminateOutcome:true,
      protocol:'Compare matching evidence under each controlled condition. Look for the predeclared direction across matched samples and retain ambiguous or unmeasured results as unresolved.',
      qualification:'Retain the pinned TELOS acceptance, stage latency, recovery and qualification requirements for policy decisions.'},
    stoppingCondition:{...method.stop,stopWhen:'Discriminating evidence is obtained or any fixed limit, invariant violation, or independent verification refusal is reached.'}};
}

function compareDesigns(a,b){
  // Prefer the strongest admissible value; a cheaper equivalent design wins.
  const net=(b.value.netInformationValueMs??-Infinity)-(a.value.netInformationValueMs??-Infinity);
  return net||a.method.estimatedCostMs-b.method.estimatedCostMs||
    a.discrimination.unresolved.length-b.discrimination.unresolved.length||cmp(a.method.id,b.method.id);
}

function archivable(row){
  const {questionSha,scopeSha,evidenceSha,applicabilitySha,outcome,reason,value}=row;
  return {schema:HISTORY,questionSha,scopeSha,evidenceSha,applicabilitySha,outcome,reason,
    expectedConvergences:value?.expectedConvergences??null,netInformationValueMs:value?.netInformationValueMs??null,economicsSourceSha:value?.sourceSha??null,
    methodEvidenceSha:row.design?.method.evidenceSha??null};
}

function normalizeHistory(row){
  requireThat(row.schema===HISTORY&&[row.questionSha,row.scopeSha,row.evidenceSha,row.applicabilitySha].every(hex)&&
    HISTORY_OUTCOMES.has(row.outcome)&&id(row.reason),'Bounded retained investigation decision required');
  requireThat((row.expectedConvergences===null||Number.isInteger(row.expectedConvergences)&&row.expectedConvergences>=1&&row.expectedConvergences<=MAX_CONVERGENCES)&&
    (row.netInformationValueMs===null||Number.isFinite(row.netInformationValueMs))&&[row.economicsSourceSha,row.methodEvidenceSha].every(value=>value===null||hex(value)),'Retained economic or method bound invalid');
  return row;
}

function materiallyChanged(earlier,candidate){
  if(earlier.evidenceSha!==candidate.evidenceSha&&earlier.applicabilitySha!==candidate.applicabilitySha)return true;
  if(candidate.outcome!=='proposed'||earlier.outcome==='proposed')return false;
  const proposed=candidate.design.value;
  if(earlier.economicsSourceSha!==proposed.sourceSha){
    if(earlier.netInformationValueMs===null)return true;
    const previousRuns=earlier.expectedConvergences??1;
    if(earlier.netInformationValueMs<=0&&proposed.expectedConvergences-previousRuns>=Math.max(2,Math.ceil(previousRuns/4)))return true;
  }
  return earlier.netInformationValueMs===null&&candidate.design.method.evidenceSha!==null&&earlier.methodEvidenceSha!==candidate.design.method.evidenceSha;
}

export function selectInvestigation(input={}){
  const base={schema:SCHEMA,outcome:'no_change',selected:null,candidates:[],historyEntries:[],limits:ZERO};
  try{
    const {models,findings=null,economics=null,economicsByFinding={},methods=[],history=[],advisorHypotheses=[]}=input;
    requireThat(models&&hex(models.scopeSha)&&hex(models.traceSha)&&hex(models.registrySha)&&boundedList(models.functions,14)&&
      idList(models.functions.map(fn=>fn.id),14),'Versioned functional models required');
    requireThat(models.functions.every(fn=>boundedList(fn.observations??[],64)&&boundedList(fn.uncertainty??[],64)&&
      boundedList(fn.interactions??[],24)&&boundedList(fn.dependencies??[],14)&&boundedList(fn.controllableVariables??[],24)),'Functional model exceeds investigation input bounds');
    requireThat((findings===null||boundedList(findings,12))&&boundedList(methods,12)&&boundedList(history,64)&&boundedList(advisorHypotheses,8)&&
      object(economicsByFinding)&&Object.keys(economicsByFinding).length<=12,'Investigation input exceeds fixed limits');
    const functions=new Map(models.functions.map(fn=>[fn.id,fn]));
    const normalized=(findings??inferredFindings(models,functions)).map(finding=>normalizeFinding(finding,models,functions));
    requireThat(idList(normalized.map(finding=>finding.id),12),'Duplicate finding identity');
    const findingIds=new Set(normalized.map(finding=>finding.id));
    requireThat(advisorHypotheses.every(item=>object(item)&&findingIds.has(item.findingId)&&Object.keys(item).every(key=>['findingId','hypothesis'].includes(key))),
      'Advisory input may only submit bounded hypotheses for observed findings');
    const allMethods=methods.map(normalizeMethod);
    requireThat(idList(allMethods.map(method=>method.id),12),'Duplicate method identity');
    const previous=history.map(normalizeHistory);
    const defaultEconomics=normalizeEconomics(economics);
    const candidates=[];
    for(const finding of normalized){
      const questionSha=digest({scopeSha:finding.scopeSha,id:finding.id,metric:finding.metric,componentIds:finding.componentIds});
      const hypotheses=finding.hypotheses.length?finding.hypotheses:deriveHypotheses(finding);
      for(const advisory of advisorHypotheses.filter(item=>item.findingId===finding.id)){
        requireThat(hypotheses.length<8,'Hypothesis count exceeds investigation input bounds');
        hypotheses.push(normalizeHypothesis(advisory.hypothesis,finding.componentIds,'advisory-model'));
      }
      requireThat(idList(hypotheses.map(hypothesis=>hypothesis.id),8),'Duplicate hypothesis identity');
      const variables=[...new Map(finding.componentIds.flatMap(name=>functions.get(name).controllableVariables??[])
        .map(variable=>[variable.id,variable])).values()].sort((a,b)=>cmp(a.id,b.id));
      const estimateInput=Object.hasOwn(economicsByFinding,finding.id)?normalizeEconomics(economicsByFinding[finding.id]):defaultEconomics;
      const designs=hypotheses.length<2?[]:allMethods.map(method=>makeDesign(method,hypotheses,variables,estimateInput)).filter(Boolean).sort(compareDesigns);
      const design=designs[0]??null;
      let outcome='insufficient_evidence',reason=hypotheses.length<2?'no-competing-hypotheses':'no-discriminating-measurement';
      if(finding.componentIds.every(name=>PROTECTED_FUNCTIONS.has(name))){
        outcome='blocked';reason='separate-governed-controller-investigation-required';
      }else if(design){
        if(design.value.netInformationValueMs===null)reason='information-value-unquantified';
        else if(design.value.netInformationValueMs<=0){outcome='no_change';reason='nonpositive-information-value';}
        else {outcome='proposed';reason='positive-information-value';}
      }
      const row={...finding,questionSha,hypotheses,functionalContext:functionalContext(finding.componentIds,functions),
        uncertainty:{resolved:false,unresolvedHypotheses:hypotheses.map(hypothesis=>hypothesis.id)},
        variables:functionVariables(variables,design),outcome,reason,design,alternatives:designs.slice(1).map(option=>({
          methodId:option.method.id,mode:option.method.mode,estimatedCostMs:option.method.estimatedCostMs,value:option.value,
        })),value:design?.value??null};
      const duplicate=previous.find(entry=>entry.scopeSha===row.scopeSha&&entry.questionSha===questionSha&&!materiallyChanged(entry,row));
      if(duplicate){row.outcome='no_change';row.reason='retained-applicable-decision';row.retainedDecision=duplicate;}
      candidates.push(row);
    }
    candidates.sort((a,b)=>cmp(a.questionSha,b.questionSha));
    const eligible=candidates.filter(row=>row.outcome==='proposed').sort((a,b)=>compareDesigns(a.design,b.design)||cmp(a.questionSha,b.questionSha));
    const selected=eligible[0]??null;
    const outcome=selected?'proposed':['insufficient_evidence','blocked'].find(status=>candidates.some(row=>row.outcome===status))??'no_change';
    return {...base,outcome,reason:selected?.reason??candidates.find(row=>row.outcome===outcome)?.reason??'no-unresolved-evidence-linked-question',
      scopeSha:models.scopeSha,traceSha:models.traceSha,modelSha:models.modelSha??null,result:models.system?.result??null,
      selected,candidates,historyEntries:candidates.filter(row=>!row.retainedDecision).map(row=>archivable(
        row===selected||row.outcome!=='proposed'?row:{...row,outcome:'no_change',reason:'deferred-by-higher-information-value'}))};
  }catch(error){return {...base,outcome:'blocked',reason:'invalid-investigation-input',detail:String(error.message).slice(0,256)};}
}

function functionVariables(variables,design){
  return variables.map(variable=>({id:variable.id,status:variable.status,permittedRange:variable.permittedRange,
    selectedForManipulation:design?.method.variableIds.includes(variable.id)??false}));
}
