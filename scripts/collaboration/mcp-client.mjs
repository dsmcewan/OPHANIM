import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class MCPClient {
  constructor(command, args = [], options = {}) {
    this.pending = new Map(); this.nextId = 0;
    this.child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...options });
    this.stderr = '';
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-2000); });
    this.child.on('error', e => this.rejectAll(e));
    this.child.stdin.on('error', e => this.rejectAll(e));
    this.child.on('exit', code => this.rejectAll(new Error(`MCP process exited ${code}: ${this.stderr}`)));
    createInterface({ input: this.child.stdout }).on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      const waiting = this.pending.get(msg.id);
      if (waiting) {
        clearTimeout(waiting.timer); this.pending.delete(msg.id);
        if (msg.error) waiting.reject(new Error(msg.error.message)); else waiting.resolve(msg.result);
      }
    });
  }
  rejectAll(error) {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
  }
  request(method, params = {}, timeout = 15000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP request timed out: ${method}; outcome may be unknown`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  async initialize() {
    const result = await this.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ophanim-collaboration', version: '0.1.0' } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return result;
  }
  async call(name, args, threadId) {
    const result = await this.request('tools/call', {
      name, arguments: args,
      ...(threadId ? { _meta: { 'x-codex-turn-metadata': { thread_id: threadId } } } : {}),
    }, 30000);
    if (result.isError) throw new Error(result.content?.filter(x => x.type === 'text').map(x => x.text).join('\n') ?? 'MCP tool failed');
    return result;
  }
  close() { this.rejectAll(new Error('MCP client closed')); this.child.kill(); }
}
