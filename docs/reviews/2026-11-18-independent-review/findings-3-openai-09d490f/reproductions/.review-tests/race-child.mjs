import fs from 'node:fs';
import {join} from 'node:path';
import {tick} from '../ophanim/operate/scheduler.mjs';
const [root,item,line]=process.argv.slice(2);
let waited=false;
const clock=()=>{
 if(!waited && new Error().stack.includes('scheduler.mjs:'+line+':')){
  waited=true; fs.writeFileSync(join(root,item+'.ready'),'ready');
  const end=Date.now()+10000;
  while(!fs.existsSync(join(root,'go'))){if(Date.now()>end)throw new Error('barrier timed out'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
 }
 return Date.now();
};
const result=await tick({repo:root,statusRoot:join(root,'status'),workRoot:join(root,'work'),only:item,clock,
 limits:{total_provider_calls:1,stage_provider_calls:1,iterations:1},
 executors:{plan:async ctx=>{ctx.charge(); return {status:'failed',outputs:{mock_call:true},usage:{provider_calls:1},next:{stage:'plan',why:'fixture stop'}};}}});
fs.writeFileSync(join(root,item+'.result'),JSON.stringify(result));
