import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from './server.js';
import { DEFAULT_QUICK_COMMANDS } from './quick-commands.js';
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
const QC_FILE = path.join(os.tmpdir(), 'qc-srv-' + Math.random().toString(36).slice(2, 8) + '.json');
const { server, port } = await createServer({ port: 0, socketName: SRV_SOCKET, quickCommandsFile: QC_FILE });

afterAll(() => {
  fs.rmSync(QC_FILE, { force: true });
  return new Promise<void>((r) => server.close(() => {
    tmux.killServerSync({ socketName: SRV_SOCKET });
    r();
  }));
});

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

  it('GET /api/quick-commands 文件不存在 → 默认命令', async () => {
    const r = await fetch(`http://localhost:${port}/api/quick-commands`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(DEFAULT_QUICK_COMMANDS);
  });

  it('PUT /api/quick-commands 写入后 GET 读回', async () => {
    const put = await fetch(`http://localhost:${port}/api/quick-commands`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(['a', 'b']),
    });
    expect(put.status).toBe(200);
    const get = await fetch(`http://localhost:${port}/api/quick-commands`);
    expect(await get.json()).toEqual(['a', 'b']);
  });

  it('PUT 非字符串数组 → 400', async () => {
    const r = await fetch(`http://localhost:${port}/api/quick-commands`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify([1, 2]),
    });
    expect(r.status).toBe(400);
  });

  it('PUT 在 Claude 代理之前被拦截（路由顺序）', async () => {
    const r = await fetch(`http://localhost:${port}/api/quick-commands`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(['x']),
    });
    expect(r.status).toBe(200);
  });
});
