// One work identity per item. Reconciliation joins every representation of the same work -- the status ledger
// item (authoritative), its published GitHub issue (by the `<!-- ophanim:item=ID -->` marker the public record
// writes), its ticket (tickets/<item>.json), its retained runs (evidence bundles naming the item), and its work
// ledger records (claims, stage results, findings, usage) -- so an issue and its ticket are never two jobs.
//
// Counts are read, never assumed. An issue with no marker is an intake CANDIDATE: recorded, classified for the
// owner, never executed (issue text and comments are task data, not authority). A ticket for an item that is not
// on the ledger is an orphan, reported. Two issues carrying the same item marker are reported as a duplicate.
//
// A PROMPT (prompt-intake.mjs) is joined the same way. An item whose SIGNED basis binds a prompt record carries it
// (`prompt: {path, digest, verified}`); when the record is missing or is not the text whose digest the owner signed, the
// item is BLOCKED (PROMPT_RECORD_MISMATCH) for as long as that is so, and nothing is planned from changed text. A prompt
// record with no signed entry, or that its item's signed basis does not bind, is a `prompt_candidates` row: recorded,
// reported, never executed.
//
// Inputs: repo, statusRoot, workLedger (openWorkLedger), issues (a snapshot array {number, title, body, state,
// labels}) or null, bundlesDir or null. Output: {items: [{item, status, history, ticket, prompt, issues, runs, gate,
// stages}], candidates, prompt_candidates, orphans, duplicates, counts}. Pure apart from reading those files.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {openStatusLedger, checkEvidenceLedgers} from '../../packages/ledger/status.mjs';
import {readTicket} from '../../pantheon/src/board/operate.mjs';
import {buildDossier, makeRetriever, admitFile} from './context.mjs';
import {earliestGate, completionEvidence, attemptInputs, requirementOf} from './gates.mjs';
import {researchOf} from './research-view.mjs';
import {promptBinding, promptRequirement, promptRecords} from './prompt-intake.mjs';
import {sourcesDigest, bundlesOf} from './evidence-recovery.mjs';
import {STAGES, workKey} from './work-ledger.mjs';

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

/**
 * The present identity of a repository path AS THE RETRIEVER'S `file` OP WOULD SERVE IT (context.mjs, THE VERSION
 * CONTRACT; register L-504, invariant 1): the sha256 of its raw bytes -- the version that op records -- when the op admits
 * the path (context.mjs admitFile); `refused:<sha256>` when the bytes are there but the op would now refuse them (newly
 * excluded by .gitignore, reached through a link out of the repository, inside git's own directory); null when there is
 * no file. So a cited file whose bytes are unchanged but which the op would no longer deliver is a change, never
 * "unchanged" (it compared the bytes behind the path only), and a file bound without being delivered (a plan's copy file,
 * stages.mjs) is bound and re-checked by the same identity. One admission check per path per closure.
 */
export const bytesOfRepo = repo => {
  const seen = new Map();
  return p => {
    if (seen.has(p)) return seen.get(p);
    const f = typeof p === 'string' && p ? path.resolve(repo, p) : null;
    let id = null;
    if (f && fs.existsSync(f) && fs.statSync(f).isFile()) {
      const raw = 'sha256:' + createHash('sha256').update(fs.readFileSync(f)).digest('hex');
      id = admitFile(repo, p).error ? `refused:${raw}` : raw;
    }
    seen.set(p, id);
    return id;
  };
};

/**
 * The ticket bytes a PLAN was given (null: there was none), so its dossier views are re-derived without its own
 * consequence, the ticket it wrote. A plan recorded with `ticket_given` names them; an older one that kept the ticket
 * was given the present bytes (undefined: read the file); an older one that wrote a ticket with no earlier one was given
 * none; an older one that revised a ticket recorded only the earlier digest, so its rebuild reads the present file.
 * (Self-audit round 3, assignment 1 (sealed 323361a), question 1: a plan staled itself through its own ticket write.)
 */
export function ticketGiven(rec) {
  if (rec?.stage !== 'plan' || rec.status !== 'passed') return undefined;
  const o = rec.outputs ?? {};
  if (o.ticket_given !== undefined) return o.ticket_given === null ? null : o.ticket_given.text;
  if (o.ticket_kept) return undefined;
  if (o.ticket && !o.ticket_revision) return null;
  return undefined;
}

// `capacity(stage)` (optional): the reviewer-pool signature of the stage executors (stages.mjs), passed to the gate
// so a capacity-pending stage is dispatched again when the pool changed. A caller without executors leaves it out.
export function reconcile({repo, statusRoot, workLedger, issues = null, bundlesDir = null, now = Date.now(), capacity = null}) {
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
  // The current version of a non-file view a plan cited (an issue, a status history, a grep): re-read with the same
  // read-only retriever the seats use, made once and only when a plan needs it (gates.mjs planValidity).
  let R = null;
  const views = new Map();
  // A view the dossier DERIVED (its relations, consumers, guess, runs, index) is re-derived: the dossier is rebuilt for
  // the plan's item against the work ledger as it stood when the plan was made (the records before it: the plan's own
  // consequences, such as an outcome bundle, are not new evidence), and the cited view's version read from it. A view
  // the rebuild no longer derives is gone (null); a rebuild that fails is undefined, and the plan is stale
  // (independent review round 2, assignment 1, OpenAI gpt-6.1-sol, 77480d6, questions 1 and 5).
  // (The record's other own consequence, the ticket a plan wrote, is cut back too: the dossier is rebuilt with the
  // ticket the plan was GIVEN (ticketGiven), not the one it wrote.)
  const dossierViews = plan => {
    if (!plan?.hash) return null;
    if (!views.has(plan.hash)) {
      let v = null;
      try {
        const item = plan.identity?.item;
        const before = [];
        for (const x of workLedger ? workLedger.stages(item) : []) { if (x.hash === plan.hash) break; before.push(x); }
        const work = workLedger ? {root: workLedger.root, stages: i => (i === undefined ? workLedger.stages() : i === item ? before : workLedger.stages(i))} : null;
        v = buildDossier({repo, statusRoot, item, work, issues, bundlesDir, ticketText: ticketGiven(plan)}).views;
      } catch { v = null; }
      views.set(plan.hash, v);
    }
    return views.get(plan.hash);
  };
  const versionOf = (request, {plan = null} = {}) => {
    if (request?.op === 'dossier') {
      const v = dossierViews(plan);
      return v ? (v.get(request.source)?.version ?? null) : undefined;
    }
    return (R ??= makeRetriever({repo, statusRoot, work: workLedger, issues})).versionOf(request);
  };
  // A passed outcome's proposal, re-checked as `status.mjs apply` will (the outcome stage's own check, now): why it would
  // be refused, or null. The proposal file must still be the bytes the stage recorded.
  // An outcome that recorded no proposal file (a scripted one) has nothing to re-check.
  const outcomeRecheck = rec => {
    const file = rec.outputs?.proposal_path;
    if (!file) return null;
    if (!fs.existsSync(file)) return `the proposal file ${file} is missing`;
    const bytes = fs.readFileSync(file);
    if (rec.outputs.proposal_file_sha256 && 'sha256:' + createHash('sha256').update(bytes).digest('hex') !== rec.outputs.proposal_file_sha256) return 'the proposal file changed since the outcome recorded it';
    let checks;
    try { checks = checkEvidenceLedgers(JSON.parse(bytes.toString('utf8'))); } catch (e) { return `its evidence does not re-check: ${String(e.message).slice(0, 200)}`; }
    if (checks?.checked !== 'structural') return `its evidence does not re-check as apply would: ${checks?.why ?? Object.entries(checks ?? {}).filter(([k, v]) => k !== 'checked' && !v).map(([k]) => k).join(', ')}`;
    return null;
  };
  const items = board.items.map(s => {
    const ticketFile = path.join(ticketsDir, `${s.item}.json`);
    const ticket = fs.existsSync(ticketFile) ? readTicket({repo, item: s.item}) : null;
    const stages = workLedger ? workLedger.stages(s.item) : [];
    const activeClaim = workLedger ? workLedger.activeClaim(s.item, now) : null;
    // Evidence recovery for a Resolved item without completion evidence: the digest of its sources NOW, and the recorded
    // search of exactly those sources when there is one (else the latest). A recovered proposal whose sources changed
    // since no longer stands: the item is searched again (gates.mjs; independent review, assignment 1, question 5).
    const gap = workLedger && s.state === 'Resolved' && !completionEvidence(s).ok;
    const recoverySources = gap ? sourcesDigest({repo, item: s.item, bundles: bundlesOf({item: s.item, bundlesDir, work: workLedger}), work: workLedger}) : null;
    const recs = workLedger ? workLedger.recoveries(s.item).filter(r => r.status_entry === s.entry) : [];
    const recovery = recs.filter(r => r.sources === recoverySources).at(-1) ?? recs.at(-1) ?? null;
    let gate = earliestGate({item: s, history: byItem.get(s.item) ?? [s], depStatus: d => latest.get(d) ?? null, ticket, stages, activeClaim, bytesOf, versionOf, now,
      recovery, recoverySources, capacity, outcomeRecheck,
      reassessments: workLedger?.reassessments ? workLedger.reassessments(s.item) : [],
      research: workLedger?.research ? (r => ({open: r.open, conclusions: r.conclusions}))(researchOf(workLedger, s.item)) : null,
      // Only for a plan waiting on evidence: what the evidence looks like now (context.mjs), so a change wakes it.
      evidenceStable: stages.filter(x => x.stage === 'plan').at(-1)?.blocker?.code === 'EVIDENCE_INSUFFICIENT'
        ? (() => { try { return buildDossier({repo, statusRoot, item: s.item, work: workLedger, issues, bundlesDir}).stable; } catch { return null; } })() : null});
    // AN ATTEMPT IDENTITY COLLISION IS A BLOCK, NEVER A SILENT SKIP. A gate that routes a stage whose attempt identity
    // (gates.mjs attemptInputs: the routing basis included) already COMPLETED would be refused by the work ledger as
    // "already completed for these exact inputs" on every tick: the gate says the work is needed and the identity says
    // it is done. That contradiction is reported here, as a block with its reason, to every reader of the gate (tick,
    // watch, the service, the CLI, live runs) (self-audit round 3, assignment 1 (sealed 323361a), question 1).
    if (workLedger && STAGES.includes(gate.gate)) {
      const key = workKey({item: s.item, stage: gate.gate, inputs: attemptInputs(gate, stages)});
      const done = workLedger.claims(s.item).find(c => c.stage === gate.gate && c.key === key && workLedger.released(c.hash)?.outcome === 'completed');
      if (done) {
        const rec = stages.find(x => x.derived_from?.[0] === done.hash) ?? null;
        const what = `ATTEMPT_IDENTITY_COLLISION: the gate routes ${gate.gate} again (${gate.reason ?? ''}), but an attempt on the same attempt identity already completed (claim ${done.hash.slice(0, 19)}${rec ? `, record ${rec.hash.slice(0, 19)}` : ''}): nothing the routing reads has changed since, so it is not dispatched again`;
        gate = {item: gate.item, state: gate.state, ...(gate.entry ? {entry: gate.entry} : {}), gate: 'blocked', stage: gate.gate, requirement: gate.requirement, stale: gate.stale ?? [],
          routed: {gate: gate.gate, mode: gate.mode ?? null, reason: gate.reason ?? null, route: gate.route ?? null}, collided: {claim: done.hash, record: rec?.hash ?? null, key},
          blocker: {code: 'ATTEMPT_IDENTITY_COLLISION', what: what.slice(0, 600), role: 'lead@orch',
            resume_when: 'something the gate reads changes (the evidence, the ticket, a dependency, review capacity), or the owner records a new status entry of the item'},
          reason: what.slice(0, 600)};
      }
    }
    // THE OWNER'S PROMPT, when the item's signed requirement binds one. Read and checked now, on every reconciliation:
    // a record that is missing or is not the signed text blocks the item for as long as that is so (it is not a stage
    // result, so restoring the record makes the item plannable again at once).
    const requirement = requirementOf(byItem.get(s.item) ?? [s]);
    const bound = promptBinding(requirement?.basis)?.item === s.item ? promptBinding(requirement.basis) : null;
    const promptNow = bound ? promptRequirement({repo, requirement}) : null;
    if (promptNow?.why && STAGES.includes(gate.gate)) {
      const what = `PROMPT_RECORD_MISMATCH: ${promptNow.why}: the item's requirement is the prompt the owner signed, and it is not planned or built from other text`;
      gate = {item: gate.item, state: gate.state, ...(gate.entry ? {entry: gate.entry} : {}), gate: 'blocked', stage: gate.gate, requirement: gate.requirement, stale: gate.stale ?? [],
        routed: {gate: gate.gate, mode: gate.mode ?? null, reason: gate.reason ?? null, route: gate.route ?? null},
        blocker: {code: 'PROMPT_RECORD_MISMATCH', what: what.slice(0, 600), role: 'decision-authority', resume_when: `${bound.record} is restored to the text the owner signed (${bound.sha256}), or the owner records a new status entry of the item`},
        reason: what.slice(0, 600)};
    }
    return {item: s.item, title: s.title, status: s.state, entry: s.entry, depends_on: s.depends_on ?? [], history: (byItem.get(s.item) ?? []).length,
      ticket: ticket ? (ticket.why ? {invalid: ticket.why} : {path: ticket.path, digest: ticket.digest}) : null,
      prompt: bound ? {path: bound.record, digest: bound.sha256, verified: !promptNow?.why, ...(promptNow?.why ? {why: promptNow.why} : {})} : null,
      issues: issueByItem.get(s.item) ?? [], runs: runs.get(s.item) ?? [], stages: stages.length, gate};
  });
  const orphans = ticketItems.filter(i => !latest.has(i)).map(i => ({ticket: `tickets/${i}.json`, why: 'a ticket for an item that is not on the status ledger'}));
  // Prompt records nobody signed for, or that their item's signed basis does not bind: data, never work.
  const boundTo = new Map(items.filter(i => i.prompt).map(i => [i.item, i.prompt.path]));
  const prompt_candidates = promptRecords(repo).filter(r => boundTo.get(r.item) !== r.record).map(r => ({prompt: r.item, record: r.record, digest: r.prompt_sha256,
    why: latest.has(r.item) ? 'a prompt record the item\'s signed status entry does not bind: not its requirement; never executed on its own'
      : 'a prompt with no owner-signed status entry: an intake candidate for the owner to authorize; never executed on its own'}));
  const gateCounts = {};
  for (const i of items) gateCounts[i.gate.gate] = (gateCounts[i.gate.gate] ?? 0) + 1;
  return {at: new Date(now).toISOString(), ledger: {head: board.head, entries: board.entries}, items, candidates, prompt_candidates, orphans, duplicates,
    counts: {items: items.length, issues: (issues ?? []).length, linked_issues: [...issueByItem.values()].flat().length, candidates: candidates.length, prompt_candidates: prompt_candidates.length,
      tickets: ticketItems.length, orphans: orphans.length, items_with_runs: items.filter(i => i.runs.length).length, by_gate: gateCounts}};
}
