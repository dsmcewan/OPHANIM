// Adversarial probes against the PreToolUse hook's decide() at af0dc30. No bwrap needed: decide() is pure.
// PASS here means "the hook behaves as the fix claims" (fail-closed / laundering-denied / etc.).
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, verifyCmdProblem, writePathArgsOf } from "/home/user/OPHANIM/.claude/worktrees/agent-a7145b44b407643ee/pantheon/src/agy/jail-hook.mjs";

const wt = mkdtempSync(join(tmpdir(), "repro-wt-"));
mkdirSync(join(wt, "src"), { recursive: true });
writeFileSync(join(wt, "src", "owned.mjs"), "x");
writeFileSync(join(wt, "src", "other.mjs"), "x");
const ctl = mkdtempSync(join(tmpdir(), "repro-ctl-"));
const policy = { worktree: wt, worktree_given: wt, control_dir: ctl, unit_id: "u1",
  owned_paths: ["src/owned.mjs"], roles: ["typescript"], verify_cmd: "node --test",
  worker_verify_cmd: join(ctl, "pantheon-verify") };

const tc = (name, args) => ({ toolCall: { name, args } });
const show = (label, d) => console.log(`${d.decision === "deny" ? "DENY" : "APPROVE"}  ${label}  :: ${d.reason}`);

// Q2: laundering — owned Path + unowned TargetFile must be DENIED (conflicting targets).
show("write laundering {Path owned, TargetFile unowned}",
  decide(policy, tc("write_file", { Path: join(wt, "src", "owned.mjs"), TargetFile: join(wt, "src", "other.mjs"), Content: "x" })));
// Q2: nested path-like key also checked
show("write nested {Path owned, extra.DestinationPath unowned}",
  decide(policy, tc("replace_file_content", { Path: join(wt, "src", "owned.mjs"), DestinationPath: join(wt, "src", "other.mjs") })));
// Q2: traversal refused before normalization
show("write traversal {Path with ..}",
  decide(policy, tc("write_file", { Path: join(wt, "src", "..", "src", "owned.mjs"), Content: "x" })));
// Q4: MCP — invoke_subagent hard deny, define_subagent hard deny
show("invoke_subagent", decide(policy, tc("invoke_subagent", {})));
show("define_subagent", decide(policy, tc("define_subagent", {})));
// Q4: unknown MCP server denied
show("call_mcp_tool other server", decide(policy, tc("call_mcp_tool", { ServerName: "evil", ToolName: "ask_subagent", Arguments: { role: "typescript", question: "q" } })));
// Q4: ask_subagent allowed role approved
show("ask_subagent allowed role", decide(policy, tc("call_mcp_tool", { ServerName: "pantheon-subagents", ToolName: "ask_subagent", Arguments: { role: "typescript", question: "q" } })));
// Q4: ask_subagent disallowed role denied
show("ask_subagent bad role", decide(policy, tc("call_mcp_tool", { ServerName: "pantheon-subagents", ToolName: "ask_subagent", Arguments: { role: "root", question: "q" } })));
// Q3: command — only the exact launcher approved
show("run_command exact launcher", decide(policy, tc("run_command", { CommandLine: join(ctl, "pantheon-verify") })));
show("run_command plain verify_cmd (denied)", decide(policy, tc("run_command", { CommandLine: "node --test" })));
show("run_command launcher + ; rm", decide(policy, tc("run_command", { CommandLine: join(ctl, "pantheon-verify") + " ; rm -rf /" })));
// Q1: unknown/newly-advertised tool denied; malformed denied
show("unknown tool newToolX", decide(policy, tc("newToolX", { Path: join(wt, "src", "owned.mjs") })));
show("malformed (no toolCall)", decide({ ...policy }, { nonsense: true }));
show("read of control dir (token)", decide(policy, tc("view_file", { Path: join(ctl, ".agents", "mcp_config.json") })));

// Q3: verify_cmd safe-form constraint
for (const c of ["node --test", "test -f a && ! grep -q x b", "sh -c 'echo hi'", "a; rm -rf /", "a | b", "a && $(evil)", "echo `id`"])
  console.log(`verifyCmdProblem(${JSON.stringify(c)}) = ${JSON.stringify(verifyCmdProblem(c))}`);
