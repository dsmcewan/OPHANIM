import {canonical, digest} from '../../board.mjs';
import {buildContributionRegistry, discoverVariables} from '../contributions.mjs';

const MODEL_SCHEMA='ophanim.functional-models/v1';
const OBSERVATION_SCHEMA='ophanim.functional-observation/v1';
const HEX=/^[a-f0-9]{64}$/;
const ID=/^[a-z0-9][a-zA-Z0-9._:-]{0,127}$/;
const METHODS=['observed','controlled-comparison','ablation'];
const EVENTS_BY_FUNCTION={
  'worker-routing':['work.held','work.failed'],
  'worker-reasoning':['work.failed'],
  scheduling:['work.held'],
  review:['gate.rejected'],
  effects:['effect.intent','effect.confirmed'],
  recovery:['work.interrupted','work.failed','work.held'],
};
const DETERMINISTIC_FIXTURE_FUNCTIONS=new Set(['planning','worker-reasoning','worker-routing','context','scheduling','concurrency']);

function requireThat(condition,message){
  if(!condition)throw Error(`Functional model: ${message}`);
}

// A reference carries no measurement or authority claim. The caller's
// independent evidence reader resolves it anew when constructing a model.
function resolveObservations(references,verifyObservation,registry){
  requireThat(Array.isArray(references)&&references.length<=64,'bounded observation references required');
  if(!references.length)return [];
  requireThat(typeof verifyObservation==='function','independent observation resolver required');
  const functions=new Set(registry.components.map(row=>row.id)),seen=new Set();
  return references.map(reference=>{
    const {receiptSha,observationId}=reference??{};
    requireThat(reference&&Object.keys(reference).length===2&&HEX.test(receiptSha??'')&&ID.test(observationId??''),'exact observation reference required');
    const key=`${receiptSha}:${observationId}`;
    requireThat(!seen.has(key),'duplicate observation reference');
    seen.add(key);
    const result=verifyObservation({receiptSha,observationId});
    requireThat(result&&Object.keys(result).length===10&&result.schema===OBSERVATION_SCHEMA&&
      result.receiptSha===receiptSha&&result.id===observationId&&result.scopeSha===registry.scopeSha&&
      functions.has(result.componentId)&&typeof result.metric==='string'&&ID.test(result.metric)&&
      typeof result.unit==='string'&&ID.test(result.unit)&&Number.isFinite(result.value)&&
      Math.abs(result.value)<=Number.MAX_SAFE_INTEGER&&Number.isInteger(result.samples)&&result.samples>=1&&result.samples<=100000&&
      METHODS.includes(result.method),'resolved observation identity, scope, or measurement differs');
    return {...result,causalStatus:'not-established'};
  }).sort((a,b)=>a.receiptSha.localeCompare(b.receiptSha)||a.id.localeCompare(b.id));
}

function allowedRange(variable,candidateById){
  if(variable.status==='protected')return {kind:'fixed',value:variable.currentValue};
  const levels=variable.candidateRefs.flatMap(id=>{
    const change=candidateById.get(id)?.change;
    return change&&Number.isFinite(change.from)&&Number.isFinite(change.to)?[change.from,change.to]:[];
  });
  if(levels.length)return {kind:'allowed-levels',levels:[...new Set(levels)].sort((a,b)=>a-b),qualification:'independent-controlled-replay-required'};
  return {kind:'unqualified',evidenceRequired:variable.requiredEvidence};
}

function implementationConditions(component){
  const protectedFunction=component.mechanismClass!=='replaceable-mechanism';
  return {
    necessary:{status:'contract-required-when-applicable',when:protectedFunction
      ?'The governed operation exercises this obligation or invariant.'
      :'A downstream consumer needs the declared output or the accepted execution depends on this contract.'},
    redundant:{status:'not-established',when:'Scoped ablation leaves every dependent result, required check, recovery behavior and resource constraint intact.'},
    replaceable:{status:protectedFunction?'mechanism-only':'eligible-for-proposal',when:'The alternative preserves the exact contract and independently passes quality, governance and recovery checks for this scope.'},
    deterministic:{status:DETERMINISTIC_FIXTURE_FUNCTIONS.has(component.id)?'current-synthetic-mechanism':'potential-requires-comparison',
      when:'A closed input contract and independently reproducible outputs permit comparison of a deterministic implementation against the same downstream requirements.'},
  };
}

function eventCounts(trace){
  const counts=new Map();
  for(const event of trace.events??[])counts.set(event.type,(counts.get(event.type)??0)+1);
  return counts;
}

function failureBehavior(id,counts,trace){
  const types=EVENTS_BY_FUNCTION[id]??[];
  const retained=Array.isArray(trace.events)&&trace.events.length>0&&trace.recovery?.measurementCoverage!=='unavailable';
  return {
    coverage:!types.length?'unattributed':retained?'retained-event-counts':'unavailable',
    events:types.map(type=>({type,count:retained?(counts.get(type)??0):null})),
    interpretation:'Events describe the retained window. A reported event can implicate several functions, and absence does not establish reliability.',
  };
}

export function buildFunctionalModels({trace,registry,variables,verifiedObservations=[],verifyObservation}={}){
  const contribution=registry??buildContributionRegistry({trace});
  const catalog=variables??discoverVariables({trace,registry:contribution});
  // The normal caller already builds both catalogs from the same accepted
  // trace. The persisted evidence verifier reconstructs both from raw inputs.
  requireThat(contribution.schema==='ophanim.efficiency.contributions/v1'&&catalog.schema==='ophanim.efficiency.variables/v1'&&
    contribution.scopeSha===catalog.scopeSha&&(!trace.scopeSha||trace.scopeSha===contribution.scopeSha)&&
    contribution.registrySha===catalog.registrySha&&canonical(contribution.evidenceBinding)===canonical(catalog.evidenceBinding)&&
    contribution.evidenceBinding.boardCommit===(trace.boardCommit??null)&&contribution.evidenceBinding.stateSha===(trace.stateSha??null),
    'trace and catalog bindings differ');
  const versions=resolveObservations(verifiedObservations,verifyObservation,contribution);
  const traceSha=digest(trace),counts=eventCounts(trace);
  const candidateById=new Map(catalog.candidateReferences.map(candidate=>[candidate.id,candidate]));
  const evidenceBinding={...contribution.evidenceBinding,traceSha,registrySha:contribution.registrySha,
    variablesSha:digest(catalog),observationReceiptShas:[...new Set(versions.map(observation=>observation.receiptSha))]};
  const functions=contribution.components.map(component=>{
    const applies=row=>row.components.includes(component.id);
    const archived=versions.filter(observation=>observation.componentId===component.id);
    const interactions=contribution.interactions.filter(applies).map(interaction=>({...interaction,evidenceClass:'structural',causalStatus:'unmeasured'}));
    const observations=component.observations.map(row=>({...row,evidence:{kind:row.value===null?'unavailable':'trace-measurement',refs:[traceSha]}}));
    const uncertainty=observations.filter(row=>row.value===null||row.coverage==='partial'||row.attribution==='shared')
      .map(row=>({metric:row.metric,status:'unresolved',reason:row.value===null?'measurement-unavailable':row.coverage==='partial'?'partial-coverage':'shared-attribution',
        evidenceRefs:[traceSha,...archived.filter(observation=>observation.metric===row.metric).map(observation=>observation.receiptSha)]}));
    return {
      id:component.id,purpose:component.purpose,contract:component.contract,mechanismClass:component.mechanismClass,
      consumers:component.consumers,dependencies:component.dependencies,sources:component.sources,
      requiredContribution:{outputs:component.contract.outputs,requiredBy:component.consumers},
      controllableVariables:catalog.variables.filter(variable=>variable.componentIds.includes(component.id)).map(({id,currentValue,status,candidateRefs,requiredEvidence})=>({
        id,currentValue,status,candidateRefs,requiredEvidence,permittedRange:allowedRange({status,currentValue,candidateRefs,requiredEvidence},candidateById),
      })),
      environmentalVariables:catalog.environmentalFactors.filter(applies),
      immutableRequirements:{contractInvariants:component.contract.invariants,systemInvariantRefs:catalog.constraintRefs},
      interactions,
      observations:[...observations,...archived.map(({metric,value,unit,receiptSha,id,samples,method,causalStatus})=>({metric,value,unit,samples,method,causalStatus,
        coverage:'observed',attribution:'scoped-observation',evidence:{kind:'independently-verified',refs:[receiptSha],observationId:id}}))],
      failureBehavior:failureBehavior(component.id,counts,trace),
      hypotheses:interactions.map(interaction=>({interactionId:interaction.id,status:'untested',
        question:'Under the exact acceptance contract, can variation at this interface explain a measured difference in downstream results?',
        evidenceBasis:'inspected-interface',evidenceRefs:[contribution.registrySha]})),
      uncertainty,implementationConditions:implementationConditions(component),
      evidenceBinding:{traceSha,observationReceiptShas:[...new Set(archived.map(observation=>observation.receiptSha))]},
    };
  });
  const model={schema:MODEL_SCHEMA,scopeSha:contribution.scopeSha,traceSha,registrySha:contribution.registrySha,evidenceBinding,functions,
    system:{result:{convergence:trace.original?.convergence??null,outputSha:trace.original?.outputSha??null,effectSha:trace.original?.effectSha??null},criticalPath:contribution.criticalPath},
    authority:{executeInvestigation:false,verifyPolicy:false,activatePolicy:false},
  };
  return {...model,modelSha:digest(model)};
}
