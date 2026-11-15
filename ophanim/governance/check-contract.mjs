// Closed synthetic contract. No model-provided checks or executable commands.
import {createHash} from 'node:crypto';

export function canonical(value) {
  const visit = (v, depth = 0) => {
    if (depth > 40) throw Error('JSON nesting bound exceeded');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map(x => visit(x, depth + 1));
    if (v && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.keys(v).sort().map(k => {
        if (['__proto__', 'prototype', 'constructor'].includes(k)) throw Error('Unsafe JSON key');
        return [k, visit(v[k], depth + 1)];
      }));
    }
    throw Error('Plain finite JSON required');
  };
  const text = JSON.stringify(visit(value));
  if (Buffer.byteLength(text) > 262144) throw Error('JSON byte bound exceeded');
  return text;
}
export const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
export const rawHash = bytes => createHash('sha256').update(bytes).digest('hex');
const str = x => typeof x === 'string' && x.length > 0 && x.length <= 512;
const id = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,191}$/.test(x);
const digest = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const same = (a, b) => canonical(a) === canonical(b);
const exact = (v, keys) => v && !Array.isArray(v) && same(Object.keys(v).sort(), [...keys].sort());
export const KINDS = Object.freeze(['normalize-intake', 'route-intake', 'draft-task', 'synthetic-release']);

export function validateRequest(request) {
  canonical(request);
  const {candidate: c, obligation: o, worker: w, evidence: e} = request;
  if (!c || !o || !w || !e || !id(o.id) || !KINDS.includes(o.kind) || !str(o.scope) || !str(o.outputKey)) throw Error('Unknown or incomplete synthetic obligation');
  if (!Array.isArray(o.dependsOn) || o.dependsOn.length > 32 || new Set(o.dependsOn).size !== o.dependsOn.length || !o.dependsOn.every(id)) throw Error('Invalid dependency set');
  if (!Number.isInteger(o.maxAttempts) || o.maxAttempts < 1 || o.maxAttempts > 8) throw Error('Bounded attempt policy required');
  if (!id(c.id) || !digest(c.sha256) || hash(c.output) !== c.sha256) throw Error('Candidate digest mismatch');
  if (!same(c.output, o.expected)) throw Error('Candidate does not satisfy the trusted synthetic oracle');
  if (!id(w.id) || !str(w.version) || !Array.isArray(w.kinds) || !w.kinds.includes(o.kind) || !Array.isArray(w.scopes) || !w.scopes.includes(o.scope)) throw Error('Worker outside declared synthetic scope');
  if (!Number.isInteger(e.attempt) || e.attempt < 1 || e.attempt > o.maxAttempts || e.stateSchema !== 'ophanim.runtime/v1') throw Error('Invalid attempt or state schema');
  if (!Array.isArray(e.dependencyVersions) || e.dependencyVersions.length !== o.dependsOn.length || new Set(e.dependencyVersions.map(d => d.id)).size !== o.dependsOn.length || e.dependencyVersions.some(d => !o.dependsOn.includes(d.id) || !digest(d.sha256))) throw Error('Exact dependency versions required');
  const out = c.output;
  if (o.kind === 'synthetic-release') {
    if (!exact(out, ['id', 'artifactSha', 'stateSchema', 'workers']) || !id(out.id) || !digest(out.artifactSha) || out.stateSchema !== e.stateSchema || !Array.isArray(out.workers) || out.workers.length < 1 || out.workers.length > 32) throw Error('Invalid synthetic release manifest');
    for (const worker of out.workers) if (!id(worker.id) || !str(worker.version) || !Array.isArray(worker.kinds) || !Array.isArray(worker.scopes)) throw Error('Invalid release worker metadata');
  } else {
    const keys = o.kind === 'draft-task' ? ['key', 'caseId', 'department', 'owner', 'title', 'requester', 'sourceRevision', 'status'] : ['caseId', 'department', 'service', 'summary', 'requester', 'sourceRevision', ...(o.kind === 'route-intake' ? ['owner'] : [])];
    if (!exact(out, keys) || keys.some(k => !(str(out[k]) || k === 'sourceRevision' && Number.isInteger(out[k]) && out[k] >= 0))) throw Error('Invalid synthetic workflow output');
    if (o.scope !== 'department:' + out.department) throw Error('Output department is outside the authorized scope');
    if (o.kind === 'draft-task' && (!id(o.effectKey) || out.key !== o.effectKey || out.status !== 'draft')) throw Error('Only exact synthetic drafts are admitted');
  }
  return {ok: true, candidateSha: c.sha256, obligationSha: hash(o), workerSha: hash(w), dependencySha: hash(e.dependencyVersions), fixtureOnly: true};
}
