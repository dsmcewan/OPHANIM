import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {openStatusLedger} from '../packages/ledger/status.mjs';
import {openWorkLedger} from '../ophanim/operate/work-ledger.mjs';
import {tick} from '../ophanim/operate/scheduler.mjs';
const root=fs.mkdtempSync('/tmp/ophanim-review-U4Ctdv/worktree/.review-tests/elapsed-');
try {
 const statusRoot=join(root,'status'),workRoot=join(root,'work');
 openStatusLedger({root:statusRoot}).set({item:'alpha',title:'Alpha',state:'Ready',basis:'fixture',checked:'2026-11-18'});
 fs.mkdirSync(join(root,'tickets'));
 const r=await tick({repo:root,statusRoot,workRoot,limits:{total_provider_calls:1,stage_provider_calls:1,elapsed_ms:100,lease_ms:10000,iterations:1},executors:{plan:async ctx=>{
  ctx.charge(); await new Promise(r=>setTimeout(r,150));
  assert.equal(ctx.signal.aborted,true);
  return {status:'passed',outputs:{partial:'answer arrived after deadline'},usage:{provider_calls:1},next:{stage:'implement',why:'approved'}};
 }}});
 const stage=openWorkLedger({root:workRoot}).stages()[0];
 assert.notEqual(stage.status,'passed','ELAPSED stage recorded passed: '+JSON.stringify({status:stage.status,outputs:stage.outputs,stopped:r.stopped}));
} finally {fs.rmSync(root,{recursive:true,force:true});}
