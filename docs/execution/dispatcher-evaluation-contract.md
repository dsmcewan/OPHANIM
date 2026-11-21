# Dispatcher diagnosis and recursive improvement: assignment and evaluation

Status: proposed implementation contract; baseline recorded before implementation. No live lane is activated by this document.

The owner's objective, 2026-11-21:

> We are wanting Ophanim to self-diagnose at the dispatcher phase and repair itself. If no repairs are needed it should be a research and recursive improvement stage.

Codex supervises assignments and independently checks evidence. Claude is the assigned assessment author and prospective implementer. An independent test session fixes acceptance and holdout tests before the implementer starts. Improvement of Claude's work and improvement of OPHANIM are measured separately.

## Decision point and existing implementation

Use the scheduler's pre-dispatch decision point, where the existing self-repair lane runs after intake. Preserve the per-unit Stage 2 dispatcher as its existing non-authoring rubric arbiter, the approved model roles, three-lab review and protected surfaces.

At `3249bb27d275c549831482b8191568171db73eb9`, with the relevant mechanisms byte-identical on main `4e5cdd2`, the repository already has Detect → Diagnose → Repair → Verify, independent review, line-only landing, rollback and idle inspection. Research runs for an individual task's evidence gaps. There is no implemented healthy-system branch automatically invoking research and recursive improvement. Claude's code-cited assessment is retained in [comment 7070736797](https://github.com/dsmcewan/OPHANIM/pull/87#issuecomment-7070736797).

The existing repair/research baseline passes 31 tests on native Linux Node 24.18.0, exit 0, in 8.384 seconds. Command:

```bash
node --test ophanim/operate/self-repair.test.mjs \
  ophanim/operate/research.test.mjs ophanim/operate/research-lifecycle.test.mjs
```

This is existing synthetic qualification, not evidence that the missing behavior works or that Claude has improved. The retained receipt is `review/dispatcher-baseline-cguy_hs_/receipt.json` in the shared workspace. Per-assignment tokens and model cost were not measured and remain unknown.

## Required behavior and evaluation cases

| Case | Required result |
| --- | --- |
| Fresh complete diagnosis finds a repairable defect | Reuse the repair lane; retain source-bound evidence, failing reproduction, independent review and verification. |
| Complete diagnosis establishes no repairs are needed | Enter research and recursive improvement through the existing research transport and resource policy. A proposal file alone is not completion of this requirement. |
| Inspection failed or recorded no complete result | Remain incomplete and retry; never mark that head successfully inspected. |
| Evidence missing or stale for the current head | Report incomplete/stale and obtain inspection evidence; do not claim healthy or start the healthy branch. |
| Work is already owned, blocked, unlocated or restricted to protected surfaces | Report the actual reason and appropriate repair/owner route. Zero selected defects does not imply healthy. |
| Research produces a possible improvement | Test it against the declared baseline; retain negative/inconclusive outcomes. Adoption continues through independent review, verification and rollback rules. |
| A historical owner-raised failure recurs | Its registered mechanism detects and corrects it without a new owner prompt before any claim of demonstrated self-improvement. A seeded fixture is synthetic evidence only. |
| Repeated ticks or a concurrent dispatcher | Avoid duplicate research starts and duplicate repair ownership. Preserve immutable decisions and receipts. |
| Dormant lane, unavailable transport or account refusal | Preserve the switch and refusal behavior; do not spend or consume repair attempts as though an account or transport refusal were a defect in the work. |

The inspector currently caches an errored inspection as `already-inspected`; that is a baseline defect to reproduce before repair. The no-change idle loop also needs an explicit freshness policy. Do not add an arbitrary three-inspection abandonment rule: the owner's amendment in `docs/self-repair.md` removed K/M retry abandonment. Use the existing scheduler/global policy and an explicit incomplete state.

An offline first increment may add diagnosis classification, inspection completeness and unsigned research proposals. It must be reported as a partial increment. The complete objective includes the actual research stage and evaluated recursive improvement; it cannot be renamed complete when only candidate generation exists.

## Measuring the assigned agent

For each assignment, retain the source revision, fixed requirement, visible tests, sealed independent holdout digest, role/model identities, result commit and actual command receipts. Record:

- behavior achieved against holdouts, separately from visible-test results;
- escaped defects and severity, including later variants of an already corrected class;
- review rounds, rework and repeated failure classes;
- owner interventions and peer corrections, reported separately;
- measured elapsed time and resource readings; unknown tokens or cost remain unknown.

Passing more tests is insufficient. A first assignment establishes a baseline; an improvement trend requires comparable later assignments. Review of Codex-authored infrastructure is evidence of Claude's review work, not Claude's implementation improvement. Source review, testing, acceptance, merge and release are separate states.

## Execution boundaries and prerequisites

The self-repair mechanism cannot change its own protected outer wheels through the lane. Mechanism changes use an ordinary independently reviewed PR. This document does not alter the signed lane switch, account settings, billing policy or model roles.

Keep the existing owner-approved launch order in PR #89: specialized builders A, then B, then foundry fix 1, then fixes 2–4. No live foundry money before fix 1, and #84 must be merged before those runs. The retained #84 xAI run read 20 source files but ran zero tests and failed its coverage gate after a cancelled write; exit 0 is not review completion. That review remains partial and is not acceptance.
