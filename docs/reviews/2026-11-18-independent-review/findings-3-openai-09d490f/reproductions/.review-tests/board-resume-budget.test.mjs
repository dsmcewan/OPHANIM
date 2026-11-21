import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {withDispatch} from '../pantheon/tests/fixtures/dispatch.mjs';
import {runOpenItem,providerCallsOf} from '../pantheon/src/board/run-item.mjs';
const scratch='/tmp/ophanim-review-U4Ctdv/worktree/.review-tests/tmp';fs.mkdirSync(scratch,{recursive:true});process.env.TMPDIR=scratch;
await withDispatch(async({spec,opts,calls,fault,agy})=>{
 let fail=true;
 fault(c=>fail&&/VERDICT/.test(c.prompt)?{error:Object.assign(new Error('quota'),{status:429,code:'insufficient_quota'})}:null);
 const o=opts(),s=spec('resume-stage-budget');
 const first=await runOpenItem(s,{...o,maxProviderCalls:4});
 assert.equal(first.shipped,false,JSON.stringify(first));
 const before=providerCallsOf(JSON.parse(fs.readFileSync(join(first.board,'run.json'),'utf8')).attempts);
 assert.equal(before,4,JSON.stringify(first.error));
 fail=false;
 // Exact argument used by stages.mjs: callsBefore + current stage budget.
 const stageBudget=1;
 const second=await runOpenItem(s,{...o,resume:first.board,maxProviderCalls:before+stageBudget});
 const r=JSON.parse(fs.readFileSync(join(second.board,'run.json'),'utf8'));
 const delta=providerCallsOf(r.attempts)-before;
 assert.ok(delta<=stageBudget,'RESUMED STAGE OVERRUN: '+delta+' new calls against stage budget 1; invocation limit='+r.provider_calls.limit+', callsBefore='+before);
});
