# Coach Continuation Owner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assign next-class activation to the planning coach so a verified class commit continues into the prepared following class without another owner prompt.

**Architecture:** Extend the existing role and class protocol rather than adding a runner. The coordinator reports persistence and commit completion; the read-only coach owns the decision to activate the already-prepared package, while existing blocking conditions remain authoritative.

**Tech Stack:** TOML agent definitions, Markdown protocol, Node.js test runner.

**Spec:** `docs/superpowers/specs/2026-11-16-coach-continuation-owner-design.md`

## Global Constraints

- Preserve planner/coach/evaluator/coordinator separation.
- Do not create production, provider, release, merge or spending authority.
- A class commit and matching prepared package are mandatory before continuation.

## Review Focus

- Missing prior commit must block activation.
- A board-head mismatch must block activation.
- Missing following package must block activation.
- Coach activation must not transfer persistence or evaluation authority.
- The next-class prompt must still be preserved before hints.

---

### Task 1: Coach-owned continuation contract

**Files:**
- Modify: `ophanim/tests/learning-roles.test.mjs`
- Modify: `.codex/agents/planning-coach.toml`
- Modify: `docs/planning/PLANNING_COACH.md`
- Modify: `docs/planning/CLASS_PROTOCOL.md`
- Modify: `docs/planning/CLI_HANDOFF.md`

**Interfaces:**
- Consumes: committed class record, current board identity, prepared following package.
- Produces: a coach-owned activation decision with explicit blocking conditions.

- [ ] **Step 1: Write a failing focused test**

Assert that the coach and protocol assign continuation ownership to `planning_coach`, require automatic next-class activation after commit without an owner prompt, preserve role boundaries, and block on missing commit/package or board conflict.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bash -lc 'node ophanim/tests/learning-roles.test.mjs'`

- [ ] **Step 3: Implement the minimal contract changes**

Update the coach card, charter, protocol and CLI handoff. Preserve the already-committed remedial package unchanged; do not add a daemon or broaden authority.

- [ ] **Step 4: Verify GREEN and repository integrity**

Run the focused test, `git diff --check`, TOML parsing and the relevant proof suite.

- [ ] **Step 5: Commit and push the contract change**

Commit the verified change on `docs/planning-fundamentals`, push it to PR #4, and monitor qualification without merging.
