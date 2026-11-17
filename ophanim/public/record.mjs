// The public record: GitHub issues and labels as a PROJECTION of the status ledger (docs/public-record.md).
//
// The ledger (status/ledger) is authoritative. Nothing here reads GitHub to decide anything: this module
// computes, from a ledger that verifies, the full desired set of labels and issues, and the publisher
// (github.mjs) only makes GitHub match it. Every body is deterministic in the ledger (no generation time,
// no ledger head), so an unchanged item yields an unchanged body and a re-run writes nothing.
//
// Identity rule (the one that matters most): the roles named here are model seats operated under one
// GitHub account. They are labels and text, never GitHub assignees, requested reviewers or approvals.
// An assignee is only ever a real person, on a decision-authority item, and only when configured.
//
// Inputs:  the status ledger at status/ledger (or `root`), optionally pinned to an expected `anchor`;
//          for plan(), the issue numbers already known and the configured human owner login.
// Outputs: readStatusRecord (the verified board plus each item's signed history), plan (the desired
//          labels and issues: title, body, labels, open/closed, assignees), and the pieces they are
//          built from (labelCatalog, labelsFor, issueBody, workSection, evidenceSection, provenanceNotice).
//          The work ledger's view of each item (stage, gate, claim, budget, usage, blocker, team, evidence)
//          is read by work.mjs and passed to plan() as `work`; this module stays pure.
// Invariants: deterministic given the ledger; readStatusRecord throws unless the ledger verifies (it
//          opens it with openStatusLedger's defaults, which create an empty ledger where none exists);
//          everything after that read is pure; every generated body carries the provenance notice.
// Must never: read or write GitHub (github.mjs does that), append to the ledger, make a model seat an
//          assignee or reviewer, or claim independence the ledger does not show.
import {openStatusLedger, STATES, EXTERNAL, OWNER_ROLES, DEFAULT_ROOT} from '../../packages/ledger/status.mjs';

export const MARKER_PREFIX = 'ophanim:item=';
export const marker = item => `<!-- ${MARKER_PREFIX}${item} -->`;
export const MARKER_RE = /<!-- ophanim:item=([a-z0-9][a-z0-9.-]{0,63}) -->/;
/** Labels the publisher owns carry this description prefix; it never edits a label without it. */
export const OWNED = 'ophanim:';
export const CHAIRS = OWNER_ROLES.filter(r => r !== 'decision-authority');

const slug = s => s.toLowerCase().replace(/[^a-z0-9@]+/g, '-');
export const stateLabel = s => `state:${slug(s)}`;
export const waitingLabel = w => `waiting:${w}`;
export const roleLabel = r => (r === 'decision-authority' ? 'decision-authority' : `role:${r}`);
/** True for a label name in the publisher's namespace (it manages these on its own issues). */
export const ourLabelName = n => /^(state|waiting|role):/.test(n) || n === 'decision-authority';

const STATE_COLOR = {'Resolved': '0e8a16', 'In progress': '1d76db', 'Ready': 'fbca04', 'On Hold': 'b60205'};
const STATE_MEANS = {
  'Resolved': 'done; names its basis',
  'In progress': 'being worked',
  'Ready': 'dependencies converged and nothing external awaited: start it',
  'On Hold': 'waits on something outside the work, or on an item that does',
};
export const WAITING_MEANS = {
  governance: 'a governance change (e.g. the pinned TELOS verifier)',
  credential: 'a credential nobody holding the work has',
  evidence: 'evidence from real runs',
  fact: 'a fact a vendor has not published',
  decision: 'a decision only the human owner can make',
};
const ROLE_MEANS = {
  'impl@build': 'implementation chair (model seat)',
  'check@review': 'review chair (model seat)',
  'lead@orch': 'orchestration chair (model seat)',
  'scout@opt': 'exploration chair (model seat)',
  'arbiter@judge': 'synthesis and judgement chair (model seat)',
  'decision-authority': 'only the human owner decides',
};

/** Every label the publisher owns, defined whether or not an item uses it today (so filters exist). */
export function labelCatalog() {
  return [
    ...STATES.map(s => ({name: stateLabel(s), color: STATE_COLOR[s],
      description: `${OWNED} state ${s}: ${STATE_MEANS[s]}`})),
    ...EXTERNAL.map(w => ({name: waitingLabel(w), color: 'd93f0b',
      description: `${OWNED} on hold, waiting on ${WAITING_MEANS[w]}`})),
    ...OWNER_ROLES.map(r => ({name: roleLabel(r), color: r === 'decision-authority' ? '5319e7' : 'c5def5',
      description: `${OWNED} ${ROLE_MEANS[r]}`})),
  ].map(l => ({...l, description: l.description.slice(0, 100)}));      // GitHub caps descriptions at 100 chars
}

/**
 * Read the status ledger: the board (from a ledger that verifies) plus each item's full history from
 * the chain, in chain order, with each entry's hash, sequence and signer.
 */
export function readStatusRecord({root = DEFAULT_ROOT, anchor = null} = {}) {
  const S = openStatusLedger({root, anchor});
  const board = S.board();                          // throws unless the ledger verifies
  const history = new Map();
  for (const e of S.ledger.read()) {
    if (e.kind !== 'status') continue;
    const p = S.ledger.payloadOf(e);
    if (!history.has(p.item)) history.set(p.item, []);
    history.get(p.item).push({entry: S.ledger.hashOf(e), seq: e.seq, signer: e.author.key_id, ...p});
  }
  const items = board.items.map(i => ({...i, history: history.get(i.item) ?? []}));
  return {anchor: board.anchor, head: board.head, entries: board.entries, items};
}

/** The role an item is owned by: the recorded owner_role, else decision-authority for a decision hold. */
export function ownerRoleOf(item) {
  if (item.owner_role) return {role: item.owner_role, source: 'owner_role on the latest status entry'};
  if (item.state === 'On Hold' && item.waiting_on === 'decision')
    return {role: 'decision-authority', source: 'waiting_on: decision on the latest status entry'};
  return null;
}

export function labelsFor(item) {
  const out = [stateLabel(item.state)];
  if (item.waiting_on) out.push(waitingLabel(item.waiting_on));
  const owner = ownerRoleOf(item);
  if (owner) out.push(roleLabel(owner.role));
  return out;
}

const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** The notice every generated body carries. `evidence` is markdown lines specific to the record. */
export function provenanceNotice(evidence = []) {
  return [
    '### Agent provenance',
    '',
    'All GitHub activity on this public record (issues, labels, comments, provenance sections) is posted by **one account**: the workflow token or the repository owner. ' +
    'The roles named here (`impl@build`, `check@review`, `lead@orch`, `scout@opt`, `arbiter@judge`) are **model seats operated under that account, not independent developers**. ' +
    'None of them is a GitHub user, so none is ever an assignee, a requested reviewer or a pull request approver. ' +
    'Independence is claimed only where the ledger shows it: reviews on distinct labs, the cold-review check passed, and the served model reported, each with its evidence ' +
    '(seat key id, vendor, requested and served model, lab, ledger entry hash). See `docs/public-record.md`.',
    '',
    ...evidence,
  ].join('\n');
}

/**
 * The evidence a status entry carries when it was recorded from a Pantheon board run's proposal
 * (packages/ledger/status.mjs `apply`, docs/operating-workflow.md): the run ledger it cites, the review
 * cycle and its outcome, the reviewers (vendor, model, lab: model seats, never GitHub identities), the
 * commit and the tests. The run and cycle ledgers live on the machine that ran them, not in the
 * repository; the status entry pins their anchors and heads, so a holder can check them.
 */
export function evidenceSection(ev) {
  if (!ev) return [];
  const short = h => (h ? `\`${h}\`` : 'none');
  const rv = ev.review ?? null;
  return [
    '## Evidence',
    '',
    'Recorded on the latest status entry, from a Pantheon board run\'s proposal (`docs/operating-workflow.md`).',
    '',
    `- **Run ledger:** anchor ${short(ev.run.ledger_anchor)}, head ${short(ev.run.ledger_head)}; run.json digest ${short(ev.run.run_json_digest)}; shipped: ${ev.run.shipped ? 'yes' : 'no'}; gate verdict entry ${short(ev.run.gate_entry)}`,
    `- **Review cycle:** ${rv ? `${short(rv.cycle)} on the ledger anchored at ${short(rv.cycle_ledger_anchor)}; close entry ${short(rv.close_entry)}; outcome **${rv.outcome ?? 'open'}**` : 'none cited'}`,
    ...(rv ? ['', '| Reviewer seat (vendor) | Requested model | Served model | Lab |', '|---|---|---|---|',
      ...rv.reviewers.map(r =>
        `| ${cell(r.vendor)} | ${cell(r.model)} | ${cell(r.served_model ?? 'not reported')} | ${cell(r.lab)} |`),
      ''] : []),
    `- **Commit:** ${ev.commit ? `\`${ev.commit}\`` : 'none'}`,
    `- **Tests:** ${ev.tests ? `\`${cell(ev.tests.cmd)}\` exited ${ev.tests.exit}` : 'none recorded'}`,
    ...(ev.ticket
      ? [`- **Ticket:** \`${ev.ticket.path}\` (\`${ev.ticket.digest}\`), slice: ${cell(ev.ticket.slice)}`]
      : []),
    ...(ev.accept_unverified_reason
      ? [`- **Accepted although the review closed unverified:** ${cell(ev.accept_unverified_reason)}`]
      : []),
    `- **Proposal:** \`${ev.proposal}\`; cited ledgers at apply: ${ev.checked === 'structural' ? 're-checked structurally (anchor, signatures, cited entries)' : 'not available on the applying machine'}`,
    '',
  ];
}

/**
 * Who is working on the item and how far it has got, from the work ledger (work.mjs readWorkRecord): the earliest
 * unmet gate and its reason, the latest stage record, the claim and lease, the budget and usage (unknown stays
 * unknown), the blocker, the team of the latest stage (model seats, as text: never GitHub assignees) and the
 * evidence of the chain the gate reuses. `work` is {ledger, item} or null when no work ledger was read.
 */
export function workSection(work) {
  const code = v => (v == null ? 'not recorded' : `\`${cell(v)}\``);
  const L = work?.ledger ?? null, w = work?.item ?? null;
  const head = ['## Work', ''];
  if (!L) return [...head, 'The work ledger was not read for this projection: no stage, claim, usage or blocker is shown.', ''];
  const source = L.state === 'verified'
    ? `From the work ledger (\`${L.path}\`), the controller's signed record of the governed lifecycle (plan, implement, review, validate, outcome), verified in full against its anchor \`${L.anchor}\`. The status ledger stays authoritative for the state above.`
    : L.state === 'absent'
      ? `There is no work ledger at \`${L.path}\` yet: no stage has been claimed, run or paid for. The gate below is computed from the status ledger and the repository alone.`
      : `The work ledger at \`${L.path}\` **did not verify** (${cell(L.why)}); nothing from it is shown. The gate below is computed without it.`;
  if (!w) return [...head, source, ''];
  const g = w.gate, c = w.claim, b = w.blocker;
  const claim = !c ? 'none recorded'
    : !c.released ? `held by ${code(c.holder)} for \`${c.stage}\` (attempt ${c.attempt}), leased ${c.leased_at}, lease until **${c.until}**; not released (a lease that passes without a result is released as \`expired\` on the controller's next tick)`
      : `none held; the last claim (\`${c.stage}\`, attempt ${c.attempt}, ${code(c.holder)}) was released \`${c.released.outcome}\`: ${cell(c.released.why)}`;
  const budget = c ? `${c.budget.provider_calls} provider calls, ${c.budget.iterations} iteration(s), ${c.budget.retries} retries, ${c.budget.elapsed_ms} ms (declared on the latest claim, before dispatch)` : 'none declared';
  const u = w.usage;
  const usage = u.known_records + u.unknown_records === 0 ? 'none recorded'
    : `${u.provider_calls} provider call(s) recorded on ${u.known_records} stage record(s)` + (u.tokens != null ? `, ${u.tokens} token(s)` : '')
      + (u.unknown_records ? `; usage **unknown** on ${u.unknown_records} stage record(s) (unknown, not zero)` : '');
  const seat = t => `| ${cell(t.role)} | ${cell(t.vendor ?? '—')} | ${cell(t.served_model ?? t.model ?? t.requested_model ?? '—')} | ${cell(t.lab ?? '—')} |`;
  const ev = w.evidence;
  // Evidence taken from the latest attempt after the reused chain (not part of it) says so.
  const from = stage => (ev.attempt?.stage === stage ? ` (from the latest \`${stage}\` attempt, \`${ev.attempt.status}\`, not part of the reused chain)` : '');
  const gateLine = `- **Earliest unmet gate:** \`${g.gate}\`${g.mode ? ` (mode \`${g.mode}\`)` : ''}${g.reason ? `: ${cell(g.reason)}` : ''}`;
  const blockerLine = `- **Blocker:** ${b ? `${cell(b.what)}; responsible role \`${cell(b.role)}\`; resumes when ${cell(b.resume_when)}` : 'none'}`;
  if (!w.claim && !w.stages.length) {
    return [...head, source, '', gateLine, blockerLine,
      '- **Stage, claim, team, budget, usage, evidence:** none recorded on the work ledger for this item yet', ''];
  }
  return [
    ...head, source, '',
    gateLine,
    `- **Current stage:** ${w.latest ? `\`${w.latest.stage}\`, attempt ${w.latest.attempt}, \`${w.latest.status}\`${w.latest.next?.why ? ` (${cell(w.latest.next.why)})` : ''}; record \`${w.latest.hash}\`` : 'none recorded'}`,
    `- **Claim:** ${claim}`,
    `- **Budget:** ${budget}`,
    `- **Usage so far:** ${usage}`,
    blockerLine,
    '',
    '**Team of the latest stage record.** Model seats, shown as text: none is a GitHub user, so none is ever an assignee or a reviewer.',
    '',
    ...(w.team.length ? ['| Role | Vendor | Model | Lab |', '|---|---|---|---|', ...w.team.map(seat)] : ['No team recorded.']),
    '',
    '**Evidence: the chain the gate reuses, and its latest attempt**',
    '',
    `- Stage records: ${ev.chain.length ? ev.chain.map(s => `${s.stage} \`${s.hash}\``).join(', ') : 'none valid'}`,
    `- Plan: ${ev.plan ? `outputs digest \`${ev.plan.outputs}\`${ev.plan.ticket ? `; ticket \`${cell(ev.plan.ticket.path)}\` (\`${ev.plan.ticket.digest}\`)` : ''}` : 'not recorded'}`,
    `- Commit: ${code(ev.commit)}${ev.commit != null ? from('implement') : ''}`,
    `- Review cycle: ${ev.review ? `${code(ev.review.cycle)}; close ${code(ev.review.close)}; outcome ${code(ev.review.outcome)}${from('review')}` : 'not recorded'}`,
    `- Validation verdict: ${code(ev.verdict)}${ev.verdict != null ? from('validate') : ''}`,
    `- Proposal: ${code(ev.proposal)}${ev.proposal != null ? from('outcome') : ''}`,
    '',
    ...(w.stages.length ? ['| # | Stage | Attempt | Status | Team (roles) | Provider calls | Record |', '|---|---|---|---|---|---|---|',
      ...w.stages.map((s, i) => `| ${i + 1} | ${s.stage} | ${s.attempt} | ${s.status} | ${cell(s.team.map(t => t.role).join(', ') || '—')} | ${s.provider_calls ?? 'unknown'} | \`${s.hash}\` |`), ''] : []),
  ];
}

/**
 * The issue body for one item. `link(id)` renders a reference to another item (an issue number once the
 * publisher knows it). `dependents` are the items that depend on this one. `work` is {ledger, item} from the
 * work ledger (workSection), or null when it was not read.
 */
export function issueBody(item, {anchor, link = id => `\`${id}\``, dependents = [], ledgerPath = 'status/ledger', work = null}) {
  const owner = ownerRoleOf(item);
  const waiting = item.waiting_on ? `${item.waiting_on}: ${WAITING_MEANS[item.waiting_on] ?? item.waiting_on}` : null;
  const deps = item.depends_on ?? [];
  const signers = [...new Set(item.history.map(h => h.signer))];
  const latestSeq = item.history.at(-1)?.seq;
  return [
    marker(item.item),
    `> **Generated from the status ledger** (\`${ledgerPath}\`), which is authoritative. This issue is a read-only projection: the publisher overwrites its title, body, state and \`state:\`/\`waiting:\`/\`role:\` labels from the ledger. Comments are welcome but are not read by OPHANIM and change nothing in the ledger.`,
    '',
    '## What needs doing',
    '',
    `**${item.title}** (item \`${item.item}\`)`,
    '',
    '## Why it matters',
    '',
    `Basis, as recorded on the ledger: ${item.basis}`,
    '',
    '## State',
    '',
    `- **State:** ${item.state} (${STATE_MEANS[item.state]})`,
    `- **Waits on:** ${waiting ?? (deps.length && item.state === 'On Hold' ? 'its unresolved dependencies (below)' : 'nothing')}`,
    `- **Last checked:** ${item.checked}`,
    `- **Owner role:** ${owner ? `\`${owner.role}\` (from ${owner.source})` : 'not recorded on the ledger'}`,
    '',
    '## Dependencies',
    '',
    `- **Depends on:** ${deps.length ? deps.map(link).join(', ') : 'none'}`,
    `- **Depended on by:** ${dependents.length ? dependents.map(link).join(', ') : 'none'}`,
    '',
    ...workSection(work),
    ...evidenceSection(item.evidence),
    '## Status history',
    '',
    '| # | Date (checked) | State | Waits on | Basis | Ledger entry |',
    '|---|---|---|---|---|---|',
    // One row per status entry, oldest first; "Waits on" falls back to the unresolved dependencies of a hold.
    ...item.history.map((h, i) => `| ${i + 1} | ${h.checked} | ${h.state} | ${cell(h.waiting_on ?? (h.depends_on?.length && h.state === 'On Hold' ? `depends on ${h.depends_on.join(', ')}` : ''))} | ${cell(h.basis)}${h.evidence ? ' (with evidence)' : ''} | \`${h.entry}\` (seq ${h.seq}) |`),
    '',
    provenanceNotice([
      `For this item: its status entries are signed by the status ledger's operator key (${signers.map(s => `\`${s}\``).join(', ')}). ` +
      (item.evidence?.review?.close_entry
        ? `Its latest status cites a review cycle that closed ${item.evidence.review.outcome} with reviews on distinct labs (${item.evidence.review.reviewers.map(r => r.lab).join(', ')}), none of them the lab that implemented the change; ` +
          'that independence rests on the cited cycle ledger, which re-derives the cold-review rule, and carries the limits in docs/public-record.md. The reviewers are model seats, not people.'
        : 'The status ledger records no model seat, review or served model for it, so **no independence is claimed here**.'),
      ...(owner && owner.role !== 'decision-authority'
        ? ['', `The owner role \`${owner.role}\` is a chair (a model seat), not a person; it is a label, never an assignee.`] : []),
    ]),
    '',
    '### Verify this record',
    '',
    `- Ledger: \`${ledgerPath}\`, genesis anchor \`${anchor}\``,
    `- This item's latest status entry: \`${item.entry}\`${latestSeq ? ` (seq ${latestSeq})` : ''}`,
    '',
    'From a clone of the repository:',
    '',
    '```sh',
    'node packages/ledger/status.mjs verify',
    `node ophanim/public/github.mjs verify-item ${item.item} ${item.entry}`,
    '```',
    '',
    'The first re-checks every signature and re-derives every status against the pinned anchor. The second checks that this entry is in that verified chain and is still the latest status of this item, and prints it.',
    '',
  ].join('\n');
}

/** Items ordered so that an item's dependencies come before it (cycles broken by id order). */
export function dependencyOrder(items) {
  const byId = new Map(items.map(i => [i.item, i])), out = [], seen = new Set();
  const visit = (i, stack) => {
    if (seen.has(i.item) || stack.has(i.item)) return;
    stack.add(i.item);
    for (const d of [...(i.depends_on ?? [])].sort()) if (byId.has(d)) visit(byId.get(d), stack);
    stack.delete(i.item);
    seen.add(i.item);
    out.push(i);
  };
  for (const i of [...items].sort((a, b) => a.item.localeCompare(b.item))) visit(i, new Set());
  return out;
}

/**
 * The desired public record: labels and one issue per item. `numbers` maps item id -> issue number where
 * known (apply); without it, dependency links name the item id. `ownerLogin` is the one GitHub login that
 * may be assigned, and only to decision-authority items. `work` is readWorkRecord's result (work.mjs) or null;
 * it adds each item's Work section and never changes labels, state or assignees.
 */
export function plan(record, {numbers = new Map(), ownerLogin = null, ledgerPath = 'status/ledger', work = null} = {}) {
  const ids = new Set(record.items.map(i => i.item));
  // An item reference: its issue number once known, else its id (flagged when it is not on the board).
  const link = id => (numbers.has(id) ? `#${numbers.get(id)} (\`${id}\`)`
    : ids.has(id) ? `\`${id}\``
    : `\`${id}\` (not on the status board)`);
  const dependents = new Map();
  for (const i of record.items) for (const d of i.depends_on ?? []) {
    if (!dependents.has(d)) dependents.set(d, []);
    dependents.get(d).push(i.item);
  }
  const issues = dependencyOrder(record.items).map(item => {
    const owner = ownerRoleOf(item);
    return {
      item: item.item,
      title: `${item.title} [${item.item}]`,
      body: issueBody(item, {anchor: record.anchor, link,
        dependents: (dependents.get(item.item) ?? []).sort(), ledgerPath,
        work: work ? {ledger: work.ledger, item: work.items.get(item.item) ?? null} : null}),
      labels: labelsFor(item),
      state: item.state === 'Resolved' ? 'closed' : 'open',
      state_reason: item.state === 'Resolved' ? 'completed' : null,
      // Only a real person, only for a decision only the owner makes, only when configured. Never a seat.
      assignees: owner?.role === 'decision-authority' && ownerLogin ? [ownerLogin] : [],
      entry: item.entry,
    };
  });
  return {anchor: record.anchor, head: record.head, entries: record.entries, labels: labelCatalog(), issues};
}

/** A short text summary of a plan, for stdout or a workflow step summary. */
export function planSummary(p) {
  // "label count" pairs for every label with prefix k, counted over the planned issues.
  const by = k => Object.entries(p.issues.reduce((m, i) => {
    for (const l of i.labels.filter(x => x.startsWith(k))) m[l] = (m[l] ?? 0) + 1; return m;
  }, {}))
    .sort().map(([l, n]) => `${l} ${n}`).join(', ');
  const open = p.issues.filter(i => i.state === 'open').length;
  return [
    `## Public record plan`,
    '',
    `- Status ledger: anchor \`${p.anchor}\`, head \`${p.head}\`, ${p.entries} entries`,
    `- Labels: ${p.labels.length} (${p.labels.map(l => `\`${l.name}\``).join(', ')})`,
    `- Issues: ${p.issues.length} (${open} open, ${p.issues.length - open} closed as completed)`,
    `- By state: ${by('state:')}`,
    `- By waiting: ${by('waiting:') || 'none'}`,
    `- By role: ${[by('role:'), by('decision-authority')].filter(Boolean).join(', ') || 'none'}`,
    `- Assignees: ${p.issues.filter(i => i.assignees.length).map(i => `${i.item} -> ${i.assignees.join(', ')}`).join('; ') || 'none'}`,
    '',
  ].join('\n');
}
