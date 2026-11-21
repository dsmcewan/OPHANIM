// Stable identity (contract ophanim.graph/v1, docs/knowledge-graph/architecture.md "Identity").
//
// A stable id is `<instance>/<domain>/<type>/<key>`:
//   instance  the OPHANIM instance that owns the entity, `[a-z][a-z0-9-]{0,31}`, default `ophanim`;
//   domain    one of the five graph domains (schema.mjs DOMAINS);
//   type      an entity type registered for that domain;
//   key       the source's own stable key, in URI path characters: `/` separates segments (no empty, `.` or `..`
//             segment) and anything else is percent-encoded (encodeKey), at most 512 characters.
// This file checks the GRAMMAR only. Whether the domain and type are registered is schema.mjs's idRefusal, so the
// registry stays in one place; an id that fails either is refused.
//
// A VERSION is a source digest (canonical JSON through packages/ledger/canonical.mjs, `sha256:<hex>`) or a
// source's own immutable id: a git object id (40 or 64 hex) or a ledger entry hash (`sha256:<hex>`).
//
// An assertion's id is the digest of its canonical content WITHOUT its timestamps (observed_at, effective_at), so
// the same assertion observed twice is the same id and its second append is a no-op.
import {digest} from '../ledger/canonical.mjs';

export const DEFAULT_INSTANCE = 'ophanim';
export const INSTANCE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const TYPE_NAME = /^[a-z][a-z0-9-]{0,47}$/;
const PCHAR = "(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-F]{2})";
const KEY = new RegExp(`^${PCHAR}+(?:/${PCHAR}+)*$`);
const MAX_KEY = 512;
export const VERSION = /^(?:sha256:[0-9a-f]{64}|[0-9a-f]{40}|[0-9a-f]{64})$/;
export const SHA256_REF = /^sha256:[0-9a-f]{64}$/;

const H = value => 'sha256:' + digest(value);

/** The grammar refusal of an id, or null. Registry membership is checked by schema.mjs idRefusal. */
export function grammarRefusal(id) {
  if (typeof id !== 'string') return 'an id is a string';
  const known = checked.get(id);
  if (known !== undefined) return known;
  const why = grammarOf(id);
  if (checked.size > 1_000_000) checked.clear();         // a pure function's results, bounded
  checked.set(id, why);
  return why;
}
const checked = new Map();
function grammarOf(id) {
  const parts = id.split('/');
  if (parts.length < 4) return `id "${id}" is not <instance>/<domain>/<type>/<key>`;
  const [instance, domain, type] = parts, key = parts.slice(3).join('/');
  if (!INSTANCE_NAME.test(instance)) return `id "${id}": instance "${instance}" is not [a-z][a-z0-9-]{0,31}`;
  if (!TYPE_NAME.test(domain)) return `id "${id}": domain "${domain}" is not a name`;
  if (!TYPE_NAME.test(type)) return `id "${id}": type "${type}" is not a name`;
  if (key.length > MAX_KEY) return `id "${id}": key longer than ${MAX_KEY}`;
  if (!KEY.test(key)) return `id "${id}": key "${key}" is not percent-encoded path characters`;
  if (key.split('/').some(s => s === '.' || s === '..')) return `id "${id}": key has a "." or ".." segment`;
  try { decodeURIComponent(key); } catch { return `id "${id}": key has a malformed percent escape`; }
  return null;
}

/** {instance, domain, type, key} of an id whose grammar holds; throws otherwise. The key stays encoded. */
export function parseId(id) {
  const why = grammarRefusal(id);
  if (why) throw Object.assign(new Error(why), {code: 'GRAPH_REFUSED'});
  const parts = id.split('/');
  return {instance: parts[0], domain: parts[1], type: parts[2], key: parts.slice(3).join('/')};
}

/** Encode a source's raw key into the key grammar: everything but unreserved characters, `:`, `@` and `/` is escaped. */
export function encodeKey(raw) {
  if (typeof raw !== 'string' || raw === '') throw new TypeError('a key is a non-empty string');
  const keepSlash = !raw.split('/').some(s => s === '' || s === '.' || s === '..');
  let k = encodeURIComponent(raw).replace(/%3A/g, ':').replace(/%40/g, '@');
  if (keepSlash) k = k.replace(/%2F/g, '/');
  return k.replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
export const decodeKey = key => decodeURIComponent(key);

/** Format an id from its parts; `key` is the raw source key (encoded here) unless `encoded` is true. */
export function entityId({instance = DEFAULT_INSTANCE, domain, type, key, encoded = false}) {
  const id = `${instance}/${domain}/${type}/${encoded ? key : encodeKey(key)}`;
  const why = grammarRefusal(id);
  if (why) throw Object.assign(new Error(why), {code: 'GRAPH_REFUSED'});
  return id;
}

/** A version of a value: its canonical digest (packages/ledger/canonical.mjs). */
export const versionOf = value => H(value);

/**
 * The subject of a relationship: `<type>(<from> -> <to>)`. A symmetric type orders its endpoints, so
 * `contradicts(a, b)` and `contradicts(b, a)` are one relationship.
 */
export function relationshipSubject(type, from, to, {symmetric = false} = {}) {
  const [a, b] = symmetric && to < from ? [to, from] : [from, to];
  return `${type}(${a} -> ${b})`;
}

// What an assertion's id is computed over: everything but the id itself and the timestamps.
const TIMESTAMPS = ['observed_at', 'effective_at'];
export function contentOf(record) {
  const out = {};
  for (const [k, v] of Object.entries(record)) if (k !== 'id' && !TIMESTAMPS.includes(k)) out[k] = v;
  return out;
}
/** The assertion id: the digest of its canonical content without timestamps (idempotency). */
export const assertionId = record => H(contentOf(record));
