import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnPromise} from '../src/board/spawn.mjs';
import {readFileSync} from 'node:fs';

const alive=pid=>{try{return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`,'utf8'));}catch{return false;}};
const cleanup=ids=>ids.forEach(pid=>{try{process.kill(pid,'SIGKILL');}catch{}});

// The timeout must outlast child startup: on a loaded CI runner a 150ms timeout fired before the
// ESM child had spawned its descendant and printed both pids, so nothing was left to check.
test('timeout kills a TERM-ignoring process and descendants while the event loop stays responsive',async()=>{
  const ids=[];
  const code=`import {spawn} from 'node:child_process';process.on('SIGTERM',()=>{});const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});console.log(JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`;
  let ticks=0;const timer=setInterval(()=>ticks++,5);
  let guard;
  try{
    const result=await Promise.race([
      spawnPromise(process.execPath,['--input-type=module','-e',code],{timeout:1500,killGraceMs:25,onStdoutLine:line=>ids.push(...JSON.parse(line))}),
      new Promise((_,reject)=>{guard=setTimeout(()=>reject(new Error('runner hung after timeout')),6000);})]);
    assert.equal(result.status,null);
    assert.ok(ticks>5);
    assert.equal(ids.length,2);
    assert.ok(ids.every(pid=>!alive(pid)),'parent or descendant remains alive');
  }finally{clearInterval(timer);clearTimeout(guard);cleanup(ids);}
});

// The output cap is the only bound here. A product timeout would race child startup on a loaded runner (CI: a 500ms
// timeout won before the child wrote, so the result was 'timeout'). The finite watchdog is an abort, which still tears
// the child's group down and fails the test as 'cancelled' if the cap never trips. 40 emoji are 160 UTF-8 bytes but
// only 80 UTF-16 units (40 code points), so a 100 cap trips only when bytes are counted.
test('output cap counts UTF-8 bytes and cancels the child',async()=>{
  const watchdog=AbortSignal.timeout(10_000);
  assert.ok(Buffer.byteLength('😀'.repeat(40))>100&&'😀'.repeat(40).length<=100,'the stimulus exceeds the cap in bytes only');
  const result=await spawnPromise(process.execPath,['-e',"process.stdout.write('😀'.repeat(40));setInterval(()=>{},1000)"],{maxBuffer:100,signal:watchdog,killGraceMs:25});
  assert.ok(Buffer.byteLength(result.stdout)<=100);
  assert.equal(result.status,null);
  assert.equal(result.killedFor,'output_limit');
});

test('abort stops an in-flight process promptly and an already aborted call never spawns',async()=>{
  const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),60);
  try{
    const result=await spawnPromise(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:ctrl.signal,timeout:500,killGraceMs:25});
    assert.equal(result.killedFor,'cancelled');
    await assert.rejects(spawnPromise(process.execPath,['-e','process.exit(0)'],{signal:ctrl.signal}),/abort/i);
  }finally{clearTimeout(timer);}
});
