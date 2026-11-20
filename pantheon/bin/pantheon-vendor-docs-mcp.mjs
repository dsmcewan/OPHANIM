#!/usr/bin/env node
// stdio transport for the MCP server over the captured documentation of the labs.
//
// Thin on purpose: every decision is in src/mcp/vendor-docs-server.mjs, a pure request -> response function tested as
// one. What is here and nowhere else is the framing (one JSON message per line) and the rule that NOTHING but a JSON-RPC
// response may reach stdout; diagnostics go to stderr.
//
// The store is the one `pantheon-vendor-docs capture` fills (default .ophanim-state/vendor-docs beside this repository's
// packages; PANTHEON_VENDOR_DOCS names another). The server reads it and never fills it: a lab not captured says so.
//
// Register with Claude Code:
//   claude mcp add pantheon-vendor-docs -- /usr/bin/node <repo>/pantheon/bin/pantheon-vendor-docs-mcp.mjs
// Register with Codex (~/.codex/config.toml):
//   [mcp_servers.pantheon-vendor-docs]
//   command = "/usr/bin/node"
//   args = ["<repo>/pantheon/bin/pantheon-vendor-docs-mcp.mjs"]
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vendorDocsServerFor } from "../src/mcp/vendor-docs-server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const server = vendorDocsServerFor({ store: process.env.PANTHEON_VENDOR_DOCS || resolve(HERE, "../../.ophanim-state/vendor-docs"), configDir: resolve(HERE, "../src/config") });
const out = line => process.stdout.write(line + "\n");

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", async line => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try { req = JSON.parse(trimmed); }
  catch {
    // A parse error has no id to answer to, so it is reported with the null id JSON-RPC specifies: a malformed frame
    // that is silently dropped looks like a hung server.
    out(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
    return;
  }
  try {
    const res = await server.handle(req);
    if (res) out(JSON.stringify(res));
  } catch (e) {
    process.stderr.write(`pantheon-vendor-docs: ${e?.stack ?? e}\n`);
    if (req?.id !== undefined && req?.id !== null) out(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: String(e?.message ?? e) } }));
  }
});

process.stdin.on("end", () => process.exit(0));
