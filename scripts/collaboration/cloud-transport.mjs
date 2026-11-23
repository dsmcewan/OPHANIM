import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Official Claude Code follow-up transport. Uses the owner's existing account login; no relay model call.
export async function sendCloud(config, text) {
  if (!/^session_[A-Za-z0-9]+$/.test(config.claudeSessionId ?? '')) throw new Error('Invalid configured Claude cloud session');
  return await new Promise((resolve, reject) => {
    const child = spawn(config.claudeCommand ?? join(homedir(), '.local', 'bin', 'claude'),
      ['-p', '--cloud', config.claudeSessionId, '--output-format', 'json'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Claude CLI timed out; send outcome unknown')); }, 30000);
    child.stdout.on('data', x => { out += x; });
    child.stderr.on('data', x => { err = (err + x).slice(-2000); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.stdin.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code) { reject(new Error(`Claude CLI exited ${code}: ${err}`)); return; }
      try {
        const receipt = JSON.parse(out);
        if (receipt.ok !== true || receipt.session_id !== config.claudeSessionId) throw new Error('Claude CLI did not confirm the configured session');
        resolve(receipt);
      } catch (e) { reject(e); }
    });
    child.stdin.end(text);
  });
}
