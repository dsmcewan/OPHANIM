// The issues intake snapshot: the repository's GitHub issues as DATA for reconciliation (reconcile.mjs), never as
// authority. Each issue becomes {number, title, body, state, labels}; reconciliation links an issue to a status item
// only by the `<!-- ophanim:item=ID -->` marker the public record writes, and an issue without one is an intake
// candidate (recorded by the scheduler through work.intake, never executed). Nothing an issue says changes a gate.
//
// Inputs: a GitHub token (GITHUB_TOKEN, read-only use) and an owner/name repository, through the public record's
// REST client (ophanim/public/github.mjs restClient); or a snapshot file. Outputs: the normalized array.
// Must never: write to GitHub, read comments, or treat issue text, labels or state as a decision.
import fs from 'node:fs';
import {restClient} from '../public/github.mjs';

/** One issue, normalized. Pull requests (which the issues endpoint also lists) are dropped (null). */
export function normalizeIssue(raw) {
  if (!raw || typeof raw !== 'object' || raw.pull_request) return null;
  if (!Number.isInteger(raw.number)) throw Object.assign(new Error('an issue in the snapshot has no number'), {code: 'ISSUES_REFUSED'});
  return {
    number: raw.number,
    title: String(raw.title ?? ''),
    body: String(raw.body ?? ''),
    state: String(raw.state ?? 'open').toLowerCase(),
    labels: (raw.labels ?? []).map(l => (typeof l === 'string' ? l : l?.name)).filter(l => typeof l === 'string').sort(),
  };
}

/** Normalize a list (or a {issues: [...]} envelope, as a GitHub MCP listing returns it), sorted by number. */
export function normalizeIssues(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.issues) ? data.issues : null;
  if (!list) throw Object.assign(new Error('an issues snapshot is an array of issues or {issues: [...]}'), {code: 'ISSUES_REFUSED'});
  return list.map(normalizeIssue).filter(Boolean).sort((a, b) => a.number - b.number);
}

/** A snapshot file written earlier (by `fetchIssues` or a GitHub listing). */
export function readIssuesFile(file) {
  return normalizeIssues(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** Every issue of `repo` (owner/name), open and closed, read through the public record's REST client. GET only. */
export async function fetchIssues({repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN, fetchImpl, api} = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw Object.assign(new Error('GITHUB_REPOSITORY (owner/name) is required to read the issues'), {code: 'ISSUES_REFUSED'});
  if (!token) throw Object.assign(new Error('GITHUB_TOKEN is required to read the issues'), {code: 'ISSUES_REFUSED'});
  const gh = restClient({token, fetchImpl, ...(api ? {api} : {}), log: () => {}});
  return normalizeIssues(await gh.paginate(`/repos/${repo}/issues?state=all&per_page=100`));
}
