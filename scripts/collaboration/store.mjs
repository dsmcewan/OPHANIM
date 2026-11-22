import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_DB = join(dirname(fileURLToPath(import.meta.url)), 'state', 'collaboration.sqlite');
// Rejected messages are distinct from transient database failures, which must remain retryable.
export class MessageRefused extends Error {}
export const agent = value => {
  if (!['codex', 'claude'].includes(value)) throw new MessageRefused('Unknown collaboration agent');
  return value;
};
const bounded = (value, name, max, fallback) => {
  value ??= fallback;
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) throw new MessageRefused(`${name} missing or too long (maximum size ${max} bytes)`);
  return value;
};

// A message ID as the store issues it (randomUUID): lower-case hex in the 8-4-4-4-12 layout, nothing joined to it.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const isMessageId = value => typeof value === 'string' && new RegExp(`^${UUID}$`).test(value);
// WIRE FORMAT v2 (issue #99). The visible body opens with the sender's identity banner; the protocol metadata is a
// strict typed HTML footer on the LAST line, invisible when rendered, so an ACK ID keeps its own boundary however the
// prose around it is rendered (GitHub joins adjacent lines into one paragraph):
//   > **[Seat: <seat> · Model: <model> · Role: <role>]**
//   ...
//   <!-- ophanim-collab-reply {"schema":"ophanim.collaboration.reply/v2","kind":"REPLY","ack":["<uuid>", ...]} -->
// The footer has exactly those keys; kind is REPLY or ACK; ack is a list of distinct message IDs. Anything else is not a
// protocol reply. The legacy form (first line OPHANIM-COLLAB REPLY|ACK, then ACK <uuid> lines up to the first blank
// line) is still read, for replies already in flight.
export const REPLY_SCHEMA = 'ophanim.collaboration.reply/v2';
const BANNER = /^> \*\*\[(Seat: [^\]\n]+)\]\*\*$/;
const FOOTER = /^<!-- ophanim-collab-reply (\{.*\}) -->$/;
const MAX_ACKS = 16;
function footerHeader(lines) {
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') last--;
  const f = last >= 0 ? FOOTER.exec(lines[last]) : null;
  if (!f) return null;
  let meta;
  try { meta = JSON.parse(f[1]); } catch { return null; }
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return null;
  if (Object.keys(meta).sort().join(',') !== 'ack,kind,schema' || meta.schema !== REPLY_SCHEMA || !['REPLY', 'ACK'].includes(meta.kind)) return null;
  if (!Array.isArray(meta.ack) || meta.ack.length > MAX_ACKS || !meta.ack.every(isMessageId) || new Set(meta.ack).size !== meta.ack.length) return null;
  const first = lines.findIndex(l => l.trim() !== '');
  const banner = first >= 0 ? BANNER.exec(lines[first]) : null;
  if (!banner) return null;
  return { kind: meta.kind, acknowledgements: [...meta.ack], format: 'v2', identity: banner[0].slice(2) };
}
export function replyHeader(body) {
  if (typeof body !== 'string') return null;
  const lines = body.replace(/^\uFEFF/, '').split(/\r?\n/);
  // An explicit legacy first line is read as legacy, whatever it quotes; otherwise only a v2 footer makes a reply.
  const header = new RegExp(`^OPHANIM-COLLAB (REPLY|ACK)(?: (\\S+))?$`).exec(lines[0]);
  if (!header) return footerHeader(lines);
  const acknowledgements = header[2] && isMessageId(header[2]) ? [header[2]] : [];
  for (const line of lines.slice(1)) {
    if (line === '') break;
    const match = /^ACK (\S+)$/.exec(line);
    if (match && isMessageId(match[1])) acknowledgements.push(match[1]);
  }
  return { kind: header[1], acknowledgements, format: 'legacy' };
}
/** A v2 reply body: the banner, the text, and the typed footer as the last line. Refuses a bad banner or ID. */
export function formatReply({ banner, text, acks = [], kind = 'REPLY' }) {
  if (typeof banner !== 'string' || !BANNER.test(banner)) throw new MessageRefused('A reply opens with an identity banner: > **[Seat: ... · Model: ... · Role: ...]**');
  if (!['REPLY', 'ACK'].includes(kind)) throw new MessageRefused('A reply kind is REPLY or ACK');
  if (!Array.isArray(acks) || acks.length > MAX_ACKS || !acks.every(isMessageId) || new Set(acks).size !== acks.length) throw new MessageRefused(`ACK takes up to ${MAX_ACKS} distinct message IDs, each exactly as issued`);
  const body = String(text ?? '').replace(/\s+$/, '');
  return `${banner}\n\n${body}\n\n<!-- ophanim-collab-reply ${JSON.stringify({ schema: REPLY_SCHEMA, kind, ack: acks })} -->\n`;
}

export class Store {
  constructor(path = process.env.OPHANIM_COLLAB_DB ?? DEFAULT_DB, now = Date.now) {
    this.now = now;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (process.platform !== 'win32') chmodSync(path, 0o600);
    this.db.exec('PRAGMA busy_timeout=5000');
    // SQLite may refuse journal changes immediately even with busy_timeout. Retry only idempotent schema setup.
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        this.db.exec('PRAGMA journal_mode=WAL');
        break;
      } catch (e) {
        if (![5, 6].includes(e.errcode) || Date.now() >= deadline) { this.db.close(); throw e; }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    this.db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
        request_key TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
        acknowledged_at INTEGER, delivery_state TEXT NOT NULL DEFAULT 'queued', route TEXT,
        delivery_evidence TEXT, UNIQUE(from_agent, request_key));
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, kind TEXT NOT NULL,
        actor TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS claims (
        resource TEXT PRIMARY KEY, owner TEXT NOT NULL, token TEXT NOT NULL,
        generation INTEGER NOT NULL, expires_at INTEGER NOT NULL, released INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  event(id, kind, actor, data = {}) {
    this.db.prepare('INSERT INTO events(message_id,kind,actor,data,created_at) VALUES(?,?,?,?,?)').run(id, kind, actor, JSON.stringify(data), this.now());
  }
  decode(row) {
    if (!row) return null;
    const { payload, delivery_evidence, ...rest } = row;
    return { ...rest, ...JSON.parse(payload), delivery_evidence: delivery_evidence ? JSON.parse(delivery_evidence) : null };
  }
  get(id) { return this.decode(this.db.prepare('SELECT * FROM messages WHERE id=?').get(id)); }
  send(input) {
    const from = agent(input.from), to = agent(input.to);
    if (from === to) throw new MessageRefused('Messages require different sender and recipient');
    const key = bounded(input.key, 'request key', 160);
    const payload = {
      from, to, subject: bounded(input.subject, 'subject', 200, 'Collaboration message'),
      text: bounded(input.text, 'text', 32768), replyTo: input.replyTo ?? null,
      provenance: input.provenance ?? { transport: 'local', identity: 'same-owner process; role is asserted' },
    };
    if (Buffer.byteLength(JSON.stringify(payload)) > 40000) throw new MessageRefused('Message payload too long');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM messages WHERE from_agent=? AND request_key=?').get(from, key);
      if (existing) {
        if (existing.payload !== JSON.stringify(payload)) throw new MessageRefused('Idempotency key conflict: payload changed');
        return this.decode(existing);
      }
      if (payload.replyTo && !this.get(payload.replyTo)) throw new MessageRefused('Unknown reply target');
      const id = randomUUID();
      this.db.prepare('INSERT INTO messages(id,from_agent,to_agent,request_key,payload,created_at) VALUES(?,?,?,?,?,?)')
        .run(id, from, to, key, JSON.stringify(payload), this.now());
      this.event(id, 'queued', from, { to, subject: payload.subject });
      return this.get(id);
    });
  }
  inbox(who, all = false) {
    return this.db.prepare(`SELECT * FROM messages WHERE to_agent=? ${all ? '' : 'AND acknowledged_at IS NULL'} ORDER BY created_at,id LIMIT 100`).all(agent(who)).map(r => this.decode(r));
  }
  ack(who, id, note = 'Read') {
    agent(who); bounded(note, 'acknowledgement note', 4000);
    return this.transaction(() => {
      const msg = this.get(id);
      if (!msg || msg.to !== who) throw new Error('Only the message recipient may acknowledge it');
      if (msg.acknowledged_at === null) {
        if (['dispatching', 'uncertain'].includes(msg.delivery_state)) {
          const evidence = { basis: 'Explicit recipient acknowledgement proves receipt', note, previous_state: msg.delivery_state };
          this.db.prepare("UPDATE messages SET delivery_state='delivered',delivery_evidence=? WHERE id=?").run(JSON.stringify(evidence), id);
          this.event(id, 'delivered', who, evidence);
        }
        this.db.prepare('UPDATE messages SET acknowledged_at=? WHERE id=?').run(this.now(), id);
        this.event(id, 'acknowledged', who, { note });
      }
      return this.get(id);
    });
  }
  outbox(route) {
    const to = ['github', 'claude-cloud'].includes(route) ? 'claude' : route === 'desktop' ? 'codex' : null;
    if (!to) throw new Error('Unknown delivery route');
    return this.db.prepare("SELECT * FROM messages WHERE to_agent=? AND acknowledged_at IS NULL AND delivery_state='queued' ORDER BY created_at,id LIMIT 20").all(to).map(r => this.decode(r));
  }
  beginDelivery(id, route) {
    return this.transaction(() => {
      const msg = this.get(id);
      if (!msg || msg.acknowledged_at !== null || msg.delivery_state !== 'queued' || !this.outbox(route).some(m => m.id === id)) throw new Error('Delivery already claimed or unavailable');
      this.db.prepare("UPDATE messages SET delivery_state='dispatching',route=? WHERE id=?").run(route, id);
      this.event(id, 'dispatching', route);
      return this.get(id);
    });
  }
  finishDelivery(id, state, evidence = {}) {
    if (!['delivered', 'uncertain'].includes(state)) throw new Error('Invalid delivery state');
    return this.transaction(() => {
      const msg = this.get(id);
      if (msg?.delivery_state === 'delivered' && msg.acknowledged_at !== null) {
        this.event(id, 'delivery-transport-result', msg.route, { reported_state: state, evidence });
        return msg;
      }
      if (!msg || !['dispatching', 'uncertain'].includes(msg.delivery_state)) throw new Error('No active delivery to finish');
      this.db.prepare('UPDATE messages SET delivery_state=?,delivery_evidence=? WHERE id=?').run(state, JSON.stringify(evidence), id);
      this.event(id, state, msg.route, evidence);
      return this.get(id);
    });
  }
  recoverDeliveries(route) {
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT id FROM messages WHERE route=? AND delivery_state='dispatching'").all(route);
      for (const { id } of rows) {
        this.db.prepare("UPDATE messages SET delivery_state='uncertain' WHERE id=?").run(id);
        this.event(id, 'uncertain', route, { reason: 'Previous dispatcher stopped without a delivery receipt; reconcile, never replay automatically.' });
      }
      return rows.length;
    });
  }
  uncertain(route) { return this.db.prepare("SELECT * FROM messages WHERE route=? AND delivery_state='uncertain'").all(route).map(r => this.decode(r)); }
  resolveDelivery(id, state, evidence) {
    if (!['delivered', 'queued'].includes(state)) throw new Error('Resolution state must be delivered or queued');
    bounded(evidence?.basis, 'resolution evidence', 4000);
    return this.transaction(() => {
      const msg = this.get(id);
      if (!msg || msg.delivery_state !== 'uncertain') throw new Error('Only an uncertain delivery can be resolved');
      this.db.prepare('UPDATE messages SET delivery_state=?,route=?,delivery_evidence=? WHERE id=?')
        .run(state, state === 'queued' ? null : msg.route, JSON.stringify(evidence), id);
      this.event(id, 'delivery-resolved', 'operator', { state, ...evidence });
      return this.get(id);
    });
  }
  events(id = null) {
    return this.db.prepare(`SELECT * FROM events ${id ? 'WHERE message_id=?' : ''} ORDER BY seq DESC LIMIT 200`).all(...(id ? [id] : [])).map(r => ({ ...r, data: JSON.parse(r.data) }));
  }
  claim(resource, who, ttl = 900000) {
    agent(who); bounded(resource, 'resource', 300); this.checkTTL(ttl);
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM claims WHERE resource=?').get(resource);
      if (old && !old.released && old.expires_at > this.now()) throw new Error(`Resource claimed by ${old.owner} until ${old.expires_at}`);
      const value = { resource, owner: who, token: randomUUID(), generation: (old?.generation ?? 0) + 1, expires_at: this.now() + ttl, released: 0 };
      this.db.prepare('INSERT OR REPLACE INTO claims VALUES(?,?,?,?,?,?)').run(...Object.values(value));
      this.event(null, 'claim', who, value);
      return value;
    });
  }
  checkTTL(ttl) { if (!Number.isInteger(ttl) || ttl < 1000 || ttl > 3600000) throw new Error('Lease ttl must be 1000..3600000 ms'); }
  owned(resource, who, token) {
    const value = this.db.prepare('SELECT * FROM claims WHERE resource=?').get(resource);
    if (!value || value.released || value.owner !== agent(who) || value.token !== token || value.expires_at <= this.now()) throw new Error('Stale or invalid claim token');
    return value;
  }
  renew(resource, who, token, ttl = 900000) {
    this.checkTTL(ttl);
    return this.transaction(() => {
      this.owned(resource, who, token);
      this.db.prepare('UPDATE claims SET expires_at=? WHERE resource=?').run(this.now() + ttl, resource);
      this.event(null, 'renew', who, { resource, token });
      return this.db.prepare('SELECT * FROM claims WHERE resource=?').get(resource);
    });
  }
  release(resource, who, token) {
    return this.transaction(() => {
      this.owned(resource, who, token);
      this.db.prepare('UPDATE claims SET released=1 WHERE resource=?').run(resource);
      this.event(null, 'release', who, { resource, token });
      return { resource, released: true };
    });
  }
  importComment(comment, allowedAuthors) {
    const author = comment.user?.login;
    const header = replyHeader(comment.body);
    if (!allowedAuthors.includes(author) || !header) return null;
    // Authenticates the GitHub account, not a model or cloud session. The envelope retains that distinction.
    const revision = createHash('sha256').update(comment.body).digest('hex').slice(0, 20);
    const legacy = this.decode(this.db.prepare('SELECT * FROM messages WHERE from_agent=? AND request_key=?').get('claude', `github-comment-${comment.id}`));
    const imported = legacy?.text === comment.body ? legacy : this.send({ from: 'claude', to: 'codex', key: `github-comment-${comment.id}-${revision}`,
      subject: 'Claude GitHub reply', text: comment.body,
      provenance: { transport: 'github', author, comment_id: comment.id, url: comment.html_url ?? comment.url, revision, identity: 'GitHub account verified; agent role asserted',
        format: header.format, ...(header.identity ? { asserted_identity: header.identity } : {}) } });
    for (const id of header.acknowledgements) {
      const original = this.get(id);
      if (original?.to === 'claude') this.ack('claude', original.id, `GitHub account ${author} acknowledged at ${comment.html_url ?? comment.id}`);
    }
    return imported;
  }
  meta(key, value) {
    if (value !== undefined) this.db.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)').run(key, JSON.stringify(value));
    const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : null;
  }
  status() {
    return {
      schema: 'ophanim.collaboration/v1',
      messages: this.db.prepare('SELECT to_agent,delivery_state,acknowledged_at IS NOT NULL AS acknowledged,count(*) AS count FROM messages GROUP BY to_agent,delivery_state,acknowledged').all(),
      active_claims: this.db.prepare('SELECT resource,owner,generation,expires_at FROM claims WHERE released=0 AND expires_at>?').all(this.now()),
      uncertain_deliveries: this.db.prepare("SELECT id,to_agent,route,created_at,delivery_evidence FROM messages WHERE delivery_state='uncertain' ORDER BY created_at").all(),
      bridge: this.meta('github-health'), desktop: this.meta('desktop-health'),
    };
  }
}
