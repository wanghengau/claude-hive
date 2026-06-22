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
