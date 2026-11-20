// A child process of the graph tests: it projects a repository into a graph, again and again, until it is killed.
//   node test-project-child.mjs <repo> <graphRoot>
import path from 'node:path';
import {project} from './project.mjs';

const [repo, graphRoot] = process.argv.slice(2);
const where = {repo, graphRoot, statusRoot: path.join(repo, 'status', 'ledger'), workRoot: path.join(repo, 'status', 'work')};
process.stdout.write('started\n');
for (let i = 0; ; i += 1) await project({...where, at: '2026-11-20T00:00:00.000Z'});
