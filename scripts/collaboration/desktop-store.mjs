import { createInterface } from 'node:readline';

// Private stdio worker for the Windows companion. One WSL process and SQLite connection, no listener or shell.
export function serveDesktopStore(store) {
  const reply = (id, result, error) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }) + '\n');
  createInterface({ input: process.stdin }).on('line', line => {
    let request;
    try { request = JSON.parse(line); } catch { reply(null, null, { code: -32700, message: 'Invalid JSON' }); return; }
    if (!request || request.id === undefined) return;
    try {
      if (request.method === 'initialize') {
        reply(request.id, { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'ophanim-desktop-store', version: '0.1.0' } }); return;
      }
      if (request.method !== 'desktop/call') throw new Error('Unknown desktop store method');
      const p = request.params ?? {};
      let result;
      switch (p.op) {
        case 'outbox': result = store.outbox('desktop'); break;
        case 'delivery-begin': result = store.beginDelivery(p.id, 'desktop'); break;
        case 'delivery-finish': result = store.finishDelivery(p.id, p.state, p.evidence ?? {}); break;
        case 'delivery-recover': result = store.recoverDeliveries('desktop'); break;
        case 'health': result = store.meta('desktop-health', p.evidence); break;
        default: throw new Error('Operation is not exposed by the desktop store');
      }
      reply(request.id, result);
    } catch (e) { reply(request.id, null, { code: -32602, message: e.message }); }
  }).on('close', () => store.close());
}
