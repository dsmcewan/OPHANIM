import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {modelId,models,isFrontier,CAPABILITIES} from '../../../packages/model-client/index.mjs';
import {LANES,labOf} from '../config/models.mjs';
import {FACTS} from '../config/facts.mjs';
import {SEATING,INTAKE,candidatesFor,modelOf} from '../role/seating.mjs';
import {routeFor,documentedWindow} from './protocol.mjs';

const seats={
  planner:[['anthropic','fable'],['google','carbon'],['openai','astra']],
  implementer:[['openai','astra'],['anthropic','fable'],['google','carbon']],
  scout:[['xai','grok-4.3']],reviewer:[['xai','grok-4.7'],['google','carbon']],
  synthesis:[['google','carbon']],fast_loop:[['google','argon']],
};

export function readPools({rows,env=process.env}={}){
  rows??=env.PANTHEON_POOLS_FILE?JSON.parse(readFileSync(env.PANTHEON_POOLS_FILE,'utf8')):[];
  if(!Array.isArray(rows))throw new Error('Pool configuration must be an array');
  const ids=new Set(),credentials=new Set();
  return rows.map(row=>{
    if(!/^[A-Za-z0-9_-]+$/.test(row.id??'')||ids.has(row.id)||!['anthropic','openai','xai','agy_google'].includes(row.vendor)||
      !['oauth','key'].includes(row.auth)||!/^[A-Z][A-Z0-9_]*$/.test(row.credential_env??''))throw new Error('Invalid or duplicate pool configuration');
    if(row.auth==='oauth'&&row.vendor!=='anthropic')throw new Error('This API transport supports configured OAuth only for Anthropic');
    const credential=env[row.credential_env];
    if(!credential)throw new Error(`Missing credential environment binding for pool ${row.id}`);
    const fingerprint=createHash('sha256').update(credential).digest('hex');
    if(credentials.has(fingerprint))throw new Error('Two pool IDs use the same credential');
    ids.add(row.id);credentials.add(fingerprint);
    return {id:row.id,vendor:row.vendor,auth:row.auth,credential_env:row.credential_env};
  });
}

// A lane model (lanes.json) is served by its declared transport and vendor; it is never an API id.
const laneOf=(model,vendor=null)=>{
  for(const [lane,names] of Object.entries(LANES))if(names[model]&&(!vendor||names[model].vendor===vendor))return {lane,...names[model]};
  return null;
};
/**
 * The transport a seat is served by: a declared lane's own transport (agy-cli); the shared API client for
 * a frontier model or any non-agy vendor; else the agy transports (non-frontier agy_google, chosen by
 * PANTHEON_AGY_TRANSPORT in run-item.mjs).
 */
export function seatTransport(vendor,model){
  const lane=laneOf(model,vendor);
  if(lane)return lane.transport;
  return isFrontier(model)||vendor!=='agy_google'?'api':'agy';
}
/** Where a pinned model is declared: the API registry or a lane. Never an API-only lookup (audit M6). */
export function resolvePinned(pin){
  const found=Object.entries(models).find(([,names])=>Object.values(names).includes(pin));
  if(found)return {vendor:found[0]==='google'?'agy_google':found[0],model:pin};
  const lane=laneOf(pin);
  if(lane)return {vendor:lane.vendor,model:pin};
  throw new Error(`Pinned model ${pin} is in neither the model registry nor a declared lane`);
}
/**
 * The credential pools a seat may be served from. An API seat that names a pool (other than its bare
 * vendor) is served from exactly that configured pool, with its configuration, and is never re-resolved to
 * the first pool of its vendor (audit M3). A seat naming no pool walks its vendor's configured pools in
 * order. A lane/agy seat spends from the vendor's own login, not from an API credential pool.
 */
export function seatPools(vendor,{pools=[],pool=null,transport='api'}={}){
  const named=pool&&pool!==vendor?pool:null;
  if(transport!=='api'){
    if(named)throw new Error(`seat names API credential pool "${named}", but ${vendor} is served by ${transport}`);
    return [{id:vendor,vendor}];
  }
  const configured=pools.filter(p=>p.vendor===vendor);
  if(named){
    const exact=configured.find(p=>p.id===named);
    if(!exact)throw new Error(`seat names credential pool "${named}", which is not a configured ${vendor} pool`);
    return [exact];
  }
  return configured.length?configured:[{id:vendor,vendor}];
}

export function frontierCandidates(role,{pools=[],avoid=[],pin}={}){
  let choices=(seats[role]??[]).map(([vendor,name])=>({vendor:vendor==='google'?'agy_google':vendor,model:modelId(vendor,name)}));
  if(pin){
    const pinned=resolvePinned(pin);
    choices=[pinned,...choices.filter(c=>c.model!==pin)];
  }
  return choices.filter(c=>!avoid.includes(c.vendor)).flatMap(c=>{
    const transport=seatTransport(c.vendor,c.model);
    return seatPools(c.vendor,{pools,transport}).map(pool=>({...c,pool:pool.id,
      poolConfig:pool.credential_env?pool:null,transport,
      basis:'OPERATOR',band:'hard',why:'ARGO November model policy'}));
  }).map((c,rank)=>({...c,rank}));
}

// ---------------------------------------------------------------- the effective role-selection policy
//
// ONE policy for the initial seat of planning, implementation and review (owner audit 2026-11-16, M1).
// It ADMITS first and chooses second:
//
//   admit   role capability (the role's own table); context fit (the work's estimated context needs a
//           known bound: a documented window smaller than it, or no recorded window at all, is excluded
//           with its reason -- audit M7; a lane's bound is its own cited lanes.json `window`); lab independence (avoided vendors AND avoided labs, by
//           labOf, so a Claude lane served by agy is the anthropic lab); approved pool (seatPools).
//   choose  `legacy`: the ticket's difficulty band (routeFor -> selectFor over the banded SEATING table).
//           `argo`:   the approved static ARGO order. That profile IS the operator's approved policy where it
//                     applies, so it is recorded as a profile override with its reason and is never silently
//                     replaced by a difficulty ranking nobody has measured. Difficulty still sets the output tier.
//
// Explicit choices outrank the policy, in this order, and each is recorded as what it is:
//
//   1. escalation        a recorded protocol decision (step_rung) for this slot
//   2. slot-override     the operator's per-slot seat (`implementer.<index>` or `implementer.<slot>`)
//   3. ticket-pin        the ticket's own slot `model`. A role-wide override naming the SAME model is used as
//                        that seat, pool included; otherwise the fallbacks after the pin are the role-wide
//                        override if there is one, else the admitted policy order
//   4. operator-override the operator's role-wide seat (`--seat role=vendor/model`)
//   5. policy | profile  the admitted choice above
//
// An explicit seat is its chair's only occupant; its pools, in order, are the only transport failover. On
// resume the RECORDED seat continues; only a per-slot override given at resume replaces it (run-item.mjs).
// Every turn records the selection's source, reason, policy version and policy hash.
export const SELECTION_POLICY='pantheon.selection/v1';
export const PRECEDENCE=Object.freeze(['escalation','slot-override','ticket-pin','operator-override','policy']);
const stable=v=>Array.isArray(v)?`[${v.map(stable).join(',')}]`
  :v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`:JSON.stringify(v);

/** The policy's identity: its version and a hash over the tables, rules and pools it applies. */
export function selectionPolicy(profile,{pools=[]}={}){
  const row=c=>({vendor:c.vendor,model:c.model??null,tier:c.tier??null,band:c.band??null,basis:c.basis});
  const table=profile==='argo'?seats
    :{...Object.fromEntries(['planner','implementer','reviewer'].map(r=>[r,(SEATING[r]??[]).map(row)])),scout:INTAKE.scout.map(row)};
  const body={policy:SELECTION_POLICY,profile,table,precedence:PRECEDENCE,admission:['role','context','lab','pool'],
    pools:pools.map(p=>({id:p.id,vendor:p.vendor}))};
  return {policy:SELECTION_POLICY,profile,hash:'sha256:'+createHash('sha256').update(stable(body)).digest('hex')};
}

const windowOf=model=>documentedWindow(model)??CAPABILITIES[model]?.window??null;

/**
 * The seat for a role, its ordered transport-failover candidates, and the recorded selection. Pure over its
 * inputs; it performs no call. Throws when nothing is admitted.
 */
export function selectSeat(role,{profile='argo',difficulty='medium',needsContext=null,avoid=[],avoidLabs=[],pools=[],
  pin=null,slotOverride=null,roleOverride=null,explicit=null}={}){
  const id=selectionPolicy(profile,{pools});
  const base={policy:id.policy,policy_hash:id.hash,profile,role,difficulty,
    context:needsContext===null?null:{estimate_tokens:needsContext,method:'prompt chars / 4'}};
  const rows=(c,selection)=>{
    const transport=seatTransport(c.vendor,c.model);
    const poolNamed=Boolean(c.pool&&c.pool!==c.vendor&&transport==='api');
    return seatPools(c.vendor,{pools,pool:c.pool??null,transport}).map(pool=>({vendor:c.vendor,model:c.model,transport,
      pool:pool.id,poolConfig:pool.credential_env?pool:null,poolNamed,basis:c.basis??'OPERATOR',band:c.band??null,why:c.why??null,selection}));
  };
  const finish=groups=>{
    const candidates=groups.flatMap(([c,selection])=>rows(c,selection)).map((c,rank)=>({...c,rank,
      selection:{...c.selection,rank,...(rank?{fallback:true}:{})}}));
    if(!candidates.length)throw new Error(`no admitted candidate for "${role}"`);
    return {seat:candidates[0],candidates,selection:candidates[0].selection};
  };
  const as=(c,source,reason)=>[c,{...base,source,band:c.band??null,reason}];
  const why=o=>o.why??'operator reseat';
  if(explicit)return finish([as(explicit.seat,explicit.source,explicit.reason)]);
  if(slotOverride)return finish([as(slotOverride,'slot-override',`operator per-slot seat: ${why(slotOverride)}`)]);
  if(pin&&roleOverride?.model===pin)return finish([as(roleOverride,'operator-override',`operator seat for ${role}, also the ticket's pin: ${why(roleOverride)}`)]);
  if(pin){
    const rest=roleOverride?[as(roleOverride,'operator-override',`fallback after the ticket's pin: ${why(roleOverride)}`)]
      :policyCandidates(role,{profile,difficulty,needsContext,avoid,avoidLabs,base}).filter(([c])=>c.model!==pin);
    return finish([as({...resolvePinned(pin),why:'the ticket pins this model'},'ticket-pin',`the ticket pins ${pin} for this slot`),...rest]);
  }
  if(roleOverride)return finish([as(roleOverride,'operator-override',`operator seat for ${role}: ${why(roleOverride)}`)]);
  return finish(policyCandidates(role,{profile,difficulty,needsContext,avoid,avoidLabs,base}));
}

function policyCandidates(role,{profile,difficulty,needsContext,avoid,avoidLabs,base}){
  const excluded=[];
  const admit=c=>{
    if(avoid.includes(c.vendor)){excluded.push({model:c.model,why:`vendor ${c.vendor} is avoided`});return false;}
    const lab=labOf(c.vendor,c.model);
    if(avoidLabs.includes(lab)){excluded.push({model:c.model,why:`the ${lab} lab is avoided (independence)`});return false;}
    const w=windowOf(c.model);
    // M7: an estimate is admitted only against a known bound. An unrecorded window is excluded with its
    // reason, never treated as unlimited -- the same rule routeFor applies on the legacy path.
    if(needsContext!==null&&w===null){excluded.push({model:c.model,why:`window unrecorded; cannot admit an estimated ${needsContext}`});return false;}
    if(needsContext!==null&&w<needsContext){excluded.push({model:c.model,why:`documented window ${w} < estimated ${needsContext}`});return false;}
    return true;
  };
  if(profile==='argo'){
    const order=[...new Map(frontierCandidates(role).map(c=>[`${c.vendor}/${c.model}`,c])).values()].filter(admit);
    return order.map((c,i)=>[{vendor:c.vendor,model:c.model,basis:'OPERATOR',why:'ARGO November model policy'},{...base,source:'profile',band:null,excluded,
      reason:`ARGO November model policy: the approved static ${role} order (operator profile); ${c.model} is ${i?`admitted fallback ${i}`:'the first admitted seat'}. `+
        `Ticket difficulty "${difficulty}" sets the output tier only: this profile does not choose the model by difficulty, and no unmeasured ranking replaces it`}]);
  }
  const seating={...SEATING,[role]:(SEATING[role]??[]).filter(c=>admit({vendor:c.vendor,model:modelOf(c)}))};
  const pick=routeFor(role,{difficulty,needsContext,seating});
  if(!pick.ok)return [];
  const usable=candidatesFor(role,{seating}).filter(c=>!pick.skipped.some(s=>s.model===c.model));
  const ordered=[usable.find(c=>c.model===pick.model)??pick,...usable.filter(c=>c.model!==pick.model)];
  const skipped=[...excluded,...pick.skipped];
  return ordered.map((c,i)=>[{vendor:c.vendor,model:c.model,basis:c.basis,band:c.band??null,why:c.why},{...base,source:'policy',band:c.band??null,excluded:skipped,
    reason:i?`admitted fallback ${i} after ${pick.model} (${c.basis}${c.band?`, ${c.band} band`:''})`
      :`difficulty band: ${pick.why_rung}; ${c.basis}: ${c.why}`}]);
}
