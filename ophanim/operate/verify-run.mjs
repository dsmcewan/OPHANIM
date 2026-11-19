#!/usr/bin/env node
// THE FRESH-PROCESS VERIFIER of a live run (live-run.mjs). The launcher spawns this file with `node`, in a new
// process that shares no memory, no open ledger handle and no cached head with the process that ran the ticks, and
// records ITS verdict in run.json (independent review, assignment 3, question 10: a fresh reader in the same process
// is not a fresh process).
//
//   node ophanim/operate/verify-run.mjs '<json: {workRoot, item, statusRoot, statusBefore: {head, files: {digest}}}>'
//
// It re-opens the work ledger read-only (create: false), verifies it, takes the item's stage records FROM THE LEDGER
// (not from the caller), verifies every run ledger they cite and the status ledger (read-only, compared with the
// state before the run), and prints one JSON object (freshVerification's shape plus {pid}). Exit 0 when it verified,
// 1 when it did not, 2 on a usage error. Must never: write to any ledger, or take a stage list from its caller.
import {openWorkLedger} from './work-ledger.mjs';
import {freshVerification} from './live-run.mjs';

let args;
try { args = JSON.parse(process.argv[2] ?? ''); } catch { process.stderr.write('usage: verify-run.mjs <json {workRoot, item, statusRoot, statusBefore}>\n'); process.exit(2); }
let stages = [];
try { stages = openWorkLedger({root: args.workRoot, create: false}).stages(args.item); } catch { /* freshVerification records the work ledger's failure */ }
const out = {...freshVerification({workRoot: args.workRoot, stages, statusRoot: args.statusRoot, statusBefore: args.statusBefore}), pid: process.pid, stages: stages.length};
process.stdout.write(JSON.stringify(out) + '\n');
process.exitCode = out.ok ? 0 : 1;
