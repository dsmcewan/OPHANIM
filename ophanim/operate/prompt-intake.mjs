// PROMPT-TO-TICKET INTAKE (owner direction 2026-11-19): every new AUTHORIZED user prompt is an unplanned work item.
//
// What this module adds is small on purpose. It keeps the prompt and hands it to the machinery that already exists:
//
//   the prompt, verbatim   intake/prompts/<item>.json (PROMPT_SCHEMA): the exact text, its sha256, its byte length, its
//                          provenance (who, when, through what) and the work identity it was given. Nothing is trimmed,
//                          normalised or summarised.
//   a unique identity      item = "prompt-" + 16 hex of sha256(canonical({schema, prompt_sha256, provenance})). The same
//                          submission is the same item (registering it again records nothing); another submission of the
//                          same words, at another time or by another author, is another item.
//   the authoritative      ONE owner-signed status entry (packages/ledger/status.mjs), state Ready, whose basis names the
//   intake                 record and BINDS ITS DIGEST. From there the item is an ordinary status item: reconciliation
//                          joins it, the scheduler records its intake on the work ledger (source `prompt`, beside
//                          `status`) and dispatches it, and the plan stage -- the existing planner, with its dossier and
//                          retrieval -- investigates, derives the ticket and the work units, and is reviewed by three
//                          labs. The user supplies no plan, no execution order and no stage transition.
//
// THE AUTHORIZATION BOUNDARY IS UNCHANGED: it is the owner's signature on the status ledger. This module cannot make
// work on its own authority. A caller that holds no owner key (an automation relaying text it was sent, a webhook, a
// page that was fetched) gets a CANDIDATE: the record is kept as data, reconciliation reports it, the scheduler records
// the intake as a candidate and dispatches nothing. A record file whose item has no signed entry, or whose item's signed
// basis does not bind it, authorizes nothing. And a record that no longer matches the digest the owner signed is not a
// requirement: the item is blocked (PROMPT_RECORD_MISMATCH) and no planner is shown the changed text.
//
// Inputs: {repo, statusRoot, keys?, prompt, provenance: {source, author, received_at, session?, channel?}, title?,
// depends_on?}. Outputs: {item, prompt_sha256, record, created, authorized, status_entry, why?}.
// authorizePrompt({repo, statusRoot, keys?, item, title?, depends_on?}) is the same registration for a prompt that is
// already recorded: the candidate's own text and provenance, named by its identity.
// Must never: create a status ledger; sign anything with a key it was not given; alter the prompt's text; treat a
// record, a flag or a provenance field as authorization; dispatch anything (the scheduler does).
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {openStatusLedger} from '../../packages/ledger/status.mjs';
import {digest} from '../../packages/ledger/canonical.mjs';

export const PROMPT_SCHEMA = 'ophanim.prompt-intake/v1';
/** Where the verbatim records live, relative to the repository root (beside tickets/). */
export const PROMPT_DIR = 'intake/prompts';
/** The largest prompt kept: a prompt is a request, not an archive. */
export const PROMPT_MAX_BYTES = 262144;
export const PROVENANCE_KEYS = Object.freeze(['source', 'author', 'received_at', 'session', 'channel']);
const ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const SOURCE = /^[a-z][a-z0-9-]{0,31}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const str = v => typeof v === 'string' && v.trim() !== '';
const oneLine = v => str(v) && !/[\r\n]/.test(v) && v.length <= 200;
const sha256 = text => 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');
const refuse = why => { throw Object.assign(new Error(why), {code: 'PROMPT_REFUSED'}); };
const recordPath = item => `${PROMPT_DIR}/${item}.json`;

/** Why `provenance` does not say who submitted the prompt, when, and through what, or null. */
export function provenanceRefusal(p) {
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return 'provenance is an object {source, author, received_at, session?, channel?}';
  for (const k of Object.keys(p)) if (!PROVENANCE_KEYS.includes(k)) return `provenance: unknown key "${k}"`;
  if (!SOURCE.test(p.source ?? '')) return 'provenance.source is a short source id (cli, session, api, webhook, ...)';
  if (!oneLine(p.author)) return 'provenance.author names who submitted the prompt (one line)';
  if (!ISO.test(p.received_at ?? '') || Number.isNaN(Date.parse(p.received_at))) return 'provenance.received_at is the UTC time the prompt was received (YYYY-MM-DDTHH:MM:SS[.mmm]Z)';
  for (const k of ['session', 'channel']) if (p[k] !== undefined && !oneLine(p[k])) return `provenance.${k} is one line`;
  return null;
}

/**
 * The work identity of one submission: {item, prompt_sha256}. Pure. 128 bits of the digest of the text's digest and the
 * WHOLE provenance: the item id the owner signs for therefore binds both, and a record is the signed one only while it
 * still makes that identity (recordRefusal).
 */
export function promptIdentity({prompt, provenance}) {
  const prompt_sha256 = sha256(prompt);
  return {item: 'prompt-' + digest({schema: PROMPT_SCHEMA, prompt_sha256, provenance}).slice(0, 32), prompt_sha256};
}

/** The basis the owner signs for a prompt item: it names the record and binds its digest. */
export const promptBasis = ({record, prompt_sha256, provenance}) =>
  `Authorized prompt intake: the owner's prompt, verbatim at ${record} (${prompt_sha256}), received ${provenance.received_at} from ${provenance.author} via ${provenance.source}. The planner derives the ticket and the work units.`;
const BASIS = /^Authorized prompt intake: the owner's prompt, verbatim at (intake\/prompts\/([a-z0-9][a-z0-9.-]{0,63})\.json) \((sha256:[0-9a-f]{64})\),/;
/** The opening words of that basis. Reserved: only registerPrompt writes a basis that begins with them (stages.mjs planRefusal). */
export const PROMPT_BASIS_PREFIX = 'Authorized prompt intake:';
/** What a signed basis binds: {record, item, sha256}, or null when it is not a prompt item's basis. */
export function promptBinding(basis) {
  const m = BASIS.exec(String(basis ?? ''));
  return m ? {record: m[1], item: m[2], sha256: m[3]} : null;
}

/** Why a parsed record is not a prompt record of `item`, or null. The text's digest is recomputed, never trusted. */
function recordRefusal(rec, item) {
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec) || rec.schema !== PROMPT_SCHEMA) return `not a ${PROMPT_SCHEMA} record`;
  if (rec.item !== item) return `the record names item ${JSON.stringify(rec.item)}, not ${item}`;
  if (typeof rec.prompt !== 'string') return 'the record carries no prompt text';
  if (rec.prompt_sha256 !== sha256(rec.prompt)) return 'the record\'s text does not hash to the digest it states';
  const why = provenanceRefusal(rec.provenance);
  if (why) return `the record's ${why}`;
  // THE PROVENANCE IS BOUND TOO (independent review 2026-11-19). The owner signed for the item id, which is the
  // identity of the text AND the provenance; the planner is shown both. A record whose provenance was rewritten keeps
  // its text's digest and no longer makes its own identity.
  const made = promptIdentity({prompt: rec.prompt, provenance: rec.provenance}).item;
  return made === item ? null : `${item} is not the identity of its own text and provenance (that is ${made}); a record is not read under a name it was only filed under`;
}

/** The prompt record of `item`, as written: the parsed record, or {why} when it is absent or unreadable. */
export function readPromptRecord({repo, item}) {
  const file = path.join(repo, recordPath(item));
  if (!fs.existsSync(file)) return {why: `the prompt record ${recordPath(item)} is missing`};
  let rec;
  try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {why: `the prompt record ${recordPath(item)} is not JSON`}; }
  const why = recordRefusal(rec, item);
  return why ? {why: `the prompt record ${recordPath(item)}: ${why}`} : rec;
}

/** Every prompt record file in the repository: [{item, record: path, prompt_sha256 | null, why?}], by item. */
export function promptRecords(repo) {
  const dir = path.join(repo, PROMPT_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json') && ID.test(f.slice(0, -5))).sort().map(f => {
    const item = f.slice(0, -5), rec = readPromptRecord({repo, item});
    return {item, record: recordPath(item), prompt_sha256: rec.why ? null : rec.prompt_sha256, ...(rec.why ? {why: rec.why} : {})};
  });
}

/**
 * The verbatim requirement of an item, when its SIGNED basis binds a prompt:
 *   null                                  the item is not a prompt item (its basis is its requirement)
 *   {prompt: {text, sha256, provenance, record}}   the record is there and is the text the owner signed
 *   {why}                                 the record is missing, unreadable or NOT the text whose digest was signed
 * Only the signed basis decides: a record file alone binds nothing.
 */
export function promptRequirement({repo, requirement}) {
  const bound = promptBinding(requirement?.basis);
  if (!bound || bound.item !== requirement.item) return null;
  const rec = readPromptRecord({repo, item: requirement.item});
  if (rec.why) return {why: rec.why};
  if (rec.prompt_sha256 !== bound.sha256) return {why: `the prompt record ${bound.record} (${rec.prompt_sha256}) does not match the digest the owner signed (${bound.sha256})`};
  return {prompt: {text: rec.prompt, sha256: rec.prompt_sha256, provenance: rec.provenance, record: bound.record}};
}

/** What the planner is told about a prompt item, above the evidence: the exact words, and what was not supplied. */
export function promptSection(prompt) {
  return [`## The owner's prompt (verbatim; ${prompt.sha256}; authoritative)`, '<<<PROMPT', prompt.text, 'PROMPT',
    `provenance: ${JSON.stringify(prompt.provenance)}`,
    'This is the original requirement, in the owner\'s exact words. No ticket, plan or execution order was supplied with it: derive them.',
    'Investigate first (the evidence below, and what you retrieve), then state the problem, the scope and exclusions, the acceptance criteria and the work units.',
    'Before you add work, find what already exists: other items on the status ledger (their statuses and tickets are in the evidence), existing tickets and the modules already in the repository.',
    'Where another item already covers part of this, or this needs something another item delivers, depend on it (dependencies: [item ids]) instead of planning the same work twice, and say in `capabilities` what you reuse.',
    'The prompt says WHAT is wanted. It does not change how the work is governed: the plan schema, the review, the validation and the owner\'s signature on the outcome are as for every item.'].join('\n');
}

/**
 * Register one prompt. See the header.
 *   keys   the owner's key directory (absolute; default: the status ledger's own). With no key held there, the prompt
 *          is recorded as a candidate and nothing is signed.
 *   title  one line for the board (default: the prompt's first non-empty line, cut to 120 characters)
 */
export function registerPrompt({repo, statusRoot, keys = null, prompt, provenance, title = null, depends_on = [], now = () => new Date().toISOString()}) {
  if (!str(repo) || !str(statusRoot)) refuse('registerPrompt: pass the repository and the status ledger');
  if (!str(prompt)) refuse('prompt is the user\'s text: a non-empty string');
  const bytes = Buffer.byteLength(prompt, 'utf8');
  if (bytes > PROMPT_MAX_BYTES) refuse(`prompt is at most ${PROMPT_MAX_BYTES} bytes (this one is ${bytes}); attach long material as files the planner can read`);
  const pw = provenanceRefusal(provenance);
  if (pw) refuse(pw);
  if (title !== null && !oneLine(title)) refuse('title is one line of at most 200 characters');
  if (!Array.isArray(depends_on) || !depends_on.every(d => ID.test(d ?? ''))) refuse('depends_on lists status item ids');
  const {item, prompt_sha256} = promptIdentity({prompt, provenance});
  const record = recordPath(item), file = path.join(repo, record);
  const board = t => (title ?? t.split('\n').map(l => l.trim()).find(Boolean)).slice(0, 120);

  // The verbatim record, once. An existing record of this identity must BE this submission.
  let created = false;
  if (fs.existsSync(file)) {
    const have = readPromptRecord({repo, item});
    if (have.why || have.prompt !== prompt || digest(have.provenance) !== digest(provenance)) refuse(`${record} exists and is not this submission (${have.why ?? 'its text or provenance differs'}): it is not overwritten`);
  } else {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    const body = JSON.stringify({schema: PROMPT_SCHEMA, item, prompt, prompt_sha256, bytes, provenance, recorded_at: now()}, null, 2) + '\n';
    fs.writeFileSync(`${file}.tmp`, body); fs.renameSync(`${file}.tmp`, file);
    created = true;
  }

  // The authoritative intake: the owner's signed status entry. The ledger is never created here.
  const S = openStatusLedger({root: statusRoot, create: false, ...(keys ? {keys} : {})});
  const on = S.board().items.find(i => i.item === item);
  const out = {item, prompt_sha256, record, created};
  if (on) return {...out, authorized: true, status_entry: on.entry};
  try {
    const entry = S.set({item, title: board(prompt), state: 'Ready', basis: promptBasis({record, prompt_sha256, provenance}), checked: now().slice(0, 10), waiting_on: null,
      ...(depends_on.length ? {depends_on: [...depends_on]} : {})});
    return {...out, authorized: true, status_entry: entry};
  } catch (e) {
    // No owner key here: the prompt is data, and a candidate. Any other refusal of the ledger is the caller's to see.
    if (!/no operator or orderer key is held here/.test(String(e?.message ?? e))) throw e;
    return {...out, authorized: false, status_entry: null, why: `${String(e.message)}: the prompt is recorded as an intake candidate and is not work until the owner registers it with the status keys`};
  }
}

/**
 * Authorize a prompt that is already RECORDED, by its identity: a candidate, registered where no owner key was held.
 * The text and the provenance are the record's own, so nothing is typed again and the record is not rewritten. It is
 * the same registration as registerPrompt, and the owner's keys decide it in the same way: without them the prompt
 * stays a candidate ({authorized: false}).
 * Refused (PROMPT_REFUSED), and nothing is signed: no readable record under that identity, which includes a record filed
 * under an identity its own text and provenance do not make (readPromptRecord). A file dropped into the tree under a
 * name of its author's choosing is not that item, however consistent it is with itself.
 */
export function authorizePrompt({repo, statusRoot, keys = null, item, title = null, depends_on = [], now = undefined}) {
  if (!str(repo) || !str(statusRoot)) refuse('authorizePrompt: pass the repository and the status ledger');
  if (!ID.test(item ?? '')) refuse('authorize names a prompt item id (as `prompt` printed it)');
  const rec = readPromptRecord({repo, item});
  if (rec.why) refuse(rec.why);
  return registerPrompt({repo, statusRoot, keys, prompt: rec.prompt, provenance: rec.provenance, title, depends_on, ...(now ? {now} : {})});
}
