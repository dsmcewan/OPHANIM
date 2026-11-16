import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { validatePhaseStatus } from "../learning/class-protocol.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const ROLE_FILES = {
  lesson_planner: ".codex/agents/lesson-planner.toml",
  class_evaluator: ".codex/agents/class-evaluator.toml",
};

function parseToml(relativePath) {
  const source = readFileSync(resolve(ROOT, relativePath), "utf8");
  const fields = {};
  for (const key of ["name", "description"]) {
    const match = source.match(new RegExp(`^${key} = "([^"\\n]*)"$`, "m"));
    assert.ok(match, `${relativePath} must define a one-line ${key}`);
    fields[key] = match[1];
  }
  const instructions = source.match(/^developer_instructions = """\n([\s\S]*)\n"""\s*$/m);
  assert.ok(instructions, `${relativePath} must define multiline developer_instructions`);
  fields.developer_instructions = instructions[1];
  for (const match of source.matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)) {
    if (!Object.hasOwn(fields, match[1])) fields[match[1]] = Symbol("declared");
  }
  return fields;
}

test("project learning roles parse as inheriting advisory agents", () => {
  const parsed = Object.fromEntries(
    Object.entries(ROLE_FILES).map(([name, path]) => [name, parseToml(path)]),
  );

  for (const [expectedName, role] of Object.entries(parsed)) {
    assert.equal(role.name, expectedName);
    assert.equal(typeof role.description, "string");
    assert.ok(role.description.length > 20);
    assert.equal(typeof role.developer_instructions, "string");
    assert.ok(role.developer_instructions.length > 500);
    for (const forbidden of [
      "model", "model_reasoning_effort", "sandbox_mode", "approval_mode",
      "approval_policy", "mcp_servers", "skills",
    ]) {
      assert.equal(Object.hasOwn(role, forbidden), false, `${expectedName} must inherit ${forbidden}`);
    }
    assert.match(role.developer_instructions, /read-only advisory/i);
    assert.match(role.developer_instructions, /coordinator (?:alone |only )?(?:writes|persists|records)/i);
    assert.match(role.developer_instructions, /does not create a filesystem security boundary/i);
  }
});

test("the lesson planner prepares one class without teaching or grading it", () => {
  const role = parseToml(ROLE_FILES.lesson_planner);
  const instructions = role.developer_instructions;

  assert.match(instructions, /exactly one versioned (?:next-)?class package/i);
  assert.match(instructions, /published rubric and evidence vocabulary/i);
  assert.match(instructions, /Do not teach/i);
  assert.match(instructions, /Do not evaluate/i);
  assert.match(instructions, /Do not .*answer.*learner/i);
  assert.match(instructions, /class_evaluator/i);
  assert.match(instructions, /private reasoning|private defense/i);
  assert.match(instructions, /next itinerary/i);
  assert.match(instructions, /first class.*does not require.*prior.*evaluation/i);
});

test("the class evaluator is an independent twin that cannot repair or redesign", () => {
  const role = parseToml(ROLE_FILES.class_evaluator);
  const instructions = role.developer_instructions;

  assert.match(instructions, /independent twin/i);
  assert.match(instructions, /same published rubric and evidence vocabulary/i);
  assert.match(instructions, /must not receive.*private reasoning|must not receive.*private defense/i);
  assert.match(instructions, /Do not teach/i);
  assert.match(instructions, /Do not .*repair.*answer/i);
  assert.match(instructions, /Do not (?:create|rewrite|redesign).*class/i);
  assert.match(instructions, /did not plan or teach/i);
  assert.match(instructions, /coached.*unassisted/i);
});

test("the twin definitions are separate files and separate identities", () => {
  const plannerSource = readFileSync(resolve(ROOT, ROLE_FILES.lesson_planner), "utf8");
  const evaluatorSource = readFileSync(resolve(ROOT, ROLE_FILES.class_evaluator), "utf8");
  assert.notEqual(plannerSource, evaluatorSource);
  assert.notEqual(parseToml(ROLE_FILES.lesson_planner).name, parseToml(ROLE_FILES.class_evaluator).name);
});

test("the class protocol closes every class through an independent committed handoff", () => {
  const protocolPath = resolve(ROOT, "docs/planning/CLASS_PROTOCOL.md");
  const protocol = readFileSync(protocolPath, "utf8");

  for (const required of [
    /versioned class package/i,
    /preserved unassisted attempt/i,
    /independent twin evaluation/i,
    /next itinerary/i,
    /following class package|blocked\/stop package/i,
    /repository verification/i,
    /commit .*before.*class.*complete/i,
  ]) assert.match(protocol, required);

  assert.match(protocol, /lesson_planner[^\n]*planning_coach[^\n]*class_evaluator[^\n]*coordinator/i);
  assert.match(protocol, /standing class-scoped approval/i);
  assert.match(protocol, /does not authorize.*production|does not extend.*production/i);
});

test("learning role documentation exists and every local Markdown link resolves", () => {
  const docs = [
    "README.md",
    "docs/planning/LESSON_PLANNER.md",
    "docs/planning/PLANNING_COACH.md",
    "docs/planning/CLASS_EVALUATOR.md",
    "docs/planning/CLASS_PROTOCOL.md",
    "docs/planning/CLI_HANDOFF.md",
    "docs/planning/LEARNING_PROGRESS.md",
    "docs/planning/BOARD.md",
  ];

  for (const relativePath of docs) {
    const absolutePath = resolve(ROOT, relativePath);
    assert.equal(existsSync(absolutePath), true, `${relativePath} must exist`);
    const source = readFileSync(absolutePath, "utf8");
    for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split("#", 1)[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      assert.equal(
        existsSync(resolve(dirname(absolutePath), target)),
        true,
        `${relativePath} link target must exist: ${target}`,
      );
    }
  }
});

test("recurring role verification accepts every recorded educational status", () => {
  for (const status of [
    "not_attempted", "attempted", "needs_revision", "ready_for_independent_check",
    "demonstrated_with_limits", "insufficient_evidence",
  ]) {
    const progress = `| 1. Frame the problem | ${status} | evidence |`;
    assert.deepEqual(validatePhaseStatus(progress, 1), { ok: true, status });
  }
  assert.deepEqual(validatePhaseStatus("| 1. Frame the problem | passed | evidence |", 1), {
    ok: false,
    reason: "unsupported educational status: passed",
  });
});

test("current role setup leaves Lesson 1 ready with a valid progress status", () => {
  const progress = readFileSync(resolve(ROOT, "docs/planning/LEARNING_PROGRESS.md"), "utf8");
  const board = readFileSync(resolve(ROOT, "docs/planning/BOARD.md"), "utf8");
  assert.deepEqual(validatePhaseStatus(progress, 1), { ok: true, status: "not_attempted" });
  assert.match(board, /LF-001 \| Frame the problem \| ready/);
  assert.match(board, /LF-006 \| Demonstrate transfer \| blocked/);
});
