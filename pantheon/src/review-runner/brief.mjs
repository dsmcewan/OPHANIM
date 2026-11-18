// What the reviewer is shown, and nothing else: the HARNESS.md text (values filled in) as the
// system text, and README.md + "\n\n---\n\n" + the assignment file, verbatim, plus one line
// naming the commit, as the first user message. Also: the README's assignment table.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { matchGlob } from "./sandbox.mjs";

export const REVIEW_DIR = "docs/reviews/2026-11-18-independent-review";
export const SEPARATOR = "\n\n---\n\n";

export const sha256 = s => createHash("sha256").update(s).digest("hex");

const LAB_TO_VENDOR = { google: "gemini", openai: "openai", xai: "xai" };

// The README's table: | # | [Title](file.md) | Lab, `model` | Scope | Testing |
export function parseAssignments(readme) {
  const rows = new Map();
  for (const line of readme.split("\n")) {
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map(s => s.trim());
    if (cells.length < 5 || !/^\d+$/.test(cells[0])) continue;
    const n = Number(cells[0]);
    const link = cells[1].match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    const labCell = cells[2];
    const lab = labCell.split(/[,`]/)[0].trim();
    const models = [...labCell.matchAll(/`([^`]+)`/g)].map(m => m[1]);
    rows.set(n, {
      n,
      title: link ? link[1] : cells[1],
      file: link ? link[2] : null,
      lab,
      vendor: LAB_TO_VENDOR[lab.toLowerCase()] ?? null,
      model: models.length === 1 ? models[0] : null,
      model_cell: labCell,
      scope: cells[3],
      testing: cells[4],
    });
  }
  return rows;
}

// Refuses an assignment the README does not name a single model, a known lab and a file for.
export function assignmentRow(readme, n) {
  const row = parseAssignments(readme).get(n);
  if (!row) throw new BriefError(`assignment ${n} is not in the README table`);
  if (!row.file || !/^[\w.-]+\.md$/.test(row.file)) throw new BriefError(`assignment ${n}: no assignment file link in the README table`);
  if (!row.vendor) throw new BriefError(`assignment ${n}: lab "${row.lab}" is not one of Google, OpenAI, xAI`);
  if (!row.model) throw new BriefError(`assignment ${n}: the README row names no model (one backticked model is required in "${row.model_cell}")`);
  return row;
}

export class BriefError extends Error {
  constructor(message) { super(message); this.name = "BriefError"; }
}

export function renderHarness(template, values) {
  const out = template.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => {
    if (!(k in values)) throw new BriefError(`HARNESS.md: unknown placeholder ${m}`);
    return String(values[k]);
  });
  return out;
}

export const commitLine = commit => `Commit under review: ${commit}`;

export function composeBrief({ readme, assignmentText, commit }) {
  return readme + SEPARATOR + assignmentText + "\n" + commitLine(commit) + "\n";
}

// Reads the three source files from `repoRoot` (the owner's checkout that holds the runner).
export async function loadBrief({ repoRoot, n, commit, harnessValues }) {
  const dir = join(repoRoot, REVIEW_DIR);
  const readme = await readFile(join(dir, "README.md"), "utf8");
  const row = assignmentRow(readme, n);
  const assignmentText = await readFile(join(dir, row.file), "utf8");
  const harnessTemplate = await readFile(join(dir, "HARNESS.md"), "utf8");
  const system = renderHarness(harnessTemplate, { COMMIT: commit, ...harnessValues });
  const brief = composeBrief({ readme, assignmentText, commit });
  return { row, readme, assignmentText, harnessTemplate, system, brief };
}

// ---- reading the assignment file --------------------------------------------------------------

const backticked = s => [...s.matchAll(/`([^`]+)`/g)].map(m => m[1]);
const pathish = t => /\//.test(t) || /\.(mjs|js|json|md|py)$/.test(t);

export function section(text, heading) {
  const lines = text.split("\n");
  const i = lines.findIndex(l => l.trim() === `## ${heading}`);
  if (i < 0) return "";
  const j = lines.findIndex((l, k) => k > i && /^## /.test(l));
  return lines.slice(i + 1, j < 0 ? undefined : j).join("\n");
}

export function testingLine(text) {
  const m = text.match(/^\*\*Testing:\*\*\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

// Paths named under "Where to look", resolved against the commit's file list (informational).
export function inScopePaths(assignmentText, files) {
  const raw = [], resolved = new Set(), unresolved = [];
  for (const line of section(assignmentText, "Where to look").split("\n")) {
    let dir = "";
    for (const t of backticked(line).filter(pathish)) {
      if (raw.includes(t)) continue;
      raw.push(t);
      let hits;
      if (t.includes("/")) {
        dir = t.endsWith("/") ? t : t.slice(0, t.lastIndexOf("/") + 1);
        hits = matchGlob(t.endsWith("/") ? `${t}**` : t, files);
      } else if (dir) {
        hits = matchGlob(dir + t, files);
      } else {
        hits = files.filter(f => matchGlob(`**/${t}`, [f]).length);
        if (hits.length > 3) hits = [];
      }
      if (hits.length) hits.forEach(h => resolved.add(h)); else unresolved.push(t);
    }
  }
  return { raw, resolved: [...resolved].sort(), unresolved };
}

// "Existing tests you may run: `pantheon/tests/agy-*.test.mjs`, `pipeline-a2a.test.mjs`, ..."
// A bare name takes the directory of the entry before it. Returns the exact files at the commit.
export function listedTests(assignmentText, files) {
  const line = assignmentText.split("\n").find(l => /Existing tests you may run:/.test(l));
  if (!line) return { patterns: [], files: [] };
  let dir = "";
  const patterns = backticked(line.split("Existing tests you may run:")[1]).filter(t => t.endsWith(".test.mjs")).map(t => {
    if (t.includes("/")) { dir = t.slice(0, t.lastIndexOf("/") + 1); return t; }
    return dir + t;
  });
  const out = new Set();
  for (const p of patterns) for (const f of matchGlob(p, files)) if (f.endsWith(".test.mjs")) out.add(f);
  return { patterns, files: [...out].sort() };
}
