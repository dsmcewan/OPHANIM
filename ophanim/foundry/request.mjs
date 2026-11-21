// A FOUNDRY REQUEST: what is to be built, how it is accepted, how it is operated and what it may depend on.
//
// Purpose   The one input of the foundry (foundry.mjs). The request states the product's contract -- its goal in words
//           a builder with no tools can work from, the files to produce, the command that accepts them, the command
//           that operates them, and the dependencies they may have -- and carries, in its seed directory, everything
//           the acceptance and operation commands need. The acceptance contract is the requester's: no builder writes it.
// Inputs    a JSON file `ophanim.foundry.request/v1` and the directory it is in.
// Outputs   readRequest(file) -> {request, dir, sha256}; requestRefusal(value) -> null or the reason.
// Must never  Accept a request whose paths leave its own directory or the product's tree, or one with a field no stage
//           reads (an unread field would be a requirement silently ignored).
import fs from 'node:fs';
import path from 'node:path';
import {digest} from '../../packages/ledger/canonical.mjs';

export const REQUEST_SCHEMA = 'ophanim.foundry.request/v1';
const FIELDS = ['schema', 'key', 'title', 'class', 'goal', 'question', 'files', 'seed', 'acceptance_cmd', 'tests_file', 'operate', 'allowed', 'difficulty'];
const ALLOWED = ['builtins', 'packages', 'env', 'hosts', 'programs', 'reads', 'writes'];
const inside = p => typeof p === 'string' && p.length > 0 && !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..') && !p.includes('\0');
const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

export function requestRefusal(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'a request is a JSON object';
  if (r.schema !== REQUEST_SCHEMA) return `schema is not ${REQUEST_SCHEMA}`;
  const unknown = Object.keys(r).filter(k => !FIELDS.includes(k));
  if (unknown.length) return `unknown field(s) ${unknown.join(', ')}: a field no stage reads would be silently ignored`;
  if (!/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(r.key ?? '')) return 'key is 1-40 letters and digits, starting with a letter';
  if (!/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*){0,3}$/.test(r.class ?? '')) return 'class names the kind of task, as lowercase segments (for example build/module)';
  if (!text(r.title, 200) || !text(r.goal, 20000) || !text(r.question, 2000)) return 'title, goal and question are non-empty text';
  if (!Array.isArray(r.files) || !r.files.length || r.files.length > 8) return 'files lists 1 to 8 files to produce';
  for (const f of r.files) if (!f || !/^[a-z][a-z0-9-]{0,31}$/.test(f.slot ?? '') || !inside(f.path) || f.path.startsWith('seed/')) return 'each file has a slot name and a path inside the product, outside seed/';
  if (new Set(r.files.map(f => f.path)).size !== r.files.length || new Set(r.files.map(f => f.slot)).size !== r.files.length) return 'file paths and slots are distinct';
  if (!inside(r.seed)) return 'seed is a directory beside the request';
  if (!text(r.acceptance_cmd, 500)) return 'acceptance_cmd is the command that must exit 0';
  if (r.tests_file !== undefined && !(inside(r.tests_file) && r.tests_file.startsWith('seed/'))) return 'tests_file is a file under seed/';
  if (r.operate !== undefined && r.operate !== null) {
    const o = r.operate;
    if (!o || !text(o.cmd, 500) || Object.keys(o).some(k => !['cmd', 'timeout_ms', 'score'].includes(k))) return 'operate is {cmd, timeout_ms?, score?}';
    if (o.timeout_ms !== undefined && !(Number.isInteger(o.timeout_ms) && o.timeout_ms >= 1000 && o.timeout_ms <= 600000)) return 'operate.timeout_ms is 1000 to 600000';
    if (o.score !== undefined && !/^[a-z_][a-z0-9_]{0,39}$/.test(o.score)) return 'operate.score names a numeric field of the operation report';
  }
  const a = r.allowed ?? {};
  if (typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(k => !ALLOWED.includes(k))) return `allowed is an object of ${ALLOWED.join(', ')}`;
  for (const k of ['builtins', 'packages', 'env']) if (a[k] !== undefined && !(Array.isArray(a[k]) && a[k].every(x => typeof x === 'string'))) return `allowed.${k} is a list of names`;
  for (const k of ['hosts', 'programs', 'reads', 'writes']) if (a[k] !== undefined && typeof a[k] !== 'boolean') return `allowed.${k} is true or false`;
  if (r.difficulty !== undefined && !['easy', 'medium', 'hard'].includes(r.difficulty)) return 'difficulty is easy, medium or hard';
  return null;
}

/** Read and check a request file. The digest covers the request and every byte of its seed directory. */
export function readRequest(file) {
  const abs = path.resolve(file), dir = path.dirname(abs);
  let request;
  try { request = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) { throw Object.assign(new Error(`the request ${abs} is not readable JSON`), {code: 'FOUNDRY_REFUSED'}); }
  const why = requestRefusal(request);
  if (why) throw Object.assign(new Error(`the request is refused: ${why}`), {code: 'FOUNDRY_REFUSED'});
  const seed = path.join(dir, request.seed);
  if (!fs.existsSync(seed) || !fs.statSync(seed).isDirectory()) throw Object.assign(new Error(`the request is refused: its seed directory ${request.seed} does not exist`), {code: 'FOUNDRY_REFUSED'});
  const files = fs.readdirSync(seed, {recursive: true, withFileTypes: true}).filter(e => e.isFile()).map(e => path.relative(seed, path.join(e.parentPath, e.name)).split(path.sep).join('/')).sort();
  if (request.tests_file && !files.includes(request.tests_file.replace(/^seed\//, ''))) throw Object.assign(new Error(`the request is refused: tests_file ${request.tests_file} is not in its seed`), {code: 'FOUNDRY_REFUSED'});
  const seedDigest = digest(files.map(f => [f, digest(fs.readFileSync(path.join(seed, f)).toString('base64'))]));
  return {request, dir, seed, sha256: digest({request, seed: seedDigest})};
}
