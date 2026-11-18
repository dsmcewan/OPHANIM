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

test("the worker card's tools are exactly view_file, write_to_file, replace_file_content, run_command", () => {
  assert.deepEqual(cardTools(card), ["view_file", "write_to_file", "replace_file_content", "run_command"]);
  assert.deepEqual(cardTools(card), [...WORKER_CARD_TOOLS]);
  assert.deepEqual(validateCardTools(cardTools(card)), { ok: true, bad: [], why: null });
});

test("the card's text no longer tells the worker to use call_mcp_tool or the deprecated tools; it reaches ask_subagent through the MCP server and has no native subagents", () => {
  const body = card.slice(card.indexOf("\n---\n", 4) + 5);
  for (const bad of AGY_1_5_10_UNKNOWN_OR_DEPRECATED.filter(t => t !== "call_mcp_tool")) assert.doesNotMatch(body, new RegExp(`\`${bad}\``), bad);
  assert.doesNotMatch(body, /"ServerName"|through the built-in `call_mcp_tool`/, "no call_mcp_tool instructions");
  assert.match(body, /`write_to_file`/); assert.match(body, /`replace_file_content`/);
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
  for (const t of ["write_to_file", "replace_file_content", "multi_replace_file_content"]) assert.ok(WRITE_TOOLS.includes(t), t);
  for (const t of ["view_file", "grep_search", "list_dir"]) assert.ok(READ_TOOLS.includes(t), t);
  assert.equal(MCP_WRAPPER, "call_mcp_tool");
});
