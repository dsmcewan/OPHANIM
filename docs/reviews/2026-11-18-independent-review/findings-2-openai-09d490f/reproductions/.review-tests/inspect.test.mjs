import fs from 'node:fs';
import test from 'node:test';
test('inspect', () => {
for (const p of ['pantheon/src/board/run-item.mjs','pantheon/src/review/scope.mjs']) {
 if(fs.existsSync(p)) {const ls=fs.readFileSync(p,'utf8').split('\n'),wanted=new Set();ls.forEach((s,i)=>{if(/reviewerRefusal|reviewerIdentity|NO_SERVED|AGY_GEMINI_ONLY|served_model_source|review_rejections/.test(s))for(let j=Math.max(0,i-4);j<=Math.min(ls.length-1,i+8);j++)wanted.add(j);});process._rawDebug('\nFILE '+p+'\n'+[...wanted].sort((a,b)=>a-b).map(i=>`${i+1}: ${ls[i]}`).join('\n'));}
}
});
