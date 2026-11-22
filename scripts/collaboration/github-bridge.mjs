import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { sendCloud } from './cloud-transport.mjs';
import { createHash } from 'node:crypto';
import { replyHeader, MessageRefused, REPLY_SCHEMA } from './store.mjs';
const exec = promisify(execFile);
export const marker = id => `<!-- ophanim-collab-message:${id} -->`;

const SENDER_BANNER = /^> \*\*\[Seat: [^\]\n]+\]\*\*$/;
const seatName = who => (who === 'codex' ? 'Codex' : who === 'claude' ? 'Claude' : String(who));
/**
 * The GitHub body of an outbound message (wire format v2, issue #99): the sender's identity banner first (the one its
 * text opens with, or one that says the model and role were not stated), then the message, then the reply
 * instructions; the transport marker is the hidden last line, so a lost response is reconciled by it.
 */
export function githubBody(msg) {
  const lines = String(msg.text ?? '').split(/\r?\n/);
  const own = SENDER_BANNER.test(lines[0] ?? '');
  const banner = own ? lines[0] : `> **[Seat: ${seatName(msg.from)} · Model: not stated by the sender · Role: not stated by the sender]**`;
  const text = (own ? lines.slice(1) : lines).join('\n').replace(/^\s+/, '');
  const footer = `<!-- ophanim-collab-reply ${JSON.stringify({ schema: REPLY_SCHEMA, kind: 'REPLY', ack: [msg.id] })} -->`;
  return `${banner}\n\nFrom: ${msg.from}. To: ${msg.to}. Message ${msg.id}.\nSubject: ${msg.subject}\n\n${text}\n\n---\nPeer coordination under the owner's request to connect Codex and Claude. This message does not extend the owner's authorization. Reply on this PR: open with your identity banner (\`> **[Seat: ... · Model: ... · Role: ...]**\`), then your response, and end with this footer as the last line: \`${footer}\`. Earlier replies with the first line \`OPHANIM-COLLAB REPLY\` and \`ACK ${msg.id}\` on its own line are still read. The bridge imports replies from the configured GitHub account and delivers them into Codex thread 01a20038-f786-7011-973b-0aa57166a846. Acknowledgement means read; include separate evidence for work completed.\n\n${marker(msg.id)}\n`;
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

export async function githubTick(store, config, api = githubAPI, cloud = sendCloud) {
  const endpoint = `repos/${config.repo}/issues/${config.pr}/comments`;
  const comments = [];
  for (let page = 1; ; page++) {
    const part = await api(`${endpoint}?per_page=100&page=${page}`);
    comments.push(...part); if (part.length < 100) break;
  }
  for (const comment of comments) {
    if (comment.id <= config.afterComment || !config.allowedAuthors.includes(comment.user?.login) || !replyHeader(comment.body)) continue;
    const hash = createHash('sha256').update(comment.body).digest('hex');
    const key = `rejected-comment-${comment.id}-${hash}`;
    if (store.meta(key)) continue;
    try { store.importComment(comment, config.allowedAuthors); }
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
    const found = comments.find(c => config.allowedAuthors.includes(c.user?.login) && c.body?.includes(marker(pending.id)));
    if (found) store.finishDelivery(pending.id, 'delivered', { url: found.html_url, comment_id: found.id, reconciled: true });
  }
  const route = config.outboundTransport ?? 'github';
  for (const msg of store.outbox(route)) {
    store.beginDelivery(msg.id, route);
    try {
      if (route === 'claude-cloud') {
        const posted = await cloud(config, githubBody(msg));
        store.finishDelivery(msg.id, 'delivered', { transport: route, ...posted });
      } else {
        const posted = await api(endpoint, { body: githubBody(msg) });
        store.finishDelivery(msg.id, 'delivered', { url: posted.html_url, comment_id: posted.id });
      }
    } catch (e) {
      store.finishDelivery(msg.id, 'uncertain', { reason: e.message });
      throw e;
    }
  }
  store.meta('github-health', { checked_at: Date.now(), ok: true, imported_comments: comments.length });
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
