import { describe, it, expect, afterAll } from 'vitest';
import { createServer } from './server.js';
import { WebSocket } from 'ws';
import * as tmux from './tmux.js';

const E2E_SOCKET = 'wmt-test-e2e-' + Math.random().toString(36).slice(2, 8);
const { server, port } = await createServer({ port: 0, socketName: E2E_SOCKET });
afterAll(() => new Promise<void>((r) => server.close(() => {
  tmux.killServerSync({ socketName: E2E_SOCKET });
  r();
})));

function open(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function next(ws: WebSocket, predicate: (m: any) => boolean, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (predicate(m)) { clearTimeout(t); resolve(m); }
    });
  });
}

describe('e2e', () => {
  it('两个会话独立收发，且 list + ring buffer 回放', async () => {
    const ws = await open();
    ws.send(JSON.stringify({ type: 'create', cols: 80, rows: 24 }));
    const c1 = await next(ws, (m) => m.type === 'created');
    ws.send(JSON.stringify({ type: 'input', sessionId: c1.sessionId, data: 'echo S1MARK\n' }));
    await next(ws, (m) => m.type === 'data' && m.payload.includes('S1MARK'));

    ws.send(JSON.stringify({ type: 'create', cols: 80, rows: 24 }));
    const c2 = await next(ws, (m) => m.type === 'created' && m.sessionId !== c1.sessionId);
    ws.send(JSON.stringify({ type: 'input', sessionId: c2.sessionId, data: 'echo S2MARK\n' }));
    await next(ws, (m) => m.type === 'data' && m.payload.includes('S2MARK'));

    // 新连接模拟重连，list 应返回 >=2 会话并回放含 S1MARK
    const ws2 = await open();
    ws2.send(JSON.stringify({ type: 'list' }));
    const list = await next(ws2, (m) => m.type === 'sessions');
    expect(list.items.length).toBeGreaterThanOrEqual(2);
    const replay = await next(ws2, (m) => m.type === 'data' && m.payload.includes('S1MARK'));
    expect(replay.payload).toContain('S1MARK');

    ws.close(); ws2.close();
  });
});
