import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createGovernance, TELOS_COMMIT} from '../governance.mjs';
import {hash, canonical} from './check-contract.mjs';
import {createWorkers} from '../fixtures.mjs';
import {FIXTURE_SOURCE_SHA} from './check-release.mjs';

function example() {
  const output = {caseId:'case-1',department:'operations',service:'records',summary:'Find template',requester:'fixture@example.invalid',sourceRevision:'fixture-r1'};
  return {
    obligation:{id:'normalize-1',kind:'normalize-intake',scope:'department:operations',inputs:{},dependsOn:[],outputKey:'normalized-1',expected:output,maxAttempts:2},
    candidate:{id:'normalize-1:1',sha256:hash(output),output,checks:['untrusted']},
    worker:{id:'fixture-normalizer',version:'v1',kinds:['normalize-intake'],scopes:['department:operations']},
    evidence:{attempt:1,dependencyVersions:[],stateSchema:'ophanim.runtime/v1'},
  };
}
async function setup(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ophanim-governance-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return {root,gov:await createGovernance({root,fixtureOnly:true})};
}
function edit(file, modify) {const data=JSON.parse(fs.readFileSync(file,'utf8'));modify(data);fs.writeFileSync(file,canonical(data));}
function releaseRequest(version='synthetic-v1') {
  const options={department:'operations',departments:['operations'],version,delayMs:0,routingAliases:version==='synthetic-v2'?{'office-support':'facilities'}:{}};
  const workers=createWorkers(options).map(({id,version,kinds,scopes})=>({id,version,kinds,scopes})).sort((a,b)=>a.id.localeCompare(b.id));
  const artifact={schema:'ophanim.synthetic-worker-artifact/v1',sourceSha:FIXTURE_SOURCE_SHA,options,workers};
  const output={id:version,artifactSha:hash(artifact),stateSchema:'ophanim.runtime/v1',workers};
  return {obligation:{id:'release:'+version,kind:'synthetic-release',scope:'fixture-release',inputs:{artifact},dependsOn:[],outputKey:'release:'+version,expected:output,maxAttempts:1},candidate:{id:'release:'+version+':1',output,sha256:hash(output),checks:[]},worker:{id:'fixture-release-builder',version:'1',kinds:['synthetic-release'],scopes:['fixture-release']},evidence:{attempt:1,dependencyVersions:[],stateSchema:'ophanim.runtime/v1'}};
}

test('real pinned TELOS lifecycle, signed receipt, artifact and obligation gate survive restart', async t=>{
  const {root,gov}=await setup(t), request=example();
  const proof=await gov.verifyCandidate(request);
  assert.equal(proof.ok,true,proof.reason);
  assert.equal(proof.verification.merge_status,'ready');
  assert.deepEqual(proof.verification.nodes[0].checks,{ledger:'ok',lineage:'ok',signature:'ok',artifact:'ok',test:'ok',obligations:'ok'});
  const again=await (await createGovernance({root})).verifyCandidate(request);
  assert.equal(again.planRef,proof.planRef);
  assert.equal(again.ok,true,again.reason);
  const readonly=await createGovernance({root,readOnly:true});
  assert.equal((await readonly.verifyPlan({planRef:proof.planRef})).ok,true);
  assert.equal((await readonly.verifyCandidate(request)).ok,false);
});

test('every durable partial fixture proposal resumes without replacing signed history', async t=>{
  // Reconstruct termination immediately after each durable event, plus after
  // packets but before the decision. No accepted result/receipt survives these
  // initialization boundaries. The original full record is our byte oracle.
  for (const [count,keepPackets] of [[0,false],[1,false],[2,false],[3,false],[4,false],[5,false],[6,false],[6,true],[7,true]]) {
    const {root,gov}=await setup(t),request=example(),proof=await gov.verifyCandidate(request);
    assert.equal(proof.ok,true,proof.reason);
    const telosDir=path.dirname(proof.paths.plan),proposalFile=path.join(telosDir,'proposal.jsonl');
    const complete=fs.readFileSync(proposalFile,'utf8'),lines=complete.trimEnd().split('\n');
    const prefix=lines.slice(0,count).map(line=>line+'\n').join('');
    fs.writeFileSync(proposalFile,prefix);
    fs.unlinkSync(proof.paths.ledger);
    fs.unlinkSync(path.join(root,'governance','accepted',hash(request.obligation.id)+'.json'));
    fs.unlinkSync(path.join(path.dirname(telosDir),'artifacts/output.json'));
    if (!keepPackets) fs.unlinkSync(path.join(telosDir,'fixture-review-packets.json'));
    const resumed=await (await createGovernance({root})).verifyCandidate(request);
    assert.equal(resumed.ok,true,`boundary ${count}, packets ${keepPackets}: ${resumed.reason}`);
    assert.equal(resumed.planRef,proof.planRef);
    assert.equal(fs.readFileSync(proposalFile,'utf8'),complete,'existing bytes remain and only exact missing events are appended');
    assert.equal((await (await createGovernance({root,readOnly:true})).verifyPlan({planRef:proof.planRef})).ok,true);
  }
});

test('recovery preserves and refuses malformed, conflicting signed history and review packets', async t=>{
  for (const variant of ['torn','forged','signed-conflict','packet-conflict']) {
    const {root,gov}=await setup(t),request=example(),proof=await gov.verifyCandidate(request);
    assert.equal(proof.ok,true,proof.reason);
    const telosDir=path.dirname(proof.paths.plan),proposalFile=path.join(telosDir,'proposal.jsonl'),packetFile=path.join(telosDir,'fixture-review-packets.json');
    const events=fs.readFileSync(proposalFile,'utf8').trimEnd().split('\n').map(JSON.parse);
    let prefix=events.slice(0,3).map(event=>JSON.stringify(event)+'\n').join('');
    if (variant==='torn') prefix+='{"unfinished":';
    if (variant==='forged') {events[0].sig.value=Buffer.alloc(64).toString('base64');prefix=JSON.stringify(events[0])+'\n';}
    if (variant==='signed-conflict') {
      const authority=JSON.parse(fs.readFileSync(path.join(root,'governance','fixture-authority.json'),'utf8'));
      const event=events[0];event.artifact_refs=['sha256:'+'0'.repeat(64)];
      const {sig,...payload}=event;
      event.sig={...sig,value:crypto.sign(null,Buffer.from(canonical(payload)),authority.proposal.privatePem).toString('base64')};
      assert.equal(crypto.verify(null,Buffer.from(canonical(payload)),crypto.createPublicKey({key:authority.proposal.publicJwk,format:'jwk'}),Buffer.from(event.sig.value,'base64')),true);
      prefix=JSON.stringify(event)+'\n';
    }
    if (variant==='packet-conflict') edit(packetFile,packets=>{packets[0].decision='reject';});
    fs.writeFileSync(proposalFile,prefix);
    const packetBytes=fs.readFileSync(packetFile);
    fs.unlinkSync(proof.paths.ledger);
    fs.unlinkSync(path.join(root,'governance','accepted',hash(request.obligation.id)+'.json'));
    const refused=await (await createGovernance({root})).verifyCandidate(request);
    assert.equal(refused.ok,false,variant);
    if (variant==='signed-conflict') assert.match(refused.reason,/prefix differs/);
    assert.equal(fs.readFileSync(proposalFile,'utf8'),prefix,variant+' history must be preserved');
    assert.deepEqual(fs.readFileSync(packetFile),packetBytes,variant+' packets must be preserved');
    assert.equal(fs.existsSync(proof.paths.ledger),false);
  }
});

test('worker assertions cannot approve wrong output, wrong hash, scope or exhausted attempts', async t=>{
  const {gov}=await setup(t);
  for (const mutate of [
    r=>{r.candidate.output={...r.candidate.output,summary:'fabricated'};r.candidate.sha256=hash(r.candidate.output);r.candidate.checks=['PASS'];},
    r=>{r.candidate.sha256='f'.repeat(64);},
    r=>{r.worker.scopes=['department:other'];},
    r=>{r.evidence.attempt=3;},
  ]) {const r=structuredClone(example());mutate(r);assert.equal((await gov.verifyCandidate(r)).ok,false);}
});

test('accepted input contract cannot change and dependencies need accepted exact versions', async t=>{
  const {root,gov}=await setup(t), first=example();
  assert.equal((await gov.verifyCandidate(first)).ok,true);
  const changed=structuredClone(first);changed.obligation.inputs={changed:true};
  assert.equal((await gov.verifyCandidate(changed)).ok,false);
  const child=structuredClone(first);child.obligation.id='normalize-2';child.candidate.id='normalize-2:1';child.obligation.dependsOn=['normalize-1'];
  child.evidence.dependencyVersions=[{id:'normalize-1',sha256:'0'.repeat(64)}];
  assert.equal((await gov.verifyCandidate(child)).ok,false);
  child.evidence.dependencyVersions[0].sha256=first.candidate.sha256;
  const proof=await gov.verifyCandidate(child);
  assert.equal(proof.ok,true);
  const unrelated=structuredClone(first);unrelated.obligation.id='unrelated';unrelated.candidate.id='unrelated:1';
  const otherProof=await gov.verifyCandidate(unrelated);assert.equal(otherProof.ok,true);
  const parentFile=path.join(root,'governance','accepted',hash(first.obligation.id)+'.json');
  edit(parentFile,a=>{a.planRef=otherProof.planRef;});
  assert.equal((await gov.verifyPlan({planRef:proof.planRef})).ok,false);
});

test('artifact tampering and added unsigned ledger bytes fail final verification', async t=>{
  const {gov}=await setup(t), proof=await gov.verifyCandidate(example());
  assert.equal(proof.ok,true,proof.reason);
  const output=path.join(path.dirname(path.dirname(proof.paths.plan)),'artifacts/output.json');
  const original=fs.readFileSync(output);
  edit(output,o=>{o.summary='tampered';});
  assert.equal((await gov.verifyPlan({planRef:proof.planRef})).ok,false);
  fs.writeFileSync(output,original);
  fs.appendFileSync(proof.paths.ledger,'{"torn":');
  assert.equal((await gov.verifyPlan({planRef:proof.planRef})).ok,false);
});

test('modified executable plan is refused before any substituted command can run', async t=>{
  const {root,gov}=await setup(t), proof=await gov.verifyCandidate(example()), marker=path.join(root,'must-not-exist');
  edit(proof.paths.plan,p=>{p.nodes[0].test={cmd:process.execPath,args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`]};});
  const denied=await gov.verifyPlan({planRef:proof.planRef});
  assert.equal(denied.ok,false);
  assert.match(denied.reason,/fixed executable contract/);
  assert.equal(fs.existsSync(marker),false);
});

test('forged reviewer and node signatures are independently refused', async t=>{
  const {gov}=await setup(t), proof=await gov.verifyCandidate(example());
  const packets=path.join(path.dirname(proof.paths.plan),'fixture-review-packets.json');
  const original=fs.readFileSync(packets);
  edit(packets,p=>{p[0].decision='reject';});
  assert.equal((await gov.verifyPlan({planRef:proof.planRef})).ok,false);
  fs.writeFileSync(packets,original);
  const receipt=JSON.parse(fs.readFileSync(proof.paths.ledger,'utf8'));receipt.artifact_tree_hash='sha256:'+'0'.repeat(64);
  fs.writeFileSync(proof.paths.ledger,JSON.stringify(receipt)+'\n');
  assert.equal((await gov.verifyPlan({planRef:proof.planRef})).ok,false);
});

test('source mismatch fails before import and explicit commit pin cannot be substituted', async t=>{
  const {root}=await setup(t), fake=path.join(root,'substituted-telos');
  fs.mkdirSync(path.join(fake,'build-gate'),{recursive:true});
  fs.writeFileSync(path.join(fake,'build-gate/check-registry.mjs'),'throw Error("must not import");');
  await assert.rejects(createGovernance({root,telosRoot:fake}),/Pinned TELOS source changed/);
  await assert.rejects(createGovernance({root,telosCommit:'0'.repeat(40)}),/pinned TELOS commit/);
  assert.equal(TELOS_COMMIT,'0c9b539ddbb08e1464603faf786e0d5cdfc33fb8');
});

test('independent release behavior is signed and activation/rollback bind exact source, state and registry', async t=>{
  const {root,gov}=await setup(t), v1=releaseRequest(), v2=releaseRequest('synthetic-v2');
  const a=await gov.verifyCandidate(v1),b=await gov.verifyCandidate(v2);
  assert.equal(a.ok,true,a.reason);assert.equal(b.ok,true,b.reason);
  const input={kind:'activate',fromRelease:'synthetic-v1',toRelease:'synthetic-v2',artifactSha:v2.candidate.output.artifactSha,stateSchema:'ophanim.runtime/v1',workers:v2.candidate.output.workers,planRef:b.planRef,evidenceRefs:b.evidenceRefs};
  const decision=await gov.issueActivationDecision(input);
  assert.equal((await gov.verifyActivationDecision({decision,expected:input})).ok,true);
  assert.equal((await (await createGovernance({root,readOnly:true})).verifyActivationDecision({decision,expected:input})).ok,true);
  assert.match(decision.body.releaseEvaluationSha,/^[a-f0-9]{64}$/);
  const request=JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(b.paths.plan)),'inputs/request.json'),'utf8'));
  assert.equal(request.releaseEvaluation.capability,'canonical-and-approved-alias');
  assert.equal(request.releaseEvaluation.outcomes.filter(x=>x.result==='canonical-pass').length,3);
  assert.equal(request.releaseEvaluation.outcomes.filter(x=>x.result==='unsupported-held').length,2);
  assert.equal((await gov.verifyActivationDecision({decision,expected:{...input,fromRelease:'other'}})).ok,false);
  const wrongWorkers=structuredClone(input);wrongWorkers.workers[0].scopes=['department:other'];
  await assert.rejects(gov.issueActivationDecision(wrongWorkers),/differs/);
  assert.equal((await gov.verifyActivationDecision({decision,expected:wrongWorkers})).ok,false);
  const forged=structuredClone(decision);forged.signature=Buffer.alloc(64).toString('base64');
  assert.equal((await gov.verifyActivationDecision({decision:forged,expected:input})).ok,false);
  const rollback={kind:'rollback',fromRelease:'synthetic-v2',toRelease:'synthetic-v1',artifactSha:v1.candidate.output.artifactSha,stateSchema:'ophanim.runtime/v1',workers:v1.candidate.output.workers,planRef:a.planRef,evidenceRefs:a.evidenceRefs};
  const back=await gov.issueActivationDecision(rollback);
  assert.equal((await gov.verifyActivationDecision({decision:back,expected:rollback})).ok,true);
});

test('caller agreement cannot authorize arbitrary source, routing change or injected failure configuration', async t=>{
  const {gov}=await setup(t);
  for (const mutate of [
    r=>{r.obligation.inputs.artifact.options.routingAliases={'office-support':'records'};},
    r=>{r.obligation.inputs.artifact.options.routingAliases={'office-support':'facilities','payroll-admin':'records'};},
    r=>{r.obligation.inputs.artifact.options.permanentCase='evaluation-facilities';},
    r=>{r.obligation.inputs.artifact.sourceSha='a'.repeat(64);},
  ]) {
    const request=releaseRequest('synthetic-v2');mutate(request);
    request.candidate.output.artifactSha=hash(request.obligation.inputs.artifact);
    request.obligation.expected=request.candidate.output;
    request.candidate.sha256=hash(request.candidate.output);
    const result=await gov.verifyCandidate(request);
    assert.equal(result.ok,false,JSON.stringify(result));
  }
});
