import { describe, it, expect } from 'vitest';
import { buildTargetUrl, scrubAuth, makeRecordId, recordDir, SSEAccumulator, injectWebSearch } from './record-proxy.js';

describe('buildTargetUrl', () => {
  it('拼接 path 与 query', () => {
    const u = buildTargetUrl('/v1/messages?x=1', 'https://open.bigmodel.cn/api/anthropic');
    expect(u.href).toBe('https://open.bigmodel.cn/api/anthropic/v1/messages?x=1');
  });
});

describe('scrubAuth', () => {
  it('脱敏 key/authorization，保留其他', () => {
    const out = scrubAuth({ 'x-api-key': 'sk-secret', authorization: 'Bearer abc', 'content-type': 'application/json', 'anthropic-version': '2023-06-01' });
    expect(out['x-api-key']).toBe('***');
    expect(out['authorization']).toBe('***');
    expect(out['content-type']).toBe('application/json');
    expect(out['anthropic-version']).toBe('2023-06-01');
  });
});

describe('makeRecordId', () => {
  it('格式 HHMMSS-xxxx', () => {
    expect(makeRecordId(new Date(2026, 5, 18, 14, 30, 12))).toMatch(/^143012-[0-9a-f]{4}$/);
  });
});

describe('recordDir', () => {
  it('生成 YYYY-MM-DD 目录', () => {
    expect(recordDir(new Date(2026, 5, 18), '/tmp/logs')).toBe('/tmp/logs/2026-06-18');
  });
});

describe('SSEAccumulator', () => {
  it('累积 text/usage/stop_reason', () => {
    const sse = new SSEAccumulator();
    const j = (o: unknown) => JSON.stringify(o);
    sse.feed(Buffer.from(
      'event: message_start\ndata: ' + j({ type: 'message_start', message: { usage: { input_tokens: 10 } } }) + '\n\n' +
      'event: content_block_delta\ndata: ' + j({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } }) + '\n\n' +
      'event: content_block_delta\ndata: ' + j({ type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } }) + '\n\n' +
      'event: message_delta\ndata: ' + j({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }) + '\n\n',
    ));
    expect(sse.text).toBe('Hello world');
    expect(sse.stopReason).toBe('end_turn');
    expect(sse.usage.input_tokens).toBe(10);
    expect(sse.usage.output_tokens).toBe(2);
  });
  it('跨 chunk 边界不丢数据', () => {
    const full = 'event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'XYZ' } }) + '\n\n';
    const sse = new SSEAccumulator();
    sse.feed(Buffer.from(full.slice(0, 15)));
    expect(sse.text).toBe('');
    sse.feed(Buffer.from(full.slice(15)));
    expect(sse.text).toBe('XYZ');
  });
});

describe('injectWebSearch', () => {
  it('有 tools 时追加 web_search', () => {
    const out = injectWebSearch({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'Read', input_schema: {} }] })!;
    const tools = out.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(2);
    expect(tools[1].type).toBe('web_search_20250305');
    expect(tools[1].name).toBe('web_search');
  });
  it('无 tools 时创建 tools 数组', () => {
    const out = injectWebSearch({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] })!;
    expect(Array.isArray(out.tools)).toBe(true);
    expect((out.tools as unknown[]).length).toBe(1);
  });
  it('已存在 web_search 时返回 null', () => {
    expect(injectWebSearch({ tools: [{ type: 'web_search_20250305', name: 'web_search' }], messages: [] })).toBeNull();
  });
  it('非对象输入返回 null', () => {
    expect(injectWebSearch(null)).toBeNull();
    expect(injectWebSearch('abc')).toBeNull();
  });
});

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleProxy } from './record-proxy.js';

function startUpstream(capture: { headers: http.IncomingHttpHeaders; body: string; status: number }) {
  return http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      capture.headers = req.headers;
      capture.body = b;
      res.writeHead(capture.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
}

function startLocal(opts: { target: string; logDir: string }) {
  return http.createServer((lreq, lres) => handleProxy(lreq, lres, { target: opts.target, logDir: opts.logDir, maxBytes: 10 * 1024 * 1024, injectWebsearch: false }));
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port)));
}

function post(port: number, headers: http.OutgoingHttpHeaders, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ port, method: 'POST', path: '/v1/messages', headers }, (rr) => {
      let b = ''; rr.on('data', (c) => (b += c)); rr.on('end', () => resolve({ status: rr.statusCode ?? 0, body: b }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

describe('handleProxy', () => {
  it('读 X-Window-Id 落盘到对应目录，转发前剥离该 header', async () => {
    const cap = { headers: {} as http.IncomingHttpHeaders, body: '', status: 200 };
    const up = startUpstream(cap);
    const upPort = await listen(up);
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
    const local = startLocal({ target: `http://127.0.0.1:${upPort}`, logDir });
    const localPort = await listen(local);

    const res = await post(localPort, { 'content-type': 'application/json', 'x-api-key': 'sk-x', 'x-window-id': 'wmt-b2' }, JSON.stringify({ model: 'glm-5.2', messages: [], stream: false }));
    await new Promise((r) => setTimeout(r, 100)); // 等异步落盘

    up.close(); local.close();
    expect(res.body).toBe(JSON.stringify({ ok: true }));
    expect(cap.headers['x-window-id']).toBeUndefined();    // 转发上游时已剥离
    expect(cap.headers['x-api-key']).toBe('sk-x');          // 真 key 仍转发
    const dayDir = fs.readdirSync(path.join(logDir, 'wmt-b2'))[0];
    const file = fs.readdirSync(path.join(logDir, 'wmt-b2', dayDir))[0];
    const rec = JSON.parse(fs.readFileSync(path.join(logDir, 'wmt-b2', dayDir, file), 'utf8'));
    expect(rec.windowId).toBe('wmt-b2');
    expect(rec.meta.status).toBe(200);
    expect(rec.meta.response_headers['content-type']).toBe('application/json'); // scrubAuth 产出（保留非敏感响应头）
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it('缺 X-Window-Id 时归 default', async () => {
    const cap = { headers: {} as http.IncomingHttpHeaders, body: '', status: 200 };
    const up = startUpstream(cap);
    const upPort = await listen(up);
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
    const local = startLocal({ target: `http://127.0.0.1:${upPort}`, logDir });
    const localPort = await listen(local);

    await post(localPort, { 'content-type': 'application/json' }, JSON.stringify({ model: 'glm-5.2', messages: [] }));
    await new Promise((r) => setTimeout(r, 100));
    up.close(); local.close();
    expect(fs.existsSync(path.join(logDir, 'default'))).toBe(true);
    fs.rmSync(logDir, { recursive: true, force: true });
  });
});
