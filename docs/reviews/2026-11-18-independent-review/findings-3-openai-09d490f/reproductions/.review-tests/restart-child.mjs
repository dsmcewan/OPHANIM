import fs from 'node:fs';
import {join} from 'node:path';
import {runPipeline} from '../pantheon/src/pipeline/index.mjs';
import {seats,unit,scripted} from '../pantheon/tests/fixtures/pipeline-stages.mjs';
const [repo,dir]=process.argv.slice(2),plan=[unit('a')];
const s=scripted({plan,dispatch:async()=>{fs.writeFileSync(join(dir,'call-sent'),'one mock provider call');await new Promise(()=>{});}});
const alive=setInterval(()=>{},1000);
await runPipeline({repo,base:'main',plan:{work_units:plan},seats:seats(),turns:s.turns,dir});clearInterval(alive);
