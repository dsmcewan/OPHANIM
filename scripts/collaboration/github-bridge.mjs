import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { sendCloud } from './cloud-transport.mjs';
import { createHash } from 'node:crypto';
import { replyHeader, MessageRefused, REPLY_SCHEMA, parseBanner, parseTarget } from './store.mjs';
const exec = promisify(execFile);
export const marker = id => `<!-- ophanim-collab-message:${id} -->`;

const seatName = who => (who === 'codex' ? 'Codex' : who === 'claude' ? 'Claude' : String(who));
/**
 * The GitHub body of an outbound message (wire format v2, issue #99): the sender's identity banner first (the one its
 * text opens with, or one that says the model and role were not stated), then the message, then the reply
 * instructions; the transport marker is the hidden last line, so a lost response is reconciled by it.
 */
export function githubBody(msg, { repo = null, target = null } = {}) {
  const lines = String(msg.text ?? '').split(/\r?\n/);
  const own = Boolean(parseBanner(lines[0] ?? ''));
  const banner = own ? lines[0] : `> **[Seat: ${seatName(msg.from)} · Model: not stated by the sender · Role: not stated by the sender]**`;
  const text = (own ? lines.slice(1) : lines).join('\n').replace(/^\s+/, '');
  const footer = `<!-- ophanim-collab-reply ${JSON.stringify({ schema: REPLY_SCHEMA, kind: 'REPLY', ack: [msg.id], ...(target ? { target } : {}) })} -->`;
  const where = target ? `${target.startsWith('pr:') ? 'pull request' : 'issue'} #${target.slice(target.indexOf(':') + 1)}` : 'this PR';
  const routeFooter = target ? `<!-- ophanim-collab-route ${JSON.stringify({ repo, target })} -->\n` : '';
  // The prose first; the copying instructions and provenance below it, collapsed; the reconcile marker last.
  return `${banner}\n\nFrom: ${msg.from}. To: ${msg.to}.\nSubject: ${msg.subject}\n\n${text}\n\n---\nPeer coordination under the owner's request to connect Codex and Claude. This message does not extend the owner's authorization. Acknowledgement means read; include separate evidence for work completed.\n\n<details>\n<summary>Reply format and provenance</summary>\n\nMessage ${msg.id}. The bridge imports replies from the configured GitHub account and delivers them into Codex thread 01a20038-f786-7011-973b-0aa57166a846. Reply on ${where}: open with your identity banner, then your response, and end with this footer as the last line:\n\n\`\`\`text\n> **[Seat: ... · Model: ... · Role: ...]**\n${footer}\n\`\`\`\n\nEarlier replies with the first line OPHANIM-COLLAB REPLY and an ACK line naming the message ID are still read${target ? ' there' : ''}.\n\n</details>\n\n${routeFooter}${marker(msg.id)}\n`;
}

export async function githubAPI(path, body, command = process.env.OPHANIM_GH ?? join(homedir(), '.local', 'bin', 'gh')) {
  const args = ['api', path];
  if (body) args.push('--method', 'POST', '--input', '-');
  // execFile does not accept stdin. Use spawn for mutation bodies so prompts never enter a shell command.
  if (!body) return JSON.parse((await exec(command, args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024 })).stdout);
  const { spawn } = await import('node:child_process');
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('GitHub request timed out; delivery outcome unknown')); }, 30000);
    child.stdout.on('data', x => { out += x; }); child.stderr.on('data', x => { err = (err + x).slice(-2000); });
    child.on('error', e => { clearTimeout(timeout); reject(e); });
    child.stdin.on('error', e => { clearTimeout(timeout); reject(e); });
    child.on('close', code => { clearTimeout(timeout); if (code) reject(new Error(`GitHub exit ${code}: ${err}`)); else { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } } });
    child.stdin.end(JSON.stringify(body));
  });
}

/**
 * The routes a config allows (issue #98): each `targets` entry (`pr:N` | `issue:N` of `config.repo`), and the legacy
 * single `pr`, which is also the route of a message sent without a target (messages already in flight).
 */
export function routesOf(config) {
  const targets = [...(config.targets ?? [])];
  for (const t of targets) if (!parseTarget(t)) throw new Error(`Invalid collaboration target in the config: ${JSON.stringify(t)} (expected pr:N or issue:N)`);
  const fallback = config.pr === undefined || config.pr === null ? null : parseTarget(`pr:${config.pr}`);
  if (config.pr !== undefined && config.pr !== null && !fallback) throw new Error(`Invalid legacy pr in the config: ${JSON.stringify(config.pr)}`);
  const allowed = new Set([...(fallback ? [fallback] : []), ...targets]);
  // ONE ITEM, ONE TARGET: issues and pull requests share one number space and one comments endpoint, so pr:N and
  // issue:N name the same timeline. A config naming one number in both forms is refused before anything is read.
  const byNumber = new Map();
  for (const t of allowed) {
    const n = t.slice(t.indexOf(':') + 1), was = byNumber.get(n);
    if (was && was !== t) throw new Error(`The collaboration config names item ${n} as both ${was} and ${t}; name it once`);
    byNumber.set(n, t);
  }
  return { allowed, fallback, routeOf: msg => msg.target ?? fallback };
}
const endpointOf = (config, target) => `repos/${config.repo}/issues/${target.slice(target.indexOf(':') + 1)}/comments`;

const MAX_SENDS = 20;
export async function githubTick(store, config, api = githubAPI, cloud = sendCloud) {
  const { allowed, fallback, routeOf } = routesOf(config);
  // Each allowlisted target's own timeline, read and imported as that target; nothing else is read. A target whose
  // read fails is set aside for this tick (its replies are not imported, its sends wait, its uncertain sends stay
  // uncertain); the other targets go on, and the tick reports every failure at its end.
  const byTarget = new Map(), failed = new Map();
  for (const target of allowed) {
    try {
      const comments = [];
      for (let page = 1; ; page++) {
        const part = await api(`${endpointOf(config, target)}?per_page=100&page=${page}`);
        comments.push(...part); if (part.length < 100) break;
      }
      byTarget.set(target, comments);
    } catch (e) { failed.set(target, `read: ${String(e?.message ?? e).slice(0, 300)}`); }
  }
  for (const [target, comments] of byTarget) for (const comment of comments) {
    if (comment.id <= config.afterComment || !config.allowedAuthors.includes(comment.user?.login) || !replyHeader(comment.body)) continue;
    const hash = createHash('sha256').update(comment.body).digest('hex');
    const key = `rejected-comment-${comment.id}-${hash}`;
    if (store.meta(key)) continue;
    try { store.importComment(comment, config.allowedAuthors, { target, routeOf }); }
    catch (error) {
      if (!(error instanceof MessageRefused)) throw error;
      store.transaction(() => {
        if (store.meta(key)) return;
        const evidence = { comment_id: comment.id, url: comment.html_url, sha256: hash, reason: error.message };
        store.event(null, 'github-import-rejected', 'github', evidence);
        store.meta(key, evidence);
      });
    }
  }
  for (const pending of store.uncertain('github')) {
    const found = (byTarget.get(routeOf(pending)) ?? []).find(c => config.allowedAuthors.includes(c.user?.login) && c.body?.includes(marker(pending.id)));
    if (found) store.finishDelivery(pending.id, 'delivered', { url: found.html_url, comment_id: found.id, reconciled: true });
  }
  const route = config.outboundTransport ?? 'github';
  // SELECTION FILTERS, THEN TAKES. Refusals: at most MAX_SENDS unroutable messages per tick, from their own query.
  // Sends: the oldest MAX_SENDS messages routed to a target that was read this tick, chosen in the query, so no
  // backlog for a failed or unconfigured target, however long, delays them.
  for (const msg of store.unroutedOutbox(route, { allowed, fallback, limit: MAX_SENDS })) {
    store.refuseDelivery(msg.id, { reason: 'NO_ROUTE', target: msg.target ?? null, allowed: [...allowed].sort() });
  }
  const sendable = [...allowed].filter(t => !failed.has(t));
  for (const msg of sendable.length ? store.routedOutbox(route, { targets: sendable, fallback, limit: MAX_SENDS }) : []) {
    const target = routeOf(msg);
    // A target whose send failed earlier in this tick gets no further write this tick.
    if (failed.has(target)) continue;
    store.beginDelivery(msg.id, route);
    const body = githubBody(msg, { repo: config.repo, target: msg.target ? target : null });
    try {
      if (route === 'claude-cloud') {
        const posted = await cloud(config, body);
        store.finishDelivery(msg.id, 'delivered', { transport: route, ...posted });
      } else {
        const posted = await api(endpointOf(config, target), { body });
        store.finishDelivery(msg.id, 'delivered', { url: posted.html_url, comment_id: posted.id });
      }
    } catch (e) {
      // The send may have reached GitHub: it is held as uncertain (reconciled by its marker, never replayed), and no
      // further write goes to that target this tick; the other targets' messages are still sent.
      store.finishDelivery(msg.id, 'uncertain', { reason: e.message });
      failed.set(target, `send: ${String(e?.message ?? e).slice(0, 300)}`);
    }
  }
  const health = { checked_at: Date.now(), ok: failed.size === 0, targets: [...allowed].sort(), imported_comments: [...byTarget.values()].reduce((n, c) => n + c.length, 0),
    ...(failed.size ? { failed_targets: Object.fromEntries(failed) } : {}) };
  store.meta('github-health', health);
  if (failed.size) throw Object.assign(new Error(`GitHub targets failed this tick: ${[...failed].map(([t, why]) => `${t}: ${why.replace(/^(read|send): /, '')}`).join('; ')}`), { healthRecorded: true });
}

export async function runGithubBridge(store, config, once = false) {
  store.recoverDeliveries('github');
  store.recoverDeliveries('claude-cloud');
  do {
    try { await githubTick(store, config); }
    catch (e) { if (!e.healthRecorded) store.meta('github-health', { checked_at: Date.now(), ok: false, error: e.message }); console.error(e.message); if (once) throw e; }
    if (!once) await new Promise(resolve => setTimeout(resolve, config.pollMs ?? 15000));
  } while (!once);
}
