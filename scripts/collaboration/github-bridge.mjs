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
  return { allowed, fallback, routeOf: msg => msg.target ?? fallback };
}
const endpointOf = (config, target) => `repos/${config.repo}/issues/${target.slice(target.indexOf(':') + 1)}/comments`;

export async function githubTick(store, config, api = githubAPI, cloud = sendCloud) {
  const { allowed, routeOf } = routesOf(config);
  // Each allowlisted target's own timeline, read and imported as that target; nothing else is read.
  const byTarget = new Map();
  for (const target of allowed) {
    const comments = [];
    for (let page = 1; ; page++) {
      const part = await api(`${endpointOf(config, target)}?per_page=100&page=${page}`);
      comments.push(...part); if (part.length < 100) break;
    }
    byTarget.set(target, comments);
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
  for (const msg of store.outbox(route)) {
    const target = routeOf(msg);
    // NO ROUTE: a target the config does not allow (or no target and no legacy PR) is refused, never sent or retried.
    if (!target || !allowed.has(target)) {
      store.refuseDelivery(msg.id, { reason: 'NO_ROUTE', target: msg.target ?? null, allowed: [...allowed].sort() });
      continue;
    }
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
      store.finishDelivery(msg.id, 'uncertain', { reason: e.message });
      throw e;
    }
  }
  store.meta('github-health', { checked_at: Date.now(), ok: true, targets: [...allowed].sort(), imported_comments: [...byTarget.values()].reduce((n, c) => n + c.length, 0) });
}

export async function runGithubBridge(store, config, once = false) {
  store.recoverDeliveries('github');
  store.recoverDeliveries('claude-cloud');
  do {
    try { await githubTick(store, config); }
    catch (e) { store.meta('github-health', { checked_at: Date.now(), ok: false, error: e.message }); console.error(e.message); if (once) throw e; }
    if (!once) await new Promise(resolve => setTimeout(resolve, config.pollMs ?? 15000));
  } while (!once);
}
