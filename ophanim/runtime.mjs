// Local synthetic planning runtime. Workers propose JSON; only this controller
// records accepted outputs after the injected real TELOS verifier succeeds.
import {STATE_SCHEMA,canonical,digest,clone,withRuntimeBoard,publishWorkerCandidate,loadRuntime,verifyRuntimeChain} from './board.mjs';
export {loadRuntime,STATE_SCHEMA,canonical,digest};

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA=/^[a-f0-9]{64}$/;
export const ASSIGNMENT_POLICY='ophanim.assignment.sorted-id-round-robin/v1';
export const REFILL_POLICY='ophanim.assignment.sorted-id-refill/v1';
export const SCHEDULES=Object.freeze(['wave','refill']);
export const HANDOFF_MODES=Object.freeze(['full','frontier']);
// Accepted rows that a not-yet-accepted obligation will consume next.
export function handoffFrontier(obligations){
  const frontier=new Set();
  for(const row of Object.values(obligations))if(row.status!=='accepted')
    for(const dep of row.spec.dependsOn)if(obligations[dep]?.status==='accepted')frontier.add(dep);
  return [...frontier].sort();
}
const fail=message=>{throw Error(message);};
const frozen=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(frozen);Object.freeze(value);}return value;};
function metadata(worker){
  const out={id:worker.id,version:worker.version,kinds:worker.kinds,scopes:worker.scopes};
  if(!ID.test(out.id??'')||typeof out.version!=='string'||!out.version||!Array.isArray(out.kinds)||!out.kinds.length||!out.kinds.every(x=>ID.test(x))||!Array.isArray(out.scopes)||!out.scopes.length||!out.scopes.every(x=>ID.test(x)))fail('Invalid scoped worker metadata');
  return clone(out);
}
function specOf(value){
  const spec=clone(value);
  if(!ID.test(spec.id??'')||!ID.test(spec.kind??'')||!ID.test(spec.scope??'')||typeof spec.outputKey!=='string'||!spec.outputKey||!Array.isArray(spec.dependsOn)||spec.dependsOn.length>32||spec.dependsOn.some(x=>!ID.test(x))||new Set(spec.dependsOn).size!==spec.dependsOn.length||!Object.hasOwn(spec,'expected'))fail('Invalid synthetic obligation');
  spec.inputs??={};spec.maxAttempts??=3;
  if(spec.effectKey!==undefined&&(typeof spec.effectKey!=='string'||!spec.effectKey||spec.effectKey.length>256))fail('Invalid stable draft effect key');
  if(!spec.inputs||Array.isArray(spec.inputs)||typeof spec.inputs!=='object'||Object.hasOwn(spec.inputs,'dependencies'))fail('Inputs must be an object; dependency context is controller-owned');
  if(!Number.isInteger(spec.maxAttempts)||spec.maxAttempts<1||spec.maxAttempts>8)fail('Bounded maxAttempts required');
  return spec;
}
function validateGraph(rows){
  const active=new Set(),done=new Set(),keys=new Set();
  function visit(id){
    if(done.has(id))return;if(active.has(id))fail('Dependency cycle refused');
    const row=rows[id];if(!row)fail(`Missing dependency ${id}`);active.add(id);
    for(const dep of row.spec.dependsOn){visit(dep);if(rows[dep].spec.scope!==row.spec.scope)fail('Cross-scope dependency requires a separate explicit handoff contract');}
    active.delete(id);done.add(id);
  }
  for(const row of Object.values(rows)){if(keys.has(row.spec.outputKey))fail('Duplicate output ownership');keys.add(row.spec.outputKey);visit(row.spec.id);}
}
function initial(registry){
  return {schema:STATE_SCHEMA,revision:0,obligations:{},effects:{},repairs:{},events:[],activeRelease:'baseline',
    releases:{baseline:{id:'baseline',artifactSha:digest(registry),stateSchema:STATE_SCHEMA,workers:registry,planRef:null}},pendingRelease:null,releaseHistory:[]};
}
async function transitionRelease(ctx,governance,fault=()=>{}){
  const pending=ctx.state.pendingRelease;if(!pending)return;
  const expected={kind:pending.kind,fromRelease:pending.fromRelease,toRelease:pending.release.id,
    artifactSha:pending.release.artifactSha,stateSchema:STATE_SCHEMA,planRef:pending.release.planRef,workers:pending.release.workers};
  const valid=await governance.verifyActivationDecision({decision:clone(pending.decision),expected});
  if(valid?.ok!==true)fail('Release decision refused');
  if(ctx.state.activeRelease!==pending.fromRelease)fail('Release source changed');
  ctx.state.releases[pending.release.id]=clone(pending.release);
  ctx.state.activeRelease=pending.release.id;
  ctx.state.releaseHistory.push({kind:pending.kind,fromRelease:pending.fromRelease,toRelease:pending.release.id,decision:clone(pending.decision)});
  for(const row of Object.values(ctx.state.obligations))if(['held','pending'].includes(row.status)&&!row.candidate){row.status='pending';row.releaseAttempts=0;row.reason=null;}
  ctx.state.pendingRelease=null;
  await ctx.save(ctx.state,{type:'release.activated',kind:pending.kind,release:pending.release.id});
  await fault('after-release-activated',{release:pending.release.id});
}

export async function activateRelease({stateDir,release,governance,kind='activate',fault=()=>{}}){
  if(!['activate','rollback'].includes(kind)||typeof governance?.issueActivationDecision!=='function'||typeof governance?.verifyActivationDecision!=='function')fail('Signed release governance required');
  return withRuntimeBoard(stateDir,async ctx=>{
    if(!ctx.state)fail('Initialize the runtime before activation');
    await transitionRelease(ctx,governance,fault);
    const target=clone(release);
    if(!ID.test(target.id??'')||!SHA.test(target.artifactSha??'')||target.stateSchema!==STATE_SCHEMA||!target.planRef||!Array.isArray(target.workers)||!target.workers.length)fail('Verified release manifest required');
    target.workers=target.workers.map(metadata).sort((a,b)=>a.id.localeCompare(b.id));
    if(new Set(target.workers.map(x=>x.id)).size!==target.workers.length)fail('Duplicate release worker');
    if(ctx.state.releases[target.id]&&canonical(ctx.state.releases[target.id])!==canonical(target))fail('Release identity reused with changed content');
    if(ctx.state.activeRelease===target.id)return clone(ctx.state);
    if(kind==='rollback'&&!ctx.state.releases[target.id])fail('Rollback requires retained prior release');
    const fromRelease=ctx.state.activeRelease;
    const decision=await governance.issueActivationDecision({kind,planRef:target.planRef,fromRelease,toRelease:target.id,artifactSha:target.artifactSha,stateSchema:STATE_SCHEMA,workers:target.workers,evidenceRefs:target.evidenceRefs??[]});
    ctx.state.pendingRelease={kind,fromRelease,release:target,decision:clone(decision)};
    await ctx.save(ctx.state,{type:'release.intent',kind,fromRelease,toRelease:target.id});
    await fault('after-release-intent',{release:target.id});
    await transitionRelease(ctx,governance,fault);
    return clone(ctx.state);
  });
}
export async function rollbackRelease({stateDir,toRelease,governance,fault}){
  const state=loadRuntime(stateDir),release=state?.releases[toRelease];
  if(!release)fail('Unknown rollback release');
  return activateRelease({stateDir,release,governance,kind:'rollback',fault});
}

export async function runRuntime({stateDir,obligations=[],planning=null,workers=[],slots=1,governance,effectAdapter,onEvent=()=>{},fault=()=>{},maxDispatches=100,signal,efficiencyContext=null,schedule='wave',handoffVerification='full'}={}){
  if(typeof stateDir!=='string'||!stateDir||!Number.isInteger(slots)||slots<1||slots>8||!Number.isInteger(maxDispatches)||maxDispatches<1||maxDispatches>10000)fail('Bounded runtime configuration required');
  if(typeof governance?.verifyCandidate!=='function')fail('TELOS governance callback required');
  if(!SCHEDULES.includes(schedule)||!HANDOFF_MODES.includes(handoffVerification))fail('Known schedule and handoff verification mode required');
  if(!Array.isArray(obligations)||obligations.length>1000||!Array.isArray(workers)||workers.length<1||workers.length>32)fail('Bounded obligation and worker sets required');
  const registry=workers.map(metadata).sort((a,b)=>a.id.localeCompare(b.id));
  if(new Set(registry.map(x=>x.id)).size!==registry.length||workers.some(w=>typeof w.run!=='function'))fail('Unique executable workers required');
  const workerMap=new Map(workers.map(w=>[w.id,w]));
  return withRuntimeBoard(stateDir,async ctx=>{
    ctx.state??=initial(registry);const state=ctx.state;
    const before={accepted:Object.values(state.obligations).filter(row=>row.status==='accepted').length,
      effects:Object.values(state.effects).filter(effect=>effect.status==='confirmed').length,
      releases:state.releaseHistory.length};
    const emit=async(type,details={})=>{
      const event={type,atMs:Date.now(),...clone(details)};
      const commit=await ctx.save(state,event);
      onEvent(frozen(event));
      return commit;
    };
    const openedRevision=state.revision;
    if(state.pendingRelease)await transitionRelease(ctx,governance,fault);
    const approved=state.releases[state.activeRelease];
    if(canonical(registry)!==canonical(approved.workers))fail('Worker registry differs from active release');
    let plannedRecord=null;
    if(planning){
      if(typeof governance.authorizePlan!=='function')fail('Governance plan registration required');
      if(obligations.length||typeof planning.planner?.plan!=='function'||!ID.test(planning.planner.id??'')||typeof planning.planner.version!=='string'||typeof planning.validatePlan!=='function')fail('Explicit planning worker and independent plan validator required');
      const request=clone(planning.request),policy=clone(planning.policy);
      const proposal=clone(await planning.planner.plan(frozen({request:clone(request),policy:clone(policy)})));
      if(Buffer.byteLength(canonical(proposal))>262144)fail('Planning output byte bound exceeded');
      const validated=await planning.validatePlan(frozen({proposal:clone(proposal),request:clone(request),policy:clone(policy)}));
      if(validated?.ok!==true||!Array.isArray(validated.obligations)||validated.obligations.length>1000)fail('Planning proposal rejected');
      obligations=clone(validated.obligations);
      plannedRecord={planner:{id:planning.planner.id,version:planning.planner.version},requestSha:digest(request),policySha:digest(policy),proposalSha:digest(proposal),obligationsSha:digest(obligations),proposal};
    }
    for(const input of obligations){
      const spec=specOf(input),old=state.obligations[spec.id];
      if(old&&canonical(old.spec)!==canonical(spec))fail(`Immutable obligation changed: ${spec.id}`);
      if(!old)state.obligations[spec.id]={spec,status:'pending',attempt:0,releaseAttempts:0,candidate:null,history:[],reason:null};
    }
    validateGraph(state.obligations);
    if(plannedRecord){
      state.plans??={};const planId=digest(plannedRecord);
      if(!state.plans[planId]){
        const authorization=await governance.authorizePlan({id:`plan:${planId}`,nodes:obligations.map(value=>state.obligations[value.id].spec)});
        if(authorization?.ok!==true)fail('Governance obligation registration refused');
        plannedRecord.authorization=clone(authorization);
        state.plans[planId]=plannedRecord;await emit('plan.admitted',{planId,obligations:obligations.length,planner:plannedRecord.planner.id});
      }
    }
    function checkDependencyContext(row){
      if(!row.candidate)return;
      const stored=row.candidate,published=stored.published;
      const commit=ctx.board.store.get(published.commit),entry=ctx.board.store.get(published.entry);
      if(!(commit.records??[]).includes(published.entry)||entry.links.log!==published.blob)fail('Candidate publication lineage changed');
      const actual=ctx.board.store.get(published.blob).toString('utf8');
      if(actual!==canonical({candidate:stored.candidate,worker:stored.worker,evidence:stored.evidence,effects:stored.effects}))fail('Candidate differs from immutable Pantheon publication');
      const expected=row.spec.dependsOn.map(id=>{
        const source=state.obligations[id];
        if(source.status!=='accepted'||!source.accepted||digest(source.accepted.output)!==source.accepted.sha256)fail('Candidate dependency is no longer accepted');
        return {id,sha256:source.accepted.sha256};
      });
      if(canonical(expected)!==canonical(row.candidate.evidence.dependencyVersions))fail('Candidate dependency versions differ from accepted inputs');
    }
    // Accepted dependencies retain their original release identity, but their
    // evidence is rechecked from disk before this run can consume them. In
    // frontier mode the verified transition chain carries every accepted row
    // unchanged from its gate acceptance, so only rows that pending work will
    // consume next are sent through TELOS again.
    const frontier=handoffVerification==='frontier'?new Set(handoffFrontier(state.obligations)):null;
    if(frontier&&state.revision>0){
      const chain=verifyRuntimeChain(stateDir);
      if(chain.head!==ctx.board.refs.resolve(ctx.ref))fail('Verified runtime chain differs from the controller head');
    }
    const handoff={mode:handoffVerification,verified:[],skipped:0};
    for(const row of Object.values(state.obligations).sort((a,b)=>a.spec.id.localeCompare(b.spec.id)))if(row.status==='accepted'){
      checkDependencyContext(row);
      if(!row.candidate||digest(row.accepted.output)!==row.accepted.sha256||row.accepted.sha256!==row.candidate.candidate.sha256)fail('Accepted dependency bytes changed');
      if(frontier&&!frontier.has(row.spec.id)){handoff.skipped++;continue;}
      handoff.verified.push(row.spec.id);
      const result=await governance.verifyCandidate({candidate:frozen(clone(row.candidate.candidate)),obligation:frozen(clone(row.spec)),worker:frozen(clone(row.candidate.worker)),evidence:frozen(clone(row.candidate.evidence))});
      if(result?.ok!==true)fail(`Accepted dependency verification refused: ${row.spec.id}`);
    }
    const heldRows=()=>Object.values(state.obligations).filter(r=>r.status!=='accepted').map(r=>({id:r.spec.id,status:r.status,reason:r.reason??'dependency-held'}));
    // Equilibrium: when the verified head already records a settled convergence
    // and nothing in this call changed or remains dispatchable, the existing
    // head is the record. Writing opened/settled again would record a change
    // that did not happen.
    const last=state.events.at(-1);
    if(state.revision===openedRevision&&!state.pendingRelease&&last?.type==='runtime.settled'&&
        !Object.values(state.obligations).some(r=>['running','gating','effect_pending'].includes(r.status)||
          r.status==='pending'&&r.spec.dependsOn.every(id=>state.obligations[id].status==='accepted'))&&
        canonical(heldRows())===canonical(last.blockers??[])){
      const held=heldRows();
      return {state:clone(state),boardCommit:ctx.board.refs.resolve(ctx.ref),accepted:Object.values(state.obligations).filter(r=>r.status==='accepted').map(r=>r.spec.id).sort(),
        held,effects:clone(state.effects),complete:held.length===0,dispatches:0,convergence:held.length?'blocked':'no_change',blockers:clone(held),reused:true,handoff};
    }
    // Defaults leave the opening event exactly as before.
    const policies={...schedule!=='wave'?{schedule}:{},...frontier?{handoff:{mode:'frontier',verified:handoff.verified}}:{}};
    await emit('runtime.opened',{slots,release:state.activeRelease,...policies,...efficiencyContext?{efficiencyContext:clone(efficiencyContext)}:{}});
    // A new controller owns the runtime lock; prior running attempts cannot
    // still legitimately publish. Their next lease is fenced before dispatch.
    for(const row of Object.values(state.obligations))if(row.status==='running'){
      row.status=row.releaseAttempts>=row.spec.maxAttempts?'held':'pending';row.reason='interrupted-worker';
      await emit('work.interrupted',{id:row.spec.id,attempt:row.attempt});
    }
    let dispatches=0;
    async function effectsFor(row){
      for(const proposed of row.candidate.effects){
        if(!effectAdapter||typeof effectAdapter.inspect!=='function'||typeof effectAdapter.apply!=='function')fail('Effect adapter required for synthetic drafts');
        if(typeof proposed.key!=='string'||!proposed.key||!Object.hasOwn(proposed,'payload'))fail('Stable effect key and payload required');
        const key=proposed.key,payload=clone(proposed.payload),sha256=digest(payload);
        let effect=state.effects[key];
        if(effect&&(effect.sha256!==sha256||effect.obligationId!==row.spec.id))fail('Effect identity collision');
        if(!effect){
          effect=state.effects[key]={key,payload,sha256,obligationId:row.spec.id,status:'intent'};
          await emit('effect.intent',{id:row.spec.id,key,sha256});
          await fault('after-effect-intent',clone(effect));
        }
        if(effect.status==='confirmed')continue;
        let observed=await effectAdapter.inspect(key);
        if(observed===null||observed===undefined){
          // Unknown operation outcomes are reconciled by inspect on restart.
          await effectAdapter.apply(frozen(clone(effect)));
          await fault('after-effect-written',clone(effect));
          observed=await effectAdapter.inspect(key);
        }
        if(!observed||observed.key!==key||digest(observed.payload)!==sha256)fail('Synthetic effect outcome unconfirmed or substituted');
        effect.status='confirmed';effect.receipt=clone(observed);
        await emit('effect.confirmed',{id:row.spec.id,key,sha256});
      }
    }
    async function finish(row){
      if(!row.candidate)return;
      checkDependencyContext(row);
      const {candidate,worker,evidence}=row.candidate;
      if(digest(candidate.output)!==candidate.sha256)fail('Candidate output changed');
      // Always reverify retained evidence through TELOS after interruption.
      const result=await governance.verifyCandidate({candidate:frozen(clone(candidate)),obligation:frozen(clone(row.spec)),worker:frozen(clone(worker)),evidence:frozen(clone(evidence))});
      if(result?.ok!==true){
        row.history.push({attempt:row.attempt,status:'gate-rejected',worker:worker.id,candidateSha:candidate.sha256,verification:clone(result??{ok:false})});
        state.repairs??={};state.repairs[`${row.spec.id}:${row.attempt}`]={obligationId:row.spec.id,attempt:row.attempt,scope:row.spec.scope,kind:row.spec.kind,status:'open',reason:'gate-rejected',candidateSha:candidate.sha256,release:state.activeRelease};
        row.candidate=null;row.status=row.releaseAttempts>=row.spec.maxAttempts?'held':'pending';row.reason='gate-rejected';
        await emit('gate.rejected',{id:row.spec.id,attempt:row.attempt});return;
      }
      row.candidate.governance=clone(result);row.status='effect_pending';
      await emit('gate.accepted',{id:row.spec.id,attempt:row.attempt,sha256:candidate.sha256});
      await effectsFor(row);
      row.accepted={output:clone(candidate.output),sha256:candidate.sha256,worker:clone(worker),planRef:result.planRef??null,verification:clone(result),attempt:row.attempt,release:row.candidate.release??state.activeRelease};
      row.history.push({attempt:row.attempt,status:'accepted',worker:worker.id,candidateSha:candidate.sha256});
      row.status='accepted';row.reason=null;
      for(const repair of Object.values(state.repairs??{}))if(repair.obligationId===row.spec.id&&repair.status==='open'){repair.status='resolved';repair.resolvedByAttempt=row.attempt;repair.acceptedSha=candidate.sha256;}
      await emit('work.accepted',{id:row.spec.id,attempt:row.attempt,sha256:candidate.sha256});
    }
    async function execute(row,assignment){
      const eligible=registry.filter(w=>w.kinds.includes(row.spec.kind)&&w.scopes.includes(row.spec.scope));
      if(!eligible.length){row.status='held';row.reason='no-scoped-worker';await emit('work.held',{id:row.spec.id,reason:row.reason});return;}
      const choice=row.releaseAttempts%eligible.length,chosen=eligible[choice],worker=workerMap.get(chosen.id);
      row.attempt++;row.releaseAttempts++;dispatches++;row.status='running';row.reason=null;
      await emit('work.started',{id:row.spec.id,attempt:row.attempt,worker:chosen.id,assignment:{...assignment,choice}});
      const lease=await publishWorkerCandidate({board:ctx.board,ref:ctx.ref,id:row.spec.id,worker:chosen,attempt:row.attempt});
      try{
        const dependencies=Object.fromEntries(row.spec.dependsOn.map(id=>{const accepted=state.obligations[id].accepted;return [id,{output:clone(accepted.output),sha256:accepted.sha256}];}));
        const inputs={...clone(row.spec.inputs),dependencies};
        const {expected,...brief}=row.spec;
        const proposedReply=await worker.run(frozen({obligation:clone(brief),inputs,priorAttempts:row.attempt-1}));
        const replyBytes=canonical(proposedReply);
        if(Buffer.byteLength(replyBytes)>262144)fail('Worker output byte bound exceeded');
        const reply=JSON.parse(replyBytes);
        if(!reply||!Object.hasOwn(reply,'output'))fail('Worker must return output');
        const candidate={id:`${row.spec.id}:${row.attempt}`,sha256:digest(reply.output),output:reply.output,checks:reply.checks??[]};
        const effects=reply.effects??[];if(!Array.isArray(effects)||effects.length>64)fail('Bounded effect proposals required');
        if(row.spec.effectKey){
          if(effects.length!==1||effects[0].key!==row.spec.effectKey||canonical(effects[0].payload)!==canonical(candidate.output))fail('Draft effect must equal accepted output and trusted effect key');
        }else if(effects.length)fail('Obligation has no authorized draft effect');
        const evidence={attempt:row.releaseAttempts,totalAttempt:row.attempt,dependencyVersions:Object.entries(dependencies).map(([id,v])=>({id,sha256:v.sha256})),stateSchema:STATE_SCHEMA};
        await fault('before-work-publish',{id:row.spec.id,attempt:row.attempt,lease:clone(lease.lease),seat:clone(lease.seat)});
        const published=await lease.publish({candidate,worker:chosen,evidence,effects});
        row.candidate={candidate,worker:chosen,evidence,effects,published,release:state.activeRelease};row.status='gating';
        await emit('work.persisted',{id:row.spec.id,attempt:row.attempt,sha256:candidate.sha256});
        await fault('after-work-persisted',{id:row.spec.id,attempt:row.attempt});
      }catch(error){
        if(row.candidate)throw error;
        row.history.push({attempt:row.attempt,status:'worker-failed',worker:chosen.id,reason:String(error.message)});
        state.repairs??={};state.repairs[`${row.spec.id}:${row.attempt}`]={obligationId:row.spec.id,attempt:row.attempt,scope:row.spec.scope,kind:row.spec.kind,status:'open',reason:'worker-failed',release:state.activeRelease};
        row.status=row.releaseAttempts>=row.spec.maxAttempts?'held':'pending';row.reason='worker-failed';
        await emit('work.failed',{id:row.spec.id,attempt:row.attempt,reason:String(error.message)});
      }finally{await lease.release();}
      if(row.candidate)await finish(row);
    }
    for(const row of Object.values(state.obligations).sort((a,b)=>a.spec.id.localeCompare(b.spec.id)))if(['gating','effect_pending'].includes(row.status)){
      const previous=ctx.board.runtime.leaseFor(`item:${row.spec.id}`);
      if(previous?.state==='active')await ctx.board.runtime.release({resource:`item:${row.spec.id}`,holder:previous.holder,gen:previous.gen});
      await finish(row);
    }
    const readyRows=exclude=>Object.values(state.obligations).filter(r=>r.status==='pending'&&!exclude.has(r.spec.id)&&r.spec.dependsOn.every(id=>state.obligations[id].status==='accepted')).sort((a,b)=>a.spec.id.localeCompare(b.spec.id));
    if(schedule==='refill'){
      // Refill: whenever an attempt settles, recompute the ready set and fill
      // the free slots in the same sorted order. Rows still in flight are
      // excluded and recorded, so the verifier can recompute each assignment.
      const inFlight=new Map();let failure=null;
      for(;;){
        if(!failure&&!signal?.aborted&&dispatches<maxDispatches){
          const ready=readyRows(new Set(inFlight.keys()));
          const free=Math.min(slots-inFlight.size,maxDispatches-dispatches);
          if(ready.length&&free>0){
            const readySetSha=digest(ready.map(r=>r.spec.id)),busy=[...inFlight.keys()].sort();
            ready.slice(0,free).forEach((row,rank)=>{
              const id=row.spec.id;
              const job=execute(row,{policy:REFILL_POLICY,readySetSha,ready:ready.length,rank,slots,inFlight:busy})
                .catch(error=>{failure??=error;}).finally(()=>inFlight.delete(id));
              inFlight.set(id,job);
            });
          }
        }
        if(!inFlight.size)break;
        await Promise.race(inFlight.values());
      }
      if(failure)throw failure;
    }
    while(schedule==='wave'&&!signal?.aborted&&dispatches<maxDispatches){
      const ready=readyRows(new Set());
      if(!ready.length)break;
      const jobs=ready.slice(0,Math.min(slots,maxDispatches-dispatches));
      // The assignment is a function of the recorded ready set: sorted ids,
      // first `slots`, worker = eligible[releaseAttempts % eligible.length].
      const readySetSha=digest(ready.map(r=>r.spec.id));
      const outcomes=await Promise.allSettled(jobs.map((row,rank)=>execute(row,{policy:ASSIGNMENT_POLICY,readySetSha,ready:ready.length,rank,slots})));
      const errors=outcomes.filter(r=>r.status==='rejected');
      if(errors.length)throw errors[0].reason;
    }
    const accepted=Object.values(state.obligations).filter(r=>r.status==='accepted').map(r=>r.spec.id).sort();
    const held=heldRows();
    const changed=accepted.length>before.accepted||Object.values(state.effects).filter(effect=>effect.status==='confirmed').length>before.effects||state.releaseHistory.length>before.releases;
    const convergence=held.length?'blocked':changed?'accepted_change':'no_change';
    const blockers=clone(held);
    const boardCommit=await emit('runtime.settled',{accepted:accepted.length,held:held.length,dispatches,convergence,blockers});
    return {state:clone(state),boardCommit,accepted,held,effects:clone(state.effects),complete:held.length===0,dispatches,convergence,blockers,handoff};
  });
}
