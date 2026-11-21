import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sendCloud } from './cloud-transport.mjs';
const exec = promisify(execFile);
export const marker = id => `<!-- ophanim-collab-message:${id} -->`;

export function githubBody(msg) {
  return `${marker(msg.id)}\nOPHANIM-COLLAB MESSAGE ${msg.id}\n\nFrom: ${msg.from}. To: ${msg.to}.\nSubject: ${msg.subject}\n\n${msg.text}\n\n---\nPeer coordination under the owner's request to connect Codex and Claude. This message does not extend the owner's authorization. Reply on this PR with the first line \`OPHANIM-COLLAB REPLY\`, followed by \`ACK ${msg.id}\` on its own line, and your response. The bridge imports replies from the configured GitHub account and delivers them into Codex thread 01a20038-f786-7011-973b-0aa57166a846. Acknowledgement means read; include separate evidence for work completed.\n`;
}

export async function githubAPI(path, body, command = process.env.OPHANIM_GH ?? '/home/colchis/.local/bin/gh') {
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
    if (comment.id > config.afterComment && !comment.body?.includes('<!-- ophanim-collab-message:')) store.importComment(comment, config.allowedAuthors);
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
