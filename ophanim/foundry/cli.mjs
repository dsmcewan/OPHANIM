#!/usr/bin/env node
// THE FOUNDRY, from the command line (docs/foundry.md).
//
//   node ophanim/foundry/cli.mjs build --request FILE --state DIR [--arms N] [--repetitions N] [--rework N] [--implementers a,b]
//                                       [--planner M] [--reviewer M] [--efforts low,high] [--max-usd X] [--per-call-usd X]
//   node ophanim/foundry/cli.mjs status --state DIR [--class CLASS]
//
// `build` carries the request through every stage (foundry.mjs) with the Claude command line as the model seat
// (claude-cli.mjs): it SPENDS on the signed-in account, up to --max-usd in total (default 2). It needs Linux and
// Bubblewrap, as Pantheon's acceptance jail does. `status` spends nothing: it re-derives the graph from the trial
// records of a state directory and prints what is measured, per class of task.
//
// The answer is JSON on stdout. Exit 0 when a product was accepted (build) or the records read (status), 1 when no
// product was accepted or the request was refused (the reason is the output), 2 on a usage error.
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {claudeCliClients} from './claude-cli.mjs';
import {runFoundry, readTrials} from './foundry.mjs';
import {rankSetups} from './setups.mjs';
import {foundryGraph, measuredSetups} from './graph.mjs';

const USAGE = `usage: node ophanim/foundry/cli.mjs build --request FILE --state DIR [--arms N] [--repetitions N] [--rework N] [--implementers a,b] [--planner M] [--reviewer M] [--efforts low,high] [--max-usd X] [--per-call-usd X]
       node ophanim/foundry/cli.mjs status --state DIR [--class CLASS]`;
const VALUED = ['request', 'state', 'arms', 'repetitions', 'rework', 'implementers', 'planner', 'reviewer', 'efforts', 'max-usd', 'per-call-usd', 'class'];
/** Where the Claude command line is the transport, the capabilities it reaches are the Anthropic models of the api profile. */
export const reachableByClaudeCli = seat => seat.vendor === 'anthropic' && seat.profile === 'api';

export async function main(argv, {out = s => process.stdout.write(s), err = s => process.stderr.write(s), clients = null, live = true, progress = () => {}} = {}) {
  const [command, ...rest] = argv, flags = {};
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i].startsWith('--') ? rest[i].slice(2) : null;
    if (!k || !VALUED.includes(k) || rest[i + 1] === undefined || rest[i + 1].startsWith('--') || k in flags) { err(USAGE + '\n'); return 2; }
    flags[k] = rest[++i];
  }
  const int = (k, d) => (flags[k] === undefined ? d : /^\d+$/.test(flags[k]) ? Number(flags[k]) : NaN), usd = (k, d) => (flags[k] === undefined ? d : /^\d+(\.\d+)?$/.test(flags[k]) ? Number(flags[k]) : NaN);
  if (command === 'status' && flags.state) {
    const trials = readTrials(path.resolve(flags.state)), classes = flags.class ? [flags.class] : [...new Set(trials.map(t => t.request.class))].sort();
    const g = foundryGraph({trials});
    try {
      const view = g.view();
      out(JSON.stringify({state: path.resolve(flags.state), trials: trials.length, live_trials: trials.filter(t => t.live).length, spent_usd: Number(trials.reduce((a, t) => a + (t.cost_usd ?? 0), 0).toFixed(6)),
        classes: classes.map(c => ({class: c, ranking: rankSetups(trials.filter(t => t.request.class === c && t.identity_ok)), on_graph: measuredSetups(view, c).map(m => ({setup: m.setup, measures: m.measures, trials: m.trials, accepted: m.accepted, uncertainty: m.uncertainty}))}))}, null, 1) + '\n');
    } finally { g.close(); }
    return 0;
  }
  const arms = int('arms', 2), repetitions = int('repetitions', 1), rework = int('rework', 0), maxUsd = usd('max-usd', 2), perCallUsd = usd('per-call-usd', 0.5);
  if (command !== 'build' || !flags.request || !flags.state || [arms, repetitions, rework, maxUsd, perCallUsd].some(Number.isNaN)) { err(USAGE + '\n'); return 2; }
  // One spending cap for the whole build: the clients of every trial share one meter. An effort applies to the trial's own clients.
  const meter = clients ?? (() => { const made = new Map(); let spentBy = [];
    return ({setup}) => { const key = setup.effort ?? '';
      if (!made.has(key)) { const prior = () => spentBy.reduce((a, m) => a + m.spent().usd, 0); const m = claudeCliClients({live, effort: setup.effort, perCallUsd, maxUsd: Math.max(maxUsd - prior(), 0)}); made.set(key, m); spentBy = [...made.values()]; }
      return made.get(key); }; })();
  try {
    const record = await runFoundry({requestFile: path.resolve(flags.request), state: path.resolve(flags.state), makeClients: meter, reachable: reachableByClaudeCli, arms, repetitions, rework,
      implementers: flags.implementers ? flags.implementers.split(',') : null, planner: flags.planner ?? null, reviewer: flags.reviewer ?? null, efforts: flags.efforts ? flags.efforts.split(',') : [null], onStage: progress});
    out(JSON.stringify(record, null, 1) + '\n');
    return record.product ? 0 : 1;
  } catch (e) {
    if (!['FOUNDRY_REFUSED', 'FOUNDRY_NO_SETUP'].includes(e.code)) throw e;
    out(JSON.stringify({error: e.code, why: e.message}, null, 1) + '\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2), {progress: s => process.stderr.write(`[foundry] ${s.stage}${s.trial ? ` trial ${s.trial}` : ''}\n`)});
