import { describe, it, expect, afterAll } from 'vitest';
import { createServer } from './server.js';
import { WebSocket } from 'ws';
import * as tmux from './tmux.js';

async function waitForOpen(url: string, timeoutMs = 5000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => reject(new Error('connect timeout')), timeoutMs);
    ws.on('open', () => { clearTimeout(t); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

async function firstMsg(ws: WebSocket, predicate: (m: any) => boolean, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('message timeout')), timeoutMs);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (predicate(m)) { clearTimeout(t); resolve(m); }
    });
  });
}

const SRV_SOCKET = 'wmt-test-srv-' + Math.random().toString(36).slice(2, 8);
const { server, port } = await createServer({ port: 0, socketName: SRV_SOCKET });

afterAll(() => new Promise<void>((r) => server.close(() => {
  tmux.killServerSync({ socketName: SRV_SOCKET });
  r();
})));

describe('server integration', () => {
  it('create→input→data 端到端', async () => {
    const ws = await waitForOpen(`ws://localhost:${port}/ws`);
    ws.send(JSON.stringify({ type: 'create', cols: 80, rows: 24 }));
    const created = await firstMsg(ws, (m) => m.type === 'created');
    ws.send(JSON.stringify({ type: 'input', sessionId: created.sessionId, data: 'echo INTMARK_99\n' }));
    const data = await firstMsg(ws, (m) => m.type === 'data' && m.payload.includes('INTMARK_99'));
    expect(data.payload).toContain('INTMARK_99');
    ws.close();
  });
});
