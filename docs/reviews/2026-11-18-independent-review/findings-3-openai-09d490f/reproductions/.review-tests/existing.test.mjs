import fs from 'node:fs';
const root = '/tmp/ophanim-review-U4Ctdv/worktree';
fs.mkdirSync(root+'/.review-tests/tmp',{recursive:true});
process.env.TMPDIR=root+'/.review-tests/tmp';
for(const f of ['ophanim/operate/scheduler.test.mjs','ophanim/operate/live-run.test.mjs','pantheon/tests/pipeline-run.test.mjs','pantheon/tests/pipeline-ladder.test.mjs','pantheon/tests/pipeline-resume.test.mjs','pantheon/tests/pipeline-async.test.mjs','pantheon/tests/pipeline-turns.test.mjs','pantheon/tests/quota-failover.test.mjs','pantheon/tests/provider-call-bound-resume.test.mjs']) await import(root+'/'+f);
