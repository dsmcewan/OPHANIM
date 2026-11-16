// Pure comparison with an already read Pantheon snapshot. This establishes
// correspondence with committed state/events; it does not verify signatures,
// read CAS publications, or execute the verifier. Callers retain those checks.
import {canonical,digest,STATE_SCHEMA} from '../board.mjs';
import {analyzeTrace,applicabilityFingerprint} from './analyze.mjs';

const fail=message=>{throw Error(`Admission trace binding: ${message}`);};
const same=(a,b)=>canonical(a)===canonical(b);
const at=event=>typeof event?.atMs==='number'&&Number.isFinite(event.atMs)&&event.atMs>=0;
const eventValue=({sequence,...event})=>event;
const key=value=>canonical([value.id,value.attempt]);
const sorted=values=>[...values].sort((a,b)=>a.id.localeCompare(b.id));
function acceptedEvent(state,row){return state.events.findLast(event=>event.type==='work.accepted'&&event.id===row.spec.id&&event.attempt===row.accepted?.attempt);}
function graph(state){
  return sorted(Object.values(state.obligations).map(row=>{
    const spec=row.spec,event=acceptedEvent(state,row);
    return {id:spec.id,kind:spec.kind,scope:spec.scope,dependsOn:spec.dependsOn,specSha:digest(spec),status:row.status,
      ...(row.accepted?{acceptedAttempt:row.accepted.attempt}:{}),...(at(event)?{acceptedAt:event.atMs}:{})};
  }));
}
function acceptedProjection(state){
  return sorted(Object.values(state.obligations).filter(row=>row.status==='accepted').map(row=>({
    id:row.spec.id,specSha:digest(row.spec),outputSha:row.accepted.sha256,planRef:row.accepted.planRef,
    evidenceRefs:row.accepted.verification?.evidenceRefs??[],publication:row.candidate.published,
  })));
}
function outputs(state){
  return Object.fromEntries(sorted(Object.values(state.obligations).filter(row=>row.status==='accepted').map(row=>({id:row.spec.id,output:row.accepted.output}))).map(row=>[row.id,row.output]));
}
function effects(state){
  return Object.values(state.effects).filter(effect=>effect.status==='confirmed').map(({key,payload})=>({key,payload})).sort((a,b)=>a.key.localeCompare(b.key));
}
function expectedInputs(state,row,attempt){
  const {expected,...obligation}=row.spec;
  const dependencies=Object.fromEntries(row.spec.dependsOn.map(id=>{
    const accepted=state.obligations[id]?.accepted;
    if(!accepted||digest(accepted.output)!==accepted.sha256)fail('committed dependency output differs');
    return [id,{output:accepted.output,sha256:accepted.sha256}];
  }));
  const inputs={...row.spec.inputs,dependencies};
  return {inputSha:digest(inputs),inputBytes:Buffer.byteLength(canonical(inputs)),
    contextBytes:Buffer.byteLength(canonical({obligation,inputs,priorAttempts:attempt-1}))};
}
function verifyAccepted(state,row,missing,legacy){
  const stored=row.candidate,candidate=stored?.candidate,accepted=row.accepted,proof=accepted?.verification;
  if(!candidate||!accepted||digest(accepted.output)!==accepted.sha256||digest(candidate.output)!==accepted.sha256||candidate.sha256!==accepted.sha256||!same(candidate.output,accepted.output)||!same(row.spec.expected,accepted.output))fail('committed accepted output/candidate differs');
  if(!same(stored.worker,accepted.worker))fail('committed accepted worker differs');
  const dependencies=row.spec.dependsOn.map(id=>({id,sha256:state.obligations[id]?.accepted?.sha256}));
  if(!same(stored.evidence.dependencyVersions,dependencies))fail('committed accepted dependency versions differ');
  if((stored.evidence.totalAttempt??stored.evidence.attempt)!==accepted.attempt)fail('committed accepted attempt differs');
  if(!proof||proof.ok!==true||proof.planRef!==accepted.planRef||proof.obligationId!==row.spec.id||proof.obligationSha!==digest(row.spec)||proof.candidateSha!==accepted.sha256)fail('committed accepted verification identity differs');
  const request={candidate:{id:candidate.id,sha256:candidate.sha256,output:candidate.output},obligation:row.spec,worker:stored.worker,evidence:stored.evidence};
  if(proof.evidenceRefs?.[1]!==`sha256:${digest(request)}`)fail('committed accepted request binding differs');
  const event=acceptedEvent(state,row);
  if(!event||event.sha256!==accepted.sha256)fail('committed acceptance event differs');
  if(!at(event)){if(!legacy)fail('timestamped acceptance event required');missing.add('acceptance-timestamps');}
  if(row.spec.effectKey){
    const effect=state.effects[row.spec.effectKey];
    if(!effect||effect.status!=='confirmed'||effect.obligationId!==row.spec.id||effect.key!==row.spec.effectKey||effect.sha256!==accepted.sha256||!same(effect.payload,accepted.output))fail('committed accepted effect differs');
  }
}

/**
 * Strict by default. `snapshot` may be {commit,state} or the state itself;
 * passing {commit,state} also binds the exact supplied commit reference.
 * legacy:true permits only missing historical timestamps/context/observations;
 * changed evidence still throws and its return is always complete:false.
 */
export function verifyAdmissionTrace(trace,snapshot,{legacy=false}={}){
  if(typeof legacy!=='boolean')fail('explicit boolean legacy option required');
  const wrapped=snapshot?.state!==undefined,state=wrapped?snapshot.state:snapshot;
  if(!state||state.schema!==STATE_SCHEMA||!Array.isArray(state.events)||state.events.length>100000)fail('bounded runtime snapshot required');
  if(trace?.schema!=='ophanim.efficiency.trace/v1'||trace.stateSha!==digest(state)||(wrapped&&trace.boardCommit!==snapshot.commit))fail('exact trace snapshot binding differs');
  const missing=new Set(),settled=state.events.at(-1);
  if(settled?.type!=='runtime.settled')fail('snapshot is not a settled convergence');
  const openedIndex=state.events.findLastIndex(event=>event.type==='runtime.opened'),opened=state.events[openedIndex];
  if(!opened)fail('committed runtime opening required');
  if(!at(opened)||!at(settled)){if(!legacy)fail('timestamped convergence required');missing.add('convergence-timestamps');}
  if(!same(trace.obligations,graph(state))||!same(trace.accepted,acceptedProjection(state)))fail('exact obligation graph or acceptance evidence differs');
  if(!same(trace.release,state.releases[state.activeRelease]))fail('exact release differs');
  if(!same(trace.configuration.workerRegistry,state.releases[state.activeRelease].workers))fail('declared worker registry differs from release');
  if(trace.original?.convergence!==settled.convergence||trace.original.slots!==opened.slots||trace.configuration.slots!==opened.slots||trace.original.outputSha!==digest(outputs(state))||trace.original.effectSha!==digest(effects(state)))fail('original output/effect/convergence projection differs');
  const actualScope=applicabilityFingerprint({obligations:trace.obligations,configuration:trace.configuration});
  if(trace.scopeSha!==actualScope)fail('actual applicability differs');
  const context=opened.efficiencyContext;
  if(context){
    if(!same(trace.configuration,context.configuration)||!same(trace.policy,context.policy)||digest(trace.policy)!==trace.configuration.policySha)fail('exact committed policy/configuration differs');
  }else {if(!legacy)fail('committed efficiency context required');missing.add('committed-policy-context');}
  const analysis=analyzeTrace(trace);
  if(at(opened)&&opened.atMs<trace.window.startedAt||at(settled)&&settled.atMs>trace.window.endedAt)fail('trace window excludes committed run');
  if(trace.original.durationMs===null&&legacy)missing.add('original-run-duration');
  else if(trace.original.durationMs!==trace.window.endedAt-trace.window.startedAt)fail('original duration differs from observation window');
  if(!Array.isArray(trace.events)||trace.events.length>25000)fail('bounded trace event list required');
  let cursor=0;const positions=[];
  for(const event of trace.events){
    while(cursor<state.events.length&&!same(event,eventValue(state.events[cursor])))cursor++;
    if(cursor===state.events.length)fail('trace event differs from committed history');
    positions.push(cursor++);
  }
  if(positions.at(-1)!==state.events.length-1)fail('trace omits final committed convergence');
  if(!positions.includes(openedIndex))fail('trace omits current runtime opening');
  const afterOpen=trace.events.filter((_,index)=>positions[index]>=openedIndex);
  const committedCurrent=state.events.slice(openedIndex).filter(event=>at(event)||legacy).map(eventValue);
  if(!same(afterOpen,committedCurrent))fail('trace omits or changes current committed events');
  for(const event of trace.events)if(at(event)&&(event.atMs<trace.window.startedAt||event.atMs>trace.window.endedAt))fail('trace window excludes recorded event');

  const rows=state.obligations;
  for(const row of Object.values(rows))if(row.status==='accepted')verifyAccepted(state,row,missing,legacy);
  const currentStarts=afterOpen.filter(event=>event.type==='work.started');
  const starts=new Map(currentStarts.map(event=>[key(event),event]));
  if(starts.size!==currentStarts.length)fail('duplicate committed work start');
  const suppliedKeys=new Set(trace.attempts.map(key));
  if(!same([...suppliedKeys].sort(),[...starts.keys()].sort())){
    if(!legacy||[...suppliedKeys].some(value=>!starts.has(value)))fail('exact current attempt set differs');
    missing.add('attempt-observations');
  }
  for(const attempt of trace.attempts){
    const start=starts.get(key(attempt));
    const terminal=afterOpen.filter(event=>['work.persisted','work.failed'].includes(event.type)&&key(event)===key(attempt));
    if(terminal.length!==1)fail('one committed worker completion required');
    const end=terminal[0];
    if(at(start)&&at(end)){
      if(attempt.startedAt!==start.atMs||attempt.endedAt!==end.atMs)fail('attempt timing differs from committed boundaries');
    }else {if(!legacy)fail('committed attempt timestamps required');missing.add('attempt-timestamps');}
    if(attempt.status!==undefined&&attempt.status!==(end.type==='work.persisted'?'produced':'failed'))fail('attempt outcome differs');
    const expected=expectedInputs(state,rows[attempt.id],attempt.attempt);
    for(const field of ['inputSha','inputBytes','contextBytes']){
      if(attempt[field]===undefined&&legacy){missing.add('input-context-observations');continue;}
      if(attempt[field]!==expected[field])fail(`exact committed ${field} differs`);
    }
  }

  const gates=afterOpen.filter(event=>['gate.accepted','gate.rejected'].includes(event.type));
  const gatesByAttempt=new Map();
  for(const gate of gates){const id=key(gate);if(!gatesByAttempt.has(id))gatesByAttempt.set(id,[]);gatesByAttempt.get(id).push(gate);}
  const acceptedBeforeOpening=new Set(Object.values(rows).filter(row=>row.status==='accepted'&&state.events.indexOf(acceptedEvent(state,row))<openedIndex).map(row=>row.spec.id));
  let replayIds=acceptedBeforeOpening;
  if(opened.handoff!==undefined){
    // Frontier handoff: only accepted rows that work still open at the
    // opening consumes were re-verified; recompute that set from the board.
    if(opened.handoff?.mode!=='frontier'||!Array.isArray(opened.handoff.verified))fail('unknown committed handoff verification mode');
    const frontier=new Set();
    for(const row of Object.values(rows))if(!acceptedBeforeOpening.has(row.spec.id))
      for(const dep of row.spec.dependsOn)if(acceptedBeforeOpening.has(dep))frontier.add(dep);
    if(!same(opened.handoff.verified,[...frontier].sort()))fail('committed handoff frontier differs from the board');
    replayIds=frontier;
  }
  const expectedReplays=new Map(Object.values(rows).filter(row=>replayIds.has(row.spec.id)).map(row=>[key({id:row.spec.id,attempt:row.accepted.attempt}),row]));
  const usedReplays=new Set();let gateChecks=0;
  for(const check of trace.verifications){
    if(typeof check.ok!=='boolean'||typeof check.candidateSha!=='string')fail('exact verification envelope required');
    const row=rows[check.id];
    if(check.purpose==='replay'){
      const expected=expectedReplays.get(key(check));
      if(!expected||usedReplays.has(key(check))||check.ok!==true||check.candidateSha!==expected.accepted.sha256)fail('retained candidate replay verification differs');
      if(at(opened)&&check.endedAt>opened.atMs)fail('replay verification exceeds runtime opening boundary');
      usedReplays.add(key(check));
      continue;
    }
    const gate=gatesByAttempt.get(key(check))?.shift();
    if(!gate||check.ok!==(gate.type==='gate.accepted'))fail('verification result differs from committed gate');
    const persisted=state.events.findLast(event=>event.type==='work.persisted'&&key(event)===key(check));
    if(!persisted||persisted.sha256!==check.candidateSha||(gate.type==='gate.accepted'&&gate.sha256!==check.candidateSha))fail('verification candidate differs from committed publication');
    if(at(persisted)&&check.startedAt<persisted.atMs||at(gate)&&check.endedAt>gate.atMs)fail('verification interval escapes publication/gate envelope');
    if(!at(persisted)||!at(gate)){if(!legacy)fail('verification envelope timestamps required');missing.add('verification-envelope-timestamps');}
    if(row.accepted?.attempt===check.attempt&&check.ok&&check.candidateSha!==row.accepted.sha256)fail('verification differs from retained accepted candidate');
    gateChecks++;
  }
  const missingChecks=gateChecks!==gates.length||usedReplays.size!==expectedReplays.size;
  if(missingChecks){if(!legacy)fail('required verification observations are missing');missing.add('verification-observations');}
  return {schema:'ophanim.efficiency.trace-binding/v1',ok:true,complete:!legacy&&missing.size===0,legacy,
    boardCommit:wrapped?snapshot.commit:null,stateSha:trace.stateSha,scopeSha:trace.scopeSha,scopeMatchesRequest:context?context.scopeSha===trace.scopeSha:null,
    verified:{obligations:analysis.obligations.total,attempts:trace.attempts.length,verificationEnvelopes:trace.verifications.length},missing:[...missing].sort(),
    limits:{signatureVerification:false,publicationBytesRead:false,exactVerifierDurationsAuthenticated:false,
      verificationTiming:'Observed intervals are bounded by committed publication/gate events; exact verifier start and end were not committed.',
      windowTiming:'The observation window must enclose committed events; its outer CLI timestamps are not separately committed.'}};
}
