# windows-record 合并实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 claude-record-proxy 的录制能力内嵌进 windows（web 多终端），让 `claude-record` 窗口的模型请求按 windows 窗口（tmux session）分组录制，并在 windows 主 UI 用窗口徽标查看。

**Architecture:** record-proxy 核心逻辑 TS 重写为 windows server 的同进程模块（`record-proxy.ts` + `record-store.ts`）；windows server 单端口（3000）同时承载 web UI、WebSocket、claude API 代理（录制）、录制查看 API；`claude-record` profile 通过 `ANTHROPIC_CUSTOM_HEADERS` 注入 `X-Window-Id` 让代理识别来源窗口；普通 `claude` 不改 BASE_URL 故不经代理（"不加载"）。

**Tech Stack:** TypeScript（server: node-pty/ws/tsx/vitest；web: React/Vite）、tmux、Node http/https、ESM。

**Spec:** `docs/superpowers/specs/2026-06-22-windows-record-merge-design.md`

**源参考文件（只读，不改动）：**
- `windows/server/src/*.ts`、`windows/web/src/*` — 复制为基座
- `claude-record-proxy/record-proxy.js` — 移植核心逻辑
- `claude-record-proxy/record-proxy.test.js` — 移植纯函数测试
- `claude-record-proxy/record-viewer.html` — 迁移渲染到 React

---

## 文件结构

| 文件 | 责任 | 动作 |
|:--|:--|:--|
| `package.json` / `server` / `web` | windows 基座 | 从 `windows/` 复制 |
| `server/src/record-proxy.ts` | 纯函数(buildTargetUrl/scrubAuth/makeRecordId/SSEAccumulator/injectWebSearch) + handleProxy(透传+录制) | 新建 |
| `server/src/record-store.ts` | windowId 分组存储：sanitize/路径/写入/list/get/counts | 新建 |
| `server/src/record-proxy.test.ts` | 纯函数 + handleProxy 集成测试 | 新建 |
| `server/src/record-store.test.ts` | 分组/sanitize/list/counts/get 测试 | 新建 |
| `server/src/server.ts` | 挂载 record 路由（非GET→代理；GET /api/record/*） | 改 |
| `claude-record.sh` | claude-record profile（注入 X-Window-Id） | 新建 |
| `web/src/types.ts` | RecordSummary/RecordCounts 类型 | 改 |
| `web/src/use-sessions.ts` | recordCounts 轮询 | 改 |
| `web/src/components/session-list.tsx` | 窗口徽标 ●录(N) | 改 |
| `web/src/components/record-view.tsx` | 该窗口录制列表+详情（迁移 record-viewer.html） | 新建 |
| `web/src/App.tsx` | recordViewId 视图切换 | 改 |
| `web/src/styles.css` | 录制视图样式 | 改 |
| `README.md` | 用法 | 新建 |

---

## Task 1: 建项目基座 + git init + 冒烟

**Files:**
- Create: `windows-record/`（从 `windows/` 复制 `server/`、`web/`、`package.json`、`package-lock.json`）

- [ ] **Step 1: 复制 windows 基座（排除 node_modules/dist/.git；不复制 windows 自带 docs，避免覆盖已写 spec）**

Run:
```bash
cd /Users/Shared/workspace
# 复制源码与清单，排除重型/无关目录
rsync -a --exclude='node_modules' --exclude='dist' --exclude='.git' --exclude='docs' \
  --exclude='.gitignore' \
  windows/server windows-record/server
rsync -a --exclude='node_modules' --exclude='dist' --exclude='.gitignore' --exclude='tsconfig.tsbuildinfo' \
  windows/web windows-record/web
cp windows/package.json windows-record/package.json
cp windows/package-lock.json windows-record/package-lock.json 2>/dev/null || true
```
Expected: `windows-record/` 下出现 `server/`、`web/`、`package.json`；已存在的 `windows-record/docs/superpowers/specs/...-design.md` 不受影响。

- [ ] **Step 2: 确认 windows-record 根 package.json 的 name 改为新项目名**

Modify: `windows-record/package.json`（把 `"name": "web-multi-terminal"` 改为 `"name": "windows-record"`，其余 scripts/workspaces 不动）。

- [ ] **Step 3: git init + .gitignore**

Create `windows-record/.gitignore`:
```
node_modules/
dist/
*.tsbuildinfo
data/
run/
```

Run:
```bash
cd /Users/Shared/workspace/windows-record
git init -q && git add -A && git commit -q -m "chore: bootstrap from windows base" && echo done
```
Expected: `done`；`git log --oneline` 显示 1 条提交。

- [ ] **Step 4: 安装依赖并冒烟（dev/build/test）**

Run:
```bash
cd /Users/Shared/workspace/windows-record
npm install
npm -w server run build
npm -w server test
```
Expected: install 成功；server tsc 构建无错；vitest 全绿（ring-buffer/tmux/pty-manager/ws-handler/server/e2e 通过）。若 node-pty 权限问题，`server/package.json` 已带 postinstall 修 chmod，应自愈。

- [ ] **Step 5: Commit 基座**

```bash
git add -A && git commit -q -m "chore: install deps, verify base builds green" && echo done
```

---

## Task 2: 移植 record-proxy 纯函数 + SSE + injectWebSearch（TS）

**Files:**
- Create: `server/src/record-proxy.ts`
- Test: `server/src/record-proxy.test.ts`

- [ ] **Step 1: 写失败测试（移植 record-proxy.test.js 的纯函数部分，vitest 语法；collectRecords 留给 Task 3 的 record-store）**

Create `server/src/record-proxy.test.ts`:
```ts
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
    expect(out.tools).toHaveLength(2);
    expect(out.tools[1].type).toBe('web_search_20250305');
    expect(out.tools[1].name).toBe('web_search');
  });
  it('无 tools 时创建 tools 数组', () => {
    const out = injectWebSearch({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] })!;
    expect(Array.isArray(out.tools)).toBe(true);
    expect(out.tools).toHaveLength(1);
  });
  it('已存在 web_search 时返回 null', () => {
    expect(injectWebSearch({ tools: [{ type: 'web_search_20250305', name: 'web_search' }], messages: [] })).toBeNull();
  });
  it('非对象输入返回 null', () => {
    expect(injectWebSearch(null)).toBeNull();
    expect(injectWebSearch('abc')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/Shared/workspace/windows-record && npm -w server test -- record-proxy`
Expected: FAIL（`Cannot find module './record-proxy.js'`）。

- [ ] **Step 3: 实现纯函数（ESM 移植自 record-proxy.js:28-119）**

Create `server/src/record-proxy.ts`:
```ts
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import path from 'node:path';

export function buildTargetUrl(reqUrl: string, target: string): URL {
  // 不能用 new URL(reqUrl, target)：reqUrl 为绝对路径时会丢弃 target 的 path。手动拼接。
  const base = new URL(target);
  const basePath = base.pathname.replace(/\/+$/, '');
  const suffix = reqUrl.startsWith('/') ? reqUrl : '/' + reqUrl;
  return new URL(basePath + suffix, base.origin);
}

export function scrubAuth(headers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    out[k] = lk === 'authorization' || lk === 'x-api-key' || lk.includes('token') || lk.includes('key') ? '***' : v;
  }
  return out;
}

export function makeRecordId(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}

export function recordDir(d: Date = new Date(), logDir: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return path.join(logDir, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
}

export interface SseEvent { type: string; message?: { usage?: Record<string, number> }; delta?: { type?: string; text?: string; stop_reason?: string }; usage?: Record<string, number> }

export class SSEAccumulator {
  buffer = '';
  text = '';
  usage: Record<string, number> = {};
  stopReason: string | null = null;
  feed(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const data = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (!data || data === '[DONE]') continue;
      try { this.handle(JSON.parse(data) as SseEvent); } catch { /* 忽略坏帧 */ }
    }
  }
  private handle(e: SseEvent): void {
    if (e.type === 'message_start' && e.message?.usage) Object.assign(this.usage, e.message.usage);
    else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') this.text += e.delta.text ?? '';
    else if (e.type === 'message_delta') {
      if (e.usage) Object.assign(this.usage, e.usage);
      if (e.delta?.stop_reason) this.stopReason = e.delta.stop_reason;
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function injectWebSearch(reqJson: any): Record<string, unknown> | null {
  if (!reqJson || typeof reqJson !== 'object' || Array.isArray(reqJson)) return null;
  const tools = Array.isArray(reqJson.tools) ? reqJson.tools : [];
  if (tools.some((t: Record<string, unknown>) => t && (t.name === 'web_search' || t.type === 'web_search_20250305'))) return null;
  return { ...reqJson, tools: [...tools, { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/Shared/workspace/windows-record && npm -w server test -- record-proxy`
Expected: PASS（全部用例绿）。

- [ ] **Step 5: Commit**

```bash
cd /Users/Shared/workspace/windows-record
git add server/src/record-proxy.ts server/src/record-proxy.test.ts
git commit -q -m "feat(record): port pure fns (buildTargetUrl/scrubAuth/SSE/injectWebSearch) to TS" && echo done
```

---

## Task 3: record-store（windowId 分组 + sanitize + list/get/counts）

**Files:**
- Create: `server/src/record-store.ts`
- Test: `server/src/record-store.test.ts`

- [ ] **Step 1: 写失败测试（移植 collectRecords 用例 + 新增 sanitize/分组/counts/get）**

Create `server/src/record-store.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeWindowId, recordFilePath, listRecords, countRecords, getRecord } from './record-store.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('sanitizeWindowId', () => {
  it('合法 id 原样返回', () => {
    expect(sanitizeWindowId('wmt-b2')).toBe('wmt-b2');
    expect(sanitizeWindowId('default')).toBe('default');
  });
  it('空/undefined → default', () => {
    expect(sanitizeWindowId(undefined)).toBe('default');
    expect(sanitizeWindowId('')).toBe('default');
    expect(sanitizeWindowId('   ')).toBe('default');
  });
  it('含路径穿越字符 → default（安全边界）', () => {
    expect(sanitizeWindowId('../etc')).toBe('default');
    expect(sanitizeWindowId('a/b')).toBe('default');
    expect(sanitizeWindowId('a b')).toBe('default');
    expect(sanitizeWindowId('..')).toBe('default');
  });
});

describe('recordFilePath', () => {
  it('按 windowId/date/id 分层', () => {
    const p = recordFilePath(tmp, 'wmt-b2', new Date(2026, 5, 22), '112233-aabb');
    expect(p).toBe(path.join(tmp, 'wmt-b2', '2026-06-22', '112233-aabb.json'));
  });
});

describe('listRecords', () => {
  it('跨日期倒序，仅该 windowId', () => {
    fs.mkdirSync(path.join(tmp, 'wmt-b2', '2026-06-18'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'wmt-b2', '2026-06-22'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'default', '2026-06-22'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'wmt-b2', '2026-06-18', '181642-75cc.json'), '{}');
    fs.writeFileSync(path.join(tmp, 'wmt-b2', '2026-06-22', '112342-e133.json'), '{}');
    fs.writeFileSync(path.join(tmp, 'wmt-b2', '2026-06-22', '112454-a55a.json'), '{}');
    fs.writeFileSync(path.join(tmp, 'default', '2026-06-22', '999999-zzzz.json'), '{}'); // 不应出现
    const list = listRecords(tmp, 'wmt-b2');
    expect(list.map((e) => `${e.date}/${e.id}`)).toEqual([
      '2026-06-22/112454-a55a', '2026-06-22/112342-e133', '2026-06-18/181642-75cc',
    ]);
  });
  it('limit 截断', () => {
    fs.mkdirSync(path.join(tmp, 'wmt-b2', '2026-06-22'), { recursive: true });
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(tmp, 'wmt-b2', '2026-06-22', `10000${i}-aaaa.json`), '{}');
    expect(listRecords(tmp, 'wmt-b2', 3)).toHaveLength(3);
  });
  it('目录不存在返回空数组', () => {
    expect(listRecords(tmp, 'nope')).toEqual([]);
  });
  it('提取摘要字段', () => {
    fs.mkdirSync(path.join(tmp, 'wmt-b2', '2026-06-22'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'wmt-b2', '2026-06-22', '100000-aaaa.json'),
      JSON.stringify({ ts: '2026-06-22T02:00:00.000Z', model: 'glm-5.2', request: { model: 'glm-5.2' }, response: { usage: { input_tokens: 100, output_tokens: 50 } }, meta: { status: 200 } }));
    const e = listRecords(tmp, 'wmt-b2')[0];
    expect(e.model).toBe('glm-5.2');
    expect(e.status).toBe(200);
    expect(e.in).toBe(100);
    expect(e.out).toBe(50);
  });
});

describe('countRecords', () => {
  it('按 windowId 汇总计数', () => {
    fs.mkdirSync(path.join(tmp, 'wmt-b2', '2026-06-22'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'default', '2026-06-22'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'wmt-b2', '2026-06-22', '1-aaaa.json'), '{}');
    fs.writeFileSync(path.join(tmp, 'wmt-b2', '2026-06-22', '2-bbbb.json'), '{}');
    fs.writeFileSync(path.join(tmp, 'default', '2026-06-22', '3-cccc.json'), '{}');
    fs.writeFileSync(path.join(tmp, 'not-a-window', 'readme.txt'), 'x'); // 非法 windowId 不计入
    expect(countRecords(tmp)).toEqual({ 'wmt-b2': 2, default: 1 });
  });
  it('空目录返回空对象', () => {
    expect(countRecords(tmp)).toEqual({});
  });
});

describe('getRecord', () => {
  it('返回单条完整 JSON', () => {
    fs.mkdirSync(path.join(tmp, 'wmt-b2', '2026-06-22'), { recursive: true });
    const rec = { id: '100000-aaaa', windowId: 'wmt-b2', model: 'glm-5.2' };
    fs.writeFileSync(path.join(tmp, 'wmt-b2', '2026-06-22', '100000-aaaa.json'), JSON.stringify(rec));
    expect(getRecord(tmp, 'wmt-b2', '2026-06-22', '100000-aaaa')).toEqual(rec);
  });
  it('不存在返回 null', () => {
    expect(getRecord(tmp, 'wmt-b2', '2026-06-22', 'missing')).toBeNull();
  });
  it('windowId 含穿越字符也安全（归 default 查询）', () => {
    expect(getRecord(tmp, '..', '2026-06-22', 'x')).toBeNull(); // 不抛异常
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/Shared/workspace/windows-record && npm -w server test -- record-store`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 record-store**

Create `server/src/record-store.ts`:
```ts
import fs from 'node:fs';
import path from 'node:path';
import { makeRecordId } from './record-proxy.js';

export interface RecordSummary {
  date: string;
  id: string;
  ts: string | null;
  model: string | null;
  status: number | null;
  in: number;
  out: number;
}

// 系统边界校验：windowId 来自外部 header，只允许 [A-Za-z0-9_-]，否则归 default（防路径穿越）
export function sanitizeWindowId(raw: string | undefined): string {
  if (!raw) return 'default';
  const clean = raw.trim();
  return /^[A-Za-z0-9_-]+$/.test(clean) ? clean : 'default';
}

const pad = (n: number) => String(n).padStart(2, '0');
const dateStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function recordFilePath(logDir: string, windowId: string, d: Date, id: string): string {
  return path.join(logDir, sanitizeWindowId(windowId), dateStr(d), `${id}.json`);
}

// 异步落盘，吞错（绝不阻塞转发主路径）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function writeRecord(logDir: string, record: any): void {
  const wid = sanitizeWindowId(record.windowId);
  const d = record.ts ? new Date(record.ts) : new Date();
  const dir = path.join(logDir, wid, dateStr(d));
  fs.mkdir(dir, { recursive: true }, () => {
    fs.writeFile(path.join(dir, `${record.id}.json`), JSON.stringify(record, null, 2), () => { /* 吞错 */ });
  });
}

export function listRecords(logDir: string, windowId: string, limit = 200): RecordSummary[] {
  const wid = sanitizeWindowId(windowId);
  const wRoot = path.join(logDir, wid);
  let dayDirs: string[] = [];
  try { dayDirs = fs.readdirSync(wRoot).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)); } catch { return []; }
  const entries: RecordSummary[] = [];
  for (const date of dayDirs) {
    let files: string[] = [];
    try { files = fs.readdirSync(path.join(wRoot, date)); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const entry: RecordSummary = { date, id: file.replace(/\.json$/, ''), ts: null, model: null, status: null, in: 0, out: 0 };
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = JSON.parse(fs.readFileSync(path.join(wRoot, date, file), 'utf8')) as any;
        entry.ts = raw.ts ?? null;
        entry.model = (raw.request && raw.request.model) || raw.model || null;
        entry.status = (raw.meta && raw.meta.status) ?? null;
        entry.in = (raw.response && raw.response.usage && raw.response.usage.input_tokens) || 0;
        entry.out = (raw.response && raw.response.usage && raw.response.usage.output_tokens) || 0;
      } catch { /* 坏文件跳过 */ }
      entries.push(entry);
    }
  }
  entries.sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id));
  return entries.slice(0, limit);
}

export function countRecords(logDir: string): Record<string, number> {
  const out: Record<string, number> = {};
  let wids: string[] = [];
  try { wids = fs.readdirSync(logDir); } catch { return out; }
  for (const wid of wids) {
    if (!/^[A-Za-z0-9_-]+$/.test(wid)) continue; // 仅计合法 windowId 目录
    const wRoot = path.join(logDir, wid);
    if (!fs.statSync(wRoot).isDirectory()) continue;
    let n = 0;
    let dayDirs: string[] = [];
    try { dayDirs = fs.readdirSync(wRoot); } catch { continue; }
    for (const dd of dayDirs) {
      try { if (fs.statSync(path.join(wRoot, dd)).isDirectory()) n += fs.readdirSync(path.join(wRoot, dd)).filter((f) => f.endsWith('.json')).length; } catch { /* skip */ }
    }
    if (n > 0) out[wid] = n;
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getRecord(logDir: string, windowId: string, date: string, id: string): any | null {
  const wid = sanitizeWindowId(windowId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[A-Za-z0-9-]+$/.test(id)) return null; // 边界校验 date/id
  const fp = path.join(logDir, wid, date, `${id}.json`);
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

export { makeRecordId };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/Shared/workspace/windows-record && npm -w server test -- record-store`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd /Users/Shared/workspace/windows-record
git add server/src/record-store.ts server/src/record-store.test.ts
git commit -q -m "feat(record): record-store with windowId grouping + sanitize" && echo done
```

---

## Task 4: handleProxy（透传 + 录制 + X-Window-Id）+ 挂载到 server.ts

**Files:**
- Modify: `server/src/record-proxy.ts`（追加 handleProxy）
- Modify: `server/src/server.ts`（路由分发 + 注入 record opts）
- Test: `server/src/record-proxy.test.ts`（追加集成测试）

- [ ] **Step 1: 写失败集成测试（带 X-Window-Id 的 POST → 落盘正确目录 + 转发上游不含该 header）**

Append to `server/src/record-proxy.test.ts`:
```ts
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleProxy } from './record-proxy.js';

// 起 mock 上游，记录收到的请求
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

describe('handleProxy', () => {
  it('读 X-Window-Id 落盘到对应目录，转发前剥离该 header', async () => {
    const cap = { headers: {} as http.IncomingHttpHeaders, body: '', status: 200 };
    const up = startUpstream(cap);
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', () => r()));
    const upPort = (up.address() as any).port;
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));

    const resBody = JSON.stringify({ model: 'glm-5.2', messages: [], stream: false });
    const res = await new Promise<{ status: number; body: string }>((resolve) => {
      const r = http.request({ port: upPort, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json', 'x-api-key': 'sk-x', 'x-window-id': 'wmt-b2' } }, (rr) => {
        let b = ''; rr.on('data', (c) => (b += c)); rr.on('end', () => resolve({ status: rr.statusCode ?? 0, body: b }));
      });
      r.end(resBody);
      // 这里直接把 server 侧 req/res 交给 handleProxy：用一个本地 http server 包一层
      const local = http.createServer((lreq, lres) => handleProxy(lreq, lres, { target: `http://127.0.0.1:${upPort}`, logDir, maxBytes: 10 * 1024 * 1024, injectWebsearch: false }));
      local.listen(0, '127.0.0.1');
    });

    // 等待落盘（异步）
    await new Promise((r) => setTimeout(r, 100));
    up.close();
    expect(res.body).toBe(JSON.stringify({ ok: true }));
    // 转发到上游的请求不应含 X-Window-Id，且保留 x-api-key
    expect(cap.headers['x-window-id']).toBeUndefined();
    expect(cap.headers['x-api-key']).toBe('sk-x');
    // 落盘到 data/wmt-b2/<date>/<id>.json
    const dayDir = fs.readdirSync(path.join(logDir, 'wmt-b2'))[0];
    const file = fs.readdirSync(path.join(logDir, 'wmt-b2', dayDir))[0];
    expect(file).toMatch(/\.json$/);
    const rec = JSON.parse(fs.readFileSync(path.join(logDir, 'wmt-b2', dayDir, file), 'utf8'));
    expect(rec.windowId).toBe('wmt-b2');
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it('缺 X-Window-Id 时归 default', async () => {
    const cap = { headers: {} as http.IncomingHttpHeaders, body: '', status: 200 };
    const up = startUpstream(cap);
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', () => r()));
    const upPort = (up.address() as any).port;
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
    await new Promise<void>((resolve) => {
      const r = http.request({ port: upPort, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json' } }, () => resolve());
      r.on('error', () => resolve());
      // 注：此用例改为走 local server
      void r;
      resolve();
    });
    // 上面请求未走 handleProxy；改用 local server 重新发：
    const local = http.createServer((lreq, lres) => handleProxy(lreq, lres, { target: `http://127.0.0.1:${upPort}`, logDir, maxBytes: 10 * 1024 * 1024, injectWebsearch: false }));
    await new Promise<void>((r) => local.listen(0, '127.0.0.1', () => r()));
    const localPort = (local.address() as any).port;
    await new Promise<void>((resolve) => {
      const r = http.request({ port: localPort, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json' } }, () => resolve());
      r.end(JSON.stringify({ model: 'glm-5.2', messages: [] }));
    });
    await new Promise((r) => setTimeout(r, 100));
    up.close(); local.close();
    expect(fs.existsSync(path.join(logDir, 'default'))).toBe(true);
    fs.rmSync(logDir, { recursive: true, force: true });
  });
});
```

> 注：上面第一个用例的请求构造有简化瑕疵（直接发到 upstream 而非 local）。**实现时按第二个用例的模式修正**：统一用 local server 监听随机端口，客户端发到 localPort。两用例都先 `local.listen` 拿 localPort 再发请求。保持断言不变。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/Shared/workspace/windows-record && npm -w server test -- record-proxy`
Expected: FAIL（`handleProxy` 未导出）。

- [ ] **Step 3: 追加 handleProxy 到 record-proxy.ts（移植 record-proxy.js:134-197，加 windowId + 剥 header）**

Append to `server/src/record-proxy.ts`:
```ts
import http from 'node:http';
import https from 'node:https';
import { PassThrough } from 'node:stream';
import { scrubAuth } from './record-proxy.js'; // 同文件，TS ESM 自引用省略；实际用本文件内 scrubAuth，无需重复 import
import { sanitizeWindowId, writeRecord } from './record-store.js';

export interface ProxyOpts {
  target: string;
  logDir: string;
  maxBytes: number;
  injectWebsearch: boolean;
}

export function handleProxy(req: http.IncomingMessage, res: http.ServerResponse, opts: ProxyOpts): void {
  const startedAt = Date.now();
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const reqBody = Buffer.concat(chunks);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let reqJson: any = null;
    try { reqJson = JSON.parse(reqBody.toString('utf8')); } catch { /* 非 JSON body */ }
    let outBody: Buffer = reqBody;
    let outJson = reqJson;
    let injected = false;
    if (opts.injectWebsearch && reqJson) {
      const inj = injectWebSearch(reqJson);
      if (inj) { outJson = inj; outBody = Buffer.from(JSON.stringify(inj), 'utf8'); injected = true; }
    }
    const windowId = sanitizeWindowId(req.headers['x-window-id'] as string | undefined);
    const u = buildTargetUrl(req.url ?? '/', opts.target);
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    // 转发前剥离内部窗口标记，不泄露给上游；其余 header 原样转发
    const fwdHeaders: Record<string, unknown> = { ...req.headers, host: u.hostname, 'content-length': String(outBody.length) };
    delete fwdHeaders['x-window-id'];
    const proxyReq = mod.request({
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: req.method,
      headers: fwdHeaders,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      const tap = new PassThrough();
      const sse = new SSEAccumulator();
      let bytes = 0, truncated = false;
      tap.on('data', (c: Buffer) => {
        if (bytes <= opts.maxBytes) { sse.feed(c); bytes += c.length; } else truncated = true;
      });
      tap.on('end', () => {
        writeRecord(opts.logDir, {
          id: makeRecordId(),
          ts: new Date().toISOString(),
          windowId,
          model: (outJson && outJson.model) || null,
          stream: !!(outJson && outJson.stream),
          request: outJson || null,
          response: { text: sse.text, stop_reason: sse.stopReason, usage: sse.usage },
          meta: { status: proxyRes.statusCode ?? null, duration_ms: Date.now() - startedAt, bytes, truncated, injected_websearch: injected, response_headers: scrubAuth(proxyRes.headers as Record<string, unknown>) },
        });
      });
      proxyRes.pipe(res);   // 主路径：流式转发（零缓冲）
      proxyRes.pipe(tap);   // 旁路：累积录制
    });
    proxyReq.on('error', (err: Error) => {
      try { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'proxy_error', message: err.message })); } catch { /* 已写头 */ }
    });
    if (outBody.length) proxyReq.write(outBody);
    proxyReq.end();
  });
}
```

> **修正（实现时执行）**：文件顶部的自引用 `import { scrubAuth } from './record-proxy.js'` 是多余的——`scrubAuth`、`buildTargetUrl`、`injectWebSearch`、`makeRecordId`、`SSEAccumulator` 都在本文件内定义，删除那行重复 import；仅保留 `import { sanitizeWindowId, writeRecord } from './record-store.js'` 和 node 内置 import。把 node 内置 import（http/https/{PassThrough}）移到文件顶部与其他 import 一起。

- [ ] **Step 4: 跑测试确认通过（必要时按 Step1 注释修正两用例的请求构造为 local-listen-then-request）**

Run: `cd /Users/Shared/workspace/windows-record && npm -w server test -- record-proxy`
Expected: PASS。

- [ ] **Step 5: 挂载到 server.ts（路由分发：非 GET → 代理；GET 保留现有 + 录制 API 占位下个 Task 填）**

Modify `server/src/server.ts`——在 `createServer` 内引入 record opts 并改写请求分发。把现有：
```ts
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/sessions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(mgr.list()));
      return;
    }
    const filePath = path.join(WEB_ROOT, url === '/' ? 'index.html' : url);
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
      res.end(data);
    });
  });
```
改为：
```ts
  const RECORD_TARGET = process.env.RECORD_TARGET || 'https://open.bigmodel.cn/api/anthropic';
  const RECORD_LOG_DIR = process.env.RECORD_LOG_DIR || path.resolve(__dirname, '../../data');
  const RECORD_MAX_BYTES = parseInt(process.env.RECORD_MAX_BYTES || String(10 * 1024 * 1024), 10);
  const RECORD_INJECT_WS = process.env.RECORD_INJECT_WEBSEARCH !== '0';

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';
    // 录制查看 API（GET /api/record/*）—— Task 5 实现
    if (method === 'GET' && url.startsWith('/api/record/')) {
      res.writeHead(501, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not implemented yet' }));
      return;
    }
    // 非 GET（claude 的 POST /v1/messages 等）→ 代理透传 + 旁路录制
    if (method !== 'GET') {
      handleProxy(req, res, { target: RECORD_TARGET, logDir: RECORD_LOG_DIR, maxBytes: RECORD_MAX_BYTES, injectWebsearch: RECORD_INJECT_WS });
      return;
    }
    // GET：会话列表 或 静态文件
    if (url === '/sessions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(mgr.list()));
      return;
    }
    const filePath = path.join(WEB_ROOT, url === '/' ? 'index.html' : url);
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
      res.end(data);
    });
  });
```
并在文件顶部 import 区追加：
```ts
import { handleProxy } from './record-proxy.js';
```

- [ ] **Step 6: 构建 + 全量测试**

Run: `cd /Users/Shared/workspace/windows-record && npm -w server run build && npm -w server test`
Expected: tsc 通过；全部测试绿（含原 windows 测试）。

- [ ] **Step 7: Commit**

```bash
cd /Users/Shared/workspace/windows-record
git add server/src/record-proxy.ts server/src/record-proxy.test.ts server/src/server.ts
git commit -q -m "feat(record): handleProxy with X-Window-Id + mount proxy route in server" && echo done
```

---

## Task 5: 录制查看 API（counts / list / get）

**Files:**
- Modify: `server/src/server.ts`（替换 Task 4 的 501 占位为真实实现）
- Test: `server/src/server.test.ts`（追加）或新建 `server/src/record-api.test.ts`

- [ ] **Step 1: 写失败测试（GET /api/record/counts 与 /api/record/list?window=）**

Create `server/src/record-api.test.ts`:
```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/Shared/workspace/windows-record && npm -w server test -- record-api`
Expected: FAIL（counts 返回 501/not implemented）。

- [ ] **Step 3: 实现 API（替换 server.ts 里 Task 4 的 501 占位块）**

Modify `server/src/server.ts`——把：
```ts
    if (method === 'GET' && url.startsWith('/api/record/')) {
      res.writeHead(501, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not implemented yet' }));
      return;
    }
```
替换为：
```ts
    if (method === 'GET' && url.startsWith('/api/record/')) {
      const u = new URL(url, `http://localhost`);
      const json = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (u.pathname === '/api/record/counts') return json(200, countRecords(RECORD_LOG_DIR));
      if (u.pathname === '/api/record/list') {
        const wid = u.searchParams.get('window') || 'default';
        return json(200, listRecords(RECORD_LOG_DIR, wid));
      }
      const m = u.pathname.match(/^\/api\/record\/([A-Za-z0-9_-]+)\/(\d{4}-\d{2}-\d{2})\/([\w-]+)$/);
      if (m) {
        const rec = getRecord(RECORD_LOG_DIR, m[1], m[2], m[3]);
        if (!rec) return json(404, { error: 'not found' });
        return json(200, rec);
      }
      return json(404, { error: 'not found' });
    }
```
并在顶部 import 追加：
```ts
import { countRecords, listRecords, getRecord } from './record-store.js';
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/Shared/workspace/windows-record && npm -w server test -- record-api`
Expected: PASS。

- [ ] **Step 5: 全量构建 + 测试**

Run: `cd /Users/Shared/workspace/windows-record && npm -w server run build && npm -w server test`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
cd /Users/Shared/workspace/windows-record
git add server/src/server.ts server/src/record-api.test.ts
git commit -q -m "feat(record): GET /api/record counts/list/get endpoints" && echo done
```

---

## Task 6: claude-record.sh profile + 冒烟验证

**Files:**
- Create: `claude-record.sh`
- Create: `README.md`

- [ ] **Step 1: 写 profile 脚本**

Create `claude-record.sh`:
```bash
#!/bin/bash
# claude-record: 在 windows 窗口内启动 Claude Code 并把请求发往 windows-record 录制代理。
# 来源窗口识别：tmux -L <socket> display 取当前 session 名；非 windows 终端 → default。
# 用法: source claude-record.sh && claude-record -p "你好"
claude-record() {
  local socket="${WMT_SOCKET:-wmt}"
  local port="${WMT_PORT:-3000}"
  local wid="${WMT_WINDOW_ID:-$(tmux -L "$socket" display-message -p '#S' 2>/dev/null)}"
  wid="${wid:-default}"
  ANTHROPIC_BASE_URL="http://localhost:${port}" \
  ANTHROPIC_CUSTOM_HEADERS="X-Window-Id: ${wid}" \
  claude "$@"
}
```

- [ ] **Step 2: 写 README**

Create `windows-record/README.md`:
````markdown
# windows-record

windows（web 多终端）× claude-record-proxy（请求录制）合并版。以 windows 为主：录制内嵌进 server，模型请求按 windows 窗口（tmux session）分组。

## 启动
```bash
npm install
npm run dev          # 起 server(:3000) + web(vite)
```

## 录制（在某个 windows 窗口内）
```bash
source claude-record.sh
claude-record -p "你好"   # 该窗口的徽标会出现 ●录(N)，点开看录制
```
- 普通 `claude`（不改 BASE_URL）→ 直连上游，不经代理，无录制。
- 非 windows 终端跑 `claude-record` → 录制归 `default` 分组。

## 环境变量
| 变量 | 默认 | 说明 |
|:--|:--|:--|
| `PORT` | 3000 | windows server 端口（= 代理端口） |
| `RECORD_TARGET` | `https://open.bigmodel.cn/api/anthropic` | 上游 |
| `RECORD_LOG_DIR` | `./data` | 录制落盘根目录（按 `<windowId>/<date>/` 分组） |
| `RECORD_INJECT_WEBSEARCH` | `1` | 注入 GLM web_search；`0` 关闭 |
| `WMT_SOCKET` | `wmt` | claude-record 取窗口名用的 tmux socket |
| `WMT_PORT` | `3000` | claude-record 指向的代理端口 |

## 测试
```bash
npm -w server test
```
````

- [ ] **Step 3: 手动冒烟（验证 X-Window-Id 确实带上；若失败回退 path 前缀方案）**

```
启动: cd windows-record && npm run dev  (浏览器开 http://localhost:3000，新建一个窗口 wmt-xxx)
在该窗口终端内: source claude-record.sh && claude-record -p "你好，报一下你的模型名"
预期: claude 正常响应；server 控制台/日志可见录制落盘
查看: ls data/  应出现与该窗口同名的目录(wmt-xxx)，其下有 <date>/<HHMMSS-id>.json
```
**判定**：
- 看到 `data/<wmt-xxx>/` → header 方案生效，继续 Task 7。
- 只看到 `data/default/` 或无录制 → header 未带；在 server.ts 的 handleProxy 入口临时加 `console.log('wid', req.headers['x-window-id'])` 确认。若确认没带，回退 path 前缀方案（见下方）。

**回退方案（path 前缀）**——仅当 header 不生效时执行：
1. `claude-record.sh` 改为 `ANTHROPIC_BASE_URL="http://localhost:${port}/r/${wid}"`（去掉 CUSTOM_HEADERS）。
2. `server.ts` 非 GET 分发前，从 `req.url` 剥离 `/r/<wid>` 前缀：`const m = req.url.match(/^\/r\/([A-Za-z0-9_-]+)(\/.*)?$/); if (m) { windowIdOverride = m[1]; req.url = m[2] || '/'; }`，handleProxy 用 override 优先于 header。
3. 重跑冒烟。

- [ ] **Step 4: Commit**

```bash
cd /Users/Shared/workspace/windows-record
git add claude-record.sh README.md
git commit -q -m "feat: claude-record profile + README" && echo done
```

---

## Task 7: web 徽标（counts 轮询）

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/use-sessions.ts`
- Modify: `web/src/components/session-list.tsx`

- [ ] **Step 1: 加类型**

Modify `web/src/types.ts`——文件末尾追加：
```ts
export interface RecordSummary {
  date: string;
  id: string;
  ts: string | null;
  model: string | null;
  status: number | null;
  in: number;
  out: number;
}
export type RecordCounts = Record<string, number>;
```

- [ ] **Step 2: use-sessions 加 counts 轮询（3s）并合并进返回**

Modify `web/src/use-sessions.ts`：
- import 行后追加：
```ts
import type { RecordCounts } from './types.js';
```
- 在 `const [running, setRunning] = ...` 后追加状态与轮询 effect：
```ts
  const [recordCounts, setRecordCounts] = useState<RecordCounts>({});
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch('/api/record/counts');
        if (r.ok && alive) setRecordCounts(await r.json());
      } catch { /* server 未就绪忽略 */ }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);
```
- 把 `SessionWithStatus` 接口加字段：在 `commands: string[];` 后加 `recordCount: number;`。
- `sessionsWithStatus` 映射里加：`recordCount: recordCounts[s.sessionId] ?? 0,`。
- 返回对象改为 `return { sessions: sessionsWithStatus, activeId, setActiveId, create, close, reportSize, recordCounts };`。

- [ ] **Step 3: session-list 徽标**

Modify `web/src/components/session-list.tsx`——在 `<div className="row-head" ...>` 内、`<span className="row-cwd"...>` 之后加徽标：
```tsx
            {s.recordCount > 0 && (
              <span className="row-record" title={`${s.recordCount} 条录制`} onClick={(e) => { e.stopPropagation(); onShowRecord?.(s.sessionId); }}>●录({s.recordCount})</span>
            )}
```
`Props` 接口加可选回调：`onShowRecord?: (id: string) => void;`，函数签名解构加 `onShowRecord`。

- [ ] **Step 4: 徽标样式**

Modify `web/src/styles.css`——追加：
```css
.row-record { font: 11px var(--mono, ui-monospace); color: #22C55E; cursor: pointer; padding: 1px 6px; border-radius: 4px; background: rgba(34,197,94,.12); margin-left: auto; }
.row-record:hover { background: rgba(34,197,94,.22); }
```

- [ ] **Step 5: 跑前端测试 + 构建**

Run: `cd /Users/Shared/workspace/windows-record && npm -w web run build && npm -w web test`
Expected: 构建无 TS 错；现有 web 测试（use-sessions/ws-client）仍绿（新增逻辑不破坏既有断言）。

- [ ] **Step 6: Commit**

```bash
cd /Users/Shared/workspace/windows-record
git add web/src/types.ts web/src/use-sessions.ts web/src/components/session-list.tsx web/src/styles.css
git commit -q -m "feat(web): window record badge with counts polling" && echo done
```

---

## Task 8: record-view.tsx + 视图切换（迁移 record-viewer.html）

**Files:**
- Create: `web/src/components/record-view.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`

- [ ] **Step 1: 写 record-view 组件（迁移 record-viewer.html 的列表 + 5 tab 详情；API 改为按 windowId）**

Create `web/src/components/record-view.tsx`:
```tsx
import { useEffect, useState } from 'react';
import type { RecordSummary } from '../types.js';

interface Props { windowId: string; onBack: () => void; }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = any;

export function RecordView({ windowId, onBack }: Props) {
  const [items, setItems] = useState<RecordSummary[]>([]);
  const [sel, setSel] = useState<Rec | null>(null);
  const [tab, setTab] = useState('response');

  useEffect(() => {
    let alive = true;
    fetch(`/api/record/list?window=${encodeURIComponent(windowId)}`).then((r) => r.json()).then((list: RecordSummary[]) => { if (alive) setItems(list); }).catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [windowId]);

  const open = async (date: string, id: string) => {
    const r = await fetch(`/api/record/${encodeURIComponent(windowId)}/${date}/${id}`);
    setSel(await r.json());
    setTab('response');
  };

  const idToTime = (id: string) => `${id.slice(0, 2)}:${id.slice(2, 4)}:${id.slice(4, 6)}`;

  return (
    <div className="record-view">
      <div className="rv-bar">
        <button className="rv-back" onClick={onBack}>← 返回终端</button>
        <span className="rv-title">录制 · {windowId}</span>
        <span className="rv-count">{items.length}</span>
      </div>
      <div className="rv-body">
        <aside className="rv-list">
          {items.length === 0 ? <div className="rv-empty">无录制</div> : items.map((it) => (
            <div className="rv-item" key={`${it.date}/${it.id}`} onClick={() => open(it.date, it.id)}>
              <span className={`rv-dot s${it.status ? String(it.status)[0] : ''}`} />
              <div className="rv-item-main">
                <div className="rv-item-top"><span className="rv-time">{it.date} {idToTime(it.id)}</span><span className="rv-code">{it.status ?? ''}</span></div>
                <div className="rv-model">{it.model ?? '?'}</div>
                <div className="rv-tok">↑{it.in} ↓{it.out}</div>
              </div>
            </div>
          ))}
        </aside>
        <main className="rv-detail">
          {!sel ? <div className="rv-empty">选择左侧请求查看详情</div> : (
            <>
              <MetaBar rec={sel} />
              <nav className="rv-tabs">
                {['response', 'system', 'messages', 'tools', 'raw'].map((t) => (
                  <button key={t} className={`rv-tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t}</button>
                ))}
              </nav>
              <div className="rv-tab-body">
                {tab === 'response' && <ResponseTab rec={sel} />}
                {tab === 'system' && <SystemTab sys={sel.request?.system} />}
                {tab === 'messages' && <MessagesTab messages={sel.request?.messages} />}
                {tab === 'tools' && <ToolsTab tools={sel.request?.tools} />}
                {tab === 'raw' && <pre className="rv-pre">{JSON.stringify(sel, null, 2)}</pre>}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

const MetaBar = ({ rec }: { rec: Rec }) => {
  const u = rec.response?.usage || {};
  const m = rec.meta || {};
  return (
    <div className="rv-meta">
      <Kv k="model" v={rec.model ?? '?'} />
      <Kv k="status" v={m.status ?? '?'} />
      <Kv k="耗时" v={m.duration_ms != null ? `${m.duration_ms}ms` : '?'} />
      <Kv k="输入" v={String(u.input_tokens || 0)} />
      <Kv k="输出" v={String(u.output_tokens || 0)} />
      {m.truncated && <span className="rv-flag warn">truncated</span>}
      {m.injected_websearch && <span className="rv-flag">web_search</span>}
    </div>
  );
};
const Kv = ({ k, v }: { k: string; v: string }) => (<div className="rv-kv"><div className="rv-k">{k}</div><div className="rv-v">{v}</div></div>);

const ResponseTab = ({ rec }: { rec: Rec }) => {
  const text = rec.response?.text;
  return (<>{text ? <pre className="rv-pre">{text}</pre> : <div className="rv-empty">无响应文本</div>}{rec.response?.stop_reason && <div className="rv-stop">stop_reason: {rec.response.stop_reason}</div>}</>);
};
const SystemTab = ({ sys }: { sys: Rec }) => {
  if (!sys) return <div className="rv-empty">无 system prompt</div>;
  const parts: string[] = typeof sys === 'string' ? [sys] : Array.isArray(sys) ? sys.map((s: Rec) => s?.text || '').filter(Boolean) : [JSON.stringify(sys, null, 2)];
  return (<details open><summary>system 全文</summary>{parts.map((t, i) => <pre className="rv-pre" key={i}>{t}</pre>)}</details>);
};
const MessagesTab = ({ messages }: { messages: Rec[] }) => {
  if (!Array.isArray(messages) || !messages.length) return <div className="rv-empty">无消息</div>;
  return (<>{messages.map((m, i) => (<div className={`rv-msg role-${m.role}`} key={i}><div className="rv-msg-head"><span className="rv-role">{m.role}</span><span className="rv-idx">#{i}</span></div><Content c={m.content} /></div>))}</>);
};
const ToolsTab = ({ tools }: { tools: Rec[] }) => {
  if (!Array.isArray(tools) || !tools.length) return <div className="rv-empty">无工具</div>;
  return (<>{tools.map((t, i) => (<details key={i}><summary><span className="rv-tool-name">{t.name || t.type}</span></summary>{t.description && <p className="rv-tool-desc">{t.description}</p>}{t.input_schema && <pre className="rv-pre">{JSON.stringify(t.input_schema, null, 2)}</pre>}</details>))}</>);
};
const Content = ({ c }: { c: Rec }) => {
  if (c == null) return <span className="rv-muted">（空）</span>;
  if (typeof c === 'string') return <div className="rv-text">{c}</div>;
  if (Array.isArray(c)) return (<>{c.map((b, i) => <Block key={i} b={b} />)}</>);
  return <pre className="rv-pre">{JSON.stringify(c, null, 2)}</pre>;
};
const Block = ({ b }: { b: Rec }) => {
  if (b?.type === 'text') return <div className="rv-text">{b.text}</div>;
  if (b?.type === 'tool_use') return (<details><summary><span className="rv-blk use">tool_use</span> {b.name}</summary><pre className="rv-pre">{JSON.stringify(b.input ?? {}, null, 2)}</pre></details>);
  if (b?.type === 'tool_result') return (<details><summary><span className={`rv-blk result${b.is_error ? ' err' : ''}`}>tool_result</span></summary><div className="rv-result"><Content c={b.content} /></div></details>);
  if (b?.type === 'thinking') return (<details><summary><span className="rv-blk think">thinking</span></summary><pre className="rv-pre">{b.thinking}</pre></details>);
  return <pre className="rv-pre">{JSON.stringify(b, null, 2)}</pre>;
};
```

- [ ] **Step 2: App.tsx 视图切换（点徽标 → 主区域切到 RecordView）**

Modify `web/src/App.tsx`：
- import 追加：`import { RecordView } from './components/record-view.js';`
- `useSessions` 解构追加 `recordCounts`（来自 Task 7 返回）；并加状态：
```tsx
  const [recordViewId, setRecordViewId] = useState<string | null>(null);
```
- `<SessionList .../>` 加属性 `onShowRecord={setRecordViewId}`。
- `<main className="main">` 内部，把现有 `main-head` / `MainTerminal` / `QuickInput` 用条件包裹：
```tsx
      <main className="main">
        {recordViewId ? (
          <RecordView windowId={recordViewId} onBack={() => setRecordViewId(null)} />
        ) : (
          <>
            <div className="main-head">{/* 原有 main-head 内容不变 */}</div>
            <MainTerminal ref={mainRef} client={client} sessionId={activeId} reportSize={reportSize} />
            <QuickInput client={client} sessionId={activeId} onAfterSend={() => mainRef.current?.focus()} />
          </>
        )}
      </main>
```
（把原 `main-head` 的 JSX 整体搬进 `<>` 内，内容不变。）

- [ ] **Step 3: 录制视图样式（从 record-viewer.html 迁移配色）**

Modify `web/src/styles.css`——追加（精简版，复用原 HTML 的深色变量）：
```css
.record-view { display: flex; flex-direction: column; height: 100%; background: #0F172A; color: #F8FAFC; }
.rv-bar { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid #334155; }
.rv-back { background: none; border: 1px solid #334155; color: #CBD5E1; padding: 4px 10px; border-radius: 6px; cursor: pointer; }
.rv-title { font-weight: 600; } .rv-count { color: #94A3B8; font-family: ui-monospace,monospace; }
.rv-body { flex: 1; display: flex; overflow: hidden; }
.rv-list { width: 300px; overflow-y: auto; border-right: 1px solid #334155; }
.rv-item { display: flex; gap: 8px; padding: 8px 10px; cursor: pointer; border-bottom: 1px solid #1E293B; }
.rv-item:hover { background: #1E293B; } .rv-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; background: #64748B; }
.rv-dot.s2 { background: #22C55E; } .rv-dot.s4 { background: #F59E0B; } .rv-dot.s5 { background: #EF4444; }
.rv-model { color: #38BDF8; font-family: ui-monospace,monospace; font-size: 12px; }
.rv-tok, .rv-time, .rv-code { font-family: ui-monospace,monospace; font-size: 11px; color: #94A3B8; }
.rv-detail { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.rv-meta { display: flex; flex-wrap: wrap; gap: 10px 18px; padding: 12px 16px; border-bottom: 1px solid #334155; }
.rv-k { font-size: 11px; color: #94A3B8; text-transform: uppercase; } .rv-v { font-family: ui-monospace,monospace; color: #CBD5E1; }
.rv-flag { font: 11px ui-monospace,monospace; padding: 2px 6px; border-radius: 4px; background: rgba(56,189,248,.12); color: #38BDF8; }
.rv-flag.warn { background: rgba(245,158,11,.12); color: #F59E0B; }
.rv-tabs { display: flex; border-bottom: 1px solid #334155; padding: 0 12px; }
.rv-tab { background: none; border: none; color: #94A3B8; padding: 8px 12px; cursor: pointer; border-bottom: 2px solid transparent; text-transform: capitalize; }
.rv-tab.active { color: #F8FAFC; border-bottom-color: #22C55E; }
.rv-tab-body { flex: 1; overflow-y: auto; padding: 16px; }
.rv-pre { font: 13px/1.6 ui-monospace,monospace; white-space: pre-wrap; word-break: break-word; background: #0B1220; border: 1px solid #334155; border-radius: 6px; padding: 12px; margin: 8px 0; color: #CBD5E1; }
.rv-text { font: 13px/1.65 ui-monospace,monospace; white-space: pre-wrap; word-break: break-word; color: #CBD5E1; }
.rv-empty { color: #94A3B8; font-style: italic; padding: 16px; }
.rv-msg { border-left: 3px solid #334155; padding: 6px 0 6px 12px; margin: 8px 0; }
.rv-msg.role-user { border-left-color: #38BDF8; } .rv-msg.role-assistant { border-left-color: #A78BFA; }
.rv-role { font: 11px ui-monospace,monospace; font-weight: 600; text-transform: uppercase; color: #94A3B8; }
.rv-tool-name { color: #22C55E; font-family: ui-monospace,monospace; }
.rv-blk.use { color: #38BDF8; } .rv-blk.result { color: #22C55E; } .rv-blk.result.err { color: #EF4444; } .rv-blk.think { color: #A78BFA; }
details { margin: 6px 0; background: #0B1220; border: 1px solid #334155; border-radius: 6px; }
details > summary { cursor: pointer; padding: 6px 10px; font: 12px ui-monospace,monospace; color: #CBD5E1; }
.rv-stop { font: 12px ui-monospace,monospace; color: #94A3B8; }
```

- [ ] **Step 4: 构建 + 前端测试**

Run: `cd /Users/Shared/workspace/windows-record && npm -w web run build && npm -w web test`
Expected: 构建无 TS 错；测试绿。

- [ ] **Step 5: Commit**

```bash
cd /Users/Shared/workspace/windows-record
git add web/src/components/record-view.tsx web/src/App.tsx web/src/styles.css
git commit -q -m "feat(web): record-view (list + detail tabs) + view switching" && echo done
```

---

## Task 9: 端到端验证（手动 checklist）

**Files:** 无（验证）

- [ ] **Step 1: 起服务**

```
cd /Users/Shared/workspace/windows-record && npm run dev
浏览器开 http://localhost:3000 → 新建窗口 A（wmt-xxx）
```

- [ ] **Step 2: 录制 + 分组**

```
窗口 A 内: source claude-record.sh && claude-record -p "你好"
预期: claude 正常响应；侧栏窗口 A 出现徽标 ●录(1)
另建窗口 B 用普通 claude(直连): claude -p "hi" → B 无徽标
```

- [ ] **Step 3: 查看入口**

```
点窗口 A 徽标 → 主区域切到 RecordView，列表显示 1 条
点该条 → response/system/messages/tools/raw 五 tab 可切换，system 全文/messages/tools/usage 可见
点"← 返回终端" → 回到终端，session 未销毁
```

- [ ] **Step 4: 脱敏 + 不泄露 header**

```
cat data/<wmt-xxx>/<date>/*.json | grep -i "api-key\|authorization" → 应只见 "***"
转发确认: handleProxy 已 delete x-window-id，上游不会收到（Task 4 测试已覆盖）
```

- [ ] **Step 5: default 分组**

```
普通 terminal(非 windows): source claude-record.sh && claude-record -p "test"
预期: data/default/<date>/ 有录制；windows UI 不显示该窗口（因不在 windows 内）
```

- [ ] **Step 6: 效率 + 边界**

```
计时对比 claude-record vs claude 响应延迟（应无感差异）
触发 response 截断: 已由 MAX_BYTES 覆盖（meta.truncated）
非法 windowId: 手动 curl -H "x-window-id: ../x" … → 落盘到 data/default/
```

- [ ] **Step 7: 全量自动化测试最终确认**

Run: `cd /Users/Shared/workspace/windows-record && npm test`
Expected: server + web 全部测试绿。

- [ ] **Step 8: 最终 commit（若有验证中的小修）**

```bash
cd /Users/Shared/workspace/windows-record
git add -A && git commit -q -m "test: e2e verified" 2>/dev/null || echo "nothing to commit"
```

---

## Self-Review（写计划后自检）

**1. Spec 覆盖：**
- 内嵌同进程同端口 → Task 4/5（server.ts 挂载）✓
- Header 识别 + path 回退 → Task 4 handleProxy + Task 6 冒烟/回退 ✓
- 窗口关联 P2（tmux display 取名）→ Task 6 claude-record.sh ✓
- 按窗口分组落盘 `data/<wid>/<date>/` → Task 3 record-store + Task 4 写入 ✓
- 路由分发（非GET→代理）→ Task 4 ✓
- web 徽标轮询 → Task 7 ✓
- record-view 迁移 → Task 8 ✓
- 错误处理（脱敏/截断/剥离 header/sanitize/default）→ Task 3/4 ✓
- 测试（移植纯函数 + 新增分组/header/集成 + record API）→ Task 2/3/4/5 ✓
- 不改原两项目 → 全程在 windows-record/ 内 ✓

**2. Placeholder 扫描：** Task 4 Step1 测试构造有已知瑕疵并已标注"实现时按 Step1 注释修正"；无 TBD/TODO/泛化措辞。

**3. 类型一致性：** `RecordSummary`/`RecordCounts`（types.ts）在 use-sessions、session-list、record-view、record-store 间一致；`SessionWithStatus.recordCount` 一致；`ProxyOpts`、`sanitizeWindowId`/`writeRecord`/`listRecords`/`countRecords`/`getRecord` 签名在各 Task 间一致。
