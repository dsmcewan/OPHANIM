import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_DB = join(dirname(fileURLToPath(import.meta.url)), 'state', 'collaboration.sqlite');
export const agent = value => {
  if (!['codex', 'claude'].includes(value)) throw new Error('Unknown collaboration agent');
  return value;
};
const bounded = (value, name, max, fallback) => {
  value ??= fallback;
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) throw new Error(`${name} missing or too long (maximum size ${max} bytes)`);
  return value;
};

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
    if (from === to) throw new Error('Messages require different sender and recipient');
    const key = bounded(input.key, 'request key', 160);
    const payload = {
      from, to, subject: bounded(input.subject, 'subject', 200, 'Collaboration message'),
      text: bounded(input.text, 'text', 32768), replyTo: input.replyTo ?? null,
      provenance: input.provenance ?? { transport: 'local', identity: 'same-owner process; role is asserted' },
    };
    if (Buffer.byteLength(JSON.stringify(payload)) > 40000) throw new Error('Message payload too long');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM messages WHERE from_agent=? AND request_key=?').get(from, key);
      if (existing) {
        if (existing.payload !== JSON.stringify(payload)) throw new Error('Idempotency key conflict: payload changed');
        return this.decode(existing);
      }
      if (payload.replyTo && !this.get(payload.replyTo)) throw new Error('Unknown reply target');
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
    if (!allowedAuthors.includes(author) || !/^OPHANIM-COLLAB (?:REPLY|ACK)\b/m.test(comment.body ?? '')) return null;
    // Authenticates the GitHub account, not a model or cloud session. The envelope retains that distinction.
    const revision = createHash('sha256').update(comment.body).digest('hex').slice(0, 20);
    const legacy = this.decode(this.db.prepare('SELECT * FROM messages WHERE from_agent=? AND request_key=?').get('claude', `github-comment-${comment.id}`));
    const imported = legacy?.text === comment.body ? legacy : this.send({ from: 'claude', to: 'codex', key: `github-comment-${comment.id}-${revision}`,
      subject: 'Claude GitHub reply', text: comment.body,
      provenance: { transport: 'github', author, comment_id: comment.id, url: comment.html_url ?? comment.url, revision, identity: 'GitHub account verified; agent role asserted' } });
    for (const match of comment.body.matchAll(/\bACK\s+([0-9a-f-]{36})\b/gi)) {
      const original = this.get(match[1]);
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
      bridge: this.meta('github-health'), desktop: this.meta('desktop-health'),
    };
  }
}
