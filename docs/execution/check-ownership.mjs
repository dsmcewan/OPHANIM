#!/usr/bin/env node
// Mechanical ownership check for a wave manifest (coordinator tool).
//   node docs/execution/check-ownership.mjs <manifest.json> <subwave>            -- glob overlap over tracked + declared new files
//   node docs/execution/check-ownership.mjs <manifest.json> <subwave> --diff <agent> <base> <ref>
//                                                                                -- every file the ref changed is owned by that agent
// Exits 1 on any overlap, any coordinator-only path owned by an agent, or any changed file outside the agent's globs.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const [file, sub, mode, agent, base, ref] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(file, 'utf8'));
const agents = m.subwaves[sub];
if (!agents) { console.error(`no subwave ${sub}`); process.exit(2); }
const globsOf = a => a.files.map(g => g.split(' ')[0]);
const match = (f, globs) => globs.some(g => path.matchesGlob(f, g));
const tracked = execFileSync('git', ['ls-files'], {encoding: 'utf8'}).trim().split('\n');
let bad = 0;
if (mode === '--diff') {
  const a = agents[agent]; if (!a) { console.error(`no agent ${agent}`); process.exit(2); }
  const changed = execFileSync('git', ['diff', '--name-only', `${base}...${ref}`], {encoding: 'utf8'}).trim().split('\n').filter(Boolean);
  for (const f of changed) {
    if (match(f, m.coordinator_only)) { console.log(`COORDINATOR-ONLY ${f}`); bad++; }
    else if (!match(f, globsOf(a)) && !(a.allowed_extra ?? []).includes(f)) { console.log(`UNOWNED ${f}`); bad++; }
  }
  console.log(`${changed.length} changed file(s); ${bad} problem(s)`);
} else {
  const names = Object.keys(agents);
  const universe = [...new Set([...tracked, ...names.flatMap(n => agents[n].new_files ?? [])])];
  for (const n of names) for (const g of globsOf(agents[n])) if (m.coordinator_only.some(c => path.matchesGlob(g, c) || g === c)) { console.log(`COORDINATOR-ONLY glob ${n}: ${g}`); bad++; }
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const both = universe.filter(f => match(f, globsOf(agents[names[i]])) && match(f, globsOf(agents[names[j]])));
    for (const f of both) { console.log(`OVERLAP ${names[i]} / ${names[j]}: ${f}`); bad++; }
  }
  for (const n of names) console.log(`${n}: ${universe.filter(f => match(f, globsOf(agents[n]))).length} file(s) matched`);
  console.log(`${bad} problem(s)`);
}
process.exit(bad ? 1 : 0);
