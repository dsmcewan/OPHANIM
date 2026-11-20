#!/usr/bin/env node
// The publisher: makes GitHub show the public record (docs/public-record.md), a PROJECTION of the
// ledgers. Nothing here reads GitHub to decide anything about the work; it reads GitHub only to find the
// issues and labels it already owns, so that a re-run updates them instead of duplicating them.
//
//   node ophanim/public/github.mjs plan [--out DIR] [--json]       dry run (default): no network
//   node ophanim/public/github.mjs apply                           GITHUB_TOKEN, GITHUB_REPOSITORY
//   node ophanim/public/github.mjs verify-item ITEM ENTRY          check an issue's "Verify this record"
//   node ophanim/public/github.mjs pr-provenance --ledger DIR [--cycle H | --scope S] [--anchor A]
//   node ophanim/public/github.mjs cycles [--ledger DIR] [--anchor A] [--out docs/cycles]
//                                  (default ledger: PANTHEON_CYCLE_LEDGER, else <git common dir>/pantheon-cycles)
//
// Common: --status-ledger DIR (default status/ledger, or OPHANIM_STATUS_LEDGER), --owner-login LOGIN
// (or OPHANIM_OWNER_LOGIN): the one real person who may be assigned, and only to decision-authority
// items. Default: nobody is ever assigned.
//
// Ownership: an issue is the publisher's only if its body carries `<!-- ophanim:item=<id> -->`; a label
// only if its description starts with `ophanim:`. It never edits, closes or deletes anything else, and it
// never removes a label or an assignee a person added to one of its issues.
//
// Projects v2 (opt-in): with PROJECT_URL (https://github.com/users|orgs/<owner>/projects/<n>) or
// PROJECT_ID, and OPHANIM_PROJECT_TOKEN (a PAT with `project` scope: GITHUB_TOKEN cannot write a
// user-owned project), each issue is added to the project and its Status field set where an option
// matches the state. Without them the sync is skipped with the reason logged.
//
// Inputs:  the verified status ledger (record.mjs), the CLI verb and options above, and the environment
//          variables named above. Outputs: GitHub labels/issues (apply), files under --out (plan),
//          JSON or text summaries on stdout; exit code 1 on refusal, 2 on a usage error.
// Invariants: what GitHub should show is computed from the ledger alone (record.mjs plan()); GitHub is
//          read only to find what the publisher already owns; writes are sequential and paced.
// Must never: touch an issue or label it does not own, remove a person's label or assignee, assign
//          anyone but the configured owner login, or write anything in `plan` (the dry run).
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {readStatusRecord, plan, planSummary, MARKER_RE, OWNED, ourLabelName} from './record.mjs';
import {DEFAULT_ROOT} from '../../packages/ledger/status.mjs';

const API = 'https://api.github.com';
const sleep = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());

/**
 * A minimal GitHub REST client over `fetch`: sequential, a pause between writes (GitHub's guidance for
 * content-creating requests), waits on a rate-limit response, and throws on any other non-2xx.
 */
export function restClient({
  token, fetchImpl = globalThis.fetch, api = API, writePause = 1000, log = () => {}, maxRateWait = 60_000
}) {
  if (!token) throw new Error('GITHUB_TOKEN is required to apply');
  let writes = 0;
  async function request(method, url, body) {
    const full = url.startsWith('http') ? url : api + url;
    if (method !== 'GET') { if (writes++) await sleep(writePause); }
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(full, {method, headers: {
        authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
        'user-agent': 'ophanim-public-record', ...(body !== undefined ? {'content-type': 'application/json'} : {}),
      }, ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
      const h = k => res.headers?.get?.(k) ?? null;
      // A rate limit is a 429/403 that says so (retry-after, or no requests remaining); retried 3 times.
      const limited = (res.status === 429 || res.status === 403) &&
        (h('retry-after') !== null || h('x-ratelimit-remaining') === '0');
      if (limited && attempt < 3) {
        const wait = h('retry-after') !== null ? Number(h('retry-after')) * 1000
          : Math.max(0, Number(h('x-ratelimit-reset')) * 1000 - Date.now());
        if (wait > maxRateWait)
          throw new Error(`${method} ${url}: rate limited for ${Math.round(wait / 1000)}s; stopping`);
        log(`rate limited; waiting ${Math.round(wait / 1000)}s`);
        await sleep(wait);
        continue;
      }
      const text = await res.text();
      if (res.status < 200 || res.status >= 300)
        throw Object.assign(new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 500)}`),
          {status: res.status});
      return {data: text ? JSON.parse(text) : null, link: h('link')};
    }
  }
  async function paginate(url) {
    const out = [];
    for (let next = url; next;) {
      const {data, link} = await request('GET', next);
      out.push(...data);
      next = /<([^>]+)>;\s*rel="next"/.exec(link ?? '')?.[1] ?? null;
    }
    return out;
  }
  return {request, paginate, writes: () => writes};
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/**
 * Make the repository's issues and labels match the plan. Idempotent: owned issues are found by their
 * marker and updated only where they differ; a second run over an unchanged ledger writes nothing.
 * Returns a summary of what was done.
 */
export async function apply({record, repo, token, fetchImpl, ownerLogin = null, writePause = 1000, log = console.log}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('GITHUB_REPOSITORY (owner/name) is required to apply');
  const gh = restClient({token, fetchImpl, writePause, log});
  const R = `/repos/${repo}`;
  const summary = {labels: {created: [], updated: [], unchanged: [], foreign: []},
    issues: {created: [], updated: [], unchanged: [], duplicates: []}};

  // Labels: create the missing; update only those carrying the ownership prefix.
  const desired = plan(record, {ownerLogin});
  const existing = new Map((await gh.paginate(`${R}/labels?per_page=100`)).map(l => [l.name, l]));
  for (const l of desired.labels) {
    const have = existing.get(l.name);
    if (!have) { await gh.request('POST', `${R}/labels`, l); summary.labels.created.push(l.name); }
    else if (!(have.description ?? '').startsWith(OWNED)) {
      summary.labels.foreign.push(l.name); log(`label ${l.name} exists and is not ours: left as is`);
    }
    else if (have.color?.toLowerCase() !== l.color || have.description !== l.description) {
      await gh.request('PATCH', `${R}/labels/${encodeURIComponent(l.name)}`,
        {new_name: l.name, color: l.color, description: l.description});
      summary.labels.updated.push(l.name);
    } else summary.labels.unchanged.push(l.name);
  }

  // Issues: the owned ones, by marker. Pull requests are listed by this endpoint too and are skipped.
  const owned = new Map();
  for (const i of await gh.paginate(`${R}/issues?state=all&per_page=100`)) {
    if (i.pull_request) continue;
    const id = MARKER_RE.exec(i.body ?? '')?.[1];
    if (!id) continue;
    if (owned.has(id)) {
      summary.issues.duplicates.push(i.number);
      log(`issue #${i.number} repeats the marker of ${id} (#${owned.get(id).number}); left as is`); continue;
    }
    owned.set(id, i);
  }
  const numbers = new Map([...owned].map(([id, i]) => [id, i.number]));

  // Create what is missing, dependencies first, so most bodies link correctly at creation.
  for (const want of desired.issues) {
    if (owned.has(want.item)) continue;
    const now = plan(record, {numbers, ownerLogin}).issues.find(x => x.item === want.item);
    const {data} = await gh.request('POST', `${R}/issues`, {title: now.title, body: now.body, labels: now.labels,
      ...(now.assignees.length ? {assignees: now.assignees} : {})});
    owned.set(want.item,
      {...data, labels: data.labels ?? now.labels.map(name => ({name})), assignees: data.assignees ?? []});
    numbers.set(want.item, data.number);
    summary.issues.created.push(want.item);
  }

  // Then bring every owned issue to the final plan (with every number known).
  const final = plan(record, {numbers, ownerLogin});
  for (const want of final.issues) {
    const have = owned.get(want.item);
    const haveLabels = (have.labels ?? []).map(l => (typeof l === 'string' ? l : l.name));
    const labels = [...haveLabels.filter(n => !ourLabelName(n)), ...want.labels];     // keep labels people added
    const patch = {};
    if (have.title !== want.title) patch.title = want.title;
    if ((have.body ?? '') !== want.body) patch.body = want.body;
    if (!sameSet(haveLabels, labels)) patch.labels = labels;
    if (have.state !== want.state) patch.state = want.state;
    if (want.state === 'closed' && (have.state_reason ?? null) !== want.state_reason)
      patch.state_reason = want.state_reason;
    if (Object.keys(patch).length) {
      await gh.request('PATCH', `${R}/issues/${have.number}`, patch);
      if (!summary.issues.created.includes(want.item)) summary.issues.updated.push(want.item);
    } else if (!summary.issues.created.includes(want.item)) summary.issues.unchanged.push(want.item);
    // Assignees are only ever added (a person, configured), never removed.
    const missing = want.assignees.filter(a => !(have.assignees ?? []).some(x => x.login === a));
    if (missing.length && !(summary.issues.created.includes(want.item)))
      await gh.request('POST', `${R}/issues/${have.number}/assignees`, {assignees: missing});
  }
  const stateOf = new Map(record.items.map(i => [i.item, i.state]));
  summary.items = final.issues.map(w => ({item: w.item, number: owned.get(w.item).number,
    node_id: owned.get(w.item).node_id ?? null, state: stateOf.get(w.item)}));
  summary.numbers = Object.fromEntries(numbers);
  summary.writes = gh.writes();
  return summary;
}

/**
 * Projects v2 sync, opt-in. Skips (with a reason) unless a project and a project token are configured.
 * Adding an issue that is already on the project returns its existing item, so this is idempotent.
 */
export async function syncProject({env = process.env, issues, fetchImpl = globalThis.fetch, log = console.log}) {
  const token = env.OPHANIM_PROJECT_TOKEN;
  const url = env.PROJECT_URL, id = env.PROJECT_ID;
  if (!url && !id) {
    const why = 'Projects sync skipped: no PROJECT_URL or PROJECT_ID is configured'; log(why); return {skipped: why};
  }
  if (!token) {
    const why =
      'Projects sync skipped: no OPHANIM_PROJECT_TOKEN (a PAT with project scope; GITHUB_TOKEN cannot write a ' +
        'user-owned project)';
    log(why); return {skipped: why};
  }
  const gql = async (query, variables) => {
    const res = await fetchImpl(`${API}/graphql`, {method: 'POST',
      headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json',
        'user-agent': 'ophanim-public-record'},
      body: JSON.stringify({query, variables})});
    const j = await res.json();
    if (res.status < 200 || res.status >= 300 || j.errors?.length)
      throw new Error(`GraphQL ${res.status}: ${JSON.stringify(j.errors ?? j).slice(0, 500)}`);
    return j.data;
  };
  let projectId = id;
  if (!projectId) {
    const m = /github\.com\/(users|orgs)\/([^/]+)\/projects\/(\d+)/.exec(url);
    if (!m) throw new Error(`PROJECT_URL is not a project URL: ${url}`);
    const owner = m[1] === 'users' ? 'user' : 'organization';
    const d = await gql(`query($login:String!,$n:Int!){ ${owner}(login:$login){ projectV2(number:$n){ id } } }`,
      {login: m[2], n: Number(m[3])});
    projectId = d[owner]?.projectV2?.id;
    if (!projectId) throw new Error(`project not found: ${url}`);
  }
  // The project's single-select Status field and its options; an issue's state sets the matching option.
  const f = await gql(
    `query($p:ID!){ node(id:$p){ ... on ProjectV2 { field(name:"Status"){ ... on ProjectV2SingleSelectField { id ` +
      `options { id name } } } } } }`,
    {p: projectId}
  );
  const status = f.node?.field ?? null;
  let added = 0, set = 0;
  for (const i of issues) {
    if (!i.node_id) continue;
    const d = await gql(
      `mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p, contentId:$c}){ item { id } } }`,
      {p: projectId, c: i.node_id}
    );
    added++;
    const option = status?.options?.find(o => o.name.toLowerCase() === i.state.toLowerCase());
    if (option) {
      await gql(
        `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){ updateProjectV2ItemFieldValue(input:{projectId:$p, itemId:$i, ` +
          `fieldId:$f, value:{singleSelectOptionId:$o}}){ projectV2Item { id } } }`,
        {p: projectId, i: d.addProjectV2ItemById.item.id, f: status.id, o: option.id}
      );
      set++;
    }
  }
  return {project: projectId, added, status_set: set};
}

/** Check one issue's "Verify this record" claim against the verified status ledger. */
export function verifyItem({record, item, entry}) {
  const it = record.items.find(i => i.item === item);
  if (!it) return {ok: false, why: `${item} is not on the status board`};
  const h = it.history.find(x => x.entry === entry);
  if (!h) return {ok: false, why: `${entry} is not a status entry of ${item} on the verified chain`};
  if (it.entry !== entry)
    return {ok: false, why: `${entry} is a status of ${item} but has been superseded by ${it.entry}`, entry: h};
  return {ok: true, entry: h};
}

// CLI
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [first, ...rest] = process.argv.slice(2);
  const verb = first && !first.startsWith('--') ? first : 'plan';
  const args = first && !first.startsWith('--') ? rest : process.argv.slice(2);
  const opts = {}, pos = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { pos.push(args[i]); continue; }
    const k = args[i].slice(2);
    opts[k] = k === 'json' ? true : args[++i];
  }
  const statusRoot = path.resolve(opts['status-ledger'] ?? process.env.OPHANIM_STATUS_LEDGER ?? DEFAULT_ROOT);
  const ownerLogin = opts['owner-login'] ?? (process.env.OPHANIM_OWNER_LOGIN || null);
  const record = () => readStatusRecord({root: statusRoot});
  try {
    if (verb === 'plan') {
      const p = plan(record(), {ownerLogin});
      if (opts.out) {
        const out = path.resolve(opts.out);
        fs.mkdirSync(path.join(out, 'issues'), {recursive: true});
        // One preview file per issue: title, labels, state and assignees, then the body.
        for (const i of p.issues) fs.writeFileSync(
          path.join(out, 'issues', `${i.item}.md`),
          `# ${i.title}\n\nlabels: ${i.labels.join(', ')} · state: ${i.state}${i.state_reason ? ` ` +
            `(${i.state_reason})` : ''} · assignees: ${i.assignees.join(', ') || 'none'}\n\n---\n\n${i.body}`
        );
        fs.writeFileSync(path.join(out, 'plan.json'), JSON.stringify(p, null, 2) + '\n');
      }
      console.log(opts.json ? JSON.stringify(p, null, 2) : planSummary(p));
    } else if (verb === 'apply') {
      const s = await apply({record: record(), repo: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN,
        ownerLogin});
      console.log(JSON.stringify({labels: Object.fromEntries(Object.entries(s.labels).map(([k, v]) => [k, v.length])),
        issues: Object.fromEntries(Object.entries(s.issues).map(([k, v]) => [k, v.length])), writes: s.writes}));
      console.log(JSON.stringify(await syncProject({issues: s.items})));
    } else if (verb === 'verify-item') {
      const [item, entry] = pos;
      if (!item || !entry) throw Object.assign(new Error('usage: verify-item ITEM ENTRY'), {usage: true});
      const v = verifyItem({record: record(), item, entry});
      console.log(v.ok ? `ok: ${entry} is the latest status of ${item} on the verified status ledger`
        : `refused: ${v.why}`);
      if (v.entry) console.log(JSON.stringify(v.entry, null, 2));
      process.exitCode = v.ok ? 0 : 1;
    } else if (verb === 'pr-provenance' || verb === 'cycles') {
      const P = await import('./provenance.mjs');
      // Default: the review-cycle CLI's own default, <git common dir>/pantheon-cycles.
      const gitDefault = () => {
        try {
          return path.join(path.resolve(REPO_ROOT,
            execFileSync('git', ['rev-parse', '--git-common-dir'], {cwd: REPO_ROOT, encoding: 'utf8'}).trim()),
          'pantheon-cycles');
        } catch { return null; }
      };
      const ledgerRoot = opts.ledger ?? process.env.PANTHEON_CYCLE_LEDGER ?? gitDefault();
      const opened = ledgerRoot && fs.existsSync(path.join(path.resolve(ledgerRoot), 'chain.jsonl'))
        ? P.openLedgerReadOnly({root: path.resolve(ledgerRoot), anchor: opts.anchor ?? null}) : null;
      if (verb === 'cycles') {
        if (ledgerRoot && !opened) console.error(`no ledger at ${ledgerRoot}: writing an empty index`);
        const files = P.writeCycleReports({opened, out: path.resolve(opts.out ?? path.join(REPO_ROOT, 'docs/cycles'))});
        console.log(files.map(f => path.relative(process.cwd(), f)).join('\n'));
      } else {
        if (!opened)
          throw Object.assign(new Error('pr-provenance needs --ledger DIR (a system or review-cycle ledger)'), {
            usage: true
          });
        const cycles = P.listCycles(opened.view).filter(c => !opts.scope || c.scope === opts.scope);
        const cycle = opts.cycle ?? cycles.at(-1)?.hash;
        if (!cycle) throw new Error('no cycle on this ledger');
        console.log(P.prProvenance(opened.view, cycle, {anchor: opened.anchor}));
      }
    } else throw Object.assign(new Error(`unknown verb: ${verb}`), {usage: true});
  } catch (err) {
    console.error(err.usage ? `${err.message}\nusage: github.mjs [plan|apply|verify-item|pr-provenance|cycles] ...`
      : `refused: ${err.message}`);
    process.exit(err.usage ? 2 : 1);
  }
}
