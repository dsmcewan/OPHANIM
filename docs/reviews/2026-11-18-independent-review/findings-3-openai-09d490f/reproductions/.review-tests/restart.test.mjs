import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {runPipeline} from '../pantheon/src/pipeline/index.mjs';
import {tempRepo,seats,unit,scripted} from '../pantheon/tests/fixtures/pipeline-stages.mjs';
const scratch='/tmp/ophanim-review-U4Ctdv/worktree/.review-tests';
fs.mkdirSync(join(scratch,'tmp'),{recursive:true});process.env.TMPDIR=join(scratch,'tmp');
const env=await tempRepo();let child;
try {
 child=spawn(process.execPath,[join(scratch,'restart-child.mjs'),env.repo,env.dir],{stdio:'ignore'});
 const closed=new Promise(r=>child.on('close',r)),end=Date.now()+10000;
 while(!fs.existsSync(join(env.dir,'call-sent'))){if(Date.now()>end)throw new Error('child did not dispatch'); await new Promise(r=>setTimeout(r,10));}
 child.kill('SIGKILL');await closed;
 const interrupted=JSON.parse(fs.readFileSync(join(env.dir,'pipeline.json'),'utf8'));
 const plan=[unit('a')];
 const resumed=await runPipeline({repo:env.repo,base:'main',plan:{work_units:plan},seats:seats(),turns:scripted({plan}).turns,dir:env.dir});
 assert.equal(interrupted.provider_calls.total,1,'RESTART LOST CALL: recorded '+interrupted.provider_calls.total+' despite mock call sent; next run '+resumed.status+': '+resumed.reason);
} finally {if(child?.exitCode===null)child.kill('SIGKILL');await env.cleanup();}
