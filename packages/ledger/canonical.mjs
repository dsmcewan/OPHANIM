// Canonical JSON and its digest: the bytes every ledger hash, board cid and policy digest is computed over.
//
// ONE implementation, two key orders. Before ME3 this repository had a dozen hand-rolled copies that agreed
// on ordinary JSON and disagreed at the edges (tests/canonical-differential.test.mjs records where). They
// fall into exactly two byte-incompatible families, and both families have persisted records, so both
// orders are kept, by name, and every other knob is one policy:
//
//   canonical            LEDGER_V1. Keys sorted by code unit, then written through JSON.stringify of a fresh
//                        object, so integer-like keys ("0", "9", "10", up to 2^32-2) come FIRST in numeric
//                        order and the rest follow in code-unit order: {"9":..,"10":..,"a":..}. This is the
//                        form every ledger entry, payload object, signature, ophanim runtime checkpoint and
//                        TELOS-facing fixture digest was computed over, and the order the pinned verifiers
//                        (ophanim/governance/check-*.mjs) and TELOS's own canonicalize also produce.
//   canonicalCodeUnit    CODE_UNIT_V1. Keys in plain code-unit order throughout: {"10":..,"9":..,"a":..}. This
//                        is the form the Pantheon board's content ids (pantheon/src/board/canon.mjs), the
//                        selection-policy hash, the escalation digest, the chair-contribution projection and
//                        ophanim's admission/analysis digests were computed over. The two orders agree on
//                        every object without an integer-like key -- every committed record -- and differ on
//                        the rest, so neither may be rewritten into the other.
//   canonicalCas         CODE_UNIT_V1 with -0 refused, for content ids: a cid must be injective, and -0
//                        serialises as 0.
//
// The edge policy, the same for all three (each line is tested in packages/ledger/tests/canonical.test.mjs):
//   accepted   null, booleans, finite numbers (written as JSON.stringify writes them: 1e+21, 1e-7, and
//              integers past 2^53 as whatever double they already are), strings (code units as given: no
//              Unicode normalisation, so NFC and NFD hash apart; lone surrogates escaped as \udXXX), dense
//              arrays, and objects whose prototype is Object.prototype or null (own enumerable string keys).
//   -0         written as 0 by canonical and canonicalCodeUnit (LEGACY: ledger/v1 always has, live writers
//              may still produce it, e.g. Math.round(-0.2)); refused by canonicalCas.
//   refused    undefined (as a value, a member or an element -- never silently dropped), NaN and +-Infinity,
//              functions, symbols, BigInt, holes in sparse arrays, non-plain objects (Date, Map, Set,
//              RegExp, Buffer, boxed primitives, class instances: their toJSON is never consulted), cycles,
//              accessor properties, the key "__proto__", and nesting deeper than 60.
// Symbol-keyed and non-enumerable properties are not part of a value and are ignored, as JSON.stringify does.
//
// Nothing persisted changes: a record read back from disk is JSON.parse output, which never contains any
// refused value, and on that domain each named form is byte-identical to the copies it replaced.
// Previously-accepted non-JSON INPUTS (undefined members dropped or written as the bare word `undefined`,
// Dates written as {}, holes written as `[,1]`) now throw when a record is written, instead of producing a
// hash that a later read of the stored JSON could not reproduce.
//
// The ledger core depends on nothing outside this package; ophanim/board.mjs re-exports canonical and
// digest from here, and ophanim/ledger/layering.test.mjs checks they are the same bytes.
import {createHash} from 'node:crypto';

const MAX_DEPTH = 60;
const ARRAY_INDEX = /^(?:0|[1-9]\d{0,9})$/;
// JSON.stringify writes an ordinary object's array-index keys (canonical integers below 2^32-1) first, in
// numeric order, then its other string keys in insertion order. LEDGER_V1 is that order after a code-unit sort.
const isIndex = k => ARRAY_INDEX.test(k) && Number(k) < 4294967295;
const codeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const ledgerOrder = (a, b) => {
  const ia = isIndex(a), ib = isIndex(b);
  if (ia && ib) return Number(a) - Number(b);
  if (ia !== ib) return ia ? -1 : 1;
  return codeUnit(a, b);
};

const refuse = (where, what) => { throw new TypeError(`Plain finite JSON required: ${where} ${what}`); };
const kindOf = v => {
  const proto = Object.getPrototypeOf(v);
  return proto?.constructor?.name || 'non-plain object';
};

/**
 * Build a canonicalizer. Exactly two key orders exist ('ledger' and 'code-unit'); `negativeZero` is
 * 'zero' (write 0) or 'reject'. Every other edge is the fixed policy above.
 */
export function canonicalizer({keyOrder, negativeZero = 'zero', maxDepth = MAX_DEPTH} = {}) {
  if (keyOrder !== 'ledger' && keyOrder !== 'code-unit') throw new TypeError(`unknown key order ${keyOrder}`);
  if (negativeZero !== 'zero' && negativeZero !== 'reject') throw new TypeError(`unknown -0 policy ${negativeZero}`);
  const order = keyOrder === 'ledger' ? ledgerOrder : codeUnit;
  return function canonicalForm(value, root = '$') {
    const open = new Set();
    const walk = (v, where, depth) => {
      if (depth > maxDepth) throw new RangeError(`JSON nesting bound exceeded at ${where}`);
      if (v === null) return 'null';
      switch (typeof v) {
        case 'boolean': return v ? 'true' : 'false';
        case 'string': return JSON.stringify(v);
        case 'number':
          if (!Number.isFinite(v)) refuse(where, `is not finite (${v})`);
          if (Object.is(v, -0) && negativeZero === 'reject') refuse(where, 'is -0, which is indistinguishable from 0 once serialised');
          return JSON.stringify(v);
        case 'undefined': refuse(where, 'is undefined; omit the key or use null, because dropping it would hash equal to a value that never had it');
        // falls through: refuse throws
        case 'object': break;
        default: refuse(where, `is a ${typeof v}, which has no canonical form`);
      }
      if (open.has(v)) refuse(where, 'is a cycle');
      const isArray = Array.isArray(v);
      if (!isArray) {
        const proto = Object.getPrototypeOf(v);
        if (proto !== Object.prototype && proto !== null) refuse(where, `is a ${kindOf(v)}, which has no canonical form`);
      }
      open.add(v);
      let out;
      if (isArray) {
        const parts = new Array(v.length);
        for (let i = 0; i < v.length; i++) {
          const at = `${where}[${i}]`, d = Object.getOwnPropertyDescriptor(v, i);
          if (!d) refuse(at, 'is a hole in a sparse array');
          if (d.get || d.set) throw new TypeError(`JSON accessors refused at ${at}`);
          parts[i] = walk(d.value, at, depth + 1);
        }
        out = `[${parts.join(',')}]`;
      } else {
        const keys = Object.keys(v).sort(order);
        const parts = new Array(keys.length);
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i], at = `${where}.${k}`;
          if (k === '__proto__') refuse(at, 'is a prototype-polluting key');
          const d = Object.getOwnPropertyDescriptor(v, k);
          if (d.get || d.set) throw new TypeError(`JSON accessors refused at ${at}`);
          parts[i] = `${JSON.stringify(k)}:${walk(d.value, at, depth + 1)}`;
        }
        out = `{${parts.join(',')}}`;
      }
      open.delete(v);
      return out;
    };
    return walk(value, root, 0);
  };
}

/** LEDGER_V1: ledger entries, payload objects, signatures, ophanim runtime state, fixture digests. */
export const canonical = canonicalizer({keyOrder: 'ledger'});
/** CODE_UNIT_V1: selection-policy, escalation, contribution, admission and analysis digests. */
export const canonicalCodeUnit = canonicalizer({keyOrder: 'code-unit'});
/** CODE_UNIT_V1 with -0 refused: Pantheon board content ids. */
export const canonicalCas = canonicalizer({keyOrder: 'code-unit', negativeZero: 'reject'});

const sha256 = text => createHash('sha256').update(text).digest('hex');
/** sha256 hex of canonical(value). */
export const digest = value => sha256(canonical(value));
/** sha256 hex of canonicalCodeUnit(value). */
export const digestCodeUnit = value => sha256(canonicalCodeUnit(value));
