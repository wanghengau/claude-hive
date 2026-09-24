# harness 结构分析器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 跨所有录制聚合出 Claude Code harness 的稳定设计特征，看板展示 6 维 + 服务端调 LLM 生成「怎么设计的」解读。

**Architecture:** 后端新增纯函数聚合模块 `analyzer.ts`（遍历 `data/` 取最高频 system/tools、统计缓存/注入/模型）+ `llm-client.ts`（服务端直调上游 LLM）；两条 HTTP 路由（`GET /api/analyze/harness`、`POST /api/analyze/interpret`）；前端新增 `analyze-view.tsx` 看板 + 解读区。只读 `data/`，不碰录制热路径。

**Tech Stack:** Node.js (http/https)、TypeScript (ESM `.js` import)、vitest、React 18、Vite。

**Spec:** `docs/superpowers/specs/2026-06-29-harness-structure-analyzer-design.md`

---

## 文件结构

| 文件 | 责任 | 动作 |
|:--|:--|:--|
| `server/src/analyzer.ts` | 聚合纯函数 + `HarnessProfile` 类型导出 | 新增 |
| `server/src/analyzer.test.ts` | 聚合逻辑单测 | 新增 |
| `server/src/llm-client.ts` | LLM 请求组装 + 调用 + 缺 key 降级 | 新增 |
| `server/src/llm-client.test.ts` | 请求体 / 缺 key 单测 | 新增 |
| `server/src/server.ts` | 注册 2 条 analyze 路由 + 3 个 env | 修改 |
| `web/src/types.ts` | `HarnessProfile` 前端类型 | 修改 |
| `web/src/components/analyze-view.tsx` | 6 维看板 + 解读区 | 新增 |
| `web/src/components/analyze-view.test.tsx` | 渲染单测（mock fetch） | 新增 |
| `web/src/App.tsx` | 视图状态 + 入口按钮 + 条件渲染 | 修改 |
| `web/src/styles.css` | `.az-*` 样式 | 修改 |

---

## Task 1: 后端 token 估算 + 频次工具 + 类型骨架

**Files:**
- Create: `server/src/analyzer.ts`
- Test: `server/src/analyzer.test.ts`

- [ ] **Step 1: 写失败测试（estimateTokens / pickMostFrequent / textOf）**

`server/src/analyzer.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { estimateTokens, pickMostFrequent, textOf } from './analyzer.js';

describe('estimateTokens', () => {
  it('英文按 /4 向上取整', () => {
    expect(estimateTokens('hello world')).toBe(3); // 11/4=2.75→3
  });
  it('中文按字符数计', () => {
    expect(estimateTokens('你好世界')).toBe(4);
  });
  it('中英混合', () => {
    expect(estimateTokens('你好 ab')).toBe(4); // 2 CJK + 3 non-CJK(含空格): 2 + ceil(3/4)=2 → 4
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm -w server test -- src/analyzer.test.ts`
Expected: FAIL — `estimateTokens is not a function`（模块未创建）

- [ ] **Step 3: 写最小实现（含类型骨架）**

`server/src/analyzer.ts`:
```ts
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeWindowId } from './record-store.js';

// ── 类型（后端导出；前端 web/src/types.ts 定义同名副本，前后端不共享文件）──
export interface ToolStat { name: string; desc: string; descTokens: number; schemaTokens: number }
export interface Injection { chars: number; tokens: number; preview: string }
export interface ModelStat { model: string; count: number }
export interface HarnessProfile {
  sampleSize: number;
  windowScope: string;
  system: { identity: string; rules: string; rulesTokens: number };
  tools: ToolStat[];
  tokenOverhead: { systemTokens: number; toolsTokens: number; total: number };
  cacheStats: { avgCacheRead: number; avgInput: number; hitRate: number };
  injections: Injection[];
  models: ModelStat[];
}

// token 粗估：CJK 每字符≈1 token，其余≈4 字符/token。零依赖，不引分词器。
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[一-鿿　-〿＀-￯]/g) || []).length;
  const nonCjk = text.length - cjk;
  return Math.ceil(cjk + nonCjk / 4);
}

// 从 {hash → {count, value}} 取出现次数最多的 value（抗 system/tools 版本漂移）
export function pickMostFrequent<T>(map: Map<string, { count: number; value: T }>): T | undefined {
  let best: { count: number; value: T } | undefined;
  for (const v of map.values()) if (!best || v.count > best.count) best = v;
  return best?.value;
}

// system 段落取文本：字符串原样，{type,text} 取 text
export function textOf(part: unknown): string {
  if (!part || typeof part !== 'object') return typeof part === 'string' ? part : '';
  const p = part as Record<string, unknown>;
  return typeof p.text === 'string' ? p.text : '';
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm -w server test -- src/analyzer.test.ts`
Expected: PASS（3 个 describe 全绿）

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer.ts server/src/analyzer.test.ts
git commit -m "feat(analyze): analyzer 类型骨架 + token 估算/频次工具"
```

---

## Task 2: 后端结构提取函数

**Files:**
- Modify: `server/src/analyzer.ts`（追加提取函数）
- Test: `server/src/analyzer.test.ts`（追加用例）

- [ ] **Step 1: 追加失败测试**

在 `server/src/analyzer.test.ts` 末尾追加：
```ts
import { extractSystem, extractTools, computeCacheStats, extractInjections, extractModels } from './analyzer.js';

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm -w server test -- src/analyzer.test.ts`
Expected: FAIL — `extractSystem is not a function`（未导出）

- [ ] **Step 3: 追加实现到 `server/src/analyzer.ts` 末尾**

```ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRec = any;

// system 取最高频版本：identity = parts[0]，rules = 其余拼接
export function extractSystem(records: AnyRec[]): HarnessProfile['system'] {
  const map = new Map<string, { count: number; value: AnyRec[] }>();
  for (const r of records) {
    const sys = r?.request?.system;
    if (!Array.isArray(sys)) continue;
    const key = JSON.stringify(sys);
    const e = map.get(key) ?? { count: 0, value: sys };
    e.count++; map.set(key, e);
  }
  const parts = pickMostFrequent(map);
  if (!parts || !parts.length) return { identity: '', rules: '', rulesTokens: 0 };
  const identity = textOf(parts[0]);
  const rules = parts.slice(1).map(textOf).filter(Boolean).join('\n\n');
  return { identity, rules, rulesTokens: estimateTokens(identity + '\n' + rules) };
}

// tools 取最高频清单 → ToolStat[]，按 descTokens 降序
export function extractTools(records: AnyRec[]): ToolStat[] {
  const map = new Map<string, { count: number; value: AnyRec[] }>();
  for (const r of records) {
    const tools = r?.request?.tools;
    if (!Array.isArray(tools)) continue;
    const key = JSON.stringify(tools);
    const e = map.get(key) ?? { count: 0, value: tools };
    e.count++; map.set(key, e);
  }
  const tools = pickMostFrequent(map);
  if (!tools) return [];
  return tools
    .map((t: AnyRec) => ({
      name: String(t?.name ?? t?.type ?? '?'),
      desc: String(t?.description ?? ''),
      descTokens: estimateTokens(String(t?.description ?? '')),
      schemaTokens: estimateTokens(JSON.stringify(t?.input_schema ?? {})),
    }))
    .sort((a, b) => b.descTokens - a.descTokens);
}

// 缓存策略：平均 cache_read / input，命中率 = cache_read / (cache_read + input)
export function computeCacheStats(records: AnyRec[]): HarnessProfile['cacheStats'] {
  let cr = 0, inp = 0, n = 0;
  for (const r of records) {
    const u = r?.response?.usage;
    if (!u) continue;
    cr += Number(u.cache_read_input_tokens) || 0;
    inp += Number(u.input_tokens) || 0;
    n++;
  }
  if (n === 0) return { avgCacheRead: 0, avgInput: 0, hitRate: 0 };
  const avgCR = Math.round(cr / n), avgIn = Math.round(inp / n);
  const total = avgCR + avgIn;
  return { avgCacheRead: avgCR, avgInput: avgIn, hitRate: total > 0 ? Math.round((avgCR / total) * 100) / 100 : 0 };
}

// 上下文注入：messages[role=system]，取 top3 频繁
export function extractInjections(records: AnyRec[]): Injection[] {
  const map = new Map<string, number>();
  for (const r of records) {
    const msgs = r?.request?.messages;
    if (!Array.isArray(msgs)) continue;
    for (const m of msgs) {
      if (m?.role !== 'system') continue;
      const t = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      if (!t) continue;
      map.set(t, (map.get(t) ?? 0) + 1);
    }
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => ({ chars: t.length, tokens: estimateTokens(t), preview: t.slice(0, 200) }));
}

// 模型分布：计数，按次数降序
export function extractModels(records: AnyRec[]): ModelStat[] {
  const map = new Map<string, number>();
  for (const r of records) {
    const m = r?.request?.model || r?.model;
    if (!m) continue;
    map.set(m, (map.get(m) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm -w server test -- src/analyzer.test.ts`
Expected: PASS（新增 5 个 describe 全绿）

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer.ts server/src/analyzer.test.ts
git commit -m "feat(analyze): system/tools/cache/injection/model 提取函数"
```

---

## Task 3: 后端 analyzeRecords 主入口 + buildInterpretPrompt

**Files:**
- Modify: `server/src/analyzer.ts`（追加主入口）
- Test: `server/src/analyzer.test.ts`（追加文件系统用例）

- [ ] **Step 1: 追加失败测试（用临时目录造真实录制文件）**

在 `server/src/analyzer.test.ts` 末尾追加：
```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeRecords, buildInterpretPrompt } from './analyzer.js';

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
```

> 注：顶部已有的 `import { describe, it, expect } from 'vitest'` 需补 `beforeEach, afterEach`：
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm -w server test -- src/analyzer.test.ts`
Expected: FAIL — `analyzeRecords is not a function`

- [ ] **Step 3: 追加主入口到 `server/src/analyzer.ts` 末尾**

```ts
export interface AnalyzeOpts { window?: string; limit?: number }

// 枚举 logDir 下合法 window 目录（含日期子目录的才算；commands/ 等无日期子目录自然排除，
// 与 record-store.countRecords 一致）
function listWindowDirs(logDir: string): string[] {
  let wids: string[] = [];
  try { wids = fs.readdirSync(logDir); } catch { return []; }
  return wids.filter((w) => /^[A-Za-z0-9_-]+$/.test(w));
}

// 主入口：遍历录制 → 按 ts 倒序取最近 limit 条 → 聚合 HarnessProfile
export function analyzeRecords(logDir: string, opts: AnalyzeOpts = {}): HarnessProfile {
  const limit = opts.limit ?? 500;
  const windowScope = opts.window || 'all';
  const wids = opts.window ? [sanitizeWindowId(opts.window)] : listWindowDirs(logDir);

  const all: { ts: string; rec: AnyRec }[] = [];
  for (const wid of wids) {
    const wRoot = path.join(logDir, wid);
    let dayDirs: string[] = [];
    try { dayDirs = fs.readdirSync(wRoot).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)); } catch { continue; }
    for (const date of dayDirs) {
      let files: string[] = [];
      try { files = fs.readdirSync(path.join(wRoot, date)); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const rec = JSON.parse(fs.readFileSync(path.join(wRoot, date, f), 'utf8'));
          if (rec && typeof rec === 'object') all.push({ ts: rec.ts ?? `${date}${f}`, rec });
        } catch { /* 坏文件跳过 */ }
      }
    }
  }

  all.sort((a, b) => b.ts.localeCompare(a.ts));
  const records = all.slice(0, limit).map((x) => x.rec);

  const system = extractSystem(records);
  const tools = extractTools(records);
  const toolsTokens = tools.reduce((s, t) => s + t.descTokens + t.schemaTokens, 0);

  return {
    sampleSize: records.length,
    windowScope,
    system,
    tools,
    tokenOverhead: { systemTokens: system.rulesTokens, toolsTokens, total: system.rulesTokens + toolsTokens },
    cacheStats: computeCacheStats(records),
    injections: extractInjections(records),
    models: extractModels(records),
  };
}

// 组装给 LLM 的分析 prompt
export function buildInterpretPrompt(p: HarnessProfile): string {
  const L: string[] = [];
  L.push('下面是一个 Claude Code harness（驱动 Claude 的外壳）的 API 录制结构数据。');
  L.push('请基于这些数据分析：这个 harness 是怎么设计的——设计哲学、能力边界、上下文与缓存管理策略。中文，分点，务实。\n');
  L.push(`采样 ${p.sampleSize} 条录制（范围：${p.windowScope}）\n`);
  L.push('## 身份声明');
  L.push(p.system.identity || '（无）');
  L.push('\n## 完整规则（system prompt）');
  L.push(p.system.rules || '（无）');
  L.push('\n## 能力集（工具）');
  for (const t of p.tools) L.push(`- ${t.name}（${t.descTokens} tok）：${t.desc}`);
  L.push('\n## 固定 token 开销');
  L.push(`system ${p.tokenOverhead.systemTokens} / tools ${p.tokenOverhead.toolsTokens} / 合计 ${p.tokenOverhead.total}`);
  L.push('\n## 缓存策略');
  L.push(`平均 cache_read ${p.cacheStats.avgCacheRead} / 平均 input ${p.cacheStats.avgInput} / 命中率 ${Math.round(p.cacheStats.hitRate * 100)}%`);
  if (p.injections.length) {
    L.push('\n## 上下文注入（role=system 消息）');
    for (const i of p.injections) L.push(`- ${i.chars} 字符 / ${i.tokens} tok：${i.preview}…`);
  }
  L.push('\n## 模型分布');
  for (const m of p.models) L.push(`- ${m.model}：${m.count} 次`);
  return L.join('\n');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm -w server test -- src/analyzer.test.ts`
Expected: PASS（含文件系统用例全绿）

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer.ts server/src/analyzer.test.ts
git commit -m "feat(analyze): analyzeRecords 主入口 + LLM prompt 组装"
```

---

## Task 4: 后端 llm-client

**Files:**
- Create: `server/src/llm-client.ts`
- Test: `server/src/llm-client.test.ts`

- [ ] **Step 1: 写失败测试**

`server/src/llm-client.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildAnalyzeRequest, interpretProfile, NoAnalyzerKeyError } from './llm-client.js';
import type { HarnessProfile } from './analyzer.js';

const profile: HarnessProfile = {
  sampleSize: 1, windowScope: 'all',
  system: { identity: 'I am C', rules: 'r', rulesTokens: 1 },
  tools: [], tokenOverhead: { systemTokens: 1, toolsTokens: 0, total: 1 },
  cacheStats: { avgCacheRead: 0, avgInput: 0, hitRate: 0 },
  injections: [], models: [],
};

describe('buildAnalyzeRequest', () => {
  it('拼出 /v1/messages URL + 含 system/messages 的 body', () => {
    const { url, body } = buildAnalyzeRequest(profile, { apiKey: 'k', target: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-a' });
    expect(url).toBe('https://open.bigmodel.cn/api/anthropic/v1/messages');
    expect(body.model).toBe('glm-a');
    expect(body.system).toContain('架构分析师');
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toContain('I am C');
  });
  it('target 末尾斜杠被规整', () => {
    const { url } = buildAnalyzeRequest(profile, { apiKey: 'k', target: 'https://x/api/', model: 'm' });
    expect(url).toBe('https://x/api/v1/messages');
  });
});

describe('interpretProfile', () => {
  it('缺 apiKey → 抛 NoAnalyzerKeyError，不发起请求', async () => {
    await expect(interpretProfile(profile, { apiKey: '', target: 'https://x/api', model: 'm' }))
      .rejects.toBeInstanceOf(NoAnalyzerKeyError);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm -w server test -- src/llm-client.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 写实现**

`server/src/llm-client.ts`:
```ts
import http from 'node:http';
import https from 'node:https';
import { buildInterpretPrompt, type HarnessProfile } from './analyzer.js';

export class NoAnalyzerKeyError extends Error {
  constructor() {
    super('ANALYZER_API_KEY not configured');
    this.name = 'NoAnalyzerKeyError';
  }
}

export interface InterpretOpts {
  apiKey: string;
  target: string;
  model: string;
  timeoutMs?: number;
}

// 纯函数：拼上游 URL + 请求体（便于单测，无网络）
export function buildAnalyzeRequest(profile: HarnessProfile, opts: InterpretOpts): { url: string; body: Record<string, unknown> } {
  const base = new URL(opts.target);
  const basePath = base.pathname.replace(/\/+$/, '');
  const url = new URL(basePath + '/v1/messages', base.origin).toString();
  const body = {
    model: opts.model,
    max_tokens: 2000,
    system: '你是软件架构分析师。用户给你一个 Claude Code harness 的录制结构数据，请写一段清晰分析：这个 harness 怎么设计的、能力边界、上下文/缓存策略。中文，分点，务实，不堆砌套话。',
    messages: [{ role: 'user', content: buildInterpretPrompt(profile) }],
  };
  return { url, body };
}

// 调上游 LLM（非流式），返回解读文本。缺 key 抛 NoAnalyzerKeyError（由路由层降级为可复制 prompt）
export function interpretProfile(profile: HarnessProfile, opts: InterpretOpts): Promise<string> {
  if (!opts.apiKey) return Promise.reject(new NoAnalyzerKeyError());
  const { url, body } = buildAnalyzeRequest(profile, opts);
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  const payload = JSON.stringify(body);
  return new Promise<string>((resolve, reject) => {
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload)),
        authorization: `Bearer ${opts.apiKey}`,
        'x-api-key': opts.apiKey, // anthropic 风格双保险
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`llm http ${res.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        try {
          const j = JSON.parse(text);
          const out = j?.content?.[0]?.text ?? j?.content ?? text;
          resolve(typeof out === 'string' ? out : JSON.stringify(out));
        } catch { resolve(text); }
      });
    });
    req.on('error', reject);
    req.setTimeout(opts.timeoutMs ?? 60000, () => req.destroy(new Error('llm timeout')));
    req.end(payload); // 对称：请求必须 end
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm -w server test -- src/llm-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/llm-client.ts server/src/llm-client.test.ts
git commit -m "feat(analyze): llm-client 服务端直调 + 缺 key 降级"
```

---

## Task 5: 后端 server.ts 路由接线

**Files:**
- Modify: `server/src/server.ts`

> ⚠️ **关键顺序**：`server.ts:86` 的 `if (method !== 'GET') { handleProxy(...) }` 会吞掉**所有 POST**。`POST /api/analyze/interpret` 必须在这行**之前**拦截，否则会被当 API 请求转发给上游。

- [ ] **Step 1: 加 import**

`server/src/server.ts` 顶部 import 区（`command-history` 那行之后）追加：
```ts
import { analyzeRecords, buildInterpretPrompt } from './analyzer.js';
import { interpretProfile, NoAnalyzerKeyError } from './llm-client.js';
```

- [ ] **Step 2: 加环境变量**

在 `createServer` 内 `RECORD_INJECT_WS` 那行（约 38 行）之后追加：
```ts
  const ANALYZER_API_KEY = process.env.ANALYZER_API_KEY || '';
  const ANALYZER_TARGET = process.env.ANALYZER_TARGET || RECORD_TARGET;
  const ANALYZER_MODEL = process.env.ANALYZER_MODEL || 'glm-5v-turbo';
```

- [ ] **Step 3: 注册两条路由（在 `/api/quick-commands` 块之后、`if (method !== 'GET')` 之前）**

在 `server.ts` 第 85 行（`/api/quick-commands` 块的 `}` 之后）与第 86 行（`if (method !== 'GET')`）之间插入：
```ts
    if (method === 'GET' && url.startsWith('/api/analyze/harness')) {
      const u = new URL(url, 'http://localhost');
      const json = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      const window = u.searchParams.get('window') || undefined;
      const limitRaw = u.searchParams.get('limit');
      const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
      return json(200, analyzeRecords(RECORD_LOG_DIR, { window, limit }));
    }
    if (url === '/api/analyze/interpret' && method === 'POST') {
      const json = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      let body = '';
      req.on('data', (c) => { body += c.toString('utf8'); });
      req.on('end', () => {
        let parsed: { window?: string; limit?: number; profile?: unknown } = {};
        try { parsed = JSON.parse(body); } catch { return json(400, { error: 'invalid json' }); }
        const profile = (parsed.profile && typeof parsed.profile === 'object')
          ? parsed.profile as import('./analyzer.js').HarnessProfile
          : analyzeRecords(RECORD_LOG_DIR, { window: parsed.window, limit: parsed.limit });
        interpretProfile(profile, { apiKey: ANALYZER_API_KEY, target: ANALYZER_TARGET, model: ANALYZER_MODEL })
          .then((text) => json(200, { text }))
          .catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            const isNoKey = e instanceof NoAnalyzerKeyError || /ANALYZER_API_KEY/.test(msg);
            // 永远给一条出路：缺 key 或调用失败都降级为可复制 prompt
            json(200, { error: isNoKey ? 'no_analyzer_key' : 'interpret_failed', message: isNoKey ? undefined : msg, fallbackPrompt: buildInterpretPrompt(profile) });
          });
      });
      return;
    }
```

- [ ] **Step 4: 类型检查 + 全量测试**

Run: `npm -w server run build && npm -w server test`
Expected: build 通过，全部测试 PASS（含原有 record/command-history 测试不回归）

- [ ] **Step 5: 手动验证端点（启动服务 curl）**

Run（一个终端）: `npm -w server run dev` &（后台）
Run（另一个终端）:
```bash
curl -s 'http://localhost:4000/api/analyze/harness' | python3 -m json.tool | head -20
curl -s -X POST 'http://localhost:4000/api/analyze/interpret' -d '{}' | python3 -m json.tool | head -5
```
Expected: harness 返回真实 `HarnessProfile`（sampleSize>0、tools 含 Bash/Read 等）；interpret 返回 `{error: 'no_analyzer_key', fallbackPrompt: '...'}`（未配 key 的降级路径）

> 验证完停掉 dev 进程。

- [ ] **Step 6: Commit**

```bash
git add server/src/server.ts
git commit -m "feat(analyze): 注册 harness/interpret 路由 + 环境变量"
```

---

## Task 6: 前端类型

**Files:**
- Modify: `web/src/types.ts`

- [ ] **Step 1: 追加类型（文件末尾）**

在 `web/src/types.ts` 末尾追加（与后端 `analyzer.ts` 字段同名同构）：
```ts
export interface ToolStat { name: string; desc: string; descTokens: number; schemaTokens: number }
export interface Injection { chars: number; tokens: number; preview: string }
export interface ModelStat { model: string; count: number }
export interface HarnessProfile {
  sampleSize: number;
  windowScope: string;
  system: { identity: string; rules: string; rulesTokens: number };
  tools: ToolStat[];
  tokenOverhead: { systemTokens: number; toolsTokens: number; total: number };
  cacheStats: { avgCacheRead: number; avgInput: number; hitRate: number };
  injections: Injection[];
  models: ModelStat[];
}
```

- [ ] **Step 2: 类型检查**

Run: `npm -w web run build`
Expected: tsc 通过（无类型错误）

- [ ] **Step 3: Commit**

```bash
git add web/src/types.ts
git commit -m "feat(analyze): 前端 HarnessProfile 类型"
```

---

## Task 7: 前端 analyze-view 组件 + 测试

**Files:**
- Create: `web/src/components/analyze-view.tsx`
- Test: `web/src/components/analyze-view.test.tsx`

- [ ] **Step 1: 写失败测试（mock fetch）**

`web/src/components/analyze-view.test.tsx`:
```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AnalyzeView } from './analyze-view.js';
import type { HarnessProfile } from '../types.js';

const profile: HarnessProfile = {
  sampleSize: 42, windowScope: 'all',
  system: { identity: 'I am Claude Code', rules: 'rules text', rulesTokens: 10 },
  tools: [{ name: 'Bash', desc: 'shell', descTokens: 2, schemaTokens: 1 }],
  tokenOverhead: { systemTokens: 10, toolsTokens: 3, total: 13 },
  cacheStats: { avgCacheRead: 100, avgInput: 50, hitRate: 0.67 },
  injections: [{ chars: 80, tokens: 60, preview: 'CLAUDE.md...' }],
  models: [{ model: 'glm-a', count: 42 }],
};

describe('AnalyzeView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fetch harness 并渲染采样数与工具', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(profile) }));
    render(<AnalyzeView onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText(/42 条/)).toBeInTheDocument());
    expect(screen.getByText('Bash')).toBeInTheDocument();
  });

  it('未配 key 点生成解读 → 展示降级 prompt', async () => {
    const seq = [
      { ok: true, json: () => Promise.resolve(profile) },
      { ok: true, json: () => Promise.resolve({ error: 'no_analyzer_key', fallbackPrompt: 'PASTE ME' }) },
    ];
    let i = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(seq[i++ % seq.length])));
    render(<AnalyzeView onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText(/42 条/)).toBeInTheDocument());
    screen.getByText('生成解读').click();
    await waitFor(() => expect(screen.getByText(/PASTE ME/)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm -w web test -- src/components/analyze-view.test.tsx`
Expected: FAIL — 组件不存在

- [ ] **Step 3: 写组件**

`web/src/components/analyze-view.tsx`:
```tsx
import { useEffect, useState } from 'react';
import type { HarnessProfile } from '../types.js';

interface Props { onBack: () => void; }

export function AnalyzeView({ onBack }: Props) {
  const [profile, setProfile] = useState<HarnessProfile | null>(null);
  const [interp, setInterp] = useState<{ text?: string; error?: string; fallbackPrompt?: string } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/analyze/harness').then((r) => r.json()).then((p: HarnessProfile) => { if (alive) setProfile(p); }).catch(() => { if (alive) setProfile(null); });
    return () => { alive = false; };
  }, []);

  const genInterp = async () => {
    setLoading(true); setInterp(null);
    try {
      const r = await fetch('/api/analyze/interpret', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      setInterp(await r.json());
    } catch (e) {
      setInterp({ error: 'fetch_failed', fallbackPrompt: String(e) });
    } finally {
      setLoading(false);
    }
  };

  const copy = (text: string) => { navigator.clipboard?.writeText(text); };

  if (!profile) return <div className="analyze-view"><div className="az-bar"><button className="az-back" onClick={onBack}>← 返回</button><span className="az-title">分析 harness</span></div><div className="az-empty">加载中…</div></div>;

  return (
    <div className="analyze-view">
      <div className="az-bar">
        <button className="az-back" onClick={onBack}>← 返回</button>
        <span className="az-title">🔧 harness 结构分析</span>
        <span className="az-sub">{profile.sampleSize} 条 · {profile.windowScope}</span>
      </div>
      <div className="az-body">
        <section className="az-card">
          <h3>① 身份</h3>
          <p className="az-identity">{profile.system.identity || '（无）'}</p>
          <details><summary>完整规则（{profile.system.rulesTokens} tok）</summary><pre className="az-pre">{profile.system.rules || '（无）'}</pre></details>
        </section>

        <section className="az-card">
          <h3>② 能力集（{profile.tools.length} 个工具）</h3>
          <ul className="az-tools">{profile.tools.map((t) => (
            <li key={t.name}><span className="az-tool-name">{t.name}</span><span className="az-tool-tok">{t.descTokens}+{t.schemaTokens} tok</span></li>
          ))}</ul>
        </section>

        <section className="az-card az-kv-grid">
          <h3>③ 固定开销 / ④ 缓存</h3>
          <div className="az-kv"><span>system</span><b>{profile.tokenOverhead.systemTokens}</b></div>
          <div className="az-kv"><span>tools</span><b>{profile.tokenOverhead.toolsTokens}</b></div>
          <div className="az-kv"><span>合计</span><b>{profile.tokenOverhead.total}</b></div>
          <div className="az-kv"><span>cache_read</span><b>{profile.cacheStats.avgCacheRead}</b></div>
          <div className="az-kv"><span>input</span><b>{profile.cacheStats.avgInput}</b></div>
          <div className="az-kv"><span>命中率</span><b>{Math.round(profile.cacheStats.hitRate * 100)}%</b></div>
        </section>

        {profile.injections.length > 0 && (
          <section className="az-card">
            <h3>⑤ 上下文注入（role=system）</h3>
            {profile.injections.map((i, n) => (<div className="az-inj" key={n}><span>{i.chars} 字符 / {i.tokens} tok</span><pre className="az-pre">{i.preview}…</pre></div>))}
          </section>
        )}

        <section className="az-card">
          <h3>⑥ 模型分布</h3>
          <ul className="az-models">{profile.models.map((m) => (<li key={m.model}><span>{m.model}</span><b>{m.count}</b></li>))}</ul>
        </section>

        <section className="az-card">
          <h3>LLM 解读：这个 harness 怎么设计的</h3>
          <button className="az-gen" onClick={genInterp} disabled={loading}>{loading ? '生成中…' : '生成解读'}</button>
          {interp?.text && <pre className="az-pre az-interp">{interp.text}</pre>}
          {interp?.error && (
            <div className="az-fallback">
              <p>解读失败（{interp.error}{interp.message ? `：${interp.message}` : ''}）。可复制下方 prompt 到任意 LLM：</p>
              <button onClick={() => interp.fallbackPrompt && copy(interp.fallbackPrompt)}>复制 prompt</button>
              <pre className="az-pre">{interp.fallbackPrompt}</pre>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm -w web test -- src/components/analyze-view.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/components/analyze-view.tsx web/src/components/analyze-view.test.tsx
git commit -m "feat(analyze): 前端 6 维看板 + LLM 解读区"
```

---

## Task 8: 前端接线（App.tsx）+ 样式

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`

- [ ] **Step 1: App.tsx 加视图状态 + 入口 + 条件渲染**

(a) import 区（`record-view.js` 那行之后）加：
```ts
import { AnalyzeView } from './components/analyze-view.js';
```

(b) 在 `const [recordViewId, setRecordViewId] = useState<string | null>(null);` 那行之后加：
```ts
  const [showAnalyze, setShowAnalyze] = useState(false);
```

(c) `sidebar-head` 内（`<button onClick={() => create(80, 24)}>+ 新建</button>` 那行之后）加入口：
```tsx
          <button className="brand-analyze" onClick={() => setShowAnalyze(true)}>🔧 分析</button>
```

(d) `<main className="main">` 内，把现有的 `{recordViewId ? (...) : (...)}` 包一层 analyze 优先判断：
```tsx
        {showAnalyze ? (
          <AnalyzeView onBack={() => setShowAnalyze(false)} />
        ) : recordViewId ? (
          <RecordView windowId={recordViewId} onBack={() => setRecordViewId(null)} />
        ) : (
          <>
            <div className="main-head">
              {active ? (
                <>
                  <span className="mh-cwd">{active.cwd || '~'}</span>
                  <span className={`row-status ${active.exited ? 'st-exited' : active.running ? 'st-running' : 'st-idle'}`}>
                    <span className="dot" />
                    {active.exited ? 'EXITED' : active.running ? 'RUNNING' : 'IDLE'}
                  </span>
                  <span className="mh-id">{active.sessionId}</span>
                </>
              ) : (
                <span className="mh-id">NO ACTIVE SESSION</span>
              )}
            </div>
            <MainTerminal ref={mainRef} client={client} sessionId={activeId} reportSize={reportSize} />
            <QuickInput
              client={client}
              sessionId={activeId}
              onAfterSend={() => mainRef.current?.focus()}
            />
          </>
        )}
```

- [ ] **Step 2: styles.css 追加样式（文件末尾，复用现有 CSS 变量）**

```css
/* ── analyze-view（harness 结构分析）── */
.brand-analyze { margin-left: 6px; padding: 2px 8px; font-size: 12px; background: var(--bg-elev); color: var(--text-dim); border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; }
.brand-analyze:hover { color: var(--accent); border-color: var(--accent-line); }
.analyze-view { display: flex; flex-direction: column; height: 100%; }
.az-bar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--bg-panel); }
.az-back { background: none; border: none; color: var(--text-dim); cursor: pointer; font-family: var(--sans); }
.az-back:hover { color: var(--accent); }
.az-title { font-weight: 600; color: var(--text); }
.az-sub { color: var(--text-faint); font-size: 12px; }
.az-body { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.az-card { background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
.az-card h3 { font-size: 13px; color: var(--accent); margin-bottom: 10px; }
.az-identity { color: var(--blue); margin-bottom: 8px; }
.az-pre { background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px; overflow-x: auto; color: var(--text-dim); font-family: var(--mono); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
.az-tools { list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 6px; }
.az-tools li { display: flex; justify-content: space-between; padding: 4px 8px; background: var(--bg-input); border-radius: var(--radius-sm); }
.az-tool-name { color: var(--blue); }
.az-tool-tok { color: var(--text-faint); font-size: 11px; }
.az-kv-grid .az-kv { display: flex; flex-direction: column; }
.az-kv span { color: var(--text-faint); font-size: 11px; }
.az-kv b { color: var(--text); font-size: 16px; }
.az-kv-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; }
.az-inj { margin-bottom: 8px; }
.az-inj span { color: var(--purple); font-size: 11px; }
.az-models { list-style: none; display: flex; flex-direction: column; gap: 4px; }
.az-models li { display: flex; justify-content: space-between; padding: 2px 0; }
.az-models span { color: var(--text-dim); }
.az-models b { color: var(--accent); }
.az-gen { padding: 8px 16px; background: var(--accent); color: var(--accent-ink); border: none; border-radius: var(--radius-sm); cursor: pointer; font-family: var(--sans); font-weight: 600; }
.az-gen:hover:not(:disabled) { background: var(--accent-hover); }
.az-gen:disabled { opacity: 0.5; cursor: not-allowed; }
.az-interp { margin-top: 12px; }
.az-fallback { margin-top: 12px; }
.az-fallback p { color: var(--amber); margin-bottom: 8px; }
.az-fallback button { margin-bottom: 8px; padding: 4px 12px; background: var(--bg-elev); color: var(--text-dim); border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; }
.az-empty { color: var(--text-faint); font-style: italic; padding: 16px; }
@media (max-width: 720px) { .az-kv-grid { grid-template-columns: repeat(3, 1fr); } }
```

- [ ] **Step 3: 类型检查 + 构建**

Run: `npm -w web run build`
Expected: 构建通过，无类型错误

- [ ] **Step 4: Commit**

```bash
git add web/src/App.tsx web/src/styles.css
git commit -m "feat(analyze): 接入 analyze 视图入口 + 样式"
```

---

## Task 9: e2e 验证（playwright MCP，主会话执行）

> 本任务**必须在主会话用 playwright MCP 实际走过**——子 agent / workflow 无法访问 MCP 工具（CLAUDE.md e2e 约定）。

**Files:** 无（验证步骤）

- [ ] **Step 1: 启动 dev（server + web）**

Run（主会话后台）: `npm run dev`
等待看到 `listening on http://localhost:4000` 与 vite 就绪。

- [ ] **Step 2: 用 playwright MCP 打开页面**

调用 `mcp__playwright__browser_navigate` → `http://localhost:4001`（vite dev）或 `:4000`（server 静态）。

- [ ] **Step 3: 截图验证入口与看板**

- `mcp__playwright__browser_snapshot`：确认侧栏顶部出现「🔧 分析」按钮。
- 点击「🔧 分析」→ `mcp__playwright__browser_take_screenshot`：确认 6 维看板渲染（身份/规则可展开、工具清单、token 开销、缓存命中率、注入预览、模型分布），用真实 `data/` 数据。

- [ ] **Step 4: 验证降级路径（未配 key）**

点击「生成解读」→ snapshot 确认展示 `{error: 'no_analyzer_key'}` 的降级可复制 prompt + 「复制 prompt」按钮。

- [ ] **Step 5: 验证配 key 路径（可选，需 GLM key）**

设 `ANALYZER_API_KEY=<key>` 重启 dev → 点「生成解读」→ 确认展示 LLM 解读文案。
（无 key 则跳过本步，记录为已验证降级路径。）

- [ ] **Step 6: 全量测试收尾**

Run: `npm test`
Expected: server + web 全部测试 PASS。

- [ ] **Step 7: 收尾 commit（如有 e2e 产生的调整）**

```bash
git add -A
git commit -m "test(analyze): e2e 验证通过" --allow-empty
```

---

## Self-Review（写计划后自检，已执行）

- **Spec 覆盖**：6 维看板（①身份/②能力/③开销/④缓存/⑤注入/⑥模型）→ Task 2+3+7；服务端直调 LLM + 降级 → Task 4+5+7；HarnessProfile 类型 → Task 1+6；window 过滤 + limit 采样 → Task 3；安全（只读/sanitize/key 不回显）→ Task 3+4+5；e2e → Task 9。✓ 无遗漏。
- **占位符**：无 TBD/TODO，所有代码步骤含完整代码。✓
- **类型一致**：`HarnessProfile` 前后端字段同名同构；`analyzeRecords`/`buildInterpretPrompt`/`interpretProfile`/`buildAnalyzeRequest` 签名在各 Task 间一致。✓
- **关键陷阱已标注**：POST 路由必须在 `handleProxy` 之前（Task 5）。✓
