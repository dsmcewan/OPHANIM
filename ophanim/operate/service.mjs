// The execution service: the long-running process that keeps the governed lifecycle moving, on the machine where the
// provider keys and the controller key are (the owner's). It is `watch` (scheduler.mjs) with what a service needs:
//
//   config      one validated file (SERVICE_CONFIG_SCHEMA): repository and ledgers, the issue source, the seats, the
//               interval and the limits. `limits.total_provider_calls` must be declared: it bounds the provider calls
//               the work ledger may ever record (scheduler `spent` counts every stage on the ledger, failed and resumed
//               ones included), so a service running for weeks cannot exceed it. Unknown keys are refused.
//   billing     (optional) THE GEMINI BILLING POLICY of every tick (register L-136; docs/billing-policy.md):
//               {metered_gemini_failover: {enabled, budget}, gemini_api_primary: {enabled, budget}}, both OFF when absent;
//               enabling either needs a budget (positive integer of billed Gemini requests the work ledger may ever
//               record of that kind, counted from its work.billing entries), or the config is refused and nothing runs.
//               A Gemini key in the service's environment authorizes nothing. Every tick of the service runs under it.
//   one process a lock file (O_EXCL) names the holder's pid and host. A second service on the same work ledger is
//               refused (SERVICE_RUNNING). A lock left by a dead process on this host is taken over and the takeover
//               recorded; a lock from another host is refused, never guessed at.
//   authority   checked before the loop: without the controller key the service stops with NO_AUTHORITY (exit 3) and
//               records nothing; it does not idle pretending to work.
//   visibility  after every tick: <state>/service-status.json (state, heartbeat, last tick summary, the next retry due,
//               spend against the cap) and one line in <state>/service.jsonl. The public record (ophanim/public)
//               projects the work ledger itself.
//   stop        SIGTERM/SIGINT (cli.mjs serve) abort `signal`, which is also every tick's `interrupt` (register L-121): the
//               stage in flight is stopped cooperatively, its claim released `interrupted` with no stage record (the
//               charges made under it stay counted), and the loop ends; the next start resumes the item at once.
//               Only a process killed outright (SIGKILL, power loss) leaves its claim held until the lease expires;
//               the next start then releases it as expired and resumes from the last recorded stage (scheduler.mjs).
//               The lease fence is unchanged: a released claim records and charges nothing.
//   errors      a tick that throws is logged with its reason and retried after the interval, at most
//               `max_consecutive_errors` times in a row; then the service stops with the error recorded.
//
// Inputs: the config file, an optional injected `executors` (tests) or seats from the config. Outputs: the status
// file, the log, and the exit code (0 stopped, 1 refused, 3 NO_AUTHORITY). Must never: run without a declared total,
// run twice on one work ledger, or continue past missing authority.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {watch, billingStatus} from './scheduler.mjs';
import {spent} from './scheduler.mjs';
import {openWorkLedger} from './work-ledger.mjs';
import {prepareDispatch, loadIssues, tickSummary, limitsOf} from './cli.mjs';
import {billingFromConfig} from '../../pantheon/src/route/quota-failover.mjs';

export const SERVICE_CONFIG_SCHEMA = 'ophanim.operate-service/v1';
const refuse = (why, code = 'SERVICE_REFUSED') => { throw Object.assign(new Error(why), {code}); };
const KEYS = ['schema', 'repo', 'status_ledger', 'work_ledger', 'bundles', 'state_dir', 'issues', 'seats', 'interval_s', 'limits', 'holder', 'max_consecutive_errors', 'billing'];
const LIMIT_KEYS = {total_provider_calls: 'total-provider-calls', stage_provider_calls: 'stage-provider-calls', iterations: 'iterations', concurrency: 'concurrency',
  elapsed_ms: 'elapsed-ms', lease_ms: 'lease-ms', stage_attempts: 'stage-attempts'};

/** Read and validate a service config. Relative paths resolve against the config file's directory. */
export function readServiceConfig(file) {
  const at = path.dirname(path.resolve(file));
  let c;
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { refuse(`the service config ${file} is not readable JSON: ${e.message}`); }
  if (c?.schema !== SERVICE_CONFIG_SCHEMA) refuse(`the service config is an ${SERVICE_CONFIG_SCHEMA} object`);
  const unknown = Object.keys(c).filter(k => !KEYS.includes(k));
  if (unknown.length) refuse(`unknown service config key(s): ${unknown.join(', ')}`);
  const abs = p => (p == null ? null : path.resolve(at, p));
  if (!c.limits || !Number.isInteger(c.limits.total_provider_calls) || c.limits.total_provider_calls < 0) {
    refuse('limits.total_provider_calls must be declared (a non-negative integer): it caps every provider call the work ledger records');
  }
  const unknownLimits = Object.keys(c.limits).filter(k => !Object.hasOwn(LIMIT_KEYS, k));
  if (unknownLimits.length) refuse(`unknown limit(s): ${unknownLimits.join(', ')}`);
  for (const [k, v] of Object.entries(c.limits)) if (!(Number.isInteger(v) && v >= 0)) refuse(`limits.${k} is a non-negative integer`);
  if (!(Number.isInteger(c.interval_s) && c.interval_s >= 10)) refuse('interval_s is a whole number of seconds, at least 10');
  const issues = c.issues ?? {source: 'none'};
  if (!['github', 'file', 'none'].includes(issues.source)) refuse('issues.source is github, file or none');
  if (issues.source === 'file' && typeof issues.path !== 'string') refuse('issues.path names the snapshot file');
  if (issues.source === 'github' && !/^[\w.-]+\/[\w.-]+$/.test(issues.repository ?? '')) refuse('issues.repository is owner/name');
  const repo = abs(c.repo ?? '.');
  return {
    repo, statusRoot: abs(c.status_ledger) ?? path.join(repo, 'status', 'ledger'), workRoot: abs(c.work_ledger) ?? path.join(repo, 'status', 'work'),
    bundlesDir: abs(c.bundles), stateDir: abs(c.state_dir) ?? path.join(repo, 'status', 'operate', 'service'),
    issues: issues.source === 'file' ? {...issues, path: abs(issues.path)} : issues,
    seats: {turn: abs(c.seats?.turn), clients: abs(c.seats?.clients)},
    interval_ms: c.interval_s * 1000, holder: c.holder ?? `service@${os.hostname()}`, max_consecutive_errors: c.max_consecutive_errors ?? 5,
    // The Gemini billing policy, resolved once from the config (refused here, before anything runs, when malformed).
    billing: billingFromConfig(c.billing, `service config ${path.resolve(file)} billing`),
    // The CLI's limit parser, so the service and `tick` mean the same thing by every limit.
    limits: limitsOf(Object.fromEntries(Object.entries(c.limits).map(([k, v]) => [LIMIT_KEYS[k], String(v)]))),
  };
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** Take the single-instance lock, or refuse. Returns {release, takeover}. */
export function acquireLock(file, {pid = process.pid, host = os.hostname(), now = Date.now()} = {}) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const mine = {pid, host, started: new Date(now).toISOString()};
  let takeover = null;
  for (let tries = 0; tries < 2; tries++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify(mine) + '\n');
      fs.closeSync(fd);
      return {takeover, release: () => {
        try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === pid) fs.rmSync(file); } catch { /* already gone */ }
      }};
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let held = null;
      try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { held = null; }
      if (held && held.host !== host) refuse(`the work ledger is served from ${held.host} (pid ${held.pid}, since ${held.started}); stop it there first`, 'SERVICE_RUNNING');
      if (held && alive(held.pid)) refuse(`a service is already running on this work ledger (pid ${held.pid}, since ${held.started})`, 'SERVICE_RUNNING');
      takeover = {previous: held, why: held ? `pid ${held.pid} is not running: its lock is stale` : 'the lock file was unreadable'};
      fs.rmSync(file, {force: true});
    }
  }
  refuse('could not take the service lock');
}

/**
 * Run the service until `signal` aborts (or, with `maxTicks`, after that many loop turns: tests and bounded runs).
 * Returns {code, ticks, stopped}.
 */
export async function runService({config, executors = null, signal = null, maxTicks = null, fetchImpl, env = process.env, clock = Date.now, onProgress = null,
  sleep = (ms, sig) => new Promise(r => { const t = setTimeout(r, ms); sig?.addEventListener('abort', () => { clearTimeout(t); r(); }, {once: true}); })}) {
  const c = config;
  fs.mkdirSync(c.stateDir, {recursive: true});
  const statusFile = path.join(c.stateDir, 'service-status.json'), logFile = path.join(c.stateDir, 'service.jsonl');
  const write = s => fs.writeFileSync(statusFile, JSON.stringify({schema: 'ophanim.operate-service-status/v1', holder: c.holder, pid: process.pid, ...s}, null, 2) + '\n');
  const event = e => fs.appendFileSync(logFile, JSON.stringify({at: new Date(clock()).toISOString(), ...e}) + '\n');
  const paths = {repo: c.repo, statusRoot: c.statusRoot, workRoot: c.workRoot, bundlesDir: c.bundlesDir};

  let lock;
  // The lock lives in the WORK LEDGER's root, not the state directory: two configs with different state_dirs on one work
  // ledger each took their own lock and ran at once (independent review round 2, assignment 3 (Google gemini-4-carbon,
  // manual, 77480d6), finding 3.2a). One instance per work ledger, as docs/operate-service.md states.
  try { lock = acquireLock(path.join(c.workRoot, 'service.lock'), {now: clock()}); }
  catch (e) { event({event: 'refused', code: e.code, why: e.message}); return {code: 1, refused: e.message, ticks: []}; }
  if (lock.takeover) event({event: 'lock-takeover', ...lock.takeover});
  const ticks = [];
  try {
    let exec = executors;
    if (!exec) {
      const prep = await prepareDispatch({paths, opts: {...(c.seats.turn ? {turn: c.seats.turn} : {}), ...(c.seats.clients ? {clients: c.seats.clients} : {})}, limits: c.limits,
        progress: e => event({event: 'progress', ...e})});
      if (prep.blocked) {
        write({state: 'blocked', at: new Date(clock()).toISOString(), block: prep.blocked});
        event({event: 'blocked', block: prep.blocked});
        return {code: 3, blocked: prep.blocked, ticks};
      }
      exec = prep.executors;
    }
    const opts = c.issues.source === 'github' ? {github: true} : c.issues.source === 'file' ? {issues: c.issues.path} : {};
    const issueEnv = c.issues.source === 'github' ? {...env, GITHUB_REPOSITORY: c.issues.repository} : env;
    const fetchIssues = async () => (await loadIssues(opts, {fetchImpl, env: issueEnv})).issues;
    const state = {last: null, due: null};
    event({event: 'started', limits: c.limits, interval_ms: c.interval_ms, issues: c.issues.source, ...(c.billing ? {billing: {digest: c.billing.digest, metered_gemini_failover: c.billing.metered_gemini_failover, gemini_api_primary: c.billing.gemini_api_primary}} : {})});
    let errors = 0, turns = 0, stopped = 'signal';
    while (!signal?.aborted) {
      if (maxTicks !== null && turns >= maxTicks) { stopped = 'max-ticks'; break; }
      turns++;
      try {
        // `interrupt`: the service's own stop reaches the stage in flight (L-121), not only the loop.
        const ran = await watch({repo: c.repo, statusRoot: c.statusRoot, workRoot: c.workRoot, bundlesDir: c.bundlesDir, executors: exec, limits: c.limits,
          holder: c.holder, fetchIssues, once: true, state, clock, ...(signal ? {interrupt: signal} : {}), ...(c.billing ? {billing: c.billing} : {}),
          progress: e => { if (typeof onProgress === 'function') onProgress(e); event({event: 'progress', ...e}); }});
        errors = 0;
        const t = ran.at(-1) ?? null;
        if (t) { ticks.push(t); event({event: 'tick', summary: tickSummary(t, c.limits)}); }
        const ledgerNow = openWorkLedger({root: c.workRoot});
        const used = spent(ledgerNow).calls;
        write({state: 'running', heartbeat: new Date(clock()).toISOString(), last_tick: t ? tickSummary(t, c.limits) : 'no input changed; nothing due',
          next_retry_due: state.due ? new Date(state.due).toISOString() : null,
          provider_calls: {spent: used, cap: c.limits.total_provider_calls, left: Math.max(0, c.limits.total_provider_calls - used)},
          ...(c.billing ? {billing: billingStatus(ledgerNow, c.billing)} : {})});
      } catch (e) {
        if (e.code === 'NO_AUTHORITY') { event({event: 'blocked', code: e.code, why: e.message}); write({state: 'blocked', why: e.message}); return {code: 3, ticks}; }
        errors++;
        event({event: 'tick-error', attempt: errors, why: e.message});
        write({state: 'error', heartbeat: new Date(clock()).toISOString(), error: e.message, consecutive_errors: errors});
        if (errors >= c.max_consecutive_errors) { stopped = `${errors} consecutive tick errors`; break; }
      }
      if (signal?.aborted || (maxTicks !== null && turns >= maxTicks)) continue;
      await sleep(c.interval_ms, signal);
    }
    write({state: 'stopped', at: new Date(clock()).toISOString(), why: stopped, ticks: ticks.length, ...(c.billing ? {billing: billingStatus(openWorkLedger({root: c.workRoot}), c.billing)} : {})});
    event({event: 'stopped', why: stopped});
    return {code: stopped.includes('error') ? 1 : 0, ticks, stopped};
  } finally {
    lock.release();
  }
}
