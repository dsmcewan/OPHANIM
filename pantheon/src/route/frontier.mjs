import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {canonicalCodeUnit} from '../../../packages/ledger/canonical.mjs';
import {modelId,models,isFrontier,CAPABILITIES} from '../../../packages/model-client/index.mjs';
import {LANES,labOf} from '../config/models.mjs';
import {FACTS} from '../config/facts.mjs';
import {SEATING,INTAKE,BASIS,candidatesFor,modelOf} from '../role/seating.mjs';
import {ROSTER} from '../team/roster.mjs';
import {routeFor,documentedWindow} from './protocol.mjs';
import {taskProfile,classFloor,requirementsOf,effortForDepth,PROFILE_MAPPING,LATENCY_CLIMB} from './task-profile.mjs';
import {FIT_MATRIX,FIT_MATRIX_BODY,FIT_DIFFICULTIES,FIT_ROLES,REVIEWER_ESCALATION,IMPLEMENTER_LADDERS,fitMatrix,fitLadder,
  pinnedReviewer,reviewerEscalation,implementerEscalation,implementerPath,laneFor,laneParts,laneLevels,quotaFailoverFor,lanePinFallback} from './fit-matrix.mjs';
import {adviseSelection} from '../capability/advisory.mjs';
import {isSdkSeat,SDK_TRANSPORT,thinkingLevelsOf} from '../antigravity/config.mjs';

// The fit matrix (fit-matrix.mjs), re-exported so a caller of the selector imports one module.
export {FIT_MATRIX,FIT_DIFFICULTIES,FIT_ROLES,REVIEWER_ESCALATION,IMPLEMENTER_LADDERS,fitMatrix,fitLadder,pinnedReviewer,
  reviewerEscalation,implementerEscalation,implementerPath,laneFor,laneParts,quotaFailoverFor};

// The `fit` candidate's class table (config/classes.json): a declared routing label per registered model,
// every entry provisional.
export const CLASSES=JSON.parse(readFileSync(new URL('../config/classes.json',import.meta.url),'utf8'));

const seats={
  planner:[['anthropic','fable'],['google','carbon'],['openai','astra']],
  implementer:[['openai','astra'],['anthropic','fable'],['google','carbon']],
  scout:[['xai','grok-4.3']],reviewer:[['xai','grok-4.7'],['google','carbon']],
  synthesis:[['google','carbon']],fast_loop:[['google','argon']],
};
/** The ARGO seat table as {role: [{vendor, model}]}, read only: what the capability graph projects as operator placements. */
export const ARGO_SEATS=Object.freeze(Object.fromEntries(Object.entries(seats).map(([role,rows])=>[role,Object.freeze(rows.map(([v,n])=>
  Object.freeze({vendor:v==='google'?'agy_google':v,model:modelId(v,n)})))])));

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
  if(lane?.retired)throw new Error(`Pinned model ${pin} is a retired lane: ${lane.retired}`);
  if(lane)return {vendor:lane.vendor,model:pin};
  throw new Error(`Pinned model ${pin} is in neither the model registry nor a declared lane`);
}
// GEMINI GOES THROUGH ANTIGRAVITY FIRST (owner direction 2026-11-17), under `argo` and `fit`. In a policy order, a
// Google seat that names a metered Gemini API id is served by that model's Antigravity lane first (the lane at the
// seat's effort; `high` when the seat carries none; an effort Antigravity does not offer maps to the highest offered
// level at or below it). The API id stays in the order ONLY as that lane's QUOTA FAILOVER: it carries
// `quota_failover` {base, lanes}, and the dispatcher reaches it only after one of those lanes was refused for quota
// (HTTP 429 / quota exhausted, packages/model-client classifyFailure). Any other lane failure never reaches it
// (route/quota-failover.mjs walks the order). An API id whose model has no lane is left as it is.
// NOT THE GOOGLE IMPLEMENTER (owner direction 2026-11-19): the fit matrix's Google implementer runs on the Gemini API
// itself (GEMINI_API_KEY), with no Antigravity CLI lane in front of it and no metered failover behind it. A seat of the
// Antigravity SDK transport ({transport: "antigravity-sdk"}, fit-matrix.mjs) and its per-file-board form ({transport:
// "api", direct_api: true}; see boardSeat below) are both left exactly as they are.
export const QUOTA_FAILOVER_RULE='used only after an Antigravity lane of the same base model was refused for quota (HTTP 429 / quota exhausted); never on any other failure';
export function antigravityFirst(list,effortOf=c=>c.effort??null){
  const out=[];
  const has=c=>out.some(o=>o.vendor===c.vendor&&o.model===c.model&&Boolean(o.quota_failover)===Boolean(c.quota_failover));
  for(const c of list){
    if(isSdkSeat(c)||c.direct_api){out.push(c);continue;}
    if(c.quota_failover||!(c.vendor==='agy_google'&&seatTransport(c.vendor,c.model)==='api'&&laneLevels(c.model).length)){if(!has(c))out.push(c);continue;}
    let lanes=out.filter(o=>!o.quota_failover&&laneParts(o.model)?.base===c.model).map(o=>o.model);
    if(!lanes.length){
      const {effort:_e,...rest}=c;
      const lane=laneFor(c.model,effortOf(c));
      out.push({...rest,vendor:lane.vendor,model:lane.model,antigravity_first:c.model});
      lanes=[lane.model];
    }
    const spare={...c,quota_failover:{base:c.model,lanes}};
    if(!has(spare))out.push(spare);
  }
  return out;
}
/** A lane seat followed by its quota failover (the metered API id of its base model), where the registry has one. */
export function withQuotaFailover(seat){
  const spare=laneParts(seat.model)&&seatTransport(seat.vendor,seat.model)==='agy-cli'?quotaFailoverFor(seat.model):null;
  return spare?[seat,{...spare,quota_failover:{base:spare.model,lanes:[seat.model]}}]:[seat];
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
  let choices=antigravityFirst((seats[role]??[]).map(([vendor,name])=>({vendor:vendor==='google'?'agy_google':vendor,model:modelId(vendor,name)})));
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
// CLAIMS (owner audit CS1). A selection separates what made a seat ELIGIBLE (constraints: the admission checks,
// and a constraint tag such as SURFACE or ISOLATION with its stated meaning) from why it is ORDERED where it is
// (preference). A constraint tag establishes eligibility only; it never orders candidates. No candidate ordering
// in this repository has matched evidence, so every preference is `unqualified` with no evidence reference; a
// preference may claim `qualified` only with one. Recorded beside the existing reason, which is left as written.
export const CONSTRAINT_TAGS=Object.freeze(['SURFACE','ISOLATION','QUOTA','CONTEXT','CONTINUITY']);
export function claimsOf(c,selection){
  const tag=c.basis??null;
  const constraints=[{check:'role',why:`a candidate in the ${selection.role} role's tables`},
    ...(selection.context?[{check:'context',why:`documented window admits the estimated ${selection.context.estimate_tokens} tokens`}]:[]),
    ...((selection.excluded??[]).some(e=>/lab is avoided|vendor .* is avoided/.test(e.why))?[{check:'independence',why:'avoided vendors and labs excluded'}]:[]),
    ...(CONSTRAINT_TAGS.includes(tag)?[{check:'tag',tag,why:BASIS[tag]}]:[])];
  const explicit=['slot-override','ticket-pin','operator-override','escalation'].includes(selection.source);
  return {constraints,preference:{source:selection.source,
    basis:CONSTRAINT_TAGS.includes(tag)?null:tag,
    kind:explicit?'operator or recorded decision (an authorization, not a ranking)':'declared order (not a measured ranking)',
    status:'unqualified',evidence:null,
    ...(CONSTRAINT_TAGS.includes(tag)?{note:`${tag} establishes eligibility only; it does not order this seat above its alternatives`}:{})}};
}

export const SELECTION_POLICY='pantheon.selection/v1';
export const PRECEDENCE=Object.freeze(['escalation','slot-override','ticket-pin','operator-override','policy']);
// `argo` is this selector's own default. `fit` (the owner's routing matrix, fit-matrix.mjs) is the lifecycle's default
// (ophanim/operate/stages.mjs, owner direction 2026-11-17); its orderings stay unmeasured (docs/routing-task-profile.md).
export const PROFILES=Object.freeze(['argo','legacy','fit']);
// The policy hash is CODE_UNIT_V1 (packages/ledger/canonical.mjs), the order it was always computed in.
const stable=v=>canonicalCodeUnit(v);

/** The policy's identity: its version and a hash over the tables, rules and pools it applies. */
export function selectionPolicy(profile,{pools=[]}={}){
  const row=c=>({vendor:c.vendor,model:c.model??null,tier:c.tier??null,band:c.band??null,basis:c.basis});
  const table=profile==='argo'?seats
    :{...Object.fromEntries(['planner','implementer','reviewer'].map(r=>[r,(SEATING[r]??[]).map(row)])),scout:INTAKE.scout.map(row)};
  // `fit` also hashes what it applies beyond the role tables: the class table, the dimension mapping, the
  // registry it draws candidates from and each role's allowed labs. The argo and legacy bodies are unchanged.
  const fit=profile==='fit'?{classes:CLASSES,mapping:PROFILE_MAPPING,registry:registryModels().map(c=>`${c.vendor}/${c.model}`),
    eligibility:Object.fromEntries(Object.keys(roleTables()).sort().map(r=>[r,roleLabs(r)])),matrix:FIT_MATRIX_BODY}:{};
  // `argo` hashes how its Google seats are served (owner direction 2026-11-17): the Antigravity lane each one starts
  // on and the rule its metered API id is kept under. The seat table itself is unchanged; the legacy body is unchanged.
  const antigravity=profile==='argo'?{antigravity:{rule:QUOTA_FAILOVER_RULE,
    lanes:Object.fromEntries(Object.values(seats).flat().filter(([v])=>v==='google').map(([v,n])=>[modelId(v,n),laneFor(modelId(v,n))?.model??null]).sort())}}:{};
  const body={policy:SELECTION_POLICY,profile,table,precedence:PRECEDENCE,admission:['role','context','lab','pool'],
    pools:pools.map(p=>({id:p.id,vendor:p.vendor})),...fit,...antigravity};
  return {policy:SELECTION_POLICY,profile,hash:'sha256:'+createHash('sha256').update(stable(body)).digest('hex')};
}

const windowOf=model=>documentedWindow(model)??CAPABILITIES[model]?.window??null;

/**
 * The seat for a role, its ordered transport-failover candidates, and the recorded selection. Pure over its
 * inputs; it performs no call. Throws when nothing is admitted.
 *
 * THE CAPABILITY GRAPH IS ADVISORY HERE (knowledge graphs, Slice C1; owner decision 2026-11-20, "Keep the seats as we
 * have them for now until we better understand the metrics"). The live choice is made by liveSelection below, from the
 * owner-directed tables and the fit matrix, exactly as before; only then does adviseSelection add, beside every
 * candidate's selection, the graph-derived eligibility verdict, the decision's digest and the capability snapshot's
 * digest (capability/advisory.mjs). Nothing it computes reaches the live choice: not the seat, the candidates, their
 * order, their pools or the policy hash (the snapshot is NOT hashed into selectionPolicy: the graph chose nothing).
 * `advisory: false` returns the live choice alone; `capability` (a snapshot) replaces the default one.
 */
export function selectSeat(role,opts={}){
  const choice=liveSelection(role,opts);
  return opts.advisory===false?choice:adviseSelection(choice,role,{...opts,argo:ARGO_SEATS});
}

function liveSelection(role,{profile='argo',difficulty='medium',needsContext=null,avoid=[],avoidLabs=[],pools=[],
  pin=null,slotOverride=null,roleOverride=null,explicit=null,task=null}={}){
  if(!PROFILES.includes(profile))throw new Error(`unknown routing profile "${profile}" (known: ${PROFILES.join(', ')})`);
  const id=selectionPolicy(profile,{pools});
  // Under `fit` every selection, explicit seats included, records the task profile it ran under.
  const profiled=profile==='fit'?{...(task??taskProfile({difficulty})),context:{value:needsContext,basis:'derived:prompt-chars'}}:null;
  const base={policy:id.policy,policy_hash:id.hash,profile,role,difficulty,
    context:needsContext===null?null:{estimate_tokens:needsContext,method:'prompt chars / 4'},...(profiled?{task:profiled}:{})};
  const rows=(c,selection)=>{
    // A seat that names its own transport keeps it (the fit matrix's Google implementer, on this surface: boardSeat).
    const transport=c.transport??seatTransport(c.vendor,c.model);
    const poolNamed=Boolean(c.pool&&c.pool!==c.vendor&&transport==='api');
    return seatPools(c.vendor,{pools,pool:c.pool??null,transport}).map(pool=>({vendor:c.vendor,model:c.model,transport,
      pool:pool.id,poolConfig:pool.credential_env?pool:null,poolNamed,basis:c.basis??'OPERATOR',band:c.band??null,why:c.why??null,
      ...(c.effort!==undefined?{effort:c.effort}:{}),...(c.quota_failover?{quota_failover:c.quota_failover}:{}),
      ...(c.direct_api?{direct_api:true,session_transport:c.session_transport}:{}),selection}));
  };
  const finish=groups=>{
    const candidates=groups.flatMap(([c,selection])=>rows(c,selection)).map((c,rank)=>({...c,rank,
      selection:{...c.selection,rank,...(rank?{fallback:true}:{}),
        ...(c.quota_failover?{quota_failover:{...c.quota_failover,used:false,rule:QUOTA_FAILOVER_RULE}}:{}),claims:claimsOf(c,c.selection)}}));
    if(!candidates.length)throw new Error(`no admitted candidate for "${role}"`);
    return {seat:candidates[0],candidates,selection:candidates[0].selection};
  };
  const as=(c,source,reason)=>[c,{...base,source,band:c.band??null,reason}];
  const why=o=>o.why??'operator reseat';
  // A recorded escalation to an Antigravity lane keeps that lane's quota failover (argo and fit): the decision chose
  // the model, and its metered API id is the same model. Every other explicit seat is its chair's only occupant.
  if(explicit&&explicit.source==='escalation'&&profile!=='legacy'){
    const [seat,spare]=withQuotaFailover(explicit.seat);
    return finish([as(seat,explicit.source,explicit.reason),...(spare?[as(spare,explicit.source,`quota failover of ${seat.model}: ${QUOTA_FAILOVER_RULE}`)]:[])]);
  }
  if(explicit)return finish([as(explicit.seat,explicit.source,explicit.reason)]);
  if(slotOverride)return finish([as(slotOverride,'slot-override',`operator per-slot seat: ${why(slotOverride)}`)]);
  if(pin&&roleOverride?.model===pin)return finish([as(roleOverride,'operator-override',`operator seat for ${role}, also the ticket's pin: ${why(roleOverride)}`)]);
  if(pin){
    // A LANE-PINNED IMPLEMENTER UNDER FIT KEEPS LANE SEMANTICS (owner decision 2026-11-20, register L-721; fit-matrix.mjs
    // lanePinFallback). The matrix's own implementer is a primary Gemini API seat, and an exhausted lane does not
    // authorize it: the pin is followed by its lane fallback only. An operator's fallback seat is its own authorization.
    const lanePin=profile==='fit'&&role==='implementer'&&!roleOverride?lanePinFallback(pin,fitLevel(base.task,role).value):null;
    if(lanePin){
      const record={pin,ladder:lanePin.ladder,difficulty:fitLevel(base.task,role).value};
      const note=c=>c.quota_failover?`quota failover of the ticket's pin ${pin}: ${QUOTA_FAILOVER_RULE}`
        :`lane fallback of the ticket's pin ${pin}: the next Antigravity lane of the ${record.difficulty} lane ladder; a lane-pinned ticket is not moved to the primary Gemini API seat`;
      return finish([as({...resolvePinned(pin),why:'the ticket pins this model'},'ticket-pin',`the ticket pins ${pin} for this slot`),
        ...lanePin.seats.map(c=>[c,{...base,source:'policy',band:null,reason:note(c),lane_pin:record}])]);
    }
    const rest=roleOverride?[as(roleOverride,'operator-override',`fallback after the ticket's pin: ${why(roleOverride)}`)]
      :policyCandidates(role,{profile,difficulty,needsContext,avoid,avoidLabs,base}).filter(([c])=>c.model!==pin);
    return finish([as({...resolvePinned(pin),why:'the ticket pins this model'},'ticket-pin',`the ticket pins ${pin} for this slot`),...rest]);
  }
  if(roleOverride)return finish([as(roleOverride,'operator-override',`operator seat for ${role}: ${why(roleOverride)}`)]);
  return finish(policyCandidates(role,{profile,difficulty,needsContext,avoid,avoidLabs,base}));
}

function policyCandidates(role,{profile,difficulty,needsContext,avoid,avoidLabs,base}){
  if(profile==='fit')return fitCandidates(role,{needsContext,avoid,avoidLabs,base});
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
    // A quota failover is kept only with a lane it stands behind.
    for(let i=order.length-1;i>=0;i--)if(order[i].quota_failover&&!order.some(o=>order[i].quota_failover.lanes.includes(o.model)))order.splice(i,1);
    return order.map((c,i)=>[{vendor:c.vendor,model:c.model,basis:'OPERATOR',why:'ARGO November model policy',...(c.quota_failover?{quota_failover:c.quota_failover}:{})},{...base,source:'profile',band:null,excluded,
      reason:`ARGO November model policy: the approved static ${role} order (operator profile); ${c.model} is ${c.quota_failover?`the quota failover of ${c.quota_failover.lanes.join(', ')} (${QUOTA_FAILOVER_RULE})`:i?`admitted fallback ${i}`:'the first admitted seat'}. `+
        (c.antigravity_first?`Gemini goes through Antigravity first (owner direction 2026-11-17): this lane serves ${c.antigravity_first}. `:'')+
        `Ticket difficulty "${difficulty}" does not choose the model under this profile, and no unmeasured ranking replaces the order. Output caps: a frontier seat keeps the frontier client's long-decode default whatever the difficulty, and the difficulty tier is sent only where the request needs a cap of its own (Anthropic Messages without a frontier default); neither cap is measured`}]);
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

// ---------------------------------------------------------------- the `fit` candidate (not the default)
//
// Candidates are EVERY registered model (models.json + lanes.json) the role may use: a model one of the
// role's tables names (`role-table`), or any registry model of a lab those tables already allow
// (`lab-allowed:<lab>`). Admission is the same rule as above (context M7, avoided vendors and labs; pools
// in selectSeat). Then:
//   class      the lowest admitted class >= the floor that stakes (and, for the planner, ambiguity) set
//   breadth    within a class, distinct labs first, in the role's declared lab order (first appearance
//              across its tables, ARGO's first): one model per lab before a second from any
//   fallbacks  across labs at the same class before stepping class; never below the floor; latency
//              `interactive` climbs at most LATENCY_CLIMB.interactive classes above it, `batch` further
//   effort     from depth, on each candidate's OWN documented ladder (task-profile.mjs effortForDepth)
// Every judgment on this path is provisional and unmeasured; docs/routing-task-profile.md is the adoption path.
const VENDOR_OF_REGISTRY=v=>v==='google'?'agy_google':v;
/** Every registered model: the API registry, then each declared lane. */
export function registryModels(){
  const api=Object.entries(models).flatMap(([vendor,names])=>Object.values(names).map(model=>({vendor:VENDOR_OF_REGISTRY(vendor),model,source:'registry'})));
  // A retired lane is declared only so recorded ledgers resolve its name; it is never a candidate.
  const lanes=Object.entries(LANES).flatMap(([lane,names])=>Object.entries(names).filter(([,l])=>!l.retired).map(([model,l])=>({vendor:l.vendor,model,source:`lane:${lane}`})));
  return [...api,...lanes];
}
function roleTables(){
  const t={};
  const add=(role,vendor,model)=>{(t[role]??=[]).push({vendor,model});};
  for(const [role,rows] of Object.entries(seats))for(const [v,n] of rows)add(role,VENDOR_OF_REGISTRY(v),modelId(v,n));
  for(const [role,rows] of Object.entries({...SEATING,...INTAKE}))for(const c of rows)add(role,c.vendor,modelOf(c));
  // The fit matrix's own rows (fit-matrix.mjs): the roles it adds (dispatcher, subagent) exist only here, and the
  // reviewer's row is the dispatcher's models. Consumed by `fit` alone (roleLabs, the fit hash).
  for(const role of FIT_ROLES)for(const d of FIT_DIFFICULTIES)for(const c of fitLadder(role,d))add(role,c.vendor,c.model);
  return t;
}
// The explorer bench (`fit` only): the scout role's tables (ARGO `scout`, INTAKE) name two labs, but explorer
// width is counted in DISTINCT labs and reaches 3 for contested work. The roster's scout/explorer chair
// (team/roster.mjs `scout@opt`, candidates agy_google, xai, openai) is the declared bench for that chair, so its
// labs are allowed after the tables' own, in the roster's order. PROVISIONAL, like every fit judgment.
const EXPLORER_BENCH=Object.freeze({scout:'scout@opt'});
/** The labs a role's tables allow, in declared order (first appearance across its tables, ARGO first). */
export function roleLabs(role){
  const bench=EXPLORER_BENCH[role]?ROSTER[EXPLORER_BENCH[role]].candidates.map(v=>labOf(v)):[];
  return [...new Set([...(roleTables()[role]??[]).map(c=>labOf(c.vendor,c.model)),...bench])];
}
const classRank=m=>CLASSES.order.indexOf(CLASSES.models[m]?.class);

/**
 * The matrix column a task runs in: the ticket's difficulty, RAISED by the profile's class floor (stakes; ambiguity
 * for the planner) when that floor is above it. fast|standard|frontier are the easy|medium|hard columns. A floor
 * never lowers a pick: a hard ticket with low stakes stays hard.
 */
export function fitLevel(task,role){
  const ticket=FIT_DIFFICULTIES.indexOf(task.difficulty?.value??'medium');
  const floor=classFloor(task,role,CLASSES.order);
  const at=Math.max(ticket,CLASSES.order.indexOf(floor.value));
  return {value:FIT_DIFFICULTIES[at],ticket:FIT_DIFFICULTIES[ticket],class:CLASSES.order[at],raised:at>ticket,floor,
    why:at>ticket?`raised from ${FIT_DIFFICULTIES[ticket]} by the class floor ${floor.value} (${floor.why})`
      :`ticket difficulty ${FIT_DIFFICULTIES[ticket]}; the class floor ${floor.value} does not raise it (a floor never lowers a pick)`};
}

// THE SURFACE THIS SELECTOR SEATS (owner direction 2026-11-19). The fit matrix's Google implementer is a seat of the
// Antigravity SDK transport: a tool-enabled SESSION on a work unit, which the pipeline runs (ophanim/operate/stages.mjs
// takes those seats from fit-matrix.mjs, not from here). This selector's callers are the per-file board
// (board/run-item.mjs) and what reports on it; the board's implementer is ONE TOOL-LESS TURN whose reply the board
// writes to disk itself. There the same model, at the same thinking level, is asked through the Gemini API client
// (GEMINI_API_KEY): no Antigravity CLI lane is started for it and it has no metered failover behind it, because it IS
// the Gemini API. The seat says what it is ({transport: "api", direct_api: true, session_transport: "antigravity-sdk"}).
export const BOARD_SURFACE='per-file board: one tool-less turn through the Gemini API client; the pipeline runs the same model as an Antigravity SDK session';
const boardSeat=c=>({transport:'api',direct_api:true,session_transport:c.transport,matrixEffort:c.effort??null});

function fitCandidates(role,{needsContext,avoid,avoidLabs,base}){
  const task=base.task;
  const labs=roleLabs(role);
  const tableOrder=[...new Set((roleTables()[role]??[]).map(c=>c.model))];
  const excluded=[];
  const level=fitLevel(task,role);
  // The floor the rest of the order is held to: the profile's own floor, never below the matrix column.
  const floor={value:level.class,why:level.raised?level.floor.why:`${level.floor.why}; ticket difficulty ${level.ticket} -> ${level.class}`};
  const floorRank=CLASSES.order.indexOf(floor.value);
  const climb=LATENCY_CLIMB[task.latency.value];
  const admissible=c=>{
    if(avoid.includes(c.vendor)){excluded.push({model:c.model,why:`vendor ${c.vendor} is avoided`});return false;}
    if(avoidLabs.includes(c.lab)){excluded.push({model:c.model,why:`the ${c.lab} lab is avoided (independence)`});return false;}
    const w=windowOf(c.model);
    if(needsContext!==null&&w===null){excluded.push({model:c.model,why:`window unrecorded; cannot admit an estimated ${needsContext}`});return false;}
    if(needsContext!==null&&w<needsContext){excluded.push({model:c.model,why:`documented window ${w} < estimated ${needsContext}`});return false;}
    return true;
  };
  // THE MATRIX HEAD (fit-matrix.mjs): the role's pick for this column -- for the implementer its ladder, each rung the
  // matrix's model at the thinking level the matrix seats it at, in the form THIS selector's caller runs (boardSeat). A
  // lane rung, where a ladder holds one, is followed by the metered API id of the pick's base model as its quota
  // failover. Admitted like any candidate.
  const ladder=FIT_ROLES.includes(role)?fitLadder(role,level.value):[];
  const matrix=ladder.length?{schema:FIT_MATRIX_BODY.schema,role,difficulty:level.value,ticket_difficulty:level.ticket,raised:level.raised,why:level.why,
    pick:ladder[0].model,ladder:ladder.map(c=>c.model),...(isSdkSeat(ladder[0])?{transport:'api',session_transport:SDK_TRANSPORT,efforts:ladder.map(c=>c.effort??null),surface:BOARD_SURFACE}:{}),
    ...(role==='reviewer'?{pinned_to:'dispatcher',escalation:REVIEWER_ESCALATION.map(c=>c.model)}:{})}:null;
  const head=ladder.map(c=>({vendor:c.vendor,model:c.model,lab:labOf(c.vendor,c.model),eligibility:'fit-matrix',...(isSdkSeat(c)?boardSeat(c):{})})).filter(admissible);
  if(role==='implementer'&&head.some(c=>c.model===ladder[0].model)){
    const spare=quotaFailoverFor(ladder[0].model);
    if(spare)head.push({vendor:spare.vendor,model:spare.model,lab:labOf(spare.vendor,spare.model),eligibility:'fit-matrix',
      fixedEffort:spare.effort,quota_failover:{base:spare.model,lanes:head.filter(c=>laneParts(c.model)?.base===spare.model).map(c=>c.model)}});
  }
  const pool=registryModels().filter(c=>labs.includes(labOf(c.vendor,c.model))).map(c=>({...c,lab:labOf(c.vendor,c.model),
    eligibility:tableOrder.includes(c.model)?'role-table':`lab-allowed:${labOf(c.vendor,c.model)}`}));
  const admitted=pool.filter(c=>{
    const cls=CLASSES.models[c.model]?.class;
    if(head.some(h=>h.vendor===c.vendor&&h.model===c.model))return false;
    if(classRank(c.model)===-1){excluded.push({model:c.model,why:'no class in classes.json'});return false;}
    if(!admissible(c))return false;
    if(classRank(c.model)<floorRank){excluded.push({model:c.model,why:`class ${cls} is below the floor ${floor.value}`});return false;}
    if(classRank(c.model)>floorRank+climb){excluded.push({model:c.model,why:`class ${cls} is more than ${climb} above the floor ${floor.value} (latency ${task.latency.value})`});return false;}
    return true;
  });
  // Class ascending from the floor; inside a class, round-robin over the labs in declared order, each lab's
  // role-table models first (in table order), then its other registry models (in registry order).
  const within=(a,b)=>{
    const ia=tableOrder.indexOf(a.model),ib=tableOrder.indexOf(b.model);
    return (ia===-1?1:0)-(ib===-1?1:0)||(ia!==-1&&ib!==-1?ia-ib:0);
  };
  const tail=[];
  for(const rank of [...new Set(admitted.map(c=>classRank(c.model)))].sort((a,b)=>a-b)){
    const byLab=labs.map(lab=>admitted.filter(c=>c.lab===lab&&classRank(c.model)===rank).sort(within));
    for(let i=0;byLab.some(l=>l[i]);i++)for(const l of byLab)if(l[i])tail.push(l[i]);
  }
  // The implementer's order IS its lane ladder and that ladder's quota failover; the wider order follows only when
  // no rung of the ladder is admitted. Every other role's pick is followed by the admitted order. Gemini API ids in
  // it stand behind their Antigravity lane (antigravityFirst), at the level the task's depth maps to.
  const ordered=antigravityFirst([...head,...(role==='implementer'&&head.length?[]:tail)],c=>c.fixedEffort??effortForDepth(task.depth.value,c).value);
  const requirements=requirementsOf(task);
  const kind={value:task.kind.value,basis:task.kind.basis,filter:'unfiltered',
    why:'no cited capability fact separates code/analysis/prose/review ability among these models (capability-facts.json)'};
  const output={value:task.output.value,basis:task.output.basis};
  return ordered.map((c,i)=>{
    const mapped=effortForDepth(task.depth.value,c);
    // A quota failover of a matrix lane runs at that lane's thinking level: the same model at the same setting.
    // An SDK seat's thinking level is the MATRIX's (the level it seats that model at; none where none is recorded), not
    // the task depth's: the pipeline raises it on a rejection (fit-matrix.mjs implementerPath), never the selector.
    const effort=c.direct_api?{value:c.matrixEffort??null,depth:task.depth.value,ladder:thinkingLevelsOf(c.model),
        mapped:c.matrixEffort?`"${c.matrixEffort}": the thinking level the fit matrix seats ${c.model} at`:`none: no thinking level is recorded for ${c.model}, so none is sent`}
      :c.fixedEffort&&mapped.ladder.includes(c.fixedEffort)?{...mapped,value:c.fixedEffort,mapped:`"${c.fixedEffort}": the thinking level of the Antigravity lane this seat stands behind`}:mapped;
    const cls=CLASSES.models[c.model];
    const inMatrix=c.eligibility==='fit-matrix';
    return [{vendor:c.vendor,model:c.model,...(c.direct_api?{transport:c.transport,direct_api:true,session_transport:c.session_transport}:{}),basis:cls.basis,band:null,effort:effort.value,why:`fit: ${inMatrix?`matrix ${role}/${level.value}`:`${cls.class} class`} (${cls.basis}, ${cls.status})`,
      ...(c.quota_failover?{quota_failover:c.quota_failover}:{})},
      {...base,source:'policy',band:null,excluded,class_floor:floor,class:{value:cls.class,model:c.model,basis:cls.basis,status:cls.status},
        eligibility:c.eligibility,effort,output,requirements,kind,latency:{value:task.latency.value,basis:task.latency.basis,climb},lab_order:labs,
        ...(matrix?{matrix}:{}),
        reason:(i?`admitted fallback ${i}: `:'')+(c.quota_failover?`quota failover of ${c.quota_failover.lanes.join(', ')} (${QUOTA_FAILOVER_RULE}): `:'')+
          (inMatrix?`fit matrix (owner direction 2026-11-17; orderings unmeasured): ${role} at ${level.value} (${level.why}); ${c.model}${c.model===ladder[0].model?' is the pick':' is on its ladder'}`
            :`fit profile (provisional, unmeasured): lowest admitted class >= floor ${floor.value} (${floor.why}); `+
              `${c.model} is ${cls.class} (${cls.basis}) from the ${c.lab} lab (${c.eligibility})`)+`; effort ${effort.mapped}`}];
  });
}
