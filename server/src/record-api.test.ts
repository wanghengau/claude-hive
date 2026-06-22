import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from './server.js';

let tmp: string;
let server: http.Server;
let port: number;
beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  process.env.RECORD_LOG_DIR = tmp;
  // 预置数据
  fs.mkdirSync(path.join(tmp, 'wmt-b2', '2026-06-22'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'wmt-b2', '2026-06-22', '100000-aaaa.json'),
    JSON.stringify({ id: '100000-aaaa', windowId: 'wmt-b2', ts: '2026-06-22T02:00:00Z', model: 'glm-5.2', request: { model: 'glm-5.2' }, response: { usage: { input_tokens: 10, output_tokens: 5 } }, meta: { status: 200 } }));
  ({ server, port } = await createServer({ port: 0 }));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

function get(p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    http.get(`http://127.0.0.1:${port}${p}`, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
  });
}

describe('record API', () => {
  it('GET /api/record/counts 返回 { windowId: count }', async () => {
    const { status, body } = await get('/api/record/counts');
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ 'wmt-b2': 1 });
  });
  it('GET /api/record/list?window=wmt-b2 返回该窗口摘要列表', async () => {
    const { status, body } = await get('/api/record/list?window=wmt-b2');
    expect(status).toBe(200);
    const list = JSON.parse(body);
    expect(list[0].id).toBe('100000-aaaa');
    expect(list[0].model).toBe('glm-5.2');
  });
  it('GET /api/record/list 缺 window 默认 default，返回空数组', async () => {
    const { body } = await get('/api/record/list');
    expect(JSON.parse(body)).toEqual([]);
  });
  it('GET /api/record/wmt-b2/2026-06-22/100000-aaaa 返回完整 JSON', async () => {
    const { status, body } = await get('/api/record/wmt-b2/2026-06-22/100000-aaaa');
    expect(status).toBe(200);
    expect(JSON.parse(body).windowId).toBe('wmt-b2');
  });
});
