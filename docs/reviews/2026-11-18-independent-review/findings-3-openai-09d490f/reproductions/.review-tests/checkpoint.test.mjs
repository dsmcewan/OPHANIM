import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {runPipeline,unitKey} from '../pantheon/src/pipeline/index.mjs';
import {writeCheckpoint} from '../pantheon/src/pipeline/checkpoint.mjs';
import {tempRepo,seats,unit,scripted,sh} from '../pantheon/tests/fixtures/pipeline-stages.mjs';
const scratch='/tmp/ophanim-review-U4Ctdv/worktree/.review-tests/tmp';
fs.mkdirSync(scratch,{recursive:true}); process.env.TMPDIR=scratch;
const env=await tempRepo({'src/a/impl.mjs':'export const id="a";\n'});
try {
 const plan=[unit('a')], checkpoints={dir:join(env.root,'checkpoints')};
 const go=async name=>runPipeline({repo:env.repo,base:'main',plan:{work_units:plan},seats:seats(),turns:scripted({plan}).turns,dir:join(env.root,name),run_id:name,checkpoints});
 const base=(await sh('git rev-parse HEAD',env.repo)).trim(), tree=(await sh('git rev-parse HEAD^{tree}',env.repo)).trim();
 await writeCheckpoint({dir:checkpoints.dir,patch:'',record:{unit_key:unitKey({unit:plan[0],base_commit:base}),unit_id:'a',base_commit:base,unit_base_commit:base,commit:base,tree,upstream:[],review_digest:'sha256:'+'0'.repeat(64),rubric_hash:'sha256:'+'1'.repeat(64),reviewer:{vendor:'invented',model:'never-reviewed'},verify:{cmd:plan[0].verify_cmd,exit_code:0}}});
 const two=await go('two');
 assert.equal(two.units.a.resumed,false,'TAMPER ACCEPTED: fabricated review/rubric hashes and reviewer resumed as approved; calls='+two.provider_calls.total);
} finally {await env.cleanup();}
