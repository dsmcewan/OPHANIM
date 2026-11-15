import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {digest,writeJson} from '../fixtures.mjs';

test('terminating the watchdog drains its separate stalled runtime child', {timeout:15000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ophanim-watchdog-stop-')),stateDir=path.join(root,'state');
  const fault={event:'after-work-persisted',mode:'stall'},requestFile=path.join(root,'worker.json'),reportFile=path.join(root,'report.json'),guardRequest=path.join(root,'guard.json');
  writeJson(requestFile,{stateDir,fixture:{count:1},fault,...process.env.OPHANIM_TELOS_ROOT?{telosRoot:process.env.OPHANIM_TELOS_ROOT}:{}});
  writeJson(guardRequest,{requestFile,reportFile,timeoutMs:12000,stallMs:10000});
  const child=spawn(process.execPath,[fileURLToPath(new URL('../watchdog.mjs',import.meta.url)),'--request',guardRequest],{stdio:['ignore','pipe','pipe','ipc']});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  const closed=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal}));});
  try{
    const marker=path.join(stateDir,`fault-${digest(fault).slice(0,16)}.json`),deadline=Date.now()+8000;
    while(!fs.existsSync(marker)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
    assert.ok(fs.existsSync(marker),`Runtime did not reach injected stall: ${stderr}`);
    child.kill('SIGTERM');
    const ended=await closed,report=JSON.parse(fs.readFileSync(reportFile,'utf8'));
    assert.equal(ended.code,1);assert.equal(report.reason,'watchdog-sigterm');
    assert.ok(['SIGTERM','SIGKILL'].includes(report.signal));
    assert.throws(()=>process.kill(report.workerPid,0),error=>error.code==='ESRCH');
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');fs.rmSync(root,{recursive:true,force:true});}
});
