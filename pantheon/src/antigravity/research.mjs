// THE RESEARCH TEAM (owner direction 2026-11-20: the Carbon 4 research and exploration team). The controller's side.
//
// A research team answers ONE question for one of the investigation roles (scout, explorer, researcher). Its
// COORDINATOR is that role's seat (route/fit-matrix.mjs researchSeat: gemini-4-carbon first); its SPECIALISTS are the
// subordinate seat (gemini-4-hydrogen). Every member is its own READ-ONLY session of the Antigravity SDK transport
// (turn.mjs, research mode), run by the caller's `runNode`; this module runs no session and calls no provider. It
// decides, in code:
//
//   WHO MAY BE DELEGATED TO   A delegation is the coordinator's request, admitted by the controller. Hydrogen does not
//                             delegate (the existing rule, subagents.mjs): a specialist REPORTS its open questions and
//                             recommended next steps, and the coordinator, shown them, asks for the next level. Every
//                             level below the coordinator is therefore opened here, never by a subordinate.
//   DEPTH                     The coordinator is level 1. A delegation that pursues an open question of a node at level d
//                             is level d + 1, and names that node as its parent. Level limits.max_depth + 1 is refused
//                             (RESEARCH_DEPTH_EXCEEDED). The limit is a ceiling: a level exists only for a named gap.
//   JUSTIFICATION             A delegation names an open question of its parent's own report (`addresses`), a question,
//                             a specialty, a scope inside the team's, read tools, bounds within the node bounds, the
//                             evidence expected and why the gap matters. Anything else is refused and recorded.
//   CONCURRENCY               At most limits.max_active specialists run at once: the coordinator model's existing subagent
//                             ceiling (Carbon 8). The rest wait for a slot. Depth is not concurrency.
//   THE REQUEST BUDGET        Every billed request of every member passes `admit` here first: the team's own bound
//                             (limits.max_requests, shared by concurrent and nested members), then the caller's `admit`
//                             (the billing policy and the stage's bound: charge before send is theirs).
//   EVIDENCE                  A member's answer is a report of seven parts (REPORT_PARTS). It may cite only sources the
//                             controller saw that session examine (turn.mjs `examined`: a file by the digest of its
//                             bytes), or, for the coordinator, sources a finished member examined. The version of each
//                             cited source is the controller's, not the model's. A report that fails is a failed node:
//                             nothing of it is taken as a finding.
//   WHAT GOES UP              The coordinator is shown each member's findings concisely, each with its source and
//                             version, bounded in bytes; the full report stays on the node's record (the caller stores it).
//   KNOWLEDGE                 The same claim from the same source and version is ONE piece of evidence, naming every node
//                             that examined it; the same claim from another source is a second piece.
//   TERMINATION               The coordinator says when the question is answered (`satisfied`). The team also ends when
//                             nothing admissible is left to ask, at the round bound, on a refused charge, or when stopped.
//   IDENTITY AND RECOVERY     A node's id is a function of the team, its parent, the gap and the question. It is recorded
//                             as admitted BEFORE its session starts. A stopped team keeps every finished node; a team
//                             resumed with those records does not run them again.
//
// Must never: let a subordinate open a level; run a node that was not admitted; take a claim from a report that was
// refused; count a request the caller refused; or report the model asked for as the model that answered.
import { createHash } from "node:crypto";
import { RESEARCH, RESEARCH_SPECIALTIES, SDK_READ_TOOLS } from "./config.mjs";

export const RESEARCH_TEAM_SCHEMA = "pantheon.research-team/v1";
export const REPORT_PARTS = Object.freeze(["question", "sources", "observations", "hypotheses", "dependencies", "unresolved", "next"]);
const str = v => typeof v === "string" && v.trim() !== "";
const list = v => (Array.isArray(v) ? v : []);
const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
const sha = text => createHash("sha256").update(text).digest("hex");
const refusal = (code, reason, more = {}) => ({ code, reason: String(reason).slice(0, 500), ...more });
const short = v => (str(v) ? v.slice(0, 19) : "unversioned");

/** A node's identity: the team, the node it descends from, the open question it pursues, and its own question. */
export const nodeId = ({ team, parent = null, addresses = null, question }) => "rn-" + sha(JSON.stringify([team, parent, addresses, String(question ?? "").trim()])).slice(0, 16);

/** The object a session answered with, or null: its structured output, or the JSON object in its text. */
export function parseReport(answer) {
  if (plain(answer)) return answer;
  if (typeof answer !== "string") return null;
  const a = answer.indexOf("{"), b = answer.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { const j = JSON.parse(answer.slice(a, b + 1)); return plain(j) ? j : null; } catch { return null; }
}

/**
 * Why a report is not accepted (a list, empty when it is). `examined` is what the controller saw the node examine;
 * `known` (the coordinator's) is the sources finished members examined: Map ref -> version.
 */
export function reportRefusal(report, { examined = [], coordinator = false, known = new Map() } = {}) {
  if (!plain(report)) return ["the answer is not a JSON object"];
  const why = [];
  for (const k of REPORT_PARTS) {
    if (k === "question") { if (!str(report.question)) why.push("the report has no question (the question it investigated, as text)"); }
    else if (!Array.isArray(report[k])) why.push(`the report has no ${k} (a list, empty when there is none)`);
  }
  if (why.length) return why;
  const seen = new Map(known);
  for (const e of examined) seen.set(e.path, e.sha256 ?? null);
  const refs = new Set();
  for (const s of report.sources) {
    const ref = plain(s) ? s.ref : s;
    if (!str(ref)) { why.push("a source has no ref (the path examined)"); continue; }
    if (!seen.has(ref)) { why.push(`the report cites ${ref}, which this node never examined`); continue; }
    if (plain(s) && s.version != null && s.version !== seen.get(ref)) why.push(`the report gives ${ref} a version (${short(s.version)}) that is not the one examined (${short(seen.get(ref))})`);
    refs.add(ref);
  }
  const ids = new Set();
  for (const o of report.observations) {
    if (!plain(o) || !str(o.id) || !str(o.text)) { why.push("an observation is {id, text, sources}"); continue; }
    ids.add(o.id);
    if (!list(o.sources).length) why.push(`observation ${o.id} names no source: a finding is what a source shows`);
    for (const r of list(o.sources)) if (!refs.has(r)) why.push(`observation ${o.id} cites ${r}, which is not among the report's sources`);
  }
  for (const h of report.hypotheses) {
    if (!plain(h) || !str(h.id) || !str(h.text)) { why.push("a hypothesis is {id, text, supports, contradicts}"); continue; }
    for (const r of [...list(h.supports), ...list(h.contradicts)]) if (!ids.has(r)) why.push(`hypothesis ${h.id} refers to ${r}, which is not one of its observations`);
  }
  for (const d of report.dependencies) if (!plain(d) || !str(d.from) || !str(d.to)) why.push("a dependency is {from, to, kind, contract?, sources}");
  const open = new Set();
  for (const u of report.unresolved) { if (!plain(u) || !str(u.id) || !str(u.question)) why.push("an unresolved question is {id, question, why}"); else open.add(u.id); }
  for (const n of report.next) {
    if (!plain(n) || !str(n.question)) { why.push("a next step is {addresses, question}"); continue; }
    if (!open.has(n.addresses)) why.push(`a next step addresses ${n.addresses}, which is not one of its unresolved questions`);
  }
  if (coordinator && !(Array.isArray(report.delegations) && typeof report.satisfied === "boolean" && typeof report.material === "boolean" && str(report.summary))) {
    why.push("a coordinator also answers delegations (a list), satisfied and material (true or false) and summary (text)");
  }
  return why;
}

const claimKey = text => sha(String(text).toLowerCase().replace(/\s+/g, " ").trim());
const REPORT_CONTRACT = [
  "Answer with ONE JSON object and nothing else:",
  ' {"question": the question you investigated,',
  '  "sources": [{"ref": a path you actually read}],',
  '  "observations": [{"id": "o1", "text": what the source shows, "sources": [refs]}],',
  '  "hypotheses": [{"id": "h1", "text": ..., "supports": [observation ids], "contradicts": [observation ids], "status": "supported" | "contradicted" | "open"}],',
  '  "dependencies": [{"from": ..., "to": ..., "kind": ..., "contract": the contract affected or null, "sources": [refs]}],',
  '  "unresolved": [{"id": "u1", "question": what you could not establish, "why": what limited the evidence}],',
  '  "next": [{"addresses": an unresolved id, "question": the investigation or planning obligation you recommend}]}',
  "Every list is present, empty when there is nothing. Cite only what you read: a source you did not read is refused, and so is a finding with no source.",
].join("\n");

/** One member's findings as the coordinator is shown them: concise, each with its source and version, bounded in bytes. */
export function conciseFinding(node, bytes = RESEARCH.bounds.finding_bytes) {
  const head = `- node ${node.id} (level ${node.depth}${node.specialty ? `, ${node.specialty}` : ""}, ${node.seat.model}): ${node.question}`;
  if (node.state !== "finished") return `${head}\n  state: ${node.state}${node.error ? ` (${node.error.code}: ${list(node.error.why).join("; ") || node.error.message || ""})` : ""}`.slice(0, bytes);
  const v = new Map(node.report.sources.map(s => [s.ref, s.version]));
  const lines = [head];
  const rows = [
    ...node.report.observations.map(o => `  ${o.id}: ${o.text} [${o.sources.map(r => `${r}@${short(v.get(r))}`).join(", ")}]`),
    ...node.report.hypotheses.map(h => `  ${h.id} (${h.status ?? "open"}): ${h.text}${list(h.supports).length ? ` supported by ${h.supports.join(", ")}` : ""}${list(h.contradicts).length ? ` contradicted by ${h.contradicts.join(", ")}` : ""}`),
    ...node.report.dependencies.map(d => `  depends: ${d.from} -> ${d.to}${d.kind ? ` (${d.kind})` : ""}${d.contract ? `; contract: ${d.contract}` : ""}`),
    ...node.report.unresolved.map(u => `  open ${u.id}: ${u.question}${u.why ? ` (${u.why})` : ""}`),
    ...node.report.next.map(n => `  next for ${n.addresses}: ${n.question}`),
  ];
  let used = Buffer.byteLength(head, "utf8"), kept = 0;
  for (const r of rows) { const b = Buffer.byteLength(r, "utf8") + 1; if (used + b > bytes) break; lines.push(r); used += b; kept += 1; }
  if (kept < rows.length) lines.push(`  (+${rows.length - kept} more line(s) in the stored report of ${node.id})`);
  return lines.join("\n");
}

function coordinatorPrompt({ team, limits, round, root, fresh, created }) {
  const role = RESEARCH.roles[team.role];
  return [
    `ROLE: ${team.role}. ${role.charter}`,
    `You coordinate a read-only research team. You may read the repository yourself, and you may ask the controller to delegate bounded questions to specialists. You change nothing and you run nothing.`,
    "", `QUESTION: ${team.question}`, `SCOPE (paths inside the repository): ${team.scope.join(", ")}`, `TRIGGER: ${team.trigger}`,
    ...(str(team.context) ? ["", "WHAT IS ALREADY KNOWN (the controller's initial view):", team.context] : []),
    "", `ROUND ${round} of at most ${limits.coordinator_rounds}. Your node id is ${root}. Specialists created so far: ${created} of at most ${limits.max_nodes}; at most ${limits.max_active} run at once.`,
    `DEPTH: you are level 1. A delegation that pursues an open question of a node at level d is level d + 1, at most level ${limits.max_depth}. Open a level only for a specific evidence gap; stop when the question is answered.`,
    ...(fresh.length ? ["", "FINDINGS RETURNED SINCE YOUR LAST ROUND (the full reports are stored; these are their findings, with sources and versions):", ...fresh] : []),
    "", REPORT_CONTRACT.replace(/\}$/, ","),
    '  "delegations": [{"parent": the node whose open question this pursues (omit for your own), "addresses": that open question\'s id, "question": ..., "specialty": one of ' + RESEARCH_SPECIALTIES.join(" | ") + ',',
    '                   "scope": [paths inside the team\'s scope], "expected_evidence": what a good answer shows, "why": why the gap matters}],',
    '  "satisfied": true when the question is answered and nothing more is needed, "material": true when what was found changes what a plan should rest on, "summary": the answer so far}',
  ].join("\n");
}
function specialistPrompt({ team, node, gap }) {
  return [
    `ROLE: research specialist (${node.specialty}). ${RESEARCH.specialties[node.specialty]}`,
    "You read the repository; you change nothing, run nothing and delegate nothing. If more investigation is needed, say so in `unresolved` and `next`: the coordinator decides.",
    "", `QUESTION: ${node.question}`, `IT PURSUES: ${gap.id}: ${gap.question}${gap.why ? ` (${gap.why})` : ""}`, `WHY IT MATTERS: ${node.why}`, `EVIDENCE EXPECTED: ${node.expected_evidence}`,
    `SCOPE (paths inside the repository): ${node.scope.join(", ")}`, `TOOLS: ${node.tools.join(", ")}`, `BOUNDS: at most ${node.bounds.model_calls} model calls and ${node.bounds.tool_calls} tool calls.`,
    `THE TEAM'S QUESTION, for context only: ${team.question}`, "", REPORT_CONTRACT,
  ].join("\n");
}

/**
 * Run one research team. See the header.
 *   team         {id, role, trigger, question, scope: [paths], item?, head?, context?}
 *   coordinator  {seat, selection} (fit-matrix.mjs researchSeat)        subordinate  the specialists' seat
 *   limits       fit-matrix.mjs researchLimits(coordinator model), with any override
 *   runNode      async ({node, prompt, seat, signal, admit, bounds}) -> {text | structured_output, examined, served_model,
 *                served_model_source, usage}; throws when the session failed
 *   admit        the caller's charge for one billed request ({class, model, node, team, role, kind, depth}); throws to refuse
 *   record       async (event) -> void: {event: "team" | "node" | "refusal" | "conclusion", ...}, in order
 *   resume       node records of an earlier run of this team: finished ones are reused, not run
 * Returns the team's record.
 */
export async function runResearchTeam({ team, coordinator, subordinate, limits, runNode, admit: charge = () => {}, record = async () => {}, resume = [], signal = null, now = () => new Date().toISOString() }) {
  if (!plain(team) || !str(team.id) || !str(team.question) || !Object.hasOwn(RESEARCH.roles, String(team.role))) throw new Error("runResearchTeam: pass team {id, role, question, scope}");
  if (!Array.isArray(team.scope) || !team.scope.length) throw new Error("runResearchTeam: the team has a scope (paths inside the repository)");
  if (!str(coordinator?.seat?.model) || !str(subordinate?.model) || typeof runNode !== "function") throw new Error("runResearchTeam: pass the coordinator's seat, the subordinate seat and runNode");
  for (const k of ["max_depth", "max_nodes", "max_requests", "node_model_calls", "node_tool_calls", "node_timeout_s", "coordinator_rounds", "finding_bytes", "min_question_chars"]) {
    if (!Number.isInteger(limits?.[k]) || limits[k] < 1) throw new Error(`runResearchTeam: limits.${k} is a positive whole number`);
  }
  if (!Number.isInteger(limits.max_active) || limits.max_active < 0) throw new Error("runResearchTeam: limits.max_active is a whole number");
  if (limits.max_depth > RESEARCH.max_depth) throw new Error(`runResearchTeam: limits.max_depth is at most ${RESEARCH.max_depth}`);

  const root = nodeId({ team: team.id, parent: null, addresses: null, question: team.question });
  const nodes = [], refusals = [], byId = new Map();
  const requests = { total: 0, by_model: {} }, tokens = { total: 0, by_model: {} };
  const knowledge = new Map(), known = new Map();
  const prior = new Map(resume.filter(n => n?.state === "finished").map(n => [n.kind === "coordinator" ? `${n.id}#${n.round}` : n.id, n]));
  let active = 0, peak = 0, created = 0, reused = 0, depthReached = 1, budgetStop = false, callerStop = null;
  const aborted = () => signal?.aborted === true;
  const nodeBounds = { model_calls: limits.node_model_calls, tool_calls: limits.node_tool_calls, timeout_s: limits.node_timeout_s };

  const emit = async ev => { await record({ ...ev, team: team.id, at: now() }); };
  const publicNode = n => { const { _refused, ...rest } = n; return rest; };
  const refuse = async (r) => { refusals.push(r); await emit({ event: "refusal", refusal: r }); };

  // EVERY BILLED REQUEST: the team's own bound first, then the caller's charge; counted only when both let it through.
  const admitFor = node => (info = {}) => {
    if (requests.total >= limits.max_requests) {
      budgetStop = true;
      node._refused = "RESEARCH_REQUEST_BUDGET";
      throw Object.assign(new Error(`RESEARCH_REQUEST_BUDGET: the team's request budget (${limits.max_requests}) is spent; the request is not sent`), { code: "RESEARCH_REQUEST_BUDGET" });
    }
    const model = str(info.model) ? info.model : node.seat.model;
    try { charge({ ...info, model, node: node.id, team: team.id, role: team.role, kind: node.kind, depth: node.depth }); }
    catch (e) { callerStop ??= e; node._refused = e?.code ?? "CHARGE_REFUSED"; throw e; }
    requests.total += 1; requests.by_model[model] = (requests.by_model[model] ?? 0) + 1; node.usage.requests += 1;
  };

  const absorb = node => {
    for (const s of node.report.sources) known.set(s.ref, s.version);
    const v = new Map(node.report.sources.map(s => [s.ref, s.version]));
    for (const o of node.report.observations) {
      const key = claimKey(o.text);
      const entry = knowledge.get(key) ?? { text: o.text.replace(/\s+/g, " ").trim(), evidence: [] };
      for (const ref of o.sources) {
        const at = entry.evidence.find(e => e.ref === ref && e.version === v.get(ref));
        if (at) { if (!at.nodes.includes(node.id)) at.nodes.push(node.id); }
        else entry.evidence.push({ ref, version: v.get(ref) ?? null, nodes: [node.id] });
      }
      knowledge.set(key, entry);
    }
  };

  /** Run one admitted node's session and settle its record. */
  const runOne = async (node, prompt) => {
    if (aborted()) { node.state = "cancelled"; node.error = { code: "ABORTED", message: "the team was stopped before this node started" }; await emit({ event: "node", node: publicNode(node) }); return node; }
    node.state = "running"; node.started_at = now();
    try {
      const r = await runNode({ node: publicNode(node), prompt, seat: node.seat, signal, admit: admitFor(node), bounds: node.bounds });
      node.served_model = r?.served_model ?? null; node.served_model_source = r?.served_model_source ?? (r?.served_model ? "unknown" : null);
      node.usage.tokens = r?.usage?.total_token_count ?? 0;
      tokens.total += node.usage.tokens; tokens.by_model[node.seat.model] = (tokens.by_model[node.seat.model] ?? 0) + node.usage.tokens;
      node.examined = list(r?.examined).map(e => ({ tool: e.tool ?? null, path: e.path, kind: e.kind ?? "file", sha256: e.sha256 ?? null, bytes: e.bytes ?? null }));
      const report = parseReport(r?.structured_output ?? r?.text);
      const why = reportRefusal(report, { examined: node.examined, coordinator: node.kind === "coordinator", known });
      if (why.length) { node.state = "failed"; node.error = { code: "INVALID_REPORT", why }; }
      else {
        const versions = new Map([...known, ...node.examined.map(e => [e.path, e.sha256 ?? null])]);
        node.report = { ...report, sources: report.sources.map(s => { const ref = plain(s) ? s.ref : s; return { ref, version: versions.get(ref) ?? null }; }) };
        node.state = "finished";
        absorb(node);
      }
    } catch (e) {
      const stopped = aborted();
      node.state = stopped ? "cancelled" : "failed";
      node.error = { code: stopped ? "ABORTED" : node._refused ?? e?.code ?? "NODE_FAILED", message: String(e?.message ?? e).slice(0, 400) };
    }
    node.ended_at = now();
    await emit({ event: "node", node: publicNode(node) });
    return node;
  };

  /** The controller's decision on one delegation the coordinator asked for: the admitted node, or null (refused and recorded). */
  const admitDelegation = async (d, round) => {
    const base = { round, parent: str(d?.parent) ? d.parent : root, question: str(d?.question) ? d.question.slice(0, 200) : null };
    const no = (code, reason, more = {}) => refuse(refusal(code, reason, { ...base, ...more })).then(() => null);
    if (!plain(d)) return no("RESEARCH_UNJUSTIFIED", "a delegation is {addresses, question, specialty, scope, expected_evidence, why}");
    const parent = base.parent === root ? rootState : byId.get(base.parent);
    if (!parent || parent.state !== "finished") return no("RESEARCH_PARENT_UNKNOWN", `the delegation names a parent (${base.parent}) that is not a finished node of this team`);
    const depth = parent.depth + 1;
    if (depth > limits.max_depth) return no("RESEARCH_DEPTH_EXCEEDED", `level ${depth} was asked for under node ${parent.id} at level ${parent.depth}: a research team is at most ${limits.max_depth} levels deep`, { attempted_depth: depth });
    if (limits.max_active < 1) return no("RESEARCH_NO_SUBORDINATES", `a coordinator on ${coordinator.seat.model} delegates to none (its subagent ceiling is 0): the restriction is not relaxed for research`);
    const gap = list(parent.report?.unresolved).find(u => u.id === d.addresses);
    if (!gap) return no("RESEARCH_UNJUSTIFIED", `the delegation names no open question of its parent (${d.addresses ?? "none given"}): a level is opened only for a specific evidence gap`);
    if (!str(d.question) || d.question.trim().length < limits.min_question_chars) return no("RESEARCH_UNJUSTIFIED", `a delegation has a question of at least ${limits.min_question_chars} characters`);
    if (!str(d.expected_evidence)) return no("RESEARCH_UNJUSTIFIED", "a delegation says what expected evidence would answer it");
    if (!str(d.why)) return no("RESEARCH_UNJUSTIFIED", "a delegation says why the gap matters");
    if (!RESEARCH_SPECIALTIES.includes(d.specialty)) return no("RESEARCH_SPECIALTY", `"${d.specialty}" is not a research specialty (${RESEARCH_SPECIALTIES.join(", ")})`);
    const scope = d.scope === undefined ? [...parent.scope] : d.scope;
    if (!Array.isArray(scope) || !scope.length) return no("RESEARCH_SCOPE", "a delegation's scope is a list of paths inside the team's scope");
    for (const p of scope) {
      if (!str(p) || p.startsWith("/") || p.split("/").includes("..")) return no("RESEARCH_SCOPE", `${p} is not a path inside the repository`);
      if (!team.scope.some(s => s === "." || p === s || p.startsWith(s.endsWith("/") ? s : s + "/"))) return no("RESEARCH_SCOPE", `${p} is outside the team's scope (${team.scope.join(", ")})`);
    }
    const tools = d.tools === undefined ? [...RESEARCH.tools] : d.tools;
    const badTool = !Array.isArray(tools) || !tools.length ? "(none)" : tools.find(t => !RESEARCH.tools.includes(t) || !SDK_READ_TOOLS.includes(t));
    if (badTool) return no("RESEARCH_TOOLS", `${badTool} is not a tool a research specialist may be given (${RESEARCH.tools.join(", ")})`);
    const bounds = { ...nodeBounds };
    for (const k of ["model_calls", "tool_calls", "timeout_s"]) {
      if (d.bounds?.[k] === undefined) continue;
      if (!Number.isInteger(d.bounds[k]) || d.bounds[k] < 1 || d.bounds[k] > nodeBounds[k]) return no("RESEARCH_BOUNDS", `bounds.${k} is a whole number from 1 to ${nodeBounds[k]}`);
      bounds[k] = d.bounds[k];
    }
    const id = nodeId({ team: team.id, parent: parent.id, addresses: gap.id, question: d.question });
    if (byId.has(id)) return no("RESEARCH_DUPLICATE", `the same question was already delegated for ${gap.id} of ${parent.id} (node ${id})`, { node: id });
    if (created >= limits.max_nodes) return no("RESEARCH_NODE_BUDGET", `the team has created its ${limits.max_nodes} specialists`);
    const node = { id, team: team.id, kind: "specialist", round, parent: parent.id, depth, specialty: d.specialty, seat: { ...subordinate }, question: d.question.trim(), addresses: gap.id, scope: [...scope], tools: [...tools], bounds,
      expected_evidence: d.expected_evidence.trim(), why: d.why.trim(), state: "admitted", admitted_at: now(), usage: { requests: 0, tokens: 0 } };
    byId.set(id, node); nodes.push(node); created += 1; depthReached = Math.max(depthReached, depth);
    const done = prior.get(id);
    if (done) {
      Object.assign(node, { state: "finished", report: done.report, examined: done.examined ?? [], served_model: done.served_model ?? null, served_model_source: done.served_model_source ?? null, usage: done.usage ?? node.usage, reused: true });
      reused += 1; absorb(node);
      return node;
    }
    await emit({ event: "node", node: publicNode(node) });   // PERSISTENT BEFORE IT RUNS
    return { ...node, _gap: gap, _live: node };
  };

  await emit({ event: "team", role: team.role, trigger: team.trigger, question: team.question, scope: team.scope, coordinator: { ...coordinator.seat }, subordinate: { ...subordinate }, selection: coordinator.selection ?? null,
    limits: { max_depth: limits.max_depth, max_active: limits.max_active, max_nodes: limits.max_nodes, max_requests: limits.max_requests, coordinator_rounds: limits.coordinator_rounds }, root, ...(resume.length ? { resumed_from: resume.length } : {}) });

  let rootState = null, status = null, stop_reason = null, rounds = 0, fresh = [];
  for (let round = 1; ; round++) {
    if (aborted()) { status = "cancelled"; stop_reason = "ABORTED"; break; }
    if (round > limits.coordinator_rounds) { status = "stopped"; stop_reason = "ROUND_LIMIT"; break; }
    const c = { id: root, team: team.id, kind: "coordinator", round, parent: null, depth: 1, specialty: null, seat: { ...coordinator.seat }, question: team.question, scope: [...team.scope], tools: [...RESEARCH.tools], bounds: { ...nodeBounds },
      state: "admitted", admitted_at: now(), usage: { requests: 0, tokens: 0 } };
    nodes.push(c);
    const done = prior.get(`${root}#${round}`);
    if (done) { Object.assign(c, { state: "finished", report: done.report, examined: done.examined ?? [], served_model: done.served_model ?? null, served_model_source: done.served_model_source ?? null, usage: done.usage ?? c.usage, reused: true }); reused += 1; absorb(c); }
    else {
      await emit({ event: "node", node: publicNode(c) });
      await runOne(c, coordinatorPrompt({ team, limits, round, root, fresh, created }));
      rounds += 1;
    }
    if (c.state !== "finished") {
      if (c.state === "cancelled" || aborted()) { status = "cancelled"; stop_reason = "ABORTED"; }
      else if (callerStop) { status = "stopped"; stop_reason = callerStop.code ?? "CHARGE_REFUSED"; }
      else if (budgetStop) { status = "stopped"; stop_reason = "RESEARCH_REQUEST_BUDGET"; }
      else { status = "failed"; stop_reason = c.error?.code ?? "COORDINATOR_FAILED"; }
      break;
    }
    rootState = c;
    if (c.report.satisfied) { status = "satisfied"; stop_reason = "SATISFIED"; break; }
    const admitted = [];
    for (const d of c.report.delegations) { const n = await admitDelegation(d, round); if (n) admitted.push(n); }
    const toRun = admitted.filter(n => n._live);
    if (!admitted.length) { status = "exhausted"; stop_reason = "NOTHING_ADMISSIBLE"; break; }
    // THE POOL: at most limits.max_active specialists at once; the rest wait for a slot.
    let next = 0;
    const worker = async () => {
      while (next < toRun.length) {
        const job = toRun[next++], node = job._live;
        active += 1; peak = Math.max(peak, active);
        try { await runOne(node, specialistPrompt({ team, node, gap: job._gap })); } finally { active -= 1; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limits.max_active, toRun.length) }, worker));
    fresh = admitted.map(n => conciseFinding(n._live ?? n, limits.finding_bytes));
    if (aborted()) { status = "cancelled"; stop_reason = "ABORTED"; break; }
    if (callerStop) { status = "stopped"; stop_reason = callerStop.code ?? "CHARGE_REFUSED"; break; }
    if (budgetStop) { status = "stopped"; stop_reason = "RESEARCH_REQUEST_BUDGET"; break; }
  }

  const out = nodes.map(publicNode);
  const final = [...out].reverse().find(n => n.kind === "coordinator" && n.state === "finished") ?? null;
  const contributors = [];
  for (const n of out) {
    if (n.state !== "finished" && !n.served_model) continue;
    const served = n.served_model ?? null;
    if (contributors.some(c => c.node === n.id && c.served_model === served)) continue;
    contributors.push({ node: n.id, kind: n.kind, depth: n.depth, parent: n.parent, requested_model: n.seat.model, served_model: served, served_model_source: n.served_model_source ?? null, vendor: n.seat.vendor ?? null });
  }
  const by = (arr, key) => arr.reduce((m, x) => { m[x[key]] = (m[x[key]] ?? 0) + 1; return m; }, {});
  const result = { schema: RESEARCH_TEAM_SCHEMA, team: { ...team }, root, status, stop_reason, satisfied: status === "satisfied", material: final?.report?.material === true, summary: final?.report?.summary ?? null, rounds,
    selection: coordinator.selection ?? null, nodes: out, refusals,
    knowledge: { observations: [...knowledge.values()], unresolved: out.filter(n => n.state === "finished").flatMap(n => n.report.unresolved.map(u => ({ node: n.id, ...u }))),
      dependencies: out.filter(n => n.state === "finished").flatMap(n => n.report.dependencies.map(d => ({ node: n.id, ...d }))), hypotheses: out.filter(n => n.state === "finished").flatMap(n => n.report.hypotheses.map(h => ({ node: n.id, ...h }))) },
    contributors,
    telemetry: { depth_reached: depthReached, active_peak: peak, nodes_created: created, coordinator_rounds: rounds, nodes: by(out.filter(n => n.kind === "specialist"), "state"), requests, tokens, refusals: by(refusals, "code"), reused } };
  await emit({ event: "conclusion", status, stop_reason, satisfied: result.satisfied, material: result.material, summary: result.summary, telemetry: result.telemetry });
  return result;
}
