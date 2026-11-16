// The extracted Pantheon store owns bytes, refs and fenced worker leases. Ophanim
// adds a synthetic obligation snapshot, not a second mutable JSON task database.
import {resolve,join} from 'node:path';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {openBoard} from '../pantheon/src/board/index.mjs';
import {openStore} from '../pantheon/src/board/cas.mjs';
import {openRefs} from '../pantheon/src/board/refs.mjs';
import {publish} from '../pantheon/src/board/dag.mjs';
import {withSeatLock} from '../pantheon/src/seat/lock.mjs';

export const STATE_SCHEMA='ophanim.runtime/v1';
const REF='refs/board/ophanim';
const CONTROLLER=Object.freeze({vendor:'controller'});
export function canonical(value){
  const seen=new Set();
  function walk(v,depth=0){
    if(depth>60)throw Error('JSON nesting bound exceeded');
    if(v===null||typeof v==='string'||typeof v==='boolean')return v;
    if(typeof v==='number'&&Number.isFinite(v))return v;
    if(!v||typeof v!=='object'||seen.has(v)||(!Array.isArray(v)&&![Object.prototype,null].includes(Object.getPrototypeOf(v))))throw Error('Plain finite JSON required');
    seen.add(v);
    const out=Array.isArray(v)?v.map(item=>walk(item,depth+1)):Object.fromEntries(Object.keys(v).sort().map(k=>{
      const d=Object.getOwnPropertyDescriptor(v,k);if(d.get||d.set)throw Error('JSON accessors refused');return [k,walk(v[k],depth+1)];
    }));
    seen.delete(v);return out;
  }
  return JSON.stringify(walk(value));
}
export const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
export const clone=value=>JSON.parse(canonical(value));
export const boardPath=stateDir=>join(resolve(stateDir),'pantheon');
// Controller commits carry either a full state snapshot (the v1 shape) or a
// delta from the parent commit's state: the was/is digests, the one appended
// event and only the entries that changed. Settled heads and release
// activations are always full checkpoints, so readers of settled boards see
// the unchanged v1 record.
const FULL='ophanim-state',DELTA='ophanim-state-delta';
export const DELTA_SCHEMA='ophanim.runtime-delta/v1';
export const CHECKPOINT_INTERVAL=64;
const CHECKPOINT_EVENTS=new Set(['runtime.settled','release.activated']);
const MAPS=['obligations','effects','repairs'];
const MAX_DECODE_DEPTH=CHECKPOINT_INTERVAL*4;
const rawSha=bytes=>createHash('sha256').update(bytes).digest('hex');
function controllerRecord(store,cid){
  const commit=store.get(cid);
  const traces=(commit.records??[]).map(r=>store.get(r)).filter(e=>e.kind==='trace'&&[FULL,DELTA].includes(e.payload?.test));
  if(traces.length!==1)throw Error('Runtime head lacks one controller state record');
  if(commit.author.vendor!=='controller'||traces[0].author.vendor!=='controller')throw Error('Runtime state must be controller-authored');
  return {commit,kind:traces[0].payload.test,value:JSON.parse(store.get(traces[0].links.log).toString('utf8'))};
}
export function diffState(prev,next,{prevSha=digest(prev),nextSha=digest(next)}={}){
  if(next.events.length!==prev.events.length+1)throw Error('A delta records exactly one appended event');
  const changed={},removed=[];
  for(const key of Object.keys(next).sort()){
    if(key==='events'||key==='revision')continue;
    if(MAPS.includes(key)){
      const before=prev[key]??{},after=next[key];
      for(const id of Object.keys(after).sort())if(!Object.hasOwn(before,id)||canonical(before[id])!==canonical(after[id]))(changed[key]??={})[id]=after[id];
      for(const id of Object.keys(before).sort())if(!Object.hasOwn(after,id))removed.push([key,id]);
    }else if(!Object.hasOwn(prev,key)||canonical(prev[key])!==canonical(next[key]))changed[key]=next[key];
  }
  for(const key of Object.keys(prev).sort())if(!Object.hasOwn(next,key))removed.push([key]);
  return {schema:DELTA_SCHEMA,revision:next.revision,prevStateSha:prevSha,stateSha:nextSha,event:next.events.at(-1),changed,removed};
}
export function applyDelta(prev,delta){
  if(delta?.schema!==DELTA_SCHEMA)throw Error('Unsupported runtime delta schema');
  if(digest(prev)!==delta.prevStateSha||delta.revision!==prev.revision+1)throw Error('Runtime delta does not follow its parent state');
  const next=clone(prev);
  next.revision=delta.revision;next.events.push(delta.event);
  for(const [key,value] of Object.entries(delta.changed)){
    if(MAPS.includes(key)){next[key]??={};for(const [id,row] of Object.entries(value))next[key][id]=row;}
    else next[key]=value;
  }
  for(const path of delta.removed){
    if(path.length===1)delete next[path[0]];
    else if(path.length===2&&MAPS.includes(path[0]))delete next[path[0]][path[1]];
    else throw Error('Invalid runtime delta removal');
  }
  if(digest(next)!==delta.stateSha)throw Error('Runtime delta result differs from its recorded state digest');
  return next;
}
// Materializes one commit, given its parent's materialized state when known.
export function materializeCommit(store,cid,parentState){
  const record=controllerRecord(store,cid);
  let state;
  if(record.kind===FULL)state=record.value;
  else{
    if(!parentState)throw Error('Runtime delta requires its parent state');
    state=applyDelta(parentState,record.value);
  }
  if(state.schema!==STATE_SCHEMA)throw Error('Unsupported runtime state schema');
  return {state,kind:record.kind,parents:record.commit.parents??[]};
}
function decode(store,head){
  if(!head)return null;
  const deltas=[];
  let cid=head,record=controllerRecord(store,cid);
  while(record.kind===DELTA){
    deltas.push(record.value);
    if(deltas.length>MAX_DECODE_DEPTH)throw Error('Runtime delta chain exceeds its checkpoint bound');
    const parents=record.commit.parents??[];
    if(parents.length!==1)throw Error('Runtime delta requires exactly one parent');
    cid=parents[0];record=controllerRecord(store,cid);
  }
  let state=record.value;
  for(const delta of deltas.reverse())state=applyDelta(state,delta);
  if(state.schema!==STATE_SCHEMA)throw Error('Unsupported runtime state schema');
  return state;
}
export function loadRuntime(stateDir){
  const root=boardPath(stateDir);
  if(!existsSync(root))return null;
  const store=openStore(root,{readOnly:true}),refs=openRefs(root,{store,readOnly:true});
  return decode(store,refs.resolve(REF));
}
export function readRuntimeSnapshot(stateDir, commit) {
  const root=boardPath(stateDir);
  const store=openStore(root,{readOnly:true});
  const refs=openRefs(root,{store,readOnly:true});
  const head=commit??refs.resolve(REF);
  return {commit:head,state:decode(store,head)};
}
export async function withRuntimeBoard(stateDir,fn){
  return withSeatLock('ophanim-controller',async()=>{
    const board=openBoard(boardPath(stateDir));
    let state=decode(board.store,board.refs.resolve(REF));
    // Concurrent workers can finish together, but controller snapshot commits
    // are serial. Each queued write captures its own complete JSON snapshot.
    let tail=Promise.resolve();
    // Deltas are taken against the last captured snapshot, in capture order,
    // which is also commit order. The first save of a session is a checkpoint.
    let last=null,lastSha=null,sinceFull=Infinity;
    const save=(next,event)=>{
      next.revision=(next.revision??0)+1;
      if(event)next.events.push({sequence:next.revision,...clone(event)});
      const bytes=canonical(next),snapshot=JSON.parse(bytes),sha=rawSha(bytes);
      const full=!last||!event||sinceFull>=CHECKPOINT_INTERVAL||CHECKPOINT_EVENTS.has(event.type);
      const entry=full?{kind:'trace',payload:{test:FULL},blob:bytes}
        :{kind:'trace',payload:{test:DELTA},blob:canonical(diffState(last,snapshot,{prevSha:lastSha,nextSha:sha}))};
      sinceFull=full?0:sinceFull+1;last=snapshot;lastSha=sha;
      const write=async()=>{
        const result=await publish({...board,ref:REF,author:CONTROLLER,budgetCheck:false,
          entries:[entry],msg:event?.type??'snapshot'});
        if(!result.ok)throw Error(`Controller snapshot refused: ${result.why}`);
        state=JSON.parse(bytes);return result.commit;
      };
      const result=tail.then(write);tail=result;return result;
    };
    return fn({board,state,save,ref:REF});
  },{dir:join(resolve(stateDir),'locks'),timeoutMs:30000});
}

export async function publishWorkerCandidate({board,ref,id,worker,attempt,candidate}){
  const seat={vendor:'openai',seat_id:`synthetic-${digest({id,worker:worker.id,attempt}).slice(0,24)}`,mode:'work',occupancy_gen:attempt};
  const resource=`item:${id}`;
  // This controller holds the sole runtime lock. An old running attempt can
  // only belong to a dead prior controller; explicitly fence it on takeover.
  const held=await board.runtime.fence({resource,holder:seat,ttlMs:120000,reason:'new synthetic obligation attempt'});
  const lease={resource,gen:held.lease.gen},wip=`refs/seat/${seat.seat_id}/wip`;
  const branched=await board.refs.branch({name:wip,from:ref,author:seat});
  if(!branched.ok)throw Error(branched.why);
  return {seat,lease,wip,async publish(value){
    const result=await publish({...board,ref:wip,author:seat,lease,budgetCheck:false,
      entries:[{kind:'trace',payload:{test:`candidate:${id}`},blob:canonical(value)}],msg:'synthetic worker candidate'});
    if(!result.ok)throw Error(`Worker fenced/refused: ${result.why}`);
    return {commit:result.commit,entry:result.written[0].cid,blob:board.store.get(result.written[0].cid).links.log};
  },async release(){return board.runtime.release({resource,holder:seat,gen:lease.gen});}};
}

// Walks the controller ref from its head and checks that every snapshot is a
// single recorded transition of its parent: one event, revision+1, and no
// rewrite of accepted obligations, confirmed effects, specs or releases.
// Assignment metadata on work.started is recomputed from the wave's base state.
export const CHAIN_LIMIT=100000;
const ASSIGNMENT='ophanim.assignment.sorted-id-round-robin/v1';
export function verifyRuntimeChain(stateDir,{head}={}){
  const root=boardPath(stateDir);
  const store=openStore(root,{readOnly:true}),refs=openRefs(root,{store,readOnly:true});
  const tip=head??refs.resolve(REF);
  if(!tip)return {ok:true,head:null,commits:0,deltas:0,assignmentsChecked:0,legacyAssignments:0};
  const commits=[];
  for(let cid=tip;cid;){
    if(commits.length>=CHAIN_LIMIT)throw Error('Runtime chain bound exceeded');
    const commit=store.get(cid);
    if((commit.parents??[]).length>1)throw Error(`Runtime chain must be linear: ${cid}`);
    commits.push(cid);cid=commit.parents?.[0]??null;
  }
  commits.reverse();
  const same=(a,b)=>canonical(a)===canonical(b);
  const fail=(cid,message)=>{throw Error(`Runtime chain ${cid}: ${message}`);};
  let parent=null,waveBase=null,wave=null,assignmentsChecked=0,legacyAssignments=0,deltas=0;
  for(const cid of commits){
    // Each commit is materialized from its verified parent; a delta must
    // reproduce its recorded was/is digests exactly.
    const materialized=materializeCommit(store,cid,parent);
    const state=materialized.state;
    if(materialized.kind===DELTA)deltas++;
    const event=state.events.at(-1);
    if(!parent){
      if(state.revision!==1||state.events.length!==1)fail(cid,'chain must start at revision 1 with one event');
    }else{
      if(state.revision!==parent.revision+1)fail(cid,'revision must advance by one');
      if(state.events.length!==parent.events.length+1||!same(state.events.slice(0,-1),parent.events))fail(cid,'events must be append-only, one per transition');
      for(const [id,row] of Object.entries(parent.obligations)){
        const next=state.obligations[id];
        if(!next)fail(cid,`obligation removed: ${id}`);
        if(!same(next.spec,row.spec))fail(cid,`obligation spec changed: ${id}`);
        if(row.status==='accepted'&&!same(next,row))fail(cid,`accepted obligation changed: ${id}`);
      }
      for(const [key,effect] of Object.entries(parent.effects)){
        const next=state.effects[key];
        if(!next||next.sha256!==effect.sha256||next.obligationId!==effect.obligationId)fail(cid,`effect identity changed: ${key}`);
        if(effect.status==='confirmed'&&!same(next,effect))fail(cid,`confirmed effect changed: ${key}`);
      }
      for(const [id,release] of Object.entries(parent.releases))if(!same(state.releases[id],release))fail(cid,`release changed: ${id}`);
      if(state.activeRelease!==parent.activeRelease&&event.type!=='release.activated')fail(cid,'active release changed without activation');
      if(state.releaseHistory.length<parent.releaseHistory.length||!same(state.releaseHistory.slice(0,parent.releaseHistory.length),parent.releaseHistory))fail(cid,'release history rewritten');
    }
    if(event.sequence!==state.revision)fail(cid,'event sequence differs from revision');
    if(event.type==='work.started'){
      const a=event.assignment;
      if(a===undefined)legacyAssignments++;
      else{
        if(!parent)fail(cid,'assignment without a base state');
        if(a.rank===0){waveBase=parent;wave=a.readySetSha;}
        else if(!waveBase||wave!==a.readySetSha)fail(cid,'assignment rank outside its recorded wave');
        const base=waveBase.obligations;
        const ready=Object.values(base).filter(row=>row.status==='pending'&&row.spec.dependsOn.every(dep=>base[dep]?.status==='accepted')).map(row=>row.spec.id).sort();
        const row=base[event.id],workers=state.releases[state.activeRelease].workers;
        const eligible=row?workers.filter(w=>w.kinds.includes(row.spec.kind)&&w.scopes.includes(row.spec.scope)):[];
        if(a.policy!==ASSIGNMENT||a.readySetSha!==digest(ready)||a.ready!==ready.length||ready[a.rank]!==event.id||
          !Number.isInteger(a.slots)||a.rank>=a.slots||!eligible.length||a.choice!==row.releaseAttempts%eligible.length||eligible[a.choice].id!==event.worker)
          fail(cid,`assignment does not follow from the recorded ready set: ${event.id}`);
        assignmentsChecked++;
      }
    }else if(event.type!=='work.held'){waveBase=null;wave=null;}
    parent=state;
  }
  return {ok:true,head:tip,commits:commits.length,deltas,assignmentsChecked,legacyAssignments};
}
