import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {openStatusLedger} from '../packages/ledger/status.mjs';
import {openWorkLedger} from '../ophanim/operate/work-ledger.mjs';
import {tick,spent} from '../ophanim/operate/scheduler.mjs';
const scratch='/tmp/ophanim-review-U4Ctdv/worktree/.review-tests';
const root=fs.mkdtempSync(join(scratch,'race-')); const children=[];
try {
 const S=openStatusLedger({root:join(root,'status')});
 for(const item of ['alpha','beta']) S.set({item,title:item,state:'Ready',basis:'fixture',checked:'2026-11-18'});
 fs.mkdirSync(join(root,'tickets'));
 await tick({repo:root,statusRoot:join(root,'status'),workRoot:join(root,'work'),limits:{total_provider_calls:100},executors:{}});
 const lines=fs.readFileSync(new URL('../ophanim/operate/scheduler.mjs',import.meta.url),'utf8').split('\n');
 const line=lines.findIndex(l=>l.includes('try { claim = work.claim('))+1;
 const results=['alpha','beta'].map(item=>new Promise((resolve,reject)=>{
  const c=spawn(process.execPath,[join(scratch,'race-child.mjs'),root,item,String(line)],{stdio:['ignore','pipe','pipe']}); children.push(c);
  let err=''; c.stderr.on('data',d=>err+=d);c.on('error',reject); c.on('close',code=>code===0?resolve():reject(new Error(err)));
 }));
 const end=Date.now()+10000;
 while(!['alpha','beta'].every(i=>fs.existsSync(join(root,i+'.ready')))) {if(Date.now()>end)throw new Error('children did not reach barrier');await new Promise(r=>setTimeout(r,10));}
 fs.writeFileSync(join(root,'go'),'go'); await Promise.all(results);
 const w=openWorkLedger({root:join(root,'work')}); assert.equal(w.verify().ok,true);
 assert.ok(spent(w).calls<=1,'TOTAL BUDGET EXCEEDED: '+JSON.stringify(spent(w))+' against total_provider_calls=1');
} finally {for(const c of children)if(c.exitCode===null)c.kill('SIGKILL');fs.rmSync(root,{recursive:true,force:true});}
