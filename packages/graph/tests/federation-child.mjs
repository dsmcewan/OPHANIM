#!/usr/bin/env node
// A separate process for the federation tests (not a test file): it opens the central instance of the synthetic
// federation a test built (federation-fixture.mjs, saved on disk) and does one thing, printing what it did.
//   node federation-child.mjs catchup <root> <name>   wait for <root>/go, catch up once, print a JSON summary
import fs from 'node:fs';
import path from 'node:path';
import {worldOf, at} from './federation-fixture.mjs';

const [cmd, root, name] = process.argv.slice(2);
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (cmd === 'catchup') {
  const go = path.join(root, 'go'), deadline = Date.now() + 30_000;
  const w = worldOf(root), central = w.central();
  while (!fs.existsSync(go) && Date.now() < deadline) sleep(2);
  const r = central.catchUp({by: w.centralBy, now: at(50)});
  console.log(JSON.stringify({name, imported: r.imported, issued: r.notices.issued.length}));
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
}
