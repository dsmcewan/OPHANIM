import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../../board.mjs';
import {retainWithinCapacity,activeInvestigationIds,foldInvestigationHistory} from './controller.mjs';

const scopeSha='a'.repeat(64);
const hex=n=>n.toString(16).padStart(64,'0');
const entry=(question,outcome='no_change')=>({schema:'ophanim.investigation-history/v1',questionSha:hex(question),scopeSha,
  evidenceSha:hex(1000+question),applicabilitySha:hex(2000+question),outcome,reason:outcome,expectedConvergences:1,
  netInformationValueMs:null,economicsSourceSha:null,methodEvidenceSha:null});
// Builds the chain a scope accumulates: each packet lists every active packet before it.
function chain(count,entriesFor){
  const packets=new Map(),ids=[];
  for(let i=0;i<count;i++){
    const packet={schema:'ophanim.investigation-scope-evidence/v1',scopeSha,boardCommit:`commit:${hex(i)}`,traceSha:hex(500+i),
      stateDir:'/synthetic',workload:1,estimate:null,historyIds:[...ids].sort(),entries:entriesFor(i)};
    const id=digest(packet);packets.set(id,packet);ids.push(id);
  }
  return {packets,ids:[...ids].sort()};
}
// A stand-in for derive(): proposes one new question unless history already has it.
const rederiveNew=question=>history=>({modelSha:'m',decision:{outcome:'proposed',reason:'positive-information-value',
  historyEntries:history.some(row=>row.questionSha===hex(question))?[]:[entry(question,'proposed')]}});

test('below capacity the decision uses the active history unchanged',()=>{
  const {packets,ids}=chain(3,i=>[entry(i)]);
  const result=retainWithinCapacity({scopeSha,ids,packets,rederive:rederiveNew(99)});
  assert.equal(result.checkpoint,null);assert.deepEqual(result.historyIds,ids);
  assert.equal(result.decision.historyEntries.length,1);
});

test('at the packet limit the active packets fold into a checkpoint instead of blocking',()=>{
  // Questions repeat, so later packets supersede earlier decisions on the same question.
  const {packets,ids}=chain(32,i=>[entry(i%5,i%2?'proposed':'no_change')]);
  const result=retainWithinCapacity({scopeSha,ids,packets,rederive:rederiveNew(99)});
  assert.ok(result.checkpoint);
  assert.deepEqual(result.checkpoint.retiredIds,ids);
  assert.deepEqual(result.historyIds,[digest(result.checkpoint)]);
  assert.equal(result.decision.outcome,'proposed');assert.equal(result.decision.historyEntries.length,1);
  // One entry per question, each the latest decision recorded for it (packets 27..31).
  assert.deepEqual(result.checkpoint.entries.map(row=>row.questionSha),[0,1,2,3,4].map(hex));
  assert.deepEqual(result.checkpoint.entries.map(row=>row.outcome),[0,1,2,3,4].map(q=>[30,31,27,28,29].find(i=>i%5===q)%2?'proposed':'no_change'));
  // With the checkpoint present, only it is active.
  const withCheckpoint=new Map(packets);withCheckpoint.set(digest(result.checkpoint),result.checkpoint);
  assert.deepEqual(activeInvestigationIds(withCheckpoint),[digest(result.checkpoint)]);
});

test('a checkpoint folds forward when the next epoch fills',()=>{
  const first=chain(32,i=>[entry(i%4)]);
  const checkpoint=retainWithinCapacity({scopeSha,ids:first.ids,packets:first.packets,rederive:rederiveNew(50)}).checkpoint;
  const packets=new Map(first.packets),cpId=digest(checkpoint);packets.set(cpId,checkpoint);
  const ids=[cpId];
  for(let i=0;i<31;i++){
    const packet={schema:'ophanim.investigation-scope-evidence/v1',scopeSha,boardCommit:`commit:${hex(100+i)}`,traceSha:hex(600+i),
      stateDir:'/synthetic',workload:1,estimate:null,historyIds:[...ids].sort(),entries:[entry(10+i%3)]};
    const id=digest(packet);packets.set(id,packet);ids.push(id);
  }
  const active=activeInvestigationIds(packets);
  assert.equal(active.length,32);assert.ok(active.includes(cpId));
  const next=retainWithinCapacity({scopeSha,ids:active,packets,rederive:rederiveNew(77)});
  assert.ok(next.checkpoint);assert.ok(next.checkpoint.retiredIds.includes(cpId));
  assert.deepEqual(next.checkpoint.entries.map(row=>row.questionSha),[0,1,2,3,10,11,12].map(hex));
  assert.deepEqual(foldInvestigationHistory(active,packets),next.checkpoint.entries);
});

test('capacity stays blocked only when folding cannot make room',()=>{
  // 64 distinct questions: folding keeps all of them, so a new one cannot fit.
  const {packets,ids}=chain(32,i=>[entry(2*i),entry(2*i+1)]);
  const result=retainWithinCapacity({scopeSha,ids,packets,rederive:rederiveNew(999)});
  assert.equal(result.checkpoint,null);assert.deepEqual(result.historyIds,ids);
  assert.equal(result.decision.outcome,'blocked');assert.equal(result.decision.reason,'retained-evidence-capacity');
  assert.deepEqual(result.decision.historyEntries,[]);
});

test('two active checkpoints are refused',()=>{
  const {packets,ids}=chain(2,i=>[entry(i)]);
  const a={schema:'ophanim.investigation-scope-checkpoint/v1',scopeSha,retiredIds:[ids[0]],entries:[entry(0)]};
  const b={schema:'ophanim.investigation-scope-checkpoint/v1',scopeSha,retiredIds:[ids[1]],entries:[entry(1)]};
  packets.set(digest(a),a);packets.set(digest(b),b);
  assert.throws(()=>activeInvestigationIds(packets),/At most one active investigation checkpoint/);
});
