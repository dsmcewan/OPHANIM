// Pull-request provenance and cycle reports: readable projections of a review-cycle ledger
// (pantheon/src/ledger/cycle-kinds.mjs, review-cycle.mjs, lineage-kinds.mjs), for the public record
// (docs/public-record.md).
//
// The ledger is opened READ-ONLY against a pinned anchor with OPHANIM's full kind composition, so every
// entry is re-derived (cold review included) before anything is projected; no key is needed and nothing
// is written. What these projections say about independence is only what the verified entries show,
// and each claim names its evidence. Their limits are stated with them.
import fs from 'node:fs';
import path from 'node:path';
import {openLedger} from '../../packages/ledger/chain.mjs';
import {systemKinds} from '../ledger/system.mjs';
import {deriveCycle, closeClaim, CYCLE, CLOSE} from '../../pantheon/src/ledger/cycle-kinds.mjs';
import {labOf} from '../../pantheon/src/config/models.mjs';
import {CHAIR_OF_MODE} from '../../pantheon/src/board/contributions.mjs';
import {dispositionsOf, evidenceBasis} from '../../pantheon/src/ledger/practice-kinds.mjs';
import {provenanceNotice} from './record.mjs';

const fail = why => { throw Object.assign(new Error(why), {code: 'PUBLIC_RECORD_REFUSED'}); };
const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const code = s => (s == null ? '—' : `\`${s}\``);

/**
 * Open a system or review-cycle ledger read-only: verified in full against `anchor` (default: the
 * ledger's ANCHOR file). Returns {ledger, view, anchor, head, entries}. Creates nothing but the
 * (empty) objects directory the chain reader expects.
 */
export function openLedgerReadOnly({root, anchor = null}) {
  if (!root || !path.isAbsolute(root)) fail('an absolute ledger root is required');
  if (!fs.existsSync(path.join(root, 'chain.jsonl'))) fail(`no ledger at ${root}`);
  const file = path.join(root, 'ANCHOR');
  const pinned = anchor ?? (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null);
  if (!pinned) fail('a ledger is read against a pinned anchor: pass one, or keep its ANCHOR file');
  const ledger = openLedger({dir: root, kinds: systemKinds(), anchor: pinned});
  const v = ledger.verify();
  if (!v.ok) fail(`ledger does not verify: ${v.why}`);
  const byHash = new Map(ledger.read().map(e => [ledger.hashOf(e), e]));
  const view = {entry: h => byHash.get(h) ?? null, payload: h => (byHash.has(h) ? ledger.payloadOf(byHash.get(h)) : null), entries: () => [...byHash.keys()]};
  return {ledger, view, anchor: pinned, head: v.head, entries: v.entries};
}

/** Every cycle on the ledger, in chain order, with its scope and its ordinal within that scope. */
export function listCycles(view) {
  const n = new Map(), out = [];
  for (const h of view.entries()) {
    const e = view.entry(h);
    if (e.kind !== CYCLE) continue;
    const p = view.payload(h);
    n.set(p.scope, (n.get(p.scope) ?? 0) + 1);
    out.push({hash: h, scope: p.scope, ordinal: n.get(p.scope), seq: e.seq, base: p.base, head: p.head, opened_at: p.opened_at});
  }
  return out;
}
export const cycleSlug = c => `${c.scope.replace(/[^A-Za-z0-9._-]+/g, '-')}-${String(c.ordinal).padStart(3, '0')}`;

const roleOfMode = mode => (mode === 'cycle-review' ? 'reviewer (cycle-review seat)' : CHAIR_OF_MODE[mode] ? `${CHAIR_OF_MODE[mode]} (${mode})` : mode ?? 'unrecorded');

/** Everything one cycle's verified entries say, shaped for the projections below. */
export function cycleRecord(view, cycle) {
  const e = view.entry(cycle);
  if (e?.kind !== CYCLE) fail(`${cycle} is not a cycle on this ledger`);
  const state = deriveCycle(view, cycle);
  const c = state.cycle;
  const seat = (h, p) => ({
    entry: h, key_id: view.entry(h).author.key_id, seat_id: p.seat?.seat_id, vendor: p.seat?.vendor, role: roleOfMode(p.seat?.mode),
    requested_model: p.requested_model ?? p.model ?? null, served_model: p.served_model ?? null,
    lab: labOf(p.seat?.vendor, p.served_model ?? p.requested_model ?? p.model), response_id: p.response_id ?? null,
  });
  const authors = e.derived_from.filter(h => view.entry(h)?.kind === 'turn').map(h => seat(h, view.payload(h)));
  const reviews = state.reviews.map(r => {
    const p = view.payload(r.hash), turn = p.turn ? view.payload(p.turn) : null;
    return {...seat(r.hash, {...p, requested_model: turn?.requested_model ?? p.model}), turn: p.turn ?? null, verdict: r.verdict, lab: r.lab,
      parsed: r.reported.parsed};
  });
  const findings = state.findings.map(f => ({
    entry: f.hash, review: f.review, reviewer_lab: reviews.find(r => r.entry === f.review)?.lab ?? null,
    ...f.payload, resolution: state.resolutions.get(f.hash) ?? null,
  }));
  const close = state.close ? {entry: state.close, ...view.payload(state.close)} : null;
  // The cycle's practice dispositions (CYCLE_CONTRACT steps 3 and 7), in chain order. `admitted`: the close
  // lists it. `synthetic`: its comparison evidence is synthetic only (practice-kinds.mjs evidenceBasis).
  const listed = new Set(close?.practice ?? []);
  const practice = dispositionsOf(view, cycle).map(h => {
    const p = view.payload(h), basis = evidenceBasis(view, p.evidence);
    return {entry: h, stage: p.stage, outcome: p.outcome, question: p.question, measured: p.measured, provisional: p.provisional,
      evidence_basis: basis, synthetic: basis === 'synthetic', policy: p.policy, candidate: p.candidate?.id ?? null, admitted: listed.has(h)};
  });
  const pending = close ? null : closeClaim(state);
  const labs = reviews.map(r => r.lab);
  const independence = {
    distinct_labs: new Set(labs).size === labs.length,
    labs: [...labs].sort(),
    author_labs: c.author_labs,
    author_lab_reviewed: labs.filter(l => c.author_labs.includes(l)),
    served_reported: reviews.filter(r => r.served_model !== null).length,
    served_differs: reviews.filter(r => r.served_model !== null && r.served_model !== r.requested_model),
    reviews_expected: c.reviewers,
  };
  return {hash: cycle, seq: e.seq, cycle: c, authors, reviews, findings, close, pending, independence, practice};
}

const LIMITS = [
  'Every seat runs under one operator and one GitHub account; distinct labs are distinct model vendors, not distinct people or organisations.',
  'Distinct labs do not establish independent training data or that the models share no blind spots.',
  'The served model is what the provider reported answering; the ledger records it, it cannot observe it.',
  'Re-derivation checks signatures, citations and the cold-review rule; it does not run tests or reproductions. Fail-before / pass-after exit codes are recorded by the controller and checked for consistency only.',
  'A finding without a reproduction can be deferred; such a cycle closes `unverified`, never `verified`.',
];

function resolutionText(f) {
  const r = f.resolution?.payload;
  if (!r) return 'unresolved';
  if (r.status === 'fixed') return `fixed in \`${r.fix.commit.slice(0, 12)}\`; \`${cell(r.fix.test)}\` exited ${r.fix.before.exit} on \`${r.fix.before.commit.slice(0, 12)}\` (fail before) and ${r.fix.after.exit} on \`${r.fix.after.commit.slice(0, 12)}\` (pass after)`;
  return `deferred: ${cell(r.reason)}`;
}
const reproText = f => (f.reproduction ? `${f.reproduction.kind}: \`${cell(f.reproduction.run)}\`` : '**unreproduced**');

function seatTable(rows, {verdict = false} = {}) {
  return [
    `| Role | Vendor | Requested model | Served model | Lab | Seat key id |${verdict ? ' Verdict |' : ''} Ledger entry |`,
    `|---|---|---|---|---|---|${verdict ? '---|' : ''}---|`,
    ...rows.map(r => `| ${cell(r.role)} | ${code(r.vendor)} | ${code(r.requested_model)} | ${r.served_model ? code(r.served_model) : 'not reported'} | ${code(r.lab)} | ${code(r.key_id)} |${verdict ? ` ${r.verdict} |` : ''} \`${r.entry}\` |`),
  ];
}

function independenceLines(rec) {
  const i = rec.independence, out = [];
  out.push(`- Reviews recorded: ${rec.reviews.length} of ${i.reviews_expected} expected.`);
  out.push(i.distinct_labs
    ? `- **Distinct labs:** yes (${i.labs.map(code).join(', ') || 'none'}), re-derived from each review's vendor and served model.`
    : `- **Distinct labs:** NO; two reviews share a lab (${i.labs.join(', ')}). No independence is claimed.`);
  out.push(i.author_lab_reviewed.length
    ? `- **Author lab excluded:** NO (${i.author_lab_reviewed.join(', ')} authored and reviewed).`
    : `- **Author lab excluded:** yes; author lab(s) ${i.author_labs.map(code).join(', ') || 'none recorded'} did not review.`);
  out.push(`- **Cold-review check:** passed for every recorded review (the ledger verified in full, and a review whose lab, seat or response is in the lineage of what it reviews does not re-derive).`);
  out.push(`- **Served model reported:** ${i.served_reported} of ${rec.reviews.length} reviews${i.served_differs.length ? `; served differs from requested for ${i.served_differs.map(r => `${r.vendor} (${r.requested_model} -> ${r.served_model})`).join(', ')}` : ''}.`);
  return out;
}

const BASIS = {
  synthetic: '**synthetic** (mechanics only, not a measurement)',
  live: 'live comparison',
  none: 'none cited',
};
/** The cycle's practice dispositions: outcome, measured or provisional, what its comparison evidence is, admitted. */
function practiceLines(rec) {
  if (!rec.practice.length) {
    return [rec.cycle.contract ? 'No practice disposition is recorded for this cycle yet; it cannot close without one.'
      : 'This cycle opened under the old contract, which records no practice disposition.'];
  }
  const pol = rec.cycle.policy;
  return [
    ...(pol ? [`Selection policy in effect: policy \`${pol.version}\` (profile \`${pol.profile}\`, \`${pol.hash}\`).`, ''] : []),
    '| Stage | Outcome | Basis | Comparison evidence | Question | Admitted | Entry |',
    '|---|---|---|---|---|---|---|',
    ...rec.practice.map(d => `| ${d.stage} | \`${d.outcome}\`${d.candidate ? ` (candidate \`${cell(d.candidate)}\`)` : ''} | ${d.measured ? 'measured' : 'provisional'} | ${BASIS[d.evidence_basis]} | ${cell(d.question)} | ${d.admitted ? 'listed by the close' : rec.close ? 'not listed' : 'cycle open'} | \`${d.entry}\` |`),
    '',
    'A synthetic comparison verifies the comparison mechanics on fake providers; it measures no provider cost or quality, and the ledger refuses a promote resting on it alone. Provisional is unmeasured judgment.',
  ];
}

function conclusion(rec) {
  if (rec.close) {
    const f = rec.close.findings;
    return `Closed **${rec.close.outcome}** (entry \`${rec.close.entry}\`): ${f.total} finding(s), ${f.fixed} fixed, ${f.deferred} deferred, ${f.unreproduced} unreproduced; reviews on ${rec.close.labs.join(', ')}. The close re-derived from the cycle's entries.`;
  }
  return rec.pending?.why
    ? `Not closed: ${rec.pending.why}.`
    : `Not closed yet; its entries would close it **${rec.pending.claim.outcome}**.`;
}

/**
 * The "Provenance" section for a pull request body: who produced and who reviewed the work, the
 * independence evidence and its limits, findings and their resolution, and the cycle's outcome.
 */
export function prProvenance(view, cycle, {anchor, ledgerLabel = 'review-cycle ledger'} = {}) {
  const rec = cycleRecord(view, cycle), c = rec.cycle;
  return [
    `<!-- ophanim:provenance cycle=${cycle} -->`,
    '## Provenance',
    '',
    `Generated from the ${ledgerLabel} (anchor \`${anchor}\`), cycle \`${cycle}\` (scope \`${c.scope}\`, \`${c.base.slice(0, 12)}..${c.head.slice(0, 12)}\`, ${c.files.length} file(s)). The ledger is authoritative; this section is a projection of it.`,
    '',
    '### Produced by',
    '',
    ...(rec.authors.length ? seatTable(rec.authors) : [`No author turn is cited by the cycle; author lab(s) recorded: ${c.author_labs.map(code).join(', ') || 'none'}.`]),
    '',
    '### Reviewed by',
    '',
    ...(rec.reviews.length ? seatTable(rec.reviews, {verdict: true}) : ['No review is recorded.']),
    '',
    '### Independence evidence',
    '',
    ...independenceLines(rec),
    '',
    '**Limits.**',
    '',
    ...LIMITS.map(l => `- ${l}`),
    '',
    '### Findings',
    '',
    ...(rec.findings.length ? [
      '| Severity | Where | Claim | Reproduction | Resolution | Entry |',
      '|---|---|---|---|---|---|',
      ...rec.findings.map(f => `| ${f.severity} | ${f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\`` : '—'} | ${cell(f.claim)} | ${reproText(f)} | ${resolutionText(f)} | \`${f.entry}\` |`),
    ] : ['No findings were reported.']),
    '',
    '### Practice dispositions',
    '',
    ...practiceLines(rec),
    '',
    '### Outcome',
    '',
    conclusion(rec),
    '',
    provenanceNotice([
      'Pull request reviews and approvals on GitHub are never used for these seats: the reviews above are ledger entries signed by each seat\'s own key, not GitHub reviews.',
    ]),
    '',
  ].join('\n');
}

/** A cycle report (docs/cycles/<slug>.md): what was, what is, what could be better, what the system concluded. */
export function cycleReport(view, cycle, {anchor, slug} = {}) {
  const rec = cycleRecord(view, cycle), c = rec.cycle;
  const deferred = rec.findings.filter(f => f.resolution?.payload.status === 'deferred');
  const unreproduced = rec.findings.filter(f => !f.reproduction);
  const better = [
    ...deferred.map(f => `- Deferred (${f.severity}) ${cell(f.claim)}: ${cell(f.resolution.payload.reason)} (entry \`${f.entry}\`)`),
    ...unreproduced.filter(f => !deferred.includes(f)).map(f => `- Unreproduced (${f.severity}) ${cell(f.claim)}: fixed without a reviewer reproduction (entry \`${f.entry}\`)`),
    ...(rec.reviews.length < c.reviewers ? [`- ${c.reviewers - rec.reviews.length} of ${c.reviewers} reviews were not recorded; the range is re-reviewed in a new cycle.`] : []),
    ...rec.reviews.filter(r => !r.served_model).map(r => `- ${r.vendor} did not report the served model; its lab is judged from the requested model.`),
    ...rec.reviews.filter(r => !r.parsed).map(r => `- ${r.vendor}'s reply was not in the required form and failed closed as a blocking finding.`),
  ];
  return [
    `<!-- Generated from the review-cycle ledger by \`node ophanim/public/github.mjs cycles\`. Do not edit by hand. -->`,
    `# Cycle ${slug ?? cycle.slice(7, 19)}: ${c.scope}`,
    '',
    `Cycle entry \`${cycle}\` (seq ${rec.seq}) on the ledger anchored at \`${anchor}\`. Opened ${c.opened_at}.`,
    '',
    '## What was',
    '',
    `The reviewed range starts at \`${c.base}\`. The change was authored by ${c.author_labs.length ? `the ${c.author_labs.join(', ')} lab(s)` : 'an unrecorded lab'}${rec.authors.length ? `, through ${rec.authors.length} recorded turn(s)` : ''}.`,
    '',
    '## What is',
    '',
    `The range ends at \`${c.head}\` (diff \`${c.diff_sha}\`), touching ${c.files.length} file(s): ${c.files.map(f => `\`${f}\``).join(', ') || 'none'}.`,
    '',
    ...(rec.reviews.length ? seatTable(rec.reviews, {verdict: true}) : ['No review is recorded.']),
    '',
    ...(rec.findings.length ? [
      '| Severity | Claim | Reproduction | Resolution |',
      '|---|---|---|---|',
      ...rec.findings.map(f => `| ${f.severity} | ${cell(f.claim)} | ${reproText(f)} | ${resolutionText(f)} |`),
    ] : ['No findings were reported.']),
    '',
    '## What could be better',
    '',
    ...(better.length ? better : ['Nothing the ledger records: every finding was fixed with a reproduction, and every review reported its served model.']),
    '',
    '## What the system concluded',
    '',
    conclusion(rec),
    '',
    ...independenceLines(rec),
    '',
    '## Practice dispositions',
    '',
    ...practiceLines(rec),
    '',
    provenanceNotice(),
    '',
  ].join('\n');
}

/** docs/cycles/index.md. `cycles` are listCycles() rows with each one's close (or null). */
export function cycleIndex(cycles, {anchor = null} = {}) {
  return [
    '<!-- Generated by `node ophanim/public/github.mjs cycles`. Do not edit by hand. -->',
    '# Review cycles',
    '',
    'Each cycle is a range of commits reviewed by model seats on distinct labs, none of them the lab that authored it, recorded on the review-cycle ledger (`pantheon/src/ledger/cycle-kinds.mjs`). A cycle closes `verified` only when every finding carries a reproduction and is fixed or deferred. The reports are generated from the ledger; it is authoritative.',
    '',
    ...(cycles.length ? [
      `Ledger anchor: \`${anchor}\`.`,
      '',
      '| Cycle | Range | Opened | Outcome |',
      '|---|---|---|---|',
      ...cycles.map(c => `| [${cycleSlug(c)}](${cycleSlug(c)}.md) | \`${c.base.slice(0, 12)}..${c.head.slice(0, 12)}\` | ${c.opened_at} | ${c.close ? c.close.outcome : 'open'} |`),
    ] : ['No review cycle is recorded on a ledger available to the generator yet. Cycles are recorded with `npm run review-cycle`; their reports appear here when this index is regenerated from that ledger.']),
    '',
  ].join('\n');
}

/** Write docs/cycles/<slug>.md for every cycle, and index.md. Returns the files written. */
export function writeCycleReports({opened = null, out}) {
  fs.mkdirSync(out, {recursive: true});
  const written = [];
  const rows = opened ? listCycles(opened.view).map(c => {
    const close = opened.view.entries().find(h => opened.view.entry(h).kind === CLOSE && opened.view.entry(h).derived_from.includes(c.hash));
    return {...c, close: close ? opened.view.payload(close) : null};
  }) : [];
  for (const c of rows) {
    const f = path.join(out, `${cycleSlug(c)}.md`);
    fs.writeFileSync(f, cycleReport(opened.view, c.hash, {anchor: opened.anchor, slug: cycleSlug(c)}));
    written.push(f);
  }
  const index = path.join(out, 'index.md');
  fs.writeFileSync(index, cycleIndex(rows, {anchor: opened?.anchor ?? null}));
  written.push(index);
  return written;
}
