// The work ledger: the controller's signed record of who is working on what, at which stage, with which inputs
// and outputs. The status ledger (packages/ledger/status.mjs) stays authoritative for an item's status and only
// the owner signs it; this ledger records the governed lifecycle that produces the evidence a status proposal
// cites. Every receiving stage re-derives its handoff from this ledger before it proceeds.
//
// Kinds (schema ophanim.work/v1), each re-derived on append and on every verify:
//   work.intake   a source of work seen by reconciliation: a status item, a published issue, a ticket, a prompt. An issue
//                 with no ledger item is a CANDIDATE: it is recorded, never executed, until the owner adds an item.
//                 ONCE PER SOURCE: an intake carrying `once: 1` (every intake this module writes since independent
//                 review, assignment 1, Google gemini-4-carbon, 09d490f, question 7) is refused when an intake of the
//                 same {source, ref} is already recorded. Older intakes carry no marker and keep verifying as written.
//   work.claim    the controller takes one stage of one item: attempt, idempotency key, lease, budget. Refused
//                 while another unreleased, unexpired claim on the same item exists (no duplicate execution), and
//                 refused when the same idempotency key already completed (no paying twice for the same inputs).
//                 The key is the digest of the attempt's inputs, which the scheduler builds from its gate
//                 (gates.mjs attemptInputs, ATTEMPT_IDENTITY 2: the routing basis -- what made the gate route the
//                 stage -- and the status entry are part of them). Older claims were keyed on version-1 inputs; a key
//                 is compared, never re-derived from inputs, so every older claim keeps verifying.
//                 A FENCED claim (payload `fence: 1`, every claim this module writes) is also refused while ANY earlier
//                 claim on the item is unreleased, expired or not: `claim()` first releases an expired one as `expired`,
//                 so two claims can never both lead to recorded stages (independent review, assignment 3, Q3/Q4).
//                 A RESERVING claim (payload `reserve: {total_provider_calls}`, every claim the scheduler writes since
//                 independent review, assignment 3 (OpenAI gpt-6-astra extra review, 09d490f), questions 1 and 3) is
//                 also refused when its stage budget does not fit in that total less what the ledger before it already
//                 uses: every other claim's recorded usage (unknown usage at its budget) or charges, whichever is larger,
//                 and the rest of the budget of every claim still live at its `leased_at` (scheduler.mjs spent()). The
//                 check is part of the claim's re-derivation, so it runs under the ledger's append lock: two processes
//                 cannot both reserve the same remainder. Older claims carry no `reserve` and keep verifying as written.
//   work.release  the claim ends: completed, returned, failed, blocked, interrupted or expired. Cites its claim.
//   work.spend    provider calls CHARGED under a claim, recorded (signed) BEFORE the calls are made: {item, stage,
//                 attempt, provider_calls (cumulative for the claim), at}. A call that already left the process is
//                 therefore on the ledger even when the process dies before its stage record, and `spent()`
//                 (scheduler.mjs) counts it, so a restarted attempt cannot spend a full budget again. Refused once the
//                 claim is released or its lease has expired at `at`: a stale holder cannot charge (or make) new calls.
//   work.stage    the stage's result, citing its claim. THE LEASE FENCE: refused when its claim was already released
//                 (any outcome), and -- for a record carrying `at` (the recording time; every record this module writes
//                 since the fence; older records carry none and keep verifying as written) -- when the claim's lease had
//                 expired at `at` (leased_at + lease_ms <= at) or the claim already has a stage record. A holder that
//                 outlived its lease cannot make its late result the handoff. Its handoff is verified on append: the identity (item,
//                 requirement) matches the previous stage's, and the inputs it names are exactly the previous stage's
//                 outputs (by digest). THE TICKET IDENTITY is checked too for a record carrying `lineage: 2` (every
//                 record this module writes since self-audit round 3, assignment 1 (sealed 323361a), question 2, whose
//                 header claimed the check before the code made it): a record that received from a stage naming a
//                 ticket names the same ticket {path, digest}. Records with `lineage: 1` keep verifying as written.
//                 Team, contributions, findings, usage, next stage and any blocker are part of the record.
//                 THE LINEAGE RULE (a record carrying `lineage: 1`, every record this module writes since independent
//                 review, assignment 1, Google gemini-4-carbon, 09d490f, question 2; older records keep verifying as
//                 written): only a plan starts without a handoff, and a handoff from a passed record is from the stage
//                 immediately before this one (no stage is skipped).
//   work.recovery an evidence-recovery attempt for an item Resolved without completion evidence: the status entry
//                 it was made against, the digest of the sources searched, every source with its result, and, when
//                 evidence was recovered, the digest of the UNSIGNED proposal written for the owner. Only the owner
//                 applies it to the status ledger (evidence-recovery.mjs).
//   work.reassessment  NEW EVIDENCE about a closed review cycle, never a change to it: under a later identity policy
//                 (an alias or lab correction), which of its recorded reviews would not qualify, and why. It names
//                 the cycle, the policy the cycle recorded and the policy it was reassessed under. The cycle's own
//                 ledger keeps verifying under its recorded policy; what follows from the evidence is the owner's.
//   work.billing  ONE BILLED GEMINI REQUEST (register L-136; pantheon/src/route/gemini-billing.mjs, docs/billing-policy.md),
//                 recorded (signed) under the claim it was made under, AFTER the billing policy and the stage's own charge
//                 admitted it and BEFORE it is sent: {item, stage, attempt, kind (failover | primary), setting, vendor,
//                 model, purpose, role, transport, source, budget, policy (digest), used_before, at}. Its re-derivation
//                 checks the claim (the lease fence, as a spend) and THE BUDGET, under the ledger's append lock: the
//                 billing entries of the same kind before it, on the whole ledger, are fewer than its declared budget.
//                 The budget's consumption is therefore derived from this record, never from a process's memory: a
//                 restart, a resumed attempt or a later service tick cannot reset it.
//   work.repair   THE SELF-REPAIR LANE'S RECORD (ophanim/operate/self-repair.mjs; docs/self-repair.md), one event each:
//                 `open` (a round: its number, kind repair|rollback, the defect with the Detect evidence, the paths it
//                 claims, its base on the line, the queue and the routing of every skipped defect), `revalidate` (a
//                 re-validation on a moved line head, or a rollback's verification), `land` (one commit on the line:
//                 commit, parent, the exact revert), `close` (landed | blocked | failed), `route` (a defect routed to the
//                 owner as an unsigned candidate). Re-derived under the append lock: rounds are numbered in order; a REPAIR
//                 round is refused while an open round claims overlapping paths, or one is already open for its defect; a
//                 landing is a FAST-FORWARD of its line (its parent is the line's last landing, or the line's start) on
//                 the round's own line, once; a landing whose parent is not the round's base (the base moved) needs a
//                 passing re-validation of exactly that commit on exactly that parent first; a round closes once, and
//                 `landed` only after its landing. A defect is routed once.
//                 A claim may carry `paths` (a self-repair round's claim does): it is refused while ANOTHER item's live
//                 claim carries overlapping paths (pantheon/src/pipeline/paths.mjs pathsOverlap), so two rounds never edit
//                 overlapping paths at once. Claims without `paths` are checked exactly as before.
//
// Inputs: an absolute root (default <repo>/status/work). Outputs: the API below. Must never: sign a status, read
// the owner's keys, or accept a stage whose handoff does not re-derive.
import fs from 'node:fs';
import path from 'node:path';
import {openLedger, createLedger, defineKinds, generateSigner} from '../../packages/ledger/chain.mjs';
import {keyStore} from '../../packages/ledger/home.mjs';
import {digest} from '../../packages/ledger/canonical.mjs';
import {GEMINI_KINDS, SETTING_OF, budgetRefusal as geminiBudgetRefusal} from '../../pantheon/src/route/gemini-billing.mjs';
import {pathsOverlap} from '../../pantheon/src/pipeline/paths.mjs';
import {RESEARCH_TRIGGERS} from '../../pantheon/src/antigravity/config.mjs';

export const WORK_SCHEMA = 'ophanim.work/v1';
// The governed lifecycle, in order. `plan` is evaluation and planning (evidence, problem, plan, independent
// review, revision). `implement` is coding with checks and in-run review. `review` is the coordinated three-lab
// cycle review of the change. `validate` judges the exact implementation against the original requirement and
// the approved acceptance criteria. `outcome` records the unsigned status transition for the owner.
export const STAGES = Object.freeze(['plan', 'implement', 'review', 'validate', 'outcome']);
export const STAGE_STATUS = Object.freeze(['passed', 'returned', 'failed', 'pending', 'blocked']);
/** The reservation refusal's own prefix: produced by the claim's re-derivation, mapped to code PROVIDER_CALL_BUDGET by claim(). */
export const RESERVE_REFUSAL = 'PROVIDER_CALL_BUDGET:';
export const RELEASE_OUTCOMES = Object.freeze(['completed', 'returned', 'failed', 'blocked', 'interrupted', 'expired']);
// `prompt` (2026-11-19): the owner's prompt a status item was registered from (prompt-intake.mjs), or -- as a candidate
// -- a prompt record with no owner-signed status entry.
export const INTAKE_SOURCES = Object.freeze(['status', 'issue', 'ticket', 'prompt']);
export const INTAKE_CLASSES = Object.freeze(['item', 'candidate', 'coordination']);
export const RECOVERY_OUTCOMES = Object.freeze(['recovered', 'not-found']);
/** The self-repair lane's events (work.repair) and how a round may close. */
export const REPAIR_EVENTS = Object.freeze(['open', 'revalidate', 'land', 'close', 'route']);
export const REPAIR_KINDS = Object.freeze(['repair', 'rollback']);
export const REPAIR_CLOSE = Object.freeze(['landed', 'blocked', 'failed']);
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const pathList = v => Array.isArray(v) && v.length <= 256 && v.every(x => typeof x === 'string' && x.trim() !== '' && x.length <= 512);
/** Why a work.repair event cannot follow `prior` (the lane's earlier events, in order), or null. */
function repairRefusal(p, prior) {
  const opens = prior.filter(q => q.event === 'open'), closes = new Map(prior.filter(q => q.event === 'close').map(q => [q.round, q]));
  const open = Number.isInteger(p.round) ? opens.find(q => q.round === p.round) ?? null : null;
  if (p.event === 'route') return prior.some(q => q.event === 'route' && q.defect?.id === p.defect.id) ? `the defect ${p.defect.id} is already routed to the owner: a defect is routed once` : null;
  if (p.event === 'open') {
    const last = Math.max(0, ...opens.map(q => q.round));
    if (p.round !== last + 1) return `rounds are numbered in order: the next round is ${last + 1}, not ${p.round}`;
    if (p.kind !== 'repair') return null;
    const live = opens.filter(q => !closes.has(q.round));
    const same = live.find(q => q.kind === 'repair' && q.defect?.id === p.defect.id);
    if (same) return `round ${same.round} is already open for ${p.defect.id}`;
    const clash = live.find(q => (q.paths ?? []).some(a => p.paths.some(b => pathsOverlap(a, b))));
    if (clash) return `PATHS_CLAIMED: round ${p.round} would claim paths overlapping open round ${clash.round} (${p.paths.join(', ').slice(0, 200)}): two rounds never edit overlapping paths at once`;
    return null;
  }
  if (!open) return `round ${p.round} was never opened`;
  if (closes.has(p.round)) return `round ${p.round} is already closed (${closes.get(p.round).outcome})`;
  if (p.event === 'close') return p.outcome === 'landed' && !prior.some(q => q.event === 'land' && q.round === p.round) ? `round ${p.round} cannot close landed: nothing of it landed` : null;
  if (p.event === 'revalidate') return null;
  // land
  if (prior.some(q => q.event === 'land' && q.round === p.round)) return `round ${p.round} already landed: a round lands one commit`;
  if (p.line !== open.line) return `LANDING_REF: round ${p.round} lands on its own line ${open.line}, never on ${p.line}`;
  const lands = prior.filter(q => q.event === 'land' && q.line === p.line);
  const start = opens.find(q => q.line === p.line)?.base ?? null;
  const head = lands.at(-1)?.commit ?? start;
  if (p.parent !== head) return `LANDING_NOT_FAST_FORWARD: the landing's parent ${p.parent.slice(0, 12)} is not the line's head ${String(head).slice(0, 12)}`;
  if (p.parent !== open.base && !prior.some(q => q.event === 'revalidate' && q.round === p.round && q.ok === true && q.commit === p.commit && q.parent === p.parent)) {
    return `REVALIDATE_REQUIRED: round ${p.round}'s base ${open.base.slice(0, 12)} moved to ${p.parent.slice(0, 12)}; it lands only after a passing re-validation of ${p.commit.slice(0, 12)} on that head`;
  }
  return null;
}
// RESEARCH (owner direction 2026-11-20: the research team; operate/research.mjs). `work.research` records, by `phase`:
//   request     an investigation is asked for, with what triggered it and by whom. A request carrying `once: 1` (every
//               request this code writes) is refused while the same {item, trigger, question} is already recorded.
//   team        a research team is opened for an item: its role, its coordinator and subordinate seats, the selection
//               record, its limits and its root node. Once per team.
//   node        one member: its identity, its parent, its level, its seat and its question, recorded when it is admitted
//               (before it runs) and again with its outcome (the model that answered, where its full report is, by digest).
//   refusal     a delegation the controller did not admit, with its code.
//   conclusion  the team's end: status, whether the question is answered, whether what was found changes what a plan
//               should rest on, the findings (concise text here, the full record by digest), the telemetry, and every
//               contributor with the model asked and the model that answered. Once per team. It answers its request.
// The level of a node is bounded HERE as well as in the controller: a record of an eleventh level is not taken.
export const RESEARCH_PHASES = Object.freeze(['request', 'team', 'node', 'refusal', 'conclusion']);
export const RESEARCH_NODE_STATES = Object.freeze(['admitted', 'finished', 'failed', 'cancelled']);
/** The ends a team can CONCLUDE with. A failed, cancelled or charge-refused team records no conclusion: its request stays open. */
export const RESEARCH_CONCLUDED = Object.freeze(['satisfied', 'exhausted', 'stopped']);
export const RESEARCH_DEPTH_MAX = 10;
/** The requests no conclusion has answered yet, from an item's research records (`work.research(item)`), oldest first. */
export const openResearchRequests = records => { const answered = new Set(records.filter(r => r.phase === 'conclusion' && r.request).map(r => r.request)); return records.filter(r => r.phase === 'request' && !answered.has(r.hash)); };
/** Why a claim may no longer record a result or charge a call at `at` (ms), or null. Shared by append and re-derivation. */
export function fenceRefusal(claim, {released, at}) {
  if (released) return `the claim (${claim.stage}, attempt ${claim.attempt}) was already released (${released.outcome ?? 'released'}): LEASE_FENCED, a released claim records nothing`;
  const until = Date.parse(claim.leased_at) + claim.lease_ms;
  if (Number.isFinite(at) && until <= at) return `the claim's lease (${claim.stage}, attempt ${claim.attempt}) expired at ${new Date(until).toISOString()}, before ${new Date(at).toISOString()}: LEASE_FENCED, a holder past its lease records nothing`;
  return null;
}
const ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const SHA = /^sha256:[0-9a-f]{64}$/;
const ISO = s => typeof s === 'string' && !Number.isNaN(Date.parse(s));
const str = v => typeof v === 'string' && v.trim() !== '';
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonneg = v => Number.isInteger(v) && v >= 0;
const fail = (why, code = 'WORK_REFUSED') => { throw Object.assign(new Error(why), {code}); };

/** The digest the handoff compares: a stage's outputs, canonical. */
export const outputsDigest = outputs => 'sha256:' + digest(outputs ?? {});
/** The idempotency key of a stage attempt: the same item, stage and inputs are the same work. */
export const workKey = ({item, stage, inputs}) => 'sha256:' + digest({item, stage, inputs: inputs ?? {}});

const budgetRefusal = b => {
  if (!plain(b)) return 'a claim names its budget {provider_calls, iterations, elapsed_ms, retries}';
  for (const k of ['provider_calls', 'iterations', 'elapsed_ms', 'retries']) if (!(Number.isInteger(b[k]) && b[k] >= 0)) return `budget.${k} is a non-negative integer, declared before dispatch`;
  return null;
};
/** Why `next` does not keep the ticket identity of `prev` (a stage that names a ticket hands it on unchanged), or null. */
const ticketRefusal = (prev, next) => (prev?.ticket && !(next?.ticket && next.ticket.path === prev.ticket.path && next.ticket.digest === prev.ticket.digest)
  ? `a handoff keeps the ticket identity: the record received names ${prev.ticket.path} ${String(prev.ticket.digest).slice(0, 19)}, this one ${next?.ticket ? `${next.ticket.path} ${String(next.ticket.digest).slice(0, 19)}` : 'none'}` : null);
const identityRefusal = id => {
  if (!plain(id) || !ID.test(id.item ?? '') || !SHA.test(id.requirement ?? '')) return 'a stage names its identity {item, requirement, ticket?}';
  if (id.ticket != null && !(plain(id.ticket) && str(id.ticket.path) && SHA.test(id.ticket.digest ?? ''))) return 'identity.ticket is {path, digest}';
  return null;
};

function kinds({operators}) {
  const byController = a => operators.includes(a.key_id);
  const entriesOf = (view, kind) => view.entries().filter(h => view.entry(h)?.kind === kind);
  // Provider calls used by the claims in `view` at `at` (ms): scheduler.mjs spent()'s calls + reserved, over the ledger
  // before the entry being re-derived. Deterministic over that prefix, so a claim that fit when appended verifies later.
  const usedBefore = (view, at) => {
    const charged = new Map(), stageOf = new Map(), released = new Set();
    for (const h of view.entries()) {
      const x = view.entry(h);
      if (x?.kind === 'work.spend') charged.set(x.derived_from[0], Math.max(charged.get(x.derived_from[0]) ?? 0, view.payload(h).provider_calls));
      else if (x?.kind === 'work.stage') stageOf.set(x.derived_from[0], view.payload(h));
      else if (x?.kind === 'work.release') for (const d of x.derived_from) released.add(d);
    }
    let used = 0;
    for (const h of entriesOf(view, 'work.claim')) {
      const c = view.payload(h), ch = charged.get(h) ?? 0, st = stageOf.get(h);
      if (st) { const u = st.usage?.provider_calls; used += Number.isInteger(u) ? Math.max(u, ch) : Math.max(c.budget.provider_calls, ch); continue; }
      used += ch;
      if (!released.has(h) && Date.parse(c.leased_at) + c.lease_ms > at) used += Math.max(0, c.budget.provider_calls - ch);
    }
    return used;
  };
  const releaseOf = (view, claim) => entriesOf(view, 'work.release').find(h => view.entry(h).derived_from.includes(claim)) ?? null;
  return {
    'work.recovery': {
      authors: byController,
      validate: p => {
        if (p?.schema !== WORK_SCHEMA || !ID.test(p.item ?? '') || !SHA.test(p.status_entry ?? '') || !SHA.test(p.sources ?? '') || !ISO(p.at)) {
          return 'a recovery names {item, status_entry, sources, outcome, searched, at}';
        }
        if (!RECOVERY_OUTCOMES.includes(p.outcome)) return `a recovery outcome is one of ${RECOVERY_OUTCOMES.join(', ')}`;
        if (!Array.isArray(p.searched) || !p.searched.every(x => plain(x) && str(x.source) && str(x.result) && str(x.why))) return 'a recovery lists every source searched {source, ref, result, why}';
        if (p.outcome === 'recovered' ? !(plain(p.proposal) && SHA.test(p.proposal.digest ?? '') && p.searched.some(x => x.result === 'recovered'))
          : p.proposal !== undefined) return 'a recovered outcome names the proposal digest it wrote, and only a recovered one does';
        return null;
      },
      // One attempt per item, status entry and set of sources: the same search is never recorded (or paid for) twice.
      rederive: (e, view) => entriesOf(view, 'work.recovery').some(h => {
        const q = view.payload(h);
        return q.item === e.payload.item && q.status_entry === e.payload.status_entry && q.sources === e.payload.sources;
      }) ? `a recovery of "${e.payload.item}" against these sources and this status is already recorded` : null,
    },
    'work.research': {
      authors: byController,
      validate: p => {
        if (p?.schema !== WORK_SCHEMA || !ID.test(p.item ?? '') || !RESEARCH_PHASES.includes(p.phase) || !ISO(p.at)) return 'a research record names {item, phase, at}';
        const seat = x => plain(x) && str(x.model);
        if (p.phase === 'request') return RESEARCH_TRIGGERS.includes(p.trigger) && str(p.question) && str(p.by) && (p.scope === undefined || (Array.isArray(p.scope) && p.scope.every(str))) && (p.role === undefined || str(p.role)) ? null
          : 'a research request names {trigger, question, by, scope?, role?}';
        if (!str(p.team)) return 'a research record after the request names its team';
        if (p.phase === 'team') return (p.request === null || SHA.test(p.request ?? '')) && str(p.trigger) && str(p.role) && seat(p.coordinator) && seat(p.subordinate) && plain(p.limits) && str(p.root) ? null
          : 'a research team names {request|null, trigger, role, coordinator, subordinate, limits, root}';
        if (p.phase === 'node') return str(p.node) && ['coordinator', 'specialist'].includes(p.kind) && Number.isInteger(p.depth) && p.depth >= 1 && p.depth <= RESEARCH_DEPTH_MAX && RESEARCH_NODE_STATES.includes(p.state)
          && (p.parent === null || str(p.parent)) && seat(p.seat) && str(p.question) ? null : `a research node names {node, kind, parent|null, depth (1 to ${RESEARCH_DEPTH_MAX}), state, seat, question}`;
        if (p.phase === 'refusal') return str(p.code) && str(p.reason) ? null : 'a research refusal names {code, reason}';
        return (p.request === null || SHA.test(p.request ?? '')) && str(p.status) && typeof p.satisfied === 'boolean' && typeof p.material === 'boolean' && plain(p.telemetry) && Array.isArray(p.contributors)
          && typeof p.findings_text === 'string' && (p.findings === null || (plain(p.findings) && SHA.test(p.findings.sha256 ?? ''))) ? null
          : 'a research conclusion names {request|null, status, satisfied, material, telemetry, contributors, findings_text, findings|null}';
      },
      rederive: (e, view) => {
        const p = e.payload, mine = entriesOf(view, 'work.research').filter(h => h !== e.hash).map(h => ({hash: h, ...view.payload(h)})).filter(q => q.item === p.item);
        // THE LEASE FENCE (independent review of ea858a6..af23623, lifecycle finding 4): a research record made under a
        // stage's claim is held to that claim like a spend: an expired or released claim records nothing more.
        const claims = e.derived_from.filter(h => view.entry(h)?.kind === 'work.claim');
        if (claims.length) {
          const c = view.payload(claims[0]), rel = releaseOf(view, claims[0]);
          if (c.item !== p.item) return 'a research record is made under a claim of its own item';
          const fenced = fenceRefusal(c, {released: rel ? view.payload(rel) : null, at: Date.parse(p.at)});
          if (fenced) return fenced;
        }
        // (finding 7) A team and a conclusion name a request that IS a request of this item, and a conclusion answers its
        // own team's request, not another's.
        const isRequest = h => mine.some(q => q.phase === 'request' && q.hash === h);
        if (p.phase === 'request') return p.once === 1 && mine.some(q => q.phase === 'request' && q.trigger === p.trigger && q.question === p.question) ? 'this research is already requested for the item (same trigger and question)' : null;
        const team = mine.filter(q => q.team === p.team);
        if (p.phase === 'team') {
          if (team.some(q => q.phase === 'team')) return 'this research team is already recorded';
          return p.request === null || isRequest(p.request) ? null : 'the request a team names is not a research request of this item';
        }
        const opened = team.find(q => q.phase === 'team');
        if (!opened) return 'its team is not recorded for this item';
        if (p.phase !== 'conclusion' && team.some(q => q.phase === 'conclusion')) return 'this research team has concluded: it records nothing more';
        if (p.phase === 'node') {
          // A member's outcome follows its admission: nothing finishes, fails or is cancelled that was never admitted.
          if (p.state !== 'admitted' && !team.some(q => q.phase === 'node' && q.node === p.node && (q.round ?? null) === (p.round ?? null) && q.state === 'admitted')) return `node ${p.node} was never recorded as admitted`;
          if (p.kind === 'coordinator') return p.depth === 1 && p.parent === null ? null : 'a coordinator is level 1 and has no parent';
          if (p.parent === null) return 'a specialist has a parent';
          if (!team.some(q => q.phase === 'node' && q.node === p.parent && q.depth === p.depth - 1)) return `its parent ${p.parent} is not a recorded node of this team one level above it`;
          // A level is opened under a member that FINISHED: its open question is what the level is for.
          return team.some(q => q.phase === 'node' && q.node === p.parent && q.state === 'finished') ? null : `its parent ${p.parent} has not finished: a level is opened for an open question of a finished member`;
        }
        if (p.phase === 'conclusion') {
          if (team.some(q => q.phase === 'conclusion')) return 'this research team has already concluded';
          if (!RESEARCH_CONCLUDED.includes(p.status)) return `a team that is ${p.status} has not concluded: its request stays open`;
          if ((p.request ?? null) !== (opened.request ?? null)) return 'a conclusion answers the request its own team was opened for';
          return team.some(q => q.phase === 'node') ? null : 'a team with no member has concluded nothing';
        }
        return null;
      },
    },
    'work.reassessment': {
      authors: byController,
      validate: p => (p?.schema === WORK_SCHEMA && ID.test(p.item ?? '') && SHA.test(p.cycle ?? '') && SHA.test(p.recorded_policy ?? '') && SHA.test(p.policy ?? '')
        && p.recorded_policy !== p.policy && Array.isArray(p.findings) && p.findings.every(x => plain(x) && (x.review === null || SHA.test(x.review ?? '')) && str(x.why)) && ISO(p.at)
        && (p.policy_rules === undefined || plain(p.policy_rules))
        ? null : 'a reassessment names {item, cycle, recorded_policy, policy (another one), findings: [{review, why}], policy_rules?, at}'),
      // One reassessment of a cycle per policy: the same evidence is not recorded twice.
      rederive: (e, view) => (entriesOf(view, 'work.reassessment').some(h => { const q = view.payload(h); return q.cycle === e.payload.cycle && q.policy === e.payload.policy; })
        ? 'this cycle is already reassessed under that policy' : null),
    },
    'work.repair': {
      authors: byController,
      validate: p => {
        if (p?.schema !== WORK_SCHEMA || !REPAIR_EVENTS.includes(p.event) || !ISO(p.at)) return 'a self-repair event names {event, round, at}';
        if (p.event === 'route') return plain(p.defect) && str(p.defect.id) && p.round === null && p.route === 'owner' && str(p.why) ? null : 'a route names {defect: {id}, route: owner, why}';
        if (!(Number.isInteger(p.round) && p.round >= 1)) return 'a self-repair event names its round (an integer >= 1)';
        if (p.event === 'open') {
          if (!REPAIR_KINDS.includes(p.kind) || !plain(p.defect) || !str(p.defect.id) || !pathList(p.paths) || !COMMIT.test(p.base ?? '') || !/^refs\/heads\/./.test(p.line ?? '')) {
            return 'an open names {kind: repair|rollback, defect: {id}, paths, base (a commit), line (refs/heads/...)}';
          }
          if (p.kind === 'rollback' && !(plain(p.culprit) && Number.isInteger(p.culprit.round) && COMMIT.test(p.culprit.commit ?? ''))) return 'a rollback round names its culprit {round, commit}';
          return null;
        }
        if (p.event === 'close') return REPAIR_CLOSE.includes(p.outcome) && str(p.why) ? null : `a close names {outcome: ${REPAIR_CLOSE.join('|')}, why}`;
        if (p.event === 'revalidate') return COMMIT.test(p.commit ?? '') && COMMIT.test(p.parent ?? '') && typeof p.ok === 'boolean' ? null : 'a revalidation names {commit, parent, ok}';
        return COMMIT.test(p.commit ?? '') && COMMIT.test(p.parent ?? '') && /^refs\/heads\/./.test(p.line ?? '') && p.revert === `git revert --no-edit ${p.commit}`
          ? null : 'a landing names {line, commit, parent, revert: the exact revert of the commit}';
      },
      rederive: (e, view) => repairRefusal(e.payload, entriesOf(view, 'work.repair').filter(h => h !== e.hash).map(h => view.payload(h))),
    },
    'work.intake': {
      authors: byController,
      validate: p => p?.schema === WORK_SCHEMA && INTAKE_SOURCES.includes(p.source) && str(p.ref) && INTAKE_CLASSES.includes(p.classification)
        && (p.item === null || ID.test(p.item ?? '')) && str(p.why) && ISO(p.at) ? null
        : 'an intake names {source, ref, item|null, classification, why, at}',
      rederive: (e, view) => {
        if ((e.payload.classification === 'item') !== (e.payload.item !== null)) return 'only an intake classified as an item names one; a candidate or coordination issue is never an item until the owner adds it';
        if (e.payload.once === 1 && entriesOf(view, 'work.intake').some(h => h !== e.hash && view.payload(h).source === e.payload.source && view.payload(h).ref === e.payload.ref)) {
          return `the ${e.payload.source} source ${e.payload.ref} is already recorded: intake is recorded once per source`;
        }
        return null;
      },
    },
    'work.claim': {
      authors: byController,
      validate: p => {
        if (p?.schema !== WORK_SCHEMA || !ID.test(p.item ?? '') || !STAGES.includes(p.stage)) return 'a claim names {item, stage}';
        if (!(Number.isInteger(p.attempt) && p.attempt >= 1) || !SHA.test(p.key ?? '') || !str(p.holder)) return 'a claim names {attempt >= 1, key, holder}';
        if (!ISO(p.leased_at) || !(Number.isInteger(p.lease_ms) && p.lease_ms > 0)) return 'a claim names its lease {leased_at, lease_ms}';
        if (p.reserve !== undefined && !(plain(p.reserve) && nonneg(p.reserve.total_provider_calls) && Object.keys(p.reserve).length === 1)) return 'a reserving claim names reserve {total_provider_calls}';
        if (p.paths !== undefined && !(pathList(p.paths) && p.paths.length)) return 'a claim\'s paths are a non-empty list of repository paths or globs';
        return budgetRefusal(p.budget);
      },
      rederive: (e, view) => {
        const p = e.payload, at = Date.parse(p.leased_at);
        for (const h of entriesOf(view, 'work.claim')) {
          const c = view.payload(h);
          if (c.item !== p.item) continue;
          const rel = releaseOf(view, h);
          // A fenced claim waits for every earlier claim on the item to be released (an expired one as `expired`).
          if (!rel && p.fence === 1 && Date.parse(c.leased_at) + c.lease_ms <= at) return `"${p.item}" has an unreleased claim (${c.stage}, attempt ${c.attempt}) whose lease expired: release it as expired before claiming again`;
          if (!rel && Date.parse(c.leased_at) + c.lease_ms > at) return `"${p.item}" is already claimed (${c.stage}, attempt ${c.attempt}, lease until ${new Date(Date.parse(c.leased_at) + c.lease_ms).toISOString()}): no duplicate execution`;
          if (rel && c.key === p.key && view.payload(rel).outcome === 'completed') return `"${p.item}" ${p.stage} already completed for these exact inputs (${p.key.slice(0, 19)}): reuse it, do not pay twice`;
        }
        // THE PATH FENCE (self-repair): a claim carrying paths waits while another item's live claim holds overlapping ones.
        if (p.paths !== undefined) {
          for (const h of entriesOf(view, 'work.claim')) {
            const c = view.payload(h);
            if (c.item === p.item || !Array.isArray(c.paths) || releaseOf(view, h) || Date.parse(c.leased_at) + c.lease_ms <= at) continue;
            const both = c.paths.filter(a => p.paths.some(b => pathsOverlap(a, b)));
            if (both.length) return `PATHS_CLAIMED: "${c.item}" holds a live claim (${c.stage}, attempt ${c.attempt}) on paths overlapping "${p.item}"'s (${both.join(', ').slice(0, 200)}): two rounds never edit overlapping paths at once`;
          }
        }
        if (p.reserve !== undefined) {
          const used = usedBefore(view, at), left = p.reserve.total_provider_calls - used;
          if (left < p.budget.provider_calls) return `${RESERVE_REFUSAL} ${left} of ${p.reserve.total_provider_calls} provider call(s) left (used or reserved by other claims: ${used}); this stage reserves ${p.budget.provider_calls}`;
        }
        return null;
      },
    },
    'work.release': {
      authors: byController,
      validate: p => p?.schema === WORK_SCHEMA && ID.test(p.item ?? '') && STAGES.includes(p.stage) && RELEASE_OUTCOMES.includes(p.outcome) && ISO(p.at) && str(p.why)
        ? null : 'a release names {item, stage, outcome, why, at}',
      rederive: (e, view) => {
        const claims = e.derived_from.filter(h => view.entry(h)?.kind === 'work.claim');
        if (claims.length !== 1) return 'a release cites exactly one claim';
        const c = view.payload(claims[0]);
        if (c.item !== e.payload.item || c.stage !== e.payload.stage) return 'a release names its claim\'s item and stage';
        const other = entriesOf(view, 'work.release').find(h => h !== e.hash && view.entry(h).derived_from.includes(claims[0]));
        return other ? 'that claim is already released' : null;
      },
    },
    'work.spend': {
      authors: byController,
      validate: p => p?.schema === WORK_SCHEMA && ID.test(p.item ?? '') && STAGES.includes(p.stage) && Number.isInteger(p.attempt) && p.attempt >= 1
        && Number.isInteger(p.provider_calls) && p.provider_calls >= 1 && ISO(p.at) ? null
        : 'a spend names {item, stage, attempt, provider_calls >= 1 (cumulative under its claim), at}',
      rederive: (e, view) => {
        const claims = e.derived_from.filter(h => view.entry(h)?.kind === 'work.claim');
        if (claims.length !== 1) return 'a spend cites the claim it was charged under';
        const c = view.payload(claims[0]), p = e.payload;
        if (c.item !== p.item || c.stage !== p.stage || c.attempt !== p.attempt) return 'a spend matches its claim (item, stage, attempt)';
        const rel = releaseOf(view, claims[0]);
        const why = fenceRefusal(c, {released: rel ? view.payload(rel) : null, at: Date.parse(p.at)});
        if (why) return why;
        if (p.provider_calls > c.budget.provider_calls) return `a spend of ${p.provider_calls} is over its claim's budget of ${c.budget.provider_calls} provider call(s)`;
        const prev = entriesOf(view, 'work.spend').filter(h => h !== e.hash && view.entry(h).derived_from.includes(claims[0])).map(h => view.payload(h).provider_calls);
        return prev.some(n => n >= p.provider_calls) ? 'a spend is cumulative: it only grows under its claim' : null;
      },
    },
    'work.billing': {
      authors: byController,
      validate: p => {
        if (p?.schema !== WORK_SCHEMA || !ID.test(p.item ?? '') || !STAGES.includes(p.stage) || !(Number.isInteger(p.attempt) && p.attempt >= 1) || !ISO(p.at)) {
          return 'a billing entry names {item, stage, attempt, kind, setting, vendor, model, source, budget, policy, at}';
        }
        if (!GEMINI_KINDS.includes(p.kind) || p.setting !== SETTING_OF[p.kind]) return `a billing entry's kind is ${GEMINI_KINDS.join(' or ')}, with its own setting`;
        if (!str(p.vendor) || !str(p.model) || !str(p.source) || !str(p.policy)) return 'a billing entry names the seat (vendor, model), the source of its policy and the policy digest';
        if (!(Number.isSafeInteger(p.budget) && p.budget > 0)) return 'a billing entry names the declared budget it was admitted under (a positive integer)';
        return null;
      },
      rederive: (e, view) => {
        const claims = e.derived_from.filter(h => view.entry(h)?.kind === 'work.claim');
        if (claims.length !== 1) return 'a billing entry cites the claim it was charged under';
        const c = view.payload(claims[0]), p = e.payload;
        if (c.item !== p.item || c.stage !== p.stage || c.attempt !== p.attempt) return 'a billing entry matches its claim (item, stage, attempt)';
        const rel = releaseOf(view, claims[0]);
        const why = fenceRefusal(c, {released: rel ? view.payload(rel) : null, at: Date.parse(p.at)});
        if (why) return why;
        // THE BUDGET, under the append lock: every billed request of this kind on the ledger before this one counts.
        const used = entriesOf(view, 'work.billing').filter(h => h !== e.hash && view.payload(h).kind === p.kind).length;
        return geminiBudgetRefusal({kind: p.kind, budget: p.budget, used});
      },
    },
    'work.stage': {
      authors: byController,
      validate: p => {
        if (p?.schema !== WORK_SCHEMA || !STAGES.includes(p.stage) || !STAGE_STATUS.includes(p.status)) return 'a stage names {stage, status}';
        const why = identityRefusal(p.identity);
        if (why) return why;
        if (!(Number.isInteger(p.attempt) && p.attempt >= 1)) return 'a stage names its attempt';
        if (p.lineage !== undefined && p.lineage !== 1 && p.lineage !== 2) return 'a stage\'s lineage marker is 1 or 2';
        if (!plain(p.inputs) || !plain(p.outputs)) return 'a stage names its inputs and outputs';
        if (!Array.isArray(p.team) || !p.team.every(t => plain(t) && str(t.role))) return 'a stage names its team [{role, vendor?, model?, lab?}]';
        if (!Array.isArray(p.contributions) || !Array.isArray(p.findings)) return 'a stage names its contributions and findings';
        if (!plain(p.usage) || !(p.usage.provider_calls === null || nonneg(p.usage.provider_calls))) return 'a stage names its usage {provider_calls (null when unknown), tokens?, elapsed_ms?}';
        if (p.next !== null && !(plain(p.next) && (p.next.stage === null || STAGES.includes(p.next.stage)) && str(p.next.why))) return 'next is null or {stage|null, why}';
        if (p.status === 'blocked' && !(plain(p.blocker) && str(p.blocker.what) && str(p.blocker.role) && str(p.blocker.resume_when))) {
          return 'a blocked stage names its blocker {what, role, resume_when}';
        }
        if (p.status === 'returned' && !(p.next && STAGES.indexOf(p.next.stage) >= 0 && STAGES.indexOf(p.next.stage) <= STAGES.indexOf(p.stage))) {
          return 'a returned stage names the earlier (or same) stage it returns to';
        }
        return null;
      },
      rederive: (e, view) => {
        const p = e.payload;
        const claims = e.derived_from.filter(h => view.entry(h)?.kind === 'work.claim');
        if (claims.length !== 1) return 'a stage cites the claim it ran under';
        const c = view.payload(claims[0]);
        if (c.item !== p.identity.item || c.stage !== p.stage || c.attempt !== p.attempt) return 'a stage matches its claim (item, stage, attempt)';
        // THE LEASE FENCE (see the header). A released claim never records; a record that carries `at` is also refused
        // past the lease, and once its claim already has a result.
        const rel = releaseOf(view, claims[0]);
        if (p.at !== undefined && !ISO(p.at)) return 'a stage\'s `at` is its recording time (ISO)';
        const fenced = fenceRefusal(c, {released: rel ? view.payload(rel) : null, at: p.at === undefined ? NaN : Date.parse(p.at)});
        if (fenced) return fenced;
        if (p.at !== undefined && entriesOf(view, 'work.stage').some(h => h !== e.hash && view.entry(h).derived_from[0] === claims[0])) return 'that claim already has a stage record';
        // The handoff: the stage it received from, if any, is the same work, and what this stage consumed is exactly
        // what that stage produced.
        const from = p.handoff?.from ?? null;
        if (p.lineage >= 1 && from === null && p.stage !== 'plan') return `a ${p.stage} stage starts from a handoff; only a plan starts without one`;
        if (from !== null) {
          if (!e.derived_from.includes(from) || view.entry(from)?.kind !== 'work.stage') return 'a handoff cites the stage record it received';
          const prev = view.payload(from);
          if (prev.identity.item !== p.identity.item || prev.identity.requirement !== p.identity.requirement) {
            return 'a handoff keeps the item and the original requirement';
          }
          if (prev.status !== 'passed' && !(prev.status === 'returned' && prev.next?.stage === p.stage)) return `a handoff starts from a passed stage, or one that returned to this stage (it was ${prev.status})`;
          if (p.lineage >= 1 && prev.status === 'passed' && prev.stage !== STAGES[STAGES.indexOf(p.stage) - 1]) return `${p.stage} receives from ${STAGES[STAGES.indexOf(p.stage) - 1] ?? 'no stage'}, not ${prev.stage}: no stage is skipped`;
          if (p.lineage >= 2 && ticketRefusal(prev.identity, p.identity)) return ticketRefusal(prev.identity, p.identity);
          if (p.inputs.upstream !== outputsDigest(prev.outputs)) return 'the stage\'s inputs are not the outputs of the stage it received from';
        }
        return null;
      },
    },
  };
}

/**
 * Why `from` is not a valid handoff for `stage` of `item`, or null. The WHOLE chain is re-derived, not one hop: from
 * `from` back to its plan, each record is this item's, passed, the stage immediately before the one it hands to, keeps
 * the original requirement (and, given `requirement`, the one the gate asks for), and its inputs are exactly the outputs
 * of the record it received. Only a plan starts the chain. (Independent review, assignment 1, Google gemini-4-carbon,
 * 09d490f, question 2: a stage consumed a record that started from nothing, or another item's.)
 */
export function handoffRefusal(work, {item, stage, from, requirement = null}) {
  if (!from) return stage === 'plan' ? null : `${item}: ${stage} has no handoff to start from`;
  const mine = work.stages(item);
  const byHash = new Map(mine.map(s => [s.hash, s]));
  let rec = byHash.get(from), want = stage;
  if (!rec) return `${item}: the handoff ${String(from).slice(0, 19)} is not a stage record of this item`;
  const head = rec;
  for (;;) {
    const wanted = STAGES[STAGES.indexOf(want) - 1];
    if (rec.stage !== wanted) return `${item}: ${want} receives from ${wanted}, not ${rec.stage}`;
    if (rec.status !== 'passed') return `${item}: the ${rec.stage} handoff is ${rec.status}, not passed`;
    if (rec.identity?.item !== item) return `${item}: the ${rec.stage} record is of "${rec.identity?.item}"`;
    if (rec.identity.requirement !== head.identity.requirement) return `${item}: the ${rec.stage} record was made for another requirement than the rest of its chain`;
    if (requirement && rec.identity.requirement !== requirement) return `${item}: the ${rec.stage} record was made for another requirement than the one the gate asks for`;
    const up = rec.handoff?.from ?? null;
    if (rec.stage === 'plan') return up === null ? null : `${item}: the plan record names a handoff`;
    if (!up) return `${item}: the ${rec.stage} record starts from no handoff; only a plan does`;
    const prev = byHash.get(up);
    if (!prev) return `${item}: the ${rec.stage} record's handoff is not a stage record of this item`;
    if (rec.inputs?.upstream !== outputsDigest(prev.outputs)) return `${item}: the ${rec.stage} record's inputs are not the outputs of the record it received`;
    // The ticket identity is handed on unchanged (checked on every chain, whatever its records' lineage marker).
    const tw = ticketRefusal(prev.identity, rec.identity);
    if (tw) return `${item}: the ${rec.stage} record: ${tw}`;
    want = rec.stage;
    rec = prev;
  }
}

/** Open (or create on first use) the work ledger at `root`. Keys for the controller live under <root>/keys. */
export function openWorkLedger({root, create = true, keys = null, anchor = null}) {
  if (!root || !path.isAbsolute(root)) fail('an absolute work ledger root is required');
  const anchorFile = path.join(root, 'ANCHOR');
  if (!create && !fs.existsSync(anchorFile)) fail(`no work ledger at ${root}`);
  fs.mkdirSync(root, {recursive: true});
  const keysDir = keys ?? path.join(root, 'keys');
  let pinned = fs.existsSync(anchorFile) ? fs.readFileSync(anchorFile, 'utf8').trim() : null;
  if (!pinned) {
    if (fs.existsSync(path.join(root, 'chain.jsonl'))) fail('a work ledger without its ANCHOR is not opened');
    const store = keyStore(keysDir);
    const op = store.put(generateSigner('controller')), order = store.put(generateSigner('work-orderer'));
    pinned = createLedger({dir: root, operator: op, order,
      authority: {keyring: {controller: op.publicJwk, 'work-orderer': order.publicJwk}, orderer: 'work-orderer', operators: ['controller']}});
    fs.writeFileSync(anchorFile, pinned + '\n');
  }
  if (anchor && anchor !== pinned) fail('this work ledger is not the one the caller pinned');
  let operators = ['controller'];
  const open = () => openLedger({dir: root, kinds: defineKinds(kinds({operators})), anchor: pinned});
  let L = open();
  const state = L.verify();
  if (!state.ok) fail(`work ledger does not verify: ${state.why}`);
  operators = state.authority.operators;
  L = open();

  const view = () => {
    const at = new Map(L.read().map(e => [L.hashOf(e), e]));
    return {entry: h => at.get(h) ?? null, payload: h => (at.has(h) ? L.payloadOf(at.get(h)) : null), entries: () => [...at.keys()]};
  };
  const signers = () => {
    // A reader without the controller's keys can verify and project, never record (a concrete block, not a skip).
    if (!fs.existsSync(keysDir)) fail('no controller key is held here: the work ledger can be verified, not changed', 'NO_AUTHORITY');
    const store = keyStore(keysDir);
    const op = operators.map(id => store.get(id)).find(Boolean), order = store.get(state.authority.orderer);
    if (!op || !order) fail('no controller key is held here: the work ledger can be verified, not changed', 'NO_AUTHORITY');
    return {op, order};
  };
  const append = (kind, payload, derivedFrom = []) => {
    const {op, order} = signers();
    return L.append({kind, payload: {schema: WORK_SCHEMA, ...payload}, author: {key_id: op.key_id}, signer: op, order, derivedFrom}).hash;
  };
  const of = (kind, pred = () => true) => { const v = view(); return v.entries().filter(h => v.entry(h).kind === kind).map(h => ({hash: h, ...v.payload(h), derived_from: v.entry(h).derived_from})).filter(pred); };
  const released = claimHash => of('work.release', r => r.derived_from.includes(claimHash))[0] ?? null;
  const fence = (claimHash, at) => {
    const c = of('work.claim', x => x.hash === claimHash)[0];
    if (!c) fail('no such claim');
    const why = fenceRefusal(c, {released: released(claimHash), at: Date.parse(at)});
    if (why) fail(why, 'LEASE_FENCED');
    return c;
  };

  return {
    ledger: L, anchor: pinned, root,
    verify: () => L.verify(),
    intake: ({source, ref, item = null, classification, why, at = new Date().toISOString()}) => append('work.intake', {source, ref, item, classification, why, at, once: 1}),
    /** Claim one stage of one item. Throws (code WORK_REFUSED) on a duplicate or an already-completed key. */
    // An unreleased claim on the item whose lease expired at `at` is first released as `expired` (a claim racing to
    // release it is fine: the ledger refuses the second release, and the fenced claim then re-derives).
    // `total_provider_calls` (optional): the total this claim's budget is RESERVED against, atomically (see the header).
    claim: ({item, stage, attempt, inputs, holder, budget, lease_ms = 30 * 60_000, at = new Date().toISOString(), total_provider_calls = undefined, paths = undefined}) => {
      for (const c of of('work.claim', x => x.item === item && !released(x.hash) && Date.parse(x.leased_at) + x.lease_ms <= Date.parse(at))) {
        try { append('work.release', {item: c.item, stage: c.stage, outcome: 'expired', why: 'the lease expired without a recorded result: released before a new claim', at}, [c.hash]); }
        catch (e) { if (!/already released/.test(e.message)) throw e; }
      }
      // A refusal of the reservation is given its CODE here, at its producer (self-audit round 3, assignment 3 (sealed
      // bb1287a), L-308): the scheduler classifies the stop by `code` PROVIDER_CALL_BUDGET, never by the message.
      try {
        return append('work.claim', {item, stage, attempt, key: workKey({item, stage, inputs}), holder, leased_at: at, lease_ms, budget, fence: 1,
          ...(total_provider_calls !== undefined ? {reserve: {total_provider_calls}} : {}), ...(paths !== undefined ? {paths} : {})});
      } catch (e) {
        if (total_provider_calls !== undefined && String(e?.message ?? '').includes(RESERVE_REFUSAL)) { try { e.code = 'PROVIDER_CALL_BUDGET'; } catch { /* frozen */ } }
        if (paths !== undefined && String(e?.message ?? '').includes('PATHS_CLAIMED:')) { try { e.code = 'PATHS_CLAIMED'; } catch { /* frozen */ } }
        throw e;
      }
    },
    release: ({claim, item, stage, outcome, why, at = new Date().toISOString()}) => append('work.release', {item, stage, outcome, why, at}, [claim]),
    /** Record a stage's result under its claim; `from` is the stage record it received (verified on append). */
    // Refused up front (code LEASE_FENCED) when the claim is released or its lease expired at `at`; the ledger's
    // re-derivation refuses the same, so the check cannot be skipped by appending directly.
    recordStage: ({claim, from = null, at = new Date().toISOString(), ...rec}) => {
      fence(claim, at);
      return append('work.stage', {...rec, at, handoff: {from}, lineage: 2}, [claim, ...(from ? [from] : [])]);
    },
    /** Charge provider calls under a live claim, BEFORE they are made: `provider_calls` is the claim's cumulative count. */
    recordSpend: ({claim, provider_calls, at = new Date().toISOString()}) => {
      const c = fence(claim, at);
      return append('work.spend', {item: c.item, stage: c.stage, attempt: c.attempt, provider_calls, at}, [claim]);
    },
    /**
     * Record ONE billed Gemini request under a live claim, BEFORE it is sent (register L-136): the usage row the billing
     * policy admitted (pantheon/src/route/gemini-billing.mjs). Refused when the claim is fenced or the declared budget of
     * the row's kind is already spent on this ledger (its re-derivation, under the append lock).
     */
    recordBilling: ({claim, kind, setting, vendor, model, purpose = null, role = null, transport = 'api', request = 1, source, budget, policy, used_before = null, at = new Date().toISOString()}) => {
      const c = fence(claim, at);
      return append('work.billing', {item: c.item, stage: c.stage, attempt: c.attempt, kind, setting, vendor, model, purpose, role, transport, request, source, budget, policy, used_before, at}, [claim]);
    },
    /** The billed Gemini requests recorded on this ledger (of `kind`, when given), in order. */
    billings: kind => of('work.billing', b => kind === undefined || b.kind === kind),
    releases: () => of('work.release'),
    spends: claimHash => of('work.spend', s => claimHash === undefined || s.derived_from.includes(claimHash)),
    /** Record an evidence-recovery attempt (evidence-recovery.mjs). Writes nothing to the status ledger. */
    recordRecovery: ({item, status_entry, sources, outcome, searched, proposal = undefined, at = new Date().toISOString()}) =>
      append('work.recovery', {item, status_entry, sources, outcome, searched, ...(proposal !== undefined ? {proposal} : {}), at}),
    recoveries: item => of('work.recovery', r => item === undefined || r.item === item),
    /** Record what a later identity policy says about a closed cycle's reviews (pantheon review/identity.mjs `reassess`). */
    recordReassessment: ({item, cycle, recorded_policy, policy, findings, policy_rules = undefined, at = new Date().toISOString()}) =>
      append('work.reassessment', {item, cycle, recorded_policy, policy, findings, ...(policy_rules !== undefined ? {policy_rules} : {}), at}),
    reassessments: item => of('work.reassessment', r => item === undefined || r.item === item),
    /** Record one research record (see RESEARCH above). `claim`: the stage claim it was made under, when there is one. */
    recordResearch: ({claim = null, at = new Date().toISOString(), ...p}) => append('work.research', {...p, at}, claim ? [claim] : []),
    research: item => of('work.research', r => item === undefined || r.item === item),
    intakes: () => of('work.intake'),
    /** Record one self-repair lane event (work.repair; see the header). Returns its entry hash. */
    recordRepair: ({at = new Date().toISOString(), ...event}) => append('work.repair', {...event, at}),
    /** The self-repair lane's events, in ledger order. */
    repairs: () => of('work.repair'),
    claims: item => of('work.claim', c => item === undefined || c.item === item),
    stages: item => of('work.stage', s => item === undefined || s.identity.item === item),
    /** The claim on `item` that is unreleased and unexpired at `now`, or null. */
    activeClaim: (item, now = Date.now()) => of('work.claim', c => c.item === item).find(c => !released(c.hash) && Date.parse(c.leased_at) + c.lease_ms > now) ?? null,
    /** Claims left open past their lease: interrupted work, to release as expired before a bounded resume. */
    expiredClaims: (now = Date.now()) => of('work.claim', c => !released(c.hash) && Date.parse(c.leased_at) + c.lease_ms <= now),
    released,
    /** Why claim `claimHash` may no longer act at `at` (released, or past its lease), or null (fenceRefusal). */
    leaseRefusal: (claimHash, at = new Date().toISOString()) => {
      const c = of('work.claim', x => x.hash === claimHash)[0];
      return c ? fenceRefusal(c, {released: released(claimHash), at: Date.parse(at)}) : 'no such claim: LEASE_FENCED';
    },
  };
}
