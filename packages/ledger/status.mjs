// The status board as a projection of a ledger.
//
// Every status change is a `status` entry, signed by an operator and citing that item's previous status,
// so the board's history is the chain and the board itself (docs/STATUS.md) is generated from it, never
// edited by hand. The standing rule is enforced on append, not left to review:
//   - Resolved      done; names its basis
//   - In progress   being worked
//   - Ready         its dependencies have converged and nothing external is awaited: start it
//   - On Hold       waits on something OUTSIDE the work: governance, a credential, evidence from real
//                   runs, a fact a vendor has not published, or a decision only a person can make.
//                   "Not started yet" is never a hold; such an item is Ready.
// A hold also names when it was last re-checked, because a hold is re-evaluated for a change in
// circumstances before a loop concludes.
//
// Layout (committed): status/ledger/{chain.jsonl, objects/, ANCHOR}. Private keys live in
// status/ledger/keys/, which is never committed: anyone can verify the board, only a key holder can
// change it.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openLedger, createLedger, defineKinds, generateSigner} from './chain.mjs';
import {keyStore} from './home.mjs';

export const STATUS_SCHEMA = 'ophanim.status/v1';
export const STATES = ['Resolved', 'In progress', 'Ready', 'On Hold'];
export const EXTERNAL = ['governance', 'credential', 'evidence', 'fact', 'decision'];
// Optional: who owns the item. One of Pantheon's five chairs (model seats, not people), or
// `decision-authority`: an item only the human owner decides. Absent on entries recorded before it existed.
export const OWNER_ROLES = ['impl@build', 'check@review', 'lead@orch', 'scout@opt', 'arbiter@judge', 'decision-authority'];
const ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const fail = why => { throw Object.assign(new Error(why), {code: 'STATUS_REFUSED'}); };

function statusKind({operators}) {
  return {
    status: {
      authors: a => operators.includes(a.key_id),
      validate: p => {
        if (p?.schema !== STATUS_SCHEMA || !ID.test(p.item ?? '') || typeof p.title !== 'string' || !p.title) return 'a status names its item id and title';
        if (!STATES.includes(p.state)) return `state must be one of ${STATES.join(', ')}`;
        if (typeof p.basis !== 'string' || !p.basis) return 'a status names its basis';
        if (!DATE.test(p.checked ?? '')) return 'a status names the date it was checked';
        if (p.depends_on !== undefined && !(Array.isArray(p.depends_on) && p.depends_on.every(d => ID.test(d)))) return 'depends_on lists item ids';
        if (p.owner_role !== undefined && !OWNER_ROLES.includes(p.owner_role)) return `owner_role must be one of ${OWNER_ROLES.join(', ')}`;
        return null;
      },
      rederive: (e, view) => {
        const p = e.payload;
        // The standing rule: a hold waits on something outside the work, or on an item that itself waits.
        if (p.state === 'On Hold') {
          const external = EXTERNAL.includes(p.waiting_on);
          const blocked = (p.depends_on ?? []).some(d => {
            const s = latest(view, d);
            return s && s.state !== 'Resolved';
          });
          if (!external && !blocked) return `"${p.item}" is held on nothing external and no unresolved dependency: it is Ready, not On Hold`;
        } else if (p.waiting_on != null) return 'only a hold waits on something';
        // An item's statuses chain: a change cites the item's previous status, and a first status cites none.
        const prev = latestHash(view, p.item);
        const cited = e.derived_from.filter(h => view.entry(h)?.kind === 'status' && view.payload(h).item === p.item);
        if (prev ? !(cited.length === 1 && cited[0] === prev) : cited.length !== 0) return `a status for "${p.item}" cites its previous status, and only that`;
        return null;
      },
    },
  };
}

function latestHash(view, item) {
  let found = null;
  for (const h of view.entries()) if (view.entry(h).kind === 'status' && view.payload(h).item === item) found = h;
  return found;
}
function latest(view, item) { const h = latestHash(view, item); return h ? view.payload(h) : null; }

/** Open (or create on first use) the status ledger at `root`. */
export function openStatusLedger({root, anchor = null}) {
  if (!root || !path.isAbsolute(root)) fail('an absolute status ledger root is required');
  fs.mkdirSync(root, {recursive: true});
  const anchorFile = path.join(root, 'ANCHOR');
  let pinned = fs.existsSync(anchorFile) ? fs.readFileSync(anchorFile, 'utf8').trim() : null;
  const keysDir = path.join(root, 'keys');
  if (!pinned) {
    if (fs.existsSync(path.join(root, 'chain.jsonl'))) fail('a status ledger without its ANCHOR is not opened');
    const keys = keyStore(keysDir);
    const operator = keys.put(generateSigner('operator')), orderer = keys.put(generateSigner('status-orderer'));
    pinned = createLedger({dir: root, operator, order: orderer,
      authority: {keyring: {operator: operator.publicJwk, 'status-orderer': orderer.publicJwk}, orderer: 'status-orderer', operators: ['operator']}});
    fs.writeFileSync(anchorFile, pinned + '\n');
  }
  if (anchor && anchor !== pinned) fail('this status ledger is not the one the caller pinned');
  // The kind is bound to whoever the chain's authority names as operators: opened once to read the
  // authority, then again with the operators it names.
  let operators = ['operator'];
  const L = () => openLedger({dir: root, kinds: defineKinds(statusKind({operators})), anchor: pinned});
  let ledger = L();
  const state = ledger.verify();
  if (!state.ok) fail(`status ledger does not verify: ${state.why}`);
  operators = state.authority.operators;
  ledger = L();

  const view = () => {
    const at = new Map(ledger.read().map(e => [ledger.hashOf(e), e]));
    return {entry: h => at.get(h) ?? null, payload: h => (at.has(h) ? ledger.payloadOf(at.get(h)) : null), entries: () => [...at.keys()]};
  };
  const signers = () => {
    const keys = keyStore(keysDir);
    const op = operators.map(id => keys.get(id)).find(Boolean), order = keys.get(state.authority.orderer);
    if (!op || !order) fail('no operator or orderer key is held here: the board can be verified, not changed');
    return {op, order};
  };
  return {
    ledger, anchor: pinned, root,
    /** Record a status for an item (a change cites the item's previous status). */
    set({item, title, state: s, basis, checked, waiting_on = null, depends_on = undefined, owner_role = undefined, cites = []}) {
      const {op, order} = signers();
      const prev = latestHash(view(), item);
      const payload = {schema: STATUS_SCHEMA, item, title, state: s, basis, checked, waiting_on, ...(depends_on ? {depends_on} : {}), ...(owner_role !== undefined ? {owner_role} : {})};
      return ledger.append({kind: 'status', payload, author: {key_id: op.key_id}, signer: op, order, derivedFrom: [...(prev ? [prev] : []), ...cites]}).hash;
    },
    /** The board: the latest status of every item, from a ledger that verifies. */
    board() {
      const v = ledger.verify();
      if (!v.ok) fail(`status ledger does not verify: ${v.why}`);
      const vw = view(), items = new Map();
      for (const h of vw.entries()) if (vw.entry(h).kind === 'status') items.set(vw.payload(h).item, {...vw.payload(h), entry: h});
      return {head: v.head, anchor: pinned, entries: v.entries, items: [...items.values()]};
    },
  };
}

const ORDER = {'On Hold': 0, 'In progress': 1, 'Ready': 2, 'Resolved': 3};
/** Render the board as Markdown. The output is generated; edit the ledger, not the file. */
export function renderBoard(board) {
  const rows = [...board.items].sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.item.localeCompare(b.item));
  const cell = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const counts = STATES.map(s => `${s}: ${rows.filter(r => r.state === s).length}`).join(' · ');
  return [
    '# Status board',
    '',
    '<!-- Generated from the status ledger (status/ledger). Do not edit by hand: record a status change',
    '     with `node packages/ledger/status.mjs set ...`, then `node packages/ledger/status.mjs render`. -->',
    '',
    `**Ledger:** \`status/ledger\` · anchor \`${board.anchor}\` · head \`${board.head}\` · ${board.entries} entries.`,
    `Verify it: \`node packages/ledger/status.mjs verify\`.`,
    '',
    `**Counts:** ${counts}.`,
    '',
    '**Rule** (enforced when a status is recorded): On Hold only for something outside the work, meaning governance, a credential, evidence from real runs, an unpublished fact, or a person\'s decision, or for an item that depends on one. An item that is merely not started is Ready, and starts.',
    '',
    '| Item | State | Waiting on | Basis | Checked |',
    '|---|---|---|---|---|',
    ...rows.map(r => `| **${cell(r.title)}** (\`${r.item}\`) | ${r.state} | ${r.waiting_on ?? (r.depends_on?.length ? `depends on ${r.depends_on.join(', ')}` : '')} | ${cell(r.basis)} | ${r.checked} |`),
    '',
  ].join('\n');
}

// CLI: node packages/ledger/status.mjs <verify|render|set> [--json '{"item":...}']
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(HERE, '../../status/ledger');
export const DEFAULT_BOARD = path.resolve(HERE, '../../docs/STATUS.md');
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, flag, json] = process.argv.slice(2);
  const S = openStatusLedger({root: process.env.OPHANIM_STATUS_LEDGER ?? DEFAULT_ROOT});
  if (cmd === 'verify') { const b = S.board(); console.log(`ok: ${b.items.length} items, ${b.entries} entries, head ${b.head}`); }
  else if (cmd === 'render') { fs.writeFileSync(DEFAULT_BOARD, renderBoard(S.board())); console.log(`wrote ${path.relative(process.cwd(), DEFAULT_BOARD)}`); }
  else if (cmd === 'set' && flag === '--json') { console.log(S.set(JSON.parse(json))); }
  else { console.error('usage: status.mjs verify | render | set --json \'{"item":..., "title":..., "state":..., "basis":..., "checked":"YYYY-MM-DD", "waiting_on":..., "depends_on":[...], "owner_role":...}\''); process.exit(2); }
}
