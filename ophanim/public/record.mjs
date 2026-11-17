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
    ...STATES.map(s => ({name: stateLabel(s), color: STATE_COLOR[s], description: `${OWNED} state ${s}: ${STATE_MEANS[s]}`})),
    ...EXTERNAL.map(w => ({name: waitingLabel(w), color: 'd93f0b', description: `${OWNED} on hold, waiting on ${WAITING_MEANS[w]}`})),
    ...OWNER_ROLES.map(r => ({name: roleLabel(r), color: r === 'decision-authority' ? '5319e7' : 'c5def5', description: `${OWNED} ${ROLE_MEANS[r]}`})),
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
  if (item.state === 'On Hold' && item.waiting_on === 'decision') return {role: 'decision-authority', source: 'waiting_on: decision on the latest status entry'};
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
 * The issue body for one item. `link(id)` renders a reference to another item (an issue number once the
 * publisher knows it). `dependents` are the items that depend on this one.
 */
export function issueBody(item, {anchor, link = id => `\`${id}\``, dependents = [], ledgerPath = 'status/ledger'}) {
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
    '## Status history',
    '',
    '| # | Date (checked) | State | Waits on | Basis | Ledger entry |',
    '|---|---|---|---|---|---|',
    ...item.history.map((h, i) => `| ${i + 1} | ${h.checked} | ${h.state} | ${cell(h.waiting_on ?? (h.depends_on?.length && h.state === 'On Hold' ? `depends on ${h.depends_on.join(', ')}` : ''))} | ${cell(h.basis)} | \`${h.entry}\` (seq ${h.seq}) |`),
    '',
    provenanceNotice([
      `For this item: its status entries are signed by the status ledger's operator key (${signers.map(s => `\`${s}\``).join(', ')}). ` +
      'The status ledger records no model seat, review or served model for it, so **no independence is claimed here**.',
      ...(owner && owner.role !== 'decision-authority' ? ['', `The owner role \`${owner.role}\` is a chair (a model seat), not a person; it is a label, never an assignee.`] : []),
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
 * may be assigned, and only to decision-authority items.
 */
export function plan(record, {numbers = new Map(), ownerLogin = null, ledgerPath = 'status/ledger'} = {}) {
  const ids = new Set(record.items.map(i => i.item));
  const link = id => (numbers.has(id) ? `#${numbers.get(id)} (\`${id}\`)` : ids.has(id) ? `\`${id}\`` : `\`${id}\` (not on the status board)`);
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
      body: issueBody(item, {anchor: record.anchor, link, dependents: (dependents.get(item.item) ?? []).sort(), ledgerPath}),
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
  const by = k => Object.entries(p.issues.reduce((m, i) => { for (const l of i.labels.filter(x => x.startsWith(k))) m[l] = (m[l] ?? 0) + 1; return m; }, {}))
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
