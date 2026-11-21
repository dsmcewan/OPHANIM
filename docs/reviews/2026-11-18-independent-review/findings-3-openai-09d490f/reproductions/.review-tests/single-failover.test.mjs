import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {runPipeline} from '../pantheon/src/pipeline/index.mjs';
import {pipelineTurns} from '../pantheon/src/pipeline/turns.mjs';
import {laneFirstTurn} from '../pantheon/src/sdk/agy-turn.mjs';
import {tempRepo,seats,unit} from '../pantheon/tests/fixtures/pipeline-stages.mjs';
const scratch='/tmp/ophanim-review-U4Ctdv/worktree/.review-tests/tmp';fs.mkdirSync(scratch,{recursive:true});process.env.TMPDIR=scratch;
const env=await tempRepo();
try {
 let sent=0;
 const lane=async()=>{sent++;throw Object.assign(new Error('quota'),{status:429,code:'quota_exhausted'});};
 const api=async({model})=>{sent++;return {served_model:model,text:JSON.stringify({unit_id:'a',cohesive:false,specialist_role:'node-esm-library-engineer',difficulty:'medium',rubric:['file exists'],notes:'fixture ends at dispatch'})};};
 const plan=[unit('a')],seat={vendor:'agy_google',model:'gemini-4-hydrogen-medium'};
 const r=await runPipeline({repo:env.repo,base:'main',plan:{work_units:plan},seats:seats({dispatcher:()=>seat}),turns:pipelineTurns({turn:args=>laneFirstTurn(args,{lane,api})}),dir:env.dir,limits:{max_provider_calls:1,judge_vendor:'agy_google'},sameModel:()=>true});
 assert.equal(sent,r.provider_calls.total,'UNCOUNTED SINGLE-TURN FAILOVER: sent='+sent+', charged='+r.provider_calls.total+', max_provider_calls=1');
} finally {await env.cleanup();}
