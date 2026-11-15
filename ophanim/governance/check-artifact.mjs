// The sole command admitted to a synthetic TELOS node. Arguments are controller-built.
import fs from 'node:fs';
import path from 'node:path';
import {canonical, rawHash, validateRequest} from './check-contract.mjs';
import {evaluateRelease} from './check-release.mjs';
function read(relative) {
  if (!['inputs/request.json', 'artifacts/output.json'].includes(relative)) throw Error('Unknown checker input');
  const file = path.resolve(relative), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262144 || fs.realpathSync(file) !== file) throw Error('Regular bounded checker input required');
  return fs.readFileSync(file);
}
try {
  const [requestFile, outputFile, expectedRequestSha, ...extra] = process.argv.slice(2);
  if (extra.length || !/^[a-f0-9]{64}$/.test(expectedRequestSha ?? '')) throw Error('Exact checker arguments required');
  const requestBytes = read(requestFile);
  if (rawHash(requestBytes) !== expectedRequestSha) throw Error('Request identity changed');
  const request = JSON.parse(requestBytes), output = JSON.parse(read(outputFile));
  if (canonical(output) !== canonical(request.candidate.output)) throw Error('Artifact differs from reviewed candidate');
  validateRequest(request);
  if (request.obligation.kind === 'synthetic-release') {
    const actual = await evaluateRelease(request);
    if (canonical(actual) !== canonical(request.releaseEvaluation)) throw Error('Independent release evaluation differs from signed request');
  }
} catch (error) {
  process.stderr.write('Synthetic artifact refused: ' + error.message + '\n');
  process.exitCode = 1;
}
