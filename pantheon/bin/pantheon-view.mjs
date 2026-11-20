#!/usr/bin/env node
// Launch the live view. The vendor SDKs are imported HERE, at the edge, and injected — so
// src/view/server.mjs stays importable in tests with no SDK installed and no credentials.
//
// Usage: pantheon-view [port] [--gemini-api-primary N]. THE GEMINI BILLING POLICY (register L-148; docs/billing-policy.md),
// OFF when absent: an agy_google seat is the metered Gemini API, so its turns run only with --gemini-api-primary N, the
// CUMULATIVE budget of billed Gemini requests counted against everything already recorded for the seats this server
// serves. The policy is enforced HERE, at the provider-call boundary of this process (the client factory the server
// calls for every turn, whoever sent POST /turn): nothing a client sends, no key in the environment, no proxy credential
// and nothing on disk authorizes a request; each start declares its own policy. --metered-gemini-failover N is accepted
// and authorizes nothing (no seat of the view fails over from a lane). The usage record is fixed under the seat home:
// <PANTHEON_HOME>/view/gemini-billing.jsonl (--gemini-usage is refused), and every start, refusal and exit is appended
// to <PANTHEON_HOME>/view/gemini-billing-runs.jsonl.
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import Anthropic from "@anthropic-ai/sdk";
import { join } from "node:path";
import { createViewServer } from "../src/view/server.mjs";
import { makeClient } from "../src/sdk/adapter.mjs";
import { operatorGemini } from "../src/sdk/live.mjs";
import { pantheonHome } from "../src/seat/store.mjs";

const home = pantheonHome();
const gemini = operatorGemini(process.argv.slice(2), { script: "pantheon-view", runDir: () => join(home, "view"), serve: true,
  make: vendor => makeClient(vendor, { OpenAI, GoogleGenAI, Anthropic }) });
const port = Number(gemini.argv[0] ?? process.env.PANTHEON_VIEW_PORT ?? 7777);

// Clients are built lazily, per seat, on first use. Building all four up front would refuse to
// start the whole view because one vendor's credential is missing — the operator should be able
// to watch the three that work and see the fourth report its own error in its own pane.
// A Gemini client is admitted by the policy before it is made, and each of its generation requests is charged on the
// record before it is sent (sdk/live.mjs operatorGemini clientFor); other vendors' clients are made once and reused.
const makeClientFor = (vendor, { model = null, purpose = "view", label = null } = {}) =>
  gemini.clientFor(vendor, { model, purpose: `pantheon-view ${purpose}`, role: label });

const { listen } = createViewServer({ makeClientFor, home });
const addr = await listen(port);
console.log(`pantheon view  http://127.0.0.1:${addr.port}`);
console.log("bound to loopback only: this process holds four vendors' credentials.");
