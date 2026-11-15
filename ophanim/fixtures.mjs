import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2)+'\n', {mode:0o600});
  fs.renameSync(temporary, file);
}

// Expected records are explicit fixture answers. Workers below derive their
// results independently from raw input and accepted upstream artifacts.
const EXAMPLES = [
  {raw:{service:' Facilities ',summary:'  Replace   meeting room lamp ',requester:'alex@example.invalid'},
    expected:{service:'facilities',summary:'Replace meeting room lamp',requester:'alex@example.invalid',owner:'Facilities queue'}},
  {raw:{service:' SOFTWARE ',summary:'Install approved   editor',requester:'sam@example.invalid'},
    expected:{service:'software',summary:'Install approved editor',requester:'sam@example.invalid',owner:'IT queue'}},
  {raw:{service:'records',summary:'  Locate current retention template ',requester:'lee@example.invalid'},
    expected:{service:'records',summary:'Locate current retention template',requester:'lee@example.invalid',owner:'Records queue'}},
];
const OWNERS = Object.freeze({facilities:'Facilities queue',software:'IT queue',records:'Records queue'});

export function makeFixtures({count=6,department='operations',namespace='pilot',missingCase=null,routingAliasCase=null}={}) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 200 || !/^[a-z][a-z0-9-]{0,31}$/.test(department) || !/^[a-z][a-z0-9-]{0,31}$/.test(namespace)) throw Error('Bounded synthetic fixture configuration required');
  const obligations=[], expectedEffects=[];
  for (let index=0; index<count; index++) {
    const example=EXAMPLES[index%EXAMPLES.length], caseId=`${namespace}-case-${String(index+1).padStart(3,'0')}`;
    const scope=`department:${department}`, raw={caseId,department,...example.raw,sourceRevision:'synthetic-r1'};
    if(routingAliasCase===caseId)raw.service=' office-support ';
    if (missingCase===caseId) delete raw.requester;
    const normalized={caseId,department,service:routingAliasCase===caseId?'office-support':example.expected.service,summary:example.expected.summary,requester:example.expected.requester,sourceRevision:'synthetic-r1'};
    const routed={...normalized,owner:example.expected.owner};
    const draft={key:`${namespace}:draft:${caseId}`,caseId,department,owner:example.expected.owner,title:`${normalized.service}: ${example.expected.summary}`,requester:example.expected.requester,sourceRevision:'synthetic-r1',status:'draft'};
    const normalizeId=`${caseId}:normalize`, routeId=`${caseId}:route`, draftId=`${caseId}:draft`;
    obligations.push(
      {id:normalizeId,kind:'normalize-intake',scope,inputs:{request:raw},dependsOn:[],outputKey:`${caseId}:normalized`,expected:normalized,maxAttempts:2},
      {id:routeId,kind:'route-intake',scope,inputs:{owners:{...OWNERS}},dependsOn:[normalizeId],outputKey:`${caseId}:routed`,expected:routed,maxAttempts:2},
      {id:draftId,kind:'draft-task',scope,inputs:{actionPrefix:namespace},dependsOn:[routeId],outputKey:`${caseId}:draft`,expected:draft,effectKey:draft.key,maxAttempts:2},
    );
    expectedEffects.push({key:draft.key,payload:draft});
  }
  return {schema:'ophanim.synthetic-fixtures/v1',synthetic:true,namespace,department,obligations,expectedEffects};
}

// A distinct deterministic planning worker receives raw requests and a bounded
// workflow policy. It has no oracle. The controller separately validates every
// proposed field against its approved templates before attaching expected data.
export function createPlanning({batches=[{}]}={}) {
  const fixtures=batches.map(makeFixtures);
  const request={schema:'ophanim.synthetic-planning-request/v1',cases:fixtures.flatMap(f=>f.obligations.filter(row=>row.kind==='normalize-intake').map(row=>({namespace:f.namespace,request:structuredClone(row.inputs.request)})))};
  const policy={schema:'ophanim.synthetic-planning-policy/v1',owners:{...OWNERS},maxAttempts:2,departments:[...new Set(fixtures.map(f=>f.department))].sort(),workflow:'intake-to-draft/v1'};
  const planner={id:'synthetic-intake-planner',version:'1',async plan({request:input,policy:rules}) {
    const obligations=[];
    for(const item of input.cases) {
      const raw=structuredClone(item.request),caseId=raw.caseId,scope=`department:${raw.department}`;
      const normalizeId=`${caseId}:normalize`,routeId=`${caseId}:route`,draftId=`${caseId}:draft`;
      obligations.push(
        {id:normalizeId,kind:'normalize-intake',scope,inputs:{request:raw},dependsOn:[],outputKey:`${caseId}:normalized`,maxAttempts:rules.maxAttempts},
        {id:routeId,kind:'route-intake',scope,inputs:{owners:structuredClone(rules.owners)},dependsOn:[normalizeId],outputKey:`${caseId}:routed`,maxAttempts:rules.maxAttempts},
        {id:draftId,kind:'draft-task',scope,inputs:{actionPrefix:item.namespace},dependsOn:[routeId],outputKey:`${caseId}:draft`,effectKey:`${item.namespace}:draft:${caseId}`,maxAttempts:rules.maxAttempts},
      );
    }
    return {schema:'ophanim.synthetic-plan/v1',obligations};
  }};
  const trusted=fixtures.flatMap(f=>f.obligations);
  const expectedProposal={schema:'ophanim.synthetic-plan/v1',obligations:trusted.map(({expected,...brief})=>brief)};
  return {request,policy,planner,validatePlan({proposal,request:actualRequest,policy:actualPolicy}) {
    if(canonical(actualRequest)!==canonical(request)||canonical(actualPolicy)!==canonical(policy)||canonical(proposal)!==canonical(expectedProposal))return {ok:false,reason:'Plan differs from approved workflow, input, ownership or dependency contract'};
    return {ok:true,obligations:structuredClone(trusted)};
  }};
}

const tidy = value => typeof value === 'string' ? value.trim().replace(/\s+/g,' ') : '';
function upstream(inputs) {
  const values=Object.values(inputs.dependencies??{});
  if (values.length!==1 || !values[0]?.output || typeof values[0].sha256!=='string') throw Error('One accepted upstream artifact required');
  return structuredClone(values[0].output);
}

export function createWorkers({department='operations',departments=[department],version='synthetic-v1',delayMs=15,correctionCase=null,permanentCase=null,routingAliases={},onInterval=()=>{}}={}) {
  if (!Number.isSafeInteger(delayMs) || delayMs<0 || delayMs>1000) throw Error('Synthetic delay out of bounds');
  const scopes=departments.map(value=>`department:${value}`);
  const work = (kind, transform) => ({id:`synthetic-${kind}`,version,kinds:[kind],scopes,
    async run({obligation,inputs,priorAttempts=0}) {
      if (Object.hasOwn(obligation,'expected')) throw Error('Oracle leaked into worker input');
      const startedAt=Date.now();
      try {
        if (delayMs) await new Promise(resolve=>setTimeout(resolve,delayMs));
        return transform({obligation,inputs,priorAttempts});
      } finally {onInterval({id:obligation.id,kind,attempt:priorAttempts+1,startedAt,endedAt:Date.now()});}
    }});
  return [
    work('normalize-intake',({inputs})=>{
      const raw=inputs.request;
      if (!raw || ['caseId','department','service','summary','requester','sourceRevision'].some(key=>!tidy(raw[key]))) throw Error('Required request field missing');
      const output=Object.fromEntries(['caseId','department','service','summary','requester','sourceRevision'].map(key=>[key,tidy(raw[key])]));
      output.service=output.service.toLowerCase();
      return {output,checks:['synthetic-normalized']};
    }),
    work('route-intake',({inputs,priorAttempts})=>{
      const source=upstream(inputs), owner=inputs.owners?.[routingAliases[source.service]??source.service];
      if (!owner) throw Error('Service has no confirmed owner');
      const wrong=source.caseId===permanentCase || source.caseId===correctionCase && priorAttempts===0;
      return {output:{...source,owner:wrong?'Unconfirmed invented owner':owner},checks:['synthetic-routed']};
    }),
    work('draft-task',({inputs})=>{
      const source=upstream(inputs);
      const output={key:`${inputs.actionPrefix}:draft:${source.caseId}`,caseId:source.caseId,department:source.department,owner:source.owner,title:`${source.service}: ${source.summary}`,requester:source.requester,sourceRevision:source.sourceRevision,status:'draft'};
      return {output,checks:['synthetic-drafted'],effects:[{key:output.key,payload:output}]};
    }),
  ];
}

// This is a synthetic destination, separate from the runtime's state. The real
// filesystem write survives killing the process before its acknowledgement.
export function createSyntheticDestination(root) {
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const filename=key=>path.join(root,`${digest(key)}.json`);
  return {
    async inspect(key) {
      try {return JSON.parse(fs.readFileSync(filename(key),'utf8'));}
      catch(error) {if(error.code==='ENOENT')return null;throw error;}
    },
    async apply(effect) {
      if (!effect || typeof effect.key!=='string' || !effect.payload || effect.payload.key!==effect.key || effect.payload.status!=='draft') throw Error('Synthetic draft action required');
      fs.appendFileSync(path.join(root,'apply-events.jsonl'),JSON.stringify({key:effect.key,payloadSha:digest(effect.payload),at:Date.now()})+'\n',{mode:0o600});
      const receipt={schema:'ophanim.synthetic-destination/v1',key:effect.key,payload:structuredClone(effect.payload),writeCount:1,createdAt:Date.now()};
      try {fs.writeFileSync(filename(effect.key),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});}
      catch(error) {
        if(error.code!=='EEXIST')throw error;
        const existing=JSON.parse(fs.readFileSync(filename(effect.key),'utf8'));
        if(canonical(existing.payload)!==canonical(effect.payload))throw Error('Conflicting duplicate destination action');
        return existing;
      }
      return receipt;
    },
    list() {return fs.readdirSync(root).filter(name=>name.endsWith('.json')).sort().map(name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8')));},
    invocations() {const file=path.join(root,'apply-events.jsonl');return fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];},
  };
}

export function outputProjection(state) {
  return Object.fromEntries(Object.entries(state.obligations??{}).filter(([,row])=>row.status==='accepted').sort(([a],[b])=>a.localeCompare(b)).map(([id,row])=>[id,row.candidate?.output??row.accepted?.output??null]));
}

export function intervalSummary(intervals) {
  const points=intervals.flatMap(row=>[[row.startedAt,1],[row.endedAt,-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  let active=0,maxActive=0;
  for(const [,delta] of points){active+=delta;maxActive=Math.max(maxActive,active);}
  return {count:intervals.length,maxActive,workerDurationMs:intervals.reduce((sum,row)=>sum+row.endedAt-row.startedAt,0)};
}
