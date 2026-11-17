// One work identity per item. Reconciliation joins every representation of the same work -- the status ledger
// item (authoritative), its published GitHub issue (by the `<!-- ophanim:item=ID -->` marker the public record
// writes), its ticket (tickets/<item>.json), its retained runs (evidence bundles naming the item), and its work
// ledger records (claims, stage results, findings, usage) -- so an issue and its ticket are never two jobs.
//
// Counts are read, never assumed. An issue with no marker is an intake CANDIDATE: recorded, classified for the
// owner, never executed (issue text and comments are task data, not authority). A ticket for an item that is not
// on the ledger is an orphan, reported. Two issues carrying the same item marker are reported as a duplicate.
//
// Inputs: repo, statusRoot, workLedger (openWorkLedger), issues (a snapshot array {number, title, body, state,
// labels}) or null, bundlesDir or null. Output: {items: [{item, status, history, ticket, issues, runs, gate,
// stages}], candidates, orphans, duplicates, counts}. Pure apart from reading those files.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {openStatusLedger} from '../../packages/ledger/status.mjs';
import {readTicket} from '../../pantheon/src/board/operate.mjs';
import {buildDossier} from './context.mjs';
import {earliestGate} from './gates.mjs';

export const MARKER = /<!--\s*ophanim:item=([a-z0-9][a-z0-9.-]{0,63})\s*-->/;

/** Every status entry of every item, in ledger order, with its entry hash. */
export function statusHistory(statusRoot) {
  const S = openStatusLedger({root: statusRoot, create: false});
  const L = S.ledger, byItem = new Map();
  for (const e of L.read()) {
    if (e.kind !== 'status') continue;
    const p = L.payloadOf(e);
    (byItem.get(p.item) ?? byItem.set(p.item, []).get(p.item)).push({...p, entry: L.hashOf(e)});
  }
  return {board: S.board(), byItem};
}

/** Retained runs: evidence bundles under `dir` (any depth), by the item they name. */
export function retainedRuns(dir) {
  const out = new Map();
  if (!dir || !fs.existsSync(dir)) return out;
  const walk = d => {
    for (const e of fs.readdirSync(d, {withFileTypes: true})) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'evidence.json') {
        try {
          const b = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (b.item) (out.get(b.item) ?? out.set(b.item, []).get(b.item)).push({file: p, shipped: b.run?.shipped ?? null, commit: b.commit ?? null,
            review: b.review ? {status: b.review.status ?? (b.review.close ? 'closed' : 'open'), outcome: b.review.outcome ?? null} : null, ticket: b.ticket?.digest ?? null});
        } catch { /* an unreadable bundle is not evidence */ }
      }
    }
  };
  walk(dir);
  return out;
}

/** The current sha256 of a repository path, or null. */
export const bytesOfRepo = repo => p => {
  const f = path.resolve(repo, p);
  return fs.existsSync(f) && fs.statSync(f).isFile() ? 'sha256:' + createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null;
};

export function reconcile({repo, statusRoot, workLedger, issues = null, bundlesDir = null, now = Date.now()}) {
  const {board, byItem} = statusHistory(statusRoot);
  const latest = new Map(board.items.map(i => [i.item, i]));
  const runs = retainedRuns(bundlesDir);
  const ticketsDir = path.join(repo, 'tickets');
  const ticketItems = fs.existsSync(ticketsDir) ? fs.readdirSync(ticketsDir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)) : [];
  const issueByItem = new Map(), candidates = [], duplicates = [];
  for (const issue of issues ?? []) {
    const m = MARKER.exec(issue.body ?? '');
    if (!m) { candidates.push({number: issue.number, title: issue.title, state: issue.state, why: 'no item marker: an intake candidate for the owner to classify; never executed on its own'}); continue; }
    const list = issueByItem.get(m[1]) ?? issueByItem.set(m[1], []).get(m[1]);
    list.push(issue.number);
    if (list.length === 2) duplicates.push({item: m[1], issues: list});
  }
  const bytesOf = bytesOfRepo(repo);
  const items = board.items.map(s => {
    const ticketFile = path.join(ticketsDir, `${s.item}.json`);
    const ticket = fs.existsSync(ticketFile) ? readTicket({repo, item: s.item}) : null;
    const stages = workLedger ? workLedger.stages(s.item) : [];
    const activeClaim = workLedger ? workLedger.activeClaim(s.item, now) : null;
    const gate = earliestGate({item: s, history: byItem.get(s.item) ?? [s], depStatus: d => latest.get(d) ?? null, ticket, stages, activeClaim, bytesOf, now,
      recovery: workLedger ? workLedger.recoveries(s.item).filter(r => r.status_entry === s.entry).at(-1) ?? null : null,
      reassessments: workLedger?.reassessments ? workLedger.reassessments(s.item) : [],
      // Only for a plan waiting on evidence: what the evidence looks like now (context.mjs), so a change wakes it.
      evidenceStable: stages.filter(x => x.stage === 'plan').at(-1)?.blocker?.code === 'EVIDENCE_INSUFFICIENT'
        ? (() => { try { return buildDossier({repo, statusRoot, item: s.item, work: workLedger, issues, bundlesDir}).stable; } catch { return null; } })() : null});
    return {item: s.item, title: s.title, status: s.state, entry: s.entry, depends_on: s.depends_on ?? [], history: (byItem.get(s.item) ?? []).length,
      ticket: ticket ? (ticket.why ? {invalid: ticket.why} : {path: ticket.path, digest: ticket.digest}) : null,
      issues: issueByItem.get(s.item) ?? [], runs: runs.get(s.item) ?? [], stages: stages.length, gate};
  });
  const orphans = ticketItems.filter(i => !latest.has(i)).map(i => ({ticket: `tickets/${i}.json`, why: 'a ticket for an item that is not on the status ledger'}));
  const gateCounts = {};
  for (const i of items) gateCounts[i.gate.gate] = (gateCounts[i.gate.gate] ?? 0) + 1;
  return {at: new Date(now).toISOString(), ledger: {head: board.head, entries: board.entries}, items, candidates, orphans, duplicates,
    counts: {items: items.length, issues: (issues ?? []).length, linked_issues: [...issueByItem.values()].flat().length, candidates: candidates.length,
      tickets: ticketItems.length, orphans: orphans.length, items_with_runs: items.filter(i => i.runs.length).length, by_gate: gateCounts}};
}
