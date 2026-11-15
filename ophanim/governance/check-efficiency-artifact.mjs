// Separate scheduler verification executable. Legacy checker bytes stay pinned.
import fs from 'node:fs';
import path from 'node:path';
import {canonical,rawHash} from './check-contract.mjs';
import {validateEfficiencyRequest,evaluateEfficiency} from './check-efficiency.mjs';
function read(relative) {
  if(!['inputs/request.json','artifacts/output.json'].includes(relative))throw Error('Unknown scheduler checker input');
  const file=path.resolve(relative),stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>262144||fs.realpathSync(file)!==file)throw Error('Regular bounded scheduler checker input required');
  return fs.readFileSync(file);
}
try {
  const [requestFile,outputFile,requestSha,...extra]=process.argv.slice(2);
  if(extra.length||!/^[a-f0-9]{64}$/.test(requestSha??''))throw Error('Exact scheduler checker arguments required');
  const bytes=read(requestFile);if(rawHash(bytes)!==requestSha)throw Error('Scheduler request identity changed');
  const request=JSON.parse(bytes),output=JSON.parse(read(outputFile));
  if(canonical(output)!==canonical(request.candidate.output))throw Error('Scheduler artifact differs from reviewed candidate');
  validateEfficiencyRequest(request);
  const evaluation=await evaluateEfficiency({policy:output,...request.obligation.inputs});
  if(!evaluation.eligible||canonical(evaluation)!==canonical(request.efficiencyEvaluation))throw Error('Independent scheduler evaluation differs from signed request');
}catch(error){process.stderr.write('Scheduler artifact refused: '+error.message+'\n');process.exitCode=1;}
