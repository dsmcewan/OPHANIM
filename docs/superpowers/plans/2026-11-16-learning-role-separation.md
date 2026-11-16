# Learning Role Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add independent lesson-planning and class-evaluation roles around the existing terminal planning coach, with a verified commit gate for every completed class.

**Architecture:** Two project-local Codex custom agents remain advisory and read-only. A documented lifecycle connects the lesson planner, existing planning coach, independent evaluator, coordinator, learning board, progress record, and Git commit without creating an automatic learning runner.

**Tech Stack:** Codex custom-agent TOML, Markdown curriculum records, Node test runner, Python `tomllib` for format validation.

**Spec:** `docs/superpowers/specs/2026-11-16-learning-role-separation-design.md`

## Global Constraints

- Keep `planning_coach` as teacher; add `lesson_planner` and its independent twin `class_evaluator` as separate roles that share only the published rubric and evidence vocabulary.
- Specialists are advisory/read-only and inherit parent model and permissions.
- Only the coordinator writes records, transitions the board, and commits.
- Standing owner approval permits uninterrupted completion of the bounded class lifecycle but grants no production, provider, experiment, release or merge authority.
- One active class; no lesson, worker, provider, experiment, or release starts during setup.
- A class is incomplete until evidence, evaluation, next itinerary, next class package, verification, and commit exist.
- Phase 6 uses an assessor independent of planner, teacher, and learner-answer authorship.

## Review Focus

- A planner attempting to grade its own class, or an evaluator receiving the planner's private reasoning/defense, must be expressly forbidden and tested.
- An evaluator attempting to teach or repair an answer must be expressly forbidden and tested.
- Missing next-class preparation or missing commit must leave the class incomplete and be documented.
- Agent TOML must parse, carry required string fields, and avoid model/permission overrides.
- Role discovery must not be confused with role execution or independent filesystem isolation.

---

### Task 1: Pin the separated agent contracts

**Files:**
- Create: `.codex/agents/lesson-planner.toml`
- Create: `.codex/agents/class-evaluator.toml`
- Create: `ophanim/tests/learning-roles.test.mjs`

**Interfaces:**
- Consumes: curriculum and progress documents under `docs/planning/`, plus read-only board snapshots.
- Produces: named `lesson_planner` and `class_evaluator` role definitions with explicit inputs, outputs, refusals, and handoff contracts.

- [ ] **Step 1: Write the failing role-contract test**

Assert both TOMLs parse through Python `tomllib`, expose `name`, `description`, and `developer_instructions` strings, have no model or permission override, preserve read-only coordinator boundaries, and contain the planner/evaluator independence refusals.

- [ ] **Step 2: Run the focused test and verify it fails because the two role files do not exist**

Run: `node --test ophanim/tests/learning-roles.test.mjs`

- [ ] **Step 3: Implement the minimal custom-agent definitions**

Create the two TOMLs using the same standalone project-agent format as `.codex/agents/planning-coach.toml`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `node --test ophanim/tests/learning-roles.test.mjs`

### Task 2: Document the class lifecycle and integrate the handoff

**Files:**
- Create: `docs/planning/LESSON_PLANNER.md`
- Create: `docs/planning/CLASS_EVALUATOR.md`
- Create: `docs/planning/CLASS_PROTOCOL.md`
- Modify: `docs/planning/CLI_HANDOFF.md`
- Modify: `docs/planning/LEARNING_PROGRESS.md`
- Modify: `docs/planning/PLANNING_COACH.md`
- Modify: `docs/planning/BOARD.md`
- Modify: `README.md`
- Modify: `ophanim/tests/learning-roles.test.mjs`

**Interfaces:**
- Consumes: the two agent contracts from Task 1 and the existing coach/board/progress workflow.
- Produces: one explicit planner → teacher → evaluator → coordinator → commit lifecycle and the exact Lesson 1 readiness state.

- [ ] **Step 1: Extend the focused test with failing documentation-link and lifecycle assertions**

Assert all linked files exist and the protocol requires a versioned class package, preserved unassisted attempt, independent evaluation, next itinerary, next class preparation, verification, and commit before completion.

- [ ] **Step 2: Run the focused test and verify the new assertions fail**

Run: `node --test ophanim/tests/learning-roles.test.mjs`

- [ ] **Step 3: Write the role charters and class protocol, then update existing handoffs**

Keep Lesson 1 unattempted, LF-001 ready, later phases blocked, and the current local board free of workers and leases.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `node --test ophanim/tests/learning-roles.test.mjs`

### Task 3: Verify and commit the preparation

**Files:**
- Modify only files listed in Tasks 1–2 plus this plan and its design.

**Interfaces:**
- Consumes: completed role definitions, documentation, tests, and current PR branch.
- Produces: a clean, tested commit on PR #4 with Lesson 1 still unattempted.

- [ ] **Step 1: Run focused and proof verification**

Run: `node --test ophanim/tests/learning-roles.test.mjs`

Run: `OPHANIM_TELOS_ROOT=/home/colchis/Projects/TELOS npm run test:proof`

- [ ] **Step 2: Run repository integrity checks**

Run: `git diff --check`

Run the documented read-only learning-board status query and confirm LF-001 ready, LF-002–LF-006 blocked, no leases, and no occupancy.

- [ ] **Step 3: Review the staged diff and commit before ending**

Commit message: `Add independent lesson planning and class evaluation`
