import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateTokens, pickMostFrequent, textOf } from './analyzer.js';
import { extractSystem, extractTools, computeCacheStats, extractInjections, extractModels } from './analyzer.js';
import { analyzeRecords, buildInterpretPrompt } from './analyzer.js';

describe('estimateTokens', () => {
  it('英文按 /4 向上取整', () => {
    expect(estimateTokens('hello world')).toBe(3); // 11/4=2.75→3
  });
  it('中文按字符数计', () => {
    expect(estimateTokens('你好世界')).toBe(4);
  });
  it('中英混合', () => {
    expect(estimateTokens('你好 ab')).toBe(3); // 2 CJK + 3 non-CJK(含空格): ceil(2 + 3/4)=ceil(2.75)→3
  });
  it('空串为 0', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('pickMostFrequent', () => {
  it('取出现次数最多的版本', () => {
    const m = new Map<string, { count: number; value: string }>();
    const add = (k: string, v: string) => m.set(k, { count: (m.get(k)?.count ?? 0) + 1, value: v });
    add('a', 'A'); add('b', 'B'); add('b', 'B');
    expect(pickMostFrequent(m)).toBe('B');
  });
  it('空 map 返回 undefined', () => {
    expect(pickMostFrequent(new Map())).toBeUndefined();
  });
});

describe('textOf', () => {
  it('字符串原样返回', () => {
    expect(textOf('hi')).toBe('hi');
  });
  it('{type,text} 取 text', () => {
    expect(textOf({ type: 'text', text: 'hello' })).toBe('hello');
  });
  it('null/空对象返回空串', () => {
    expect(textOf(null)).toBe('');
    expect(textOf({})).toBe('');
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rec = (over: any = {}): any => ({ request: {}, response: {}, ...over });

describe('extractSystem', () => {
  it('取最高频 system 版本，拆出 identity + rules', () => {
    const sys1 = [{ type: 'text', text: 'I am Claude' }, { type: 'text', text: 'rule-A' }];
    const sys2 = [{ type: 'text', text: 'I am Claude' }, { type: 'text', text: 'rule-B' }];
    const rs = [rec({ request: { system: sys1 } }), rec({ request: { system: sys1 } }), rec({ request: { system: sys2 } })];
    const s = extractSystem(rs);
    expect(s.identity).toBe('I am Claude');
    expect(s.rules).toBe('rule-A');
    expect(s.rulesTokens).toBeGreaterThan(0);
  });
  it('无 system → 空态', () => {
    const s = extractSystem([rec(), rec()]);
    expect(s.identity).toBe('');
    expect(s.rules).toBe('');
    expect(s.rulesTokens).toBe(0);
  });
});

describe('extractTools', () => {
  it('取最高频 tools 清单，map 成 ToolStat 并按 descTokens 降序', () => {
    const tools = [{ name: 'Bash', description: 'short', input_schema: { x: 1 } }, { name: 'Workflow', description: 'L'.repeat(800), input_schema: {} }];
    const rs = [rec({ request: { tools } }), rec({ request: { tools } })];
    const t = extractTools(rs);
    expect(t).toHaveLength(2);
    expect(t[0].name).toBe('Workflow'); // desc 长 → 排前
    expect(t[1].name).toBe('Bash');
    expect(t[0].descTokens).toBeGreaterThan(t[1].descTokens);
  });
  it('无 tools → []', () => {
    expect(extractTools([rec()])).toEqual([]);
  });
});

describe('computeCacheStats', () => {
  it('算平均 cache_read / input 与命中率', () => {
    const rs = [rec({ response: { usage: { cache_read_input_tokens: 100, input_tokens: 50 } } }), rec({ response: { usage: { cache_read_input_tokens: 200, input_tokens: 50 } } })];
    const c = computeCacheStats(rs);
    expect(c.avgCacheRead).toBe(150);
    expect(c.avgInput).toBe(50);
    expect(c.hitRate).toBe(0.75); // 150/(150+50)
  });
  it('无 usage → 全 0', () => {
    expect(computeCacheStats([rec()])).toEqual({ avgCacheRead: 0, avgInput: 0, hitRate: 0 });
  });
});

describe('extractInjections', () => {
  it('收集 messages[role=system]，取 top3 频繁，带 preview', () => {
    const rs = [rec({ request: { messages: [{ role: 'system', content: 'CLAUDE.md rules'.repeat(20) }, { role: 'user', content: 'hi' }] } })];
    const inj = extractInjections(rs);
    expect(inj).toHaveLength(1);
    expect(inj[0].chars).toBeGreaterThan(0);
    expect(inj[0].preview.length).toBeLessThanOrEqual(200);
  });
  it('忽略普通 user/assistant', () => {
    const rs = [rec({ request: { messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] } })];
    expect(extractInjections(rs)).toEqual([]);
  });
});

describe('extractModels', () => {
  it('计数并按次数降序', () => {
    const rs = [rec({ request: { model: 'glm-a' } }), rec({ request: { model: 'glm-a' } }), rec({ request: { model: 'glm-b' } })];
    const m = extractModels(rs);
    expect(m[0]).toEqual({ model: 'glm-a', count: 2 });
    expect(m[1]).toEqual({ model: 'glm-b', count: 1 });
  });
});

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'az-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

// 在 dir/<wid>/<date>/<id>.json 写一条录制
function writeRec(wid: string, date: string, id: string, over: Record<string, unknown>): void {
  const d = path.join(dir, wid, date);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${id}.json`), JSON.stringify({ id, ts: `${date}T10:00:00Z`, windowId: wid, ...over }));
}

describe('analyzeRecords', () => {
  it('聚合真实文件，sampleSize 与字段正确', () => {
    writeRec('wmt-aaa', '2026-06-23', '100000-a1', {
      request: { model: 'glm-a', system: [{ type: 'text', text: 'I am C' }, { type: 'text', text: 'rules' }], tools: [{ name: 'Bash', description: 'd', input_schema: {} }] },
      response: { usage: { input_tokens: 10, cache_read_input_tokens: 90 } },
    });
    writeRec('wmt-aaa', '2026-06-23', '100100-a2', {
      request: { model: 'glm-a', system: [{ type: 'text', text: 'I am C' }, { type: 'text', text: 'rules' }], tools: [{ name: 'Bash', description: 'd', input_schema: {} }] },
      response: { usage: { input_tokens: 20, cache_read_input_tokens: 80 } },
    });
    const p = analyzeRecords(dir);
    expect(p.sampleSize).toBe(2);
    expect(p.windowScope).toBe('all');
    expect(p.system.identity).toBe('I am C');
    expect(p.tools[0].name).toBe('Bash');
    expect(p.cacheStats.avgInput).toBe(15);
    expect(p.models[0]).toEqual({ model: 'glm-a', count: 2 });
  });

  it('window 过滤只读指定 window', () => {
    writeRec('wmt-aaa', '2026-06-23', '100000-a1', { request: { model: 'a' }, response: { usage: { input_tokens: 1 } } });
    writeRec('wmt-bbb', '2026-06-23', '100000-b1', { request: { model: 'b' }, response: { usage: { input_tokens: 1 } } });
    const p = analyzeRecords(dir, { window: 'wmt-bbb' });
    expect(p.windowScope).toBe('wmt-bbb');
    expect(p.models).toEqual([{ model: 'b', count: 1 }]);
  });

  it('limit 截断：按 ts 倒序取最近 N 条', () => {
    writeRec('w', '2026-06-23', '090000-1', { ts: '2026-06-23T09:00:00Z', request: { model: 'old' }, response: {} });
    writeRec('w', '2026-06-24', '090000-2', { ts: '2026-06-24T09:00:00Z', request: { model: 'new' }, response: {} });
    const p = analyzeRecords(dir, { limit: 1 });
    expect(p.sampleSize).toBe(1);
    expect(p.models[0].model).toBe('new'); // 取最近
  });

  it('空目录 → 空态不抛错', () => {
    const p = analyzeRecords(dir);
    expect(p.sampleSize).toBe(0);
    expect(p.tools).toEqual([]);
  });

  it('坏 JSON 文件跳过', () => {
    fs.mkdirSync(path.join(dir, 'w', '2026-06-23'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'w', '2026-06-23', '100000-x.json'), 'not json');
    writeRec('w', '2026-06-23', '100100-y', { request: { model: 'ok' }, response: {} });
    const p = analyzeRecords(dir);
    expect(p.sampleSize).toBe(1);
  });
});

describe('buildInterpretPrompt', () => {
  it('含身份/规则/工具/缓存/模型各段', () => {
    const p: import('./analyzer.js').HarnessProfile = {
      sampleSize: 5, windowScope: 'all',
      system: { identity: 'I am Claude', rules: 'be helpful', rulesTokens: 10 },
      tools: [{ name: 'Bash', desc: 'run shell', descTokens: 2, schemaTokens: 1 }],
      tokenOverhead: { systemTokens: 10, toolsTokens: 3, total: 13 },
      cacheStats: { avgCacheRead: 100, avgInput: 50, hitRate: 0.67 },
      injections: [{ chars: 100, tokens: 80, preview: 'CLAUDE.md...' }],
      models: [{ model: 'glm-a', count: 5 }],
    };
    const s = buildInterpretPrompt(p);
    expect(s).toContain('I am Claude');
    expect(s).toContain('Bash');
    expect(s).toContain('67%');
    expect(s).toContain('glm-a');
  });
});
