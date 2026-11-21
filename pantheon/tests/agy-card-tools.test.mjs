// The unit worker's role card lists ONLY tool names agy resolves. Observed on agy 1.5.10 (owner's probe 2026-11-18):
// `unknown component: tool "call_mcp_tool" not found in registry`, and grep_search, list_dir, multi_replace_file_content
// "deprecated and has no effect"; that turn hung to its print timeout with zero tool steps (Antigravity's docs warn an
// unmapped tool name in a card's `tools` may hang the subagent process). These tests would catch a bad name creeping
// back into the card, and a validator that stops rejecting one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AGY_1_5_10_UNKNOWN_OR_DEPRECATED, CARD_TEMPLATE, WORKER_CARD_TOOLS, cardTools, validateCardTools } from "../src/agy/workspace.mjs";
import { WRITE_TOOLS, READ_TOOLS, MCP_WRAPPER } from "../src/agy/jail-hook.mjs";

const card = readFileSync(CARD_TEMPLATE, "utf8");

// write_file replaced write_to_file: observed on agy 1.5.10 (first real worker turn, 2026-11-18) the CLI emitted
// write_file {Path, Content} although the card listed write_to_file. A card naming the old tool again would fail here.
test("the worker card's tools are exactly view_file, write_file, replace_file_content, run_command (the names the CLI was observed to use)", () => {
  assert.deepEqual(cardTools(card), ["view_file", "write_file", "replace_file_content", "run_command"]);
  assert.deepEqual(cardTools(card), [...WORKER_CARD_TOOLS]);
  assert.deepEqual(validateCardTools(cardTools(card)), { ok: true, bad: [], why: null });
});

test("the card's text no longer tells the worker to use call_mcp_tool or the deprecated tools; it reaches ask_subagent through the MCP server and has no native subagents", () => {
  const body = card.slice(card.indexOf("\n---\n", 4) + 5);
  for (const bad of AGY_1_5_10_UNKNOWN_OR_DEPRECATED.filter(t => t !== "call_mcp_tool")) assert.doesNotMatch(body, new RegExp(`\`${bad}\``), bad);
  assert.doesNotMatch(body, /"ServerName"|through the built-in `call_mcp_tool`/, "no call_mcp_tool instructions");
  assert.match(body, /`write_file` with `Path` and `Content`/); assert.match(body, /`replace_file_content`/);
  assert.doesNotMatch(body, /`write_to_file`/, "the worker is told the observed tool name");
  assert.doesNotMatch(body, /\(`Cwd`\) set to the worktree/, "run_command has no Cwd: the worker runs the exact verify launcher");
  // Credential isolation: the worker's one command is the unit's verify launcher, not a cd-prefixed command.
  assert.match(body, /ending in\s+`\/pantheon-verify`/);
  assert.doesNotMatch(body, /cd '<your worktree>' &&/);
  assert.match(card.slice(0, card.indexOf("\n---\n", 4)), /# write_file REPLACES write_to_file \(observed on agy 1\.5\.10/, "the decision and its reason are recorded in the frontmatter");
  assert.match(body, /`ask_subagent` that the configured MCP server\s+`pantheon-subagents` provides/);
  assert.match(body, /No native subagents/);
});

test("validateCardTools rejects every name agy 1.5.10 reported unknown or deprecated, and malformed lists", () => {
  assert.deepEqual([...AGY_1_5_10_UNKNOWN_OR_DEPRECATED], ["call_mcp_tool", "grep_search", "list_dir", "multi_replace_file_content"]);
  for (const bad of AGY_1_5_10_UNKNOWN_OR_DEPRECATED) {
    const v = validateCardTools([...WORKER_CARD_TOOLS, bad]);
    assert.deepEqual([v.ok, v.bad], [false, [bad]], bad);
    assert.match(v.why, /agy 1\.5\.10/);
  }
  assert.equal(validateCardTools([]).ok, false);
  assert.equal(validateCardTools(null).ok, false);
  assert.equal(validateCardTools(["view_file", "view_file"]).ok, false);
  assert.equal(validateCardTools(["view file"]).ok, false);
  // The parser reads quoted names too, so quoting cannot smuggle a bad name past the validator.
  assert.deepEqual(validateCardTools(cardTools('---\nname: x\ntools: ["view_file", \'call_mcp_tool\']\n---\n')).bad, ["call_mcp_tool"]);
  assert.equal(cardTools("no frontmatter"), null);
});

test("the jail hook still accepts every spelling (harmless: it decides per call)", () => {
  for (const t of ["write_file", "write_to_file", "replace_file_content", "multi_replace_file_content"]) assert.ok(WRITE_TOOLS.includes(t), t);
  for (const t of ["view_file", "grep_search", "list_dir"]) assert.ok(READ_TOOLS.includes(t), t);
  assert.equal(MCP_WRAPPER, "call_mcp_tool");
});

// Assignment 3 Antigravity run, read_file (findings-3-google-77480d6): agy 1.5.11 advertised read_file as its only file
// reader whatever the card listed, and the hook denied it. The hook accepts it as a read tool for every card (worker and
// reviewer share the hook). The CARDS do not list it: it was never observed resolving as a card component, and an
// unmapped card name may hang the subagent process (the reason this file exists); the card list is not an allowlist.
test("read_file is a read tool of the jail hook (agy 1.5.11), and the cards keep only names observed to resolve", () => {
  assert.ok(READ_TOOLS.includes("read_file"));
  assert.ok(!WRITE_TOOLS.includes("read_file"));
  assert.ok(!cardTools(card).includes("read_file"));
  const reviewer = readFileSync(new URL("../.agents/agents/pantheon-reviewer-agent/agent.md", import.meta.url), "utf8");
  assert.deepEqual(validateCardTools(cardTools(reviewer)), { ok: true, bad: [], why: null });
  assert.ok(!cardTools(reviewer).includes("read_file"));
});
