# 会话命令历史服务端持久化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把终端会话的命令历史解析从浏览器搬到服务端、落盘到 `data/commands/<sessionId>.json`,刷新页面/换浏览器/tmux 重建都不丢,仅在关闭会话时清理。

**Architecture:** 新增服务端纯函数模块 `command-history.ts`(parse / appendTruncated / load / save / remove / prune / sanitize),由 `ws-handler` 在 `input` 分支解析编排、`server.ts` 注入共享上下文 + 广播 + onExit 清理 + restore 后清孤儿。前端删掉 localStorage 解析逻辑,改为监听新 `commands` WS 消息。

**Tech Stack:** TypeScript(ESM)、Node.js `fs`/`path`、`ws`、vitest、React。

**参考 spec:** `docs/superpowers/specs/2026-06-25-session-command-history-persistence-design.md`

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `server/src/command-history.ts` | 纯函数:解析 / 截断 / 落盘 / 读 / 删 / 清孤儿 / sanitize | Create |
| `server/src/command-history.test.ts` | 纯函数单测(解析用例从 web 迁移 + 持久化/prune/sanitize) | Create |
| `server/src/protocol.ts` | `ServerMessage` 加 `commands` 分支 | Modify |
| `server/src/ws-handler.ts` | `handleConnection` 加 `cmdCtx` + `broadcast`;input 解析编排;list 回 commands | Modify |
| `server/src/pty-manager.ts` | 暴露 `restored: Promise<void>` | Modify |
| `server/src/server.ts` | `COMMANDS_DIR`、`cmdCtx`、`broadcast`、onExit 清理、prune、注入 handleConnection | Modify |
| `web/src/types.ts` | ServerMessage 加 `commands` 分支(与 server/protocol 镜像) | Modify |
| `web/src/ws-client.ts` | 删 recordInput/localStorage 等 | Modify |
| `web/src/ws-client.test.ts` | 删已迁移解析用例,保留 buffer 用例 | Modify |
| `web/src/use-sessions.ts` | commands 来源改 WS 消息;exit 清 commands | Modify |
| `web/src/use-sessions.test.ts` | 补 commands 消息用例 | Modify |

---

## Task 1: 服务端纯函数模块 `command-history.ts`(TDD — 解析)

**Files:**
- Create: `server/src/command-history.ts`
- Test: `server/src/command-history.test.ts`

- [ ] **Step 1: 写失败测试 — 解析正确性**

Create `server/src/command-history.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseChunk } from './command-history.js';

describe('parseChunk 命令解析', () => {
  // 输入「当前半行 + 新数据」,返回 { line: 新半行, commands: 本次成形的命令 }
  function run(...chunks: string[]): string[] {
    let line = '';
    const out: string[] = [];
    for (const c of chunks) {
      const r = parseChunk(line, c);
      line = r.line;
      out.push(...r.commands);
    }
    return out;
  }

  it('记录普通输入命令', () => {
    expect(run('git status\r')).toEqual(['git status']);
  });
  it('退格删除前一字符', () => {
    expect(run('abc\x7f\r')).toEqual(['ab']);
  });
  it('跳过 CSI 方向键(ESC [ X),不残留', () => {
    expect(run('\x1b[Als\r')).toEqual(['ls']);
  });
  it('跳过 CSI Delete 序列(ESC [ 3 ~)', () => {
    expect(run('\x1b[3~cd\r')).toEqual(['cd']);
  });
  it('跳过 SS3 方向键(ESC O X),不残留字母', () => {
    expect(run('\x1bOAls\r')).toEqual(['ls']);
  });
  it('跳过 SS3 功能键(ESC O P..S)', () => {
    expect(run('\x1bOPpwd\r')).toEqual(['pwd']);
  });
  it('跳过 OSC 颜色查询响应(BEL 结束),不残留', () => {
    expect(run('\x1b]10;rgb:cbcb/d5d5/e1e1\x07ls\r')).toEqual(['ls']);
  });
  it('跳过 OSC 响应(ST=ESC\\ 结束)', () => {
    expect(run('\x1b]11;rgb:0a0a/1010/1818\x1b\\ls\r')).toEqual(['ls']);
  });
  it('用户实际场景:OSC 颜色响应后接中文输入', () => {
    expect(run('\x1b]10;rgb:cbcb/d5d5/e1e1\x07左侧小窗鼠标按住后可以拖动排序\r'))
      .toEqual(['左侧小窗鼠标按住后可以拖动排序']);
  });
  it('多条命令与空行不计', () => {
    expect(run('a\r\r', 'b\r')).toEqual(['a', 'b']);
  });
  it('跨 chunk 的半行累积(无回车不成形)', () => {
    expect(run('git ', 'sta', 'tus\r')).toEqual(['git status']);
  });
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `npm -w server test -- command-history`
Expected: FAIL("parseChunk 未导出 / 模块不存在")

- [ ] **Step 3: 写最小实现 — parseChunk**

Create `server/src/command-history.ts`:

```ts
export interface ParseResult {
  line: string;
  commands: string[];
}

// 纯解析:累积可见字符,遇回车成形(trim 后非空才记),处理退格,跳过 ESC 转义。
// 逻辑移植自原 web/src/ws-client.ts recordInput。
export function parseChunk(prevLine: string, data: string): ParseResult {
  let line = prevLine;
  const commands: string[] = [];
  let i = 0;
  while (i < data.length) {
    const code = data.charCodeAt(i);
    const ch = data[i];
    if (code === 0x1b) {
      const next = data[i + 1];
      if (next === '[') {
        // CSI: ESC [ 参数... 终结字节(0x40-0x7e) — 方向键/Home/End/Delete
        i += 2;
        while (i < data.length) {
          const c = data.charCodeAt(i);
          i++;
          if (c >= 0x40 && c <= 0x7e) break;
        }
      } else if (next === 'O') {
        // SS3: ESC O 终结字节 — application 模式方向键/F1-F4,固定 3 字节整体跳过
        i += 3;
      } else if (next === ']' || next === 'P' || next === '^' || next === '_') {
        // OSC/DCS/PM/APC: ESC X 参数... — 以 BEL(\x07) 或 ST(ESC \) 结束
        i += 2;
        while (i < data.length) {
          const c = data.charCodeAt(i);
          if (c === 0x07) { i++; break; }
          if (c === 0x1b && data.charCodeAt(i + 1) === 0x5c) { i += 2; break; }
          i++;
        }
      } else if (next !== undefined) {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      const cmd = line.trim();
      if (cmd) commands.push(cmd);
      line = '';
    } else if (code === 127 || code === 8) {
      line = line.slice(0, -1);
    } else if (code >= 32 || ch === '\t') {
      line += ch;
    }
    i++;
  }
  return { line, commands };
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `npm -w server test -- command-history`
Expected: PASS(11 条)

- [ ] **Step 5: 提交**

```bash
git add server/src/command-history.ts server/src/command-history.test.ts
git commit -m "feat(server): command-history parseChunk 解析(从 web 迁移)"
```

---

## Task 2: 纯函数 — appendTruncated / sanitize / load / save / remove / prune(TDD)

**Files:**
- Modify: `server/src/command-history.ts`
- Test: `server/src/command-history.test.ts`

- [ ] **Step 1: 写失败测试 — 追加到 `command-history.test.ts`**

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendTruncated, sanitizeSessionId, load, save, remove, prune } from './command-history.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('appendTruncated', () => {
  it('未达上限直接追加', () => {
    expect(appendTruncated(['a'], 'b', 50)).toEqual(['a', 'b']);
  });
  it('达到上限丢最旧', () => {
    expect(appendTruncated(['a', 'b', 'c'], 'd', 3)).toEqual(['b', 'c', 'd']);
  });
  it('空数组', () => {
    expect(appendTruncated([], 'x', 50)).toEqual(['x']);
  });
});

describe('sanitizeSessionId', () => {
  it('合法 id 通过', () => {
    expect(sanitizeSessionId('wmt-0mcx5sf2')).toBe('wmt-0mcx5sf2');
  });
  it('含路径穿越 → null', () => {
    expect(sanitizeSessionId('../etc')).toBeNull();
    expect(sanitizeSessionId('a/b')).toBeNull();
  });
  it('含空格 → null', () => {
    expect(sanitizeSessionId('a b')).toBeNull();
  });
  it('空串 → null', () => {
    expect(sanitizeSessionId('')).toBeNull();
  });
});

describe('load', () => {
  it('文件不存在 → []', () => {
    expect(load(dir, 'nope')).toEqual([]);
  });
  it('非法 JSON → []', () => {
    fs.writeFileSync(path.join(dir, 'bad.json'), 'not json');
    expect(load(dir, 'bad')).toEqual([]);
  });
  it('合法 → 返回内容', () => {
    fs.writeFileSync(path.join(dir, 's.json'), JSON.stringify(['x', 'y']));
    expect(load(dir, 's')).toEqual(['x', 'y']);
  });
  it('sessionId 非法 → []', () => {
    expect(load(dir, '../etc')).toEqual([]);
  });
});

describe('save', () => {
  it('写入后可 load 读回', () => {
    save(dir, 's', ['a', 'b']);
    expect(load(dir, 's')).toEqual(['a', 'b']);
  });
  it('sessionId 非法 → 不写文件(静默)', () => {
    save(dir, '../etc', ['a']);
    expect(fs.existsSync(path.join(dir, '..', 'etc.json'))).toBe(false);
  });
});

describe('remove', () => {
  it('删除已存在文件', () => {
    save(dir, 's', ['a']);
    remove(dir, 's');
    expect(fs.existsSync(path.join(dir, 's.json'))).toBe(false);
  });
  it('文件不存在不抛错', () => {
    expect(() => remove(dir, 'nope')).not.toThrow();
  });
});

describe('prune', () => {
  it('删除不在存活集合的文件', () => {
    save(dir, 'a', ['1']);
    save(dir, 'b', ['2']);
    save(dir, 'c', ['3']);
    prune(dir, new Set(['a', 'c']));
    expect(fs.existsSync(path.join(dir, 'a.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'c.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'b.json'))).toBe(false);
  });
  it('非 *.json / 非法名文件不动', () => {
    fs.writeFileSync(path.join(dir, 'readme.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'a.json'), '[]');
    prune(dir, new Set([]));
    expect(fs.existsSync(path.join(dir, 'readme.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'a.json'))).toBe(false);
  });
});
```

需在文件顶部 import 行补 `beforeEach, afterEach`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `npm -w server test -- command-history`
Expected: FAIL("appendTruncated 等未导出")

- [ ] **Step 3: 写实现 — 追加到 `command-history.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';

const MAX_HISTORY = 50;
const NAME_RE = /^[A-Za-z0-9_-]+$/;

// 纯追加:超 max 丢最旧一条。无副作用。
export function appendTruncated(items: string[], cmd: string, max: number = MAX_HISTORY): string[] {
  const next = [...items, cmd];
  if (next.length > max) next.splice(0, next.length - max);
  return next;
}

// 边界校验:sessionId 来自外部 WS 消息,只允许 [A-Za-z0-9_-],防路径穿越。
export function sanitizeSessionId(raw: string): string | null {
  return NAME_RE.test(raw) ? raw : null;
}

function filePath(dir: string, sessionId: string): string {
  return path.join(dir, `${sessionId}.json`);
}

// 读:文件不存在 / 非法 / sanitize 失败 → []
export function load(dir: string, sessionId: string): string[] {
  const sid = sanitizeSessionId(sessionId);
  if (!sid) return [];
  try {
    const raw = fs.readFileSync(filePath(dir, sid), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

// 写:异步落盘,吞错(不阻塞主路径)。sessionId 非法则静默跳过。
export function save(dir: string, sessionId: string, items: string[]): void {
  const sid = sanitizeSessionId(sessionId);
  if (!sid) return;
  fs.mkdir(dir, { recursive: true }, () => {
    fs.writeFile(filePath(dir, sid), JSON.stringify(items, null, 2), () => { /* 吞错 */ });
  });
}

// 删:文件不存在静默(幂等)
export function remove(dir: string, sessionId: string): void {
  const sid = sanitizeSessionId(sessionId);
  if (!sid) return;
  fs.unlink(filePath(dir, sid), () => { /* ENOENT 静默 */ });
}

// 清孤儿:删除文件名(去 .json)不在 liveIds 集合、且名合法的 *.json
export function prune(dir: string, liveIds: Set<string>): void {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const sid = name.slice(0, -5);
    if (!NAME_RE.test(sid)) continue;
    if (!liveIds.has(sid)) {
      fs.unlink(path.join(dir, name), () => { /* 吞错 */ });
    }
  }
}
```

> 注:`fs` / `path` import 与 `parseChunk` 同文件,合并到顶部(不重复 import)。

- [ ] **Step 4: 运行测试,确认通过**

Run: `npm -w server test -- command-history`
Expected: PASS(全部)

- [ ] **Step 5: 提交**

```bash
git add server/src/command-history.ts server/src/command-history.test.ts
git commit -m "feat(server): command-history 落盘/读/删/清孤儿/sanitize"
```

---

## Task 3: 协议 — 加 `commands` ServerMessage

**Files:**
- Modify: `server/src/protocol.ts:32-37`

- [ ] **Step 1: 改 protocol.ts**

在 `ServerMessage` 联合类型末尾(`cwd` 分支后)加:

```ts
  | { type: 'commands'; sessionId: string; items: string[] };
```

完整 `ServerMessage` 改为:

```ts
export type ServerMessage =
  | { type: 'created'; sessionId: string }
  | { type: 'data'; sessionId: string; payload: string }
  | { type: 'exit'; sessionId: string; code: number }
  | { type: 'sessions'; items: SessionInfo[] }
  | { type: 'cwd'; sessionId: string; cwd: string }
  | { type: 'commands'; sessionId: string; items: string[] };
```

- [ ] **Step 2: 类型检查**

Run: `npm -w server run build`
Expected: 编译通过无错

- [ ] **Step 3: 提交**

```bash
git add server/src/protocol.ts
git commit -m "feat(server): ServerMessage 加 commands 分支"
```

---

## Task 4: pty-manager 暴露 `restored`

**Files:**
- Modify: `server/src/pty-manager.ts:33,95-101`

- [ ] **Step 1: 改 pty-manager.ts**

(a) 在类字段区(约 `cwdTimer` 附近)加公开字段:

```ts
  restored: Promise<void>;
```

(b) 构造函数里把 fire-and-forget 的 restore 改为赋值给 `restored`。

改构造函数最后两行(原):
```ts
    // 启动恢复：attach 所有已存在的 wmt-* 会话（server 重启场景）
    this.restore().catch(() => {});
```
改为:
```ts
    // 启动恢复：attach 所有已存在的 wmt-* 会话（server 重启场景）
    this.restored = this.restore();
```

- [ ] **Step 2: 运行现有 pty 测试,确认不回归**

Run: `npm -w server test -- pty-manager`
Expected: PASS(无回归)

- [ ] **Step 3: 提交**

```bash
git add server/src/pty-manager.ts
git commit -m "refactor(server): pty-manager 暴露 restored promise 供 prune 同步"
```

---

## Task 5: ws-handler 接入解析编排(TDD)

**Files:**
- Modify: `server/src/ws-handler.ts`
- Modify: `server/src/ws-handler.test.ts`(确认现有用例不回归)

- [ ] **Step 1: 改 ws-handler.ts 签名与 input/list 分支**

完整替换 `server/src/ws-handler.ts`:

```ts
import type { ClientMessage, IPtyManager, ServerMessage } from './protocol.js';
import { parseChunk, appendTruncated, save, load } from './command-history.js';

export interface WSLike {
  send(data: string): void;
  on(event: 'message', cb: (data: string) => void): void;
  on(event: 'close', cb: () => void): void;
}

export interface CmdState {
  line: string;
  items: string[];
}

export interface CmdCtx {
  dir: string;
  sessions: Map<string, CmdState>;
}

type Broadcast = (msg: ServerMessage) => void;

const MAX_HISTORY = 50;

export function handleConnection(ws: WSLike, mgr: IPtyManager, cmdCtx: CmdCtx, broadcast: Broadcast): void {
  const send = (m: ServerMessage) => ws.send(JSON.stringify(m));

  const offData = mgr.onData((sessionId, data) => send({ type: 'data', sessionId, payload: data }));
  const offExit = mgr.onExit((sessionId, code) => send({ type: 'exit', sessionId, code }));
  const offCwd = mgr.onCwd((sessionId, cwd) => send({ type: 'cwd', sessionId, cwd }));

  const feed = (sessionId: string, data: string): void => {
    let st = cmdCtx.sessions.get(sessionId);
    if (!st) { st = { line: '', items: load(cmdCtx.dir, sessionId) }; cmdCtx.sessions.set(sessionId, st); }
    const formed = parseChunk(st.line, data);
    st.line = formed.line;
    for (const cmd of formed.commands) {
      st.items = appendTruncated(st.items, cmd, MAX_HISTORY);
      save(cmdCtx.dir, sessionId, st.items);
      broadcast({ type: 'commands', sessionId, items: st.items });
    }
  };

  ws.on('message', (raw: string) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'create': {
        const id = mgr.create({ cols: msg.cols, rows: msg.rows, cwd: msg.cwd });
        send({ type: 'created', sessionId: id });
        break;
      }
      case 'input':
        mgr.write(msg.sessionId, msg.data);
        feed(msg.sessionId, msg.data);
        break;
      case 'resize':
        mgr.resize(msg.sessionId, msg.cols, msg.rows);
        break;
      case 'close':
        mgr.close(msg.sessionId);
        break;
      case 'list': {
        const items = mgr.list();
        send({ type: 'sessions', items });
        for (const info of items) {
          const replay = mgr.getRingBuffer(info.sessionId);
          if (replay) send({ type: 'data', sessionId: info.sessionId, payload: replay });
          const cwd = mgr.getCwd(info.sessionId);
          if (cwd) send({ type: 'cwd', sessionId: info.sessionId, cwd });
          const cmds = cmdCtx.sessions.get(info.sessionId)?.items ?? load(cmdCtx.dir, info.sessionId);
          send({ type: 'commands', sessionId: info.sessionId, items: cmds });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    offData();
    offExit();
    offCwd();
  });
}
```

- [ ] **Step 2: 确认 ws-handler.test.ts 兼容新签名**

Run: `npm -w server test -- ws-handler`

如果因 `handleConnection` 签名变化报错(现有测试用 mock mgr 但未传 cmdCtx/broadcast),更新 `server/src/ws-handler.test.ts` 里所有 `handleConnection(...)` 调用,补传:
```ts
const cmdCtx: CmdCtx = { dir: <tmpdir>, sessions: new Map() };
const sent: ServerMessage[] = [];
handleConnection(wsLike, mockMgr, cmdCtx, (m) => sent.push(m));
```
（先读该测试文件确认现有调用形态,再做最小适配;不重写无关用例。）

Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add server/src/ws-handler.ts server/src/ws-handler.test.ts
git commit -m "feat(server): ws-handler 解析输入并广播 commands 消息"
```

---

## Task 6: server.ts 装配 — cmdCtx / broadcast / onExit 清理 / prune

**Files:**
- Modify: `server/src/server.ts:6-11,31,101-103`

- [ ] **Step 1: 改 server.ts**

(a) import 区(约 6-11 行)加:

```ts
import { prune } from './command-history.js';
import type { CmdCtx } from './ws-handler.js';
import type { ServerMessage } from './protocol.js';
```

(b) `PtyManager` 实例化后(约 31 行后),加 COMMANDS_DIR:

```ts
  const COMMANDS_DIR = process.env.COMMANDS_DIR || path.resolve(__dirname, '../../data/commands');
```

(c) 在 `wss` 创建后、`wss.on('connection', ...)` 处替换为装配逻辑(原 101-103 行):

```ts
  const wss = new WebSocketServer({ server, path: '/ws' });

  // 命令历史:连接间共享的 per-session 解析状态(同一会话可被多浏览器查看)
  const cmdCtx: CmdCtx = { dir: COMMANDS_DIR, sessions: new Map() };
  const broadcast = (msg: ServerMessage): void => {
    const payload = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === 1 /* WebSocket.OPEN */) {
        try { client.send(payload); } catch { /* 连接已断 */ }
      }
    }
  };

  // 会话结束(点 × 或 shell 自然退出)即清该会话历史 —— 对应「关闭窗口清理」
  mgr.onExit((sessionId) => {
    cmdCtx.sessions.delete(sessionId);
    remove(COMMANDS_DIR, sessionId);
  });

  // 启动清孤儿:restore 完成后,删 data/commands/ 里对应 tmux session 已不存在的文件
  mgr.restored.then(() => {
    prune(COMMANDS_DIR, new Set(mgr.list().map((s) => s.sessionId)));
  }).catch(() => { /* restore 失败不阻塞 */ });

  wss.on('connection', (ws) => handleConnection(ws as unknown as Parameters<typeof handleConnection>[0], mgr, cmdCtx, broadcast));
  server.on('close', () => mgr.dispose());
```

并在 import 区补 `remove`:
```ts
import { prune, remove } from './command-history.js';
```

- [ ] **Step 2: 类型检查 + 现有 server 测试不回归**

Run: `npm -w server run build && npm -w server test`
Expected: 编译通过;server.test.ts 全绿

- [ ] **Step 3: 提交**

```bash
git add server/src/server.ts
git commit -m "feat(server): 装配命令历史(cmdCtx/broadcast/onExit 清理/启动清孤儿)"
```

---

## Task 7: 前端 ws-client 删解析 + localStorage

**Files:**
- Modify: `web/src/ws-client.ts`
- Modify: `web/src/ws-client.test.ts`

- [ ] **Step 1: 精简 ws-client.ts**

删除:`MAX_HISTORY`、`COMMANDS_KEY`、`CommandHandler` 类型、字段 `commandHandlers`、`inputLines`、方法 `loadCommands`/`saveCommands`/`getCommands`/`onCommand`/`recordInput`,以及 `send()` 里的 `if (msg.type === 'input') this.recordInput(...)` 一行。

`send` 改为:
```ts
  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
```

保留其余:`buffers`/`MAX_BUFFER`、`connect`/reconnect、`subscribeData`、`onMessage`、`onOpen`、`getBuffer`、`dispose`。

- [ ] **Step 2: 改 ws-client.test.ts — 删已迁移用例**

删除整个 `describe('recordInput 命令解析', ...)` 块(其用例已在 Task 1 迁移到服务端)。
删除文件顶部为 localStorage 注入的 `Object.defineProperty(globalThis, 'localStorage', ...)` 补丁(不再需要)。
保留 `describe('WsClient', ...)` 的 4 条 buffer/订阅/发送用例。

- [ ] **Step 3: 运行前端测试**

Run: `npm -w web test`
Expected: PASS(ws-client 用例)

- [ ] **Step 4: 提交**

```bash
git add web/src/ws-client.ts web/src/ws-client.test.ts
git commit -m "refactor(web): ws-client 移除命令解析与 localStorage(搬至服务端)"
```

---

## Task 8: 前端 use-sessions 改 commands 来源(TDD)

**Files:**
- Modify: `web/src/types.ts:15-20`
- Modify: `web/src/use-sessions.ts`
- Modify: `web/src/use-sessions.test.ts`

- [ ] **Step 1: 写失败测试 — 追加到 use-sessions.test.ts**

```ts
import { renderHook, act } from '@testing-library/react';
// 复用文件里已有的 fake client 工厂(确认命名后对齐)

it('收到 commands 消息更新对应会话命令历史', () => {
  const { client, result } = setupHook(); // 复用现有 setup
  act(() => {
    client.fireMessage(JSON.stringify({ type: 'sessions', items: [{ sessionId: 's1', createdAt: 0, exited: false }] }));
    client.fireMessage(JSON.stringify({ type: 'commands', sessionId: 's1', items: ['ls', 'pwd'] }));
  });
  const s1 = result.current.sessions.find((s) => s.sessionId === 's1');
  expect(s1?.commands).toEqual(['ls', 'pwd']);
});

it('会话 exit 后清掉其 commands', () => {
  const { client, result } = setupHook();
  act(() => {
    client.fireMessage(JSON.stringify({ type: 'sessions', items: [{ sessionId: 's1', createdAt: 0, exited: false }] }));
    client.fireMessage(JSON.stringify({ type: 'commands', sessionId: 's1', items: ['ls'] }));
    client.fireMessage(JSON.stringify({ type: 'exit', sessionId: 's1', code: 0 }));
  });
  // s1 已从列表移除;commands 残留不暴露(session-list 读不到)
  expect(result.current.sessions.find((s) => s.sessionId === 's1')).toBeUndefined();
});
```

> 先读 `use-sessions.test.ts` 确认现有 fake client / setup 形态,用相同模式补这两条;`setupHook` 用现有命名。

- [ ] **Step 2: 运行测试,确认失败**

Run: `npm -w web test -- use-sessions`
Expected: FAIL(commands 消息未处理)

- [ ] **Step 3: 改 types.ts + use-sessions.ts**

(a) `web/src/types.ts` 的 `ServerMessage` 末尾加分支(与 server/protocol.ts 镜像):
```ts
  | { type: 'commands'; sessionId: string; items: string[] };
```

(b) `use-sessions.ts` 的 `onMessage` 回调 `sessions` 分支:删除从 localStorage 回填 commands 的代码块(原 80-83 行):
```ts
        // 删除:const restored ...; for (...) restored[...] = client.getCommands(...); setCommands(restored);
```
改为不回填(交给 commands 消息)。

(c) `use-sessions.ts` 的 `onMessage` 回调新增 `commands` 分支(在 `cwd` 分支后):
```ts
      } else if (msg.type === 'commands') {
        setCommands((prev) => (prev[msg.sessionId] === msg.items ? prev : { ...prev, [msg.sessionId]: msg.items }));
      }
```

(d) `use-sessions.ts` 的 `exit` 分支:在 `setSessions((s) => s.filter(...))` 后补清该会话 commands:
```ts
      } else if (msg.type === 'exit') {
        setSessions((s) => s.filter((x) => x.sessionId !== msg.sessionId));
        setCommands((prev) => {
          if (!(msg.sessionId in prev)) return prev;
          const next = { ...prev };
          delete next[msg.sessionId];
          return next;
        });
      }
```

(e) 删除 `use-sessions.ts` 里 `onCommand` 监听的 useEffect(原 91-95 行,`client.onCommand` 已不存在):
```ts
  // 删除整个:
  // useEffect(() => { return client.onCommand((sid) => { setCommands(...) }); }, [client]);
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `npm -w web test -- use-sessions`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add web/src/use-sessions.ts web/src/use-sessions.test.ts
git commit -m "feat(web): commands 历史改由 WS commands 消息驱动,exit 清理"
```

---

## Task 9: 全量验证 + 构建产物处理

**Files:** 无(验证)

- [ ] **Step 1: 全量测试**

Run: `npm -w server test && npm -w web test`
Expected: 全绿

- [ ] **Step 2: 类型 + 构建**

Run: `npm run build`
Expected: server `tsc` + web `tsc -b && vite build` 均通过;`web/dist` 与 `server/dist` 产物更新

- [ ] **Step 3: 端到端手测(黄金路径 + 边界)**

启动:`npm run dev`(server :4000 + web vite)。浏览器打开 web,操作并观察:

- [ ] 新建会话 → 敲 `ls -la\r` → 该卡片 `row-inputs` 实时出现 `ls -la`
- [ ] 连敲多条 → 卡片显示最近 5 条
- [ ] **刷新页面(F5)** → 卡片历史仍在(不丢)
- [ ] 换隐私窗口打开 → 历史仍在
- [ ] 点某卡片 × 关闭 → `ls data/commands/` 该 `<sid>.json` 已删;其他卡片历史不动
- [ ] `windows-record restart`(tmux 未重启)→ 历史 restore 回来
- [ ] `tmux -L wmt kill-server` 后 `windows-record restart` → `data/commands/` 旧文件被清,新会话从空开始
- [ ] 方向键/颜色查询不污染命令(敲含 ESC 序列的输入,卡片命令干净)

> CLAUDE.md 第 9 条:UI 变更必须实际看过。本任务命令历史是 UI 可见行为,必须肉眼确认。

- [ ] **Step 4: 最终提交(若手测中有微调)**

```bash
git add -A
git commit -m "test: 端到端验证通过"
```

（若 Task 1-8 已是干净提交且手测无改动,跳过此步。）

---

## Self-Review 结果

**1. Spec 覆盖:**
- 解析搬服务端 → Task 1 ✅
- 落盘/读/删/清孤儿/sanitize → Task 2 ✅
- commands 协议消息 → Task 3 ✅
- pty-manager restored → Task 4 ✅
- ws-handler input 解析 + list 回 commands → Task 5 ✅
- server.ts cmdCtx/broadcast/onExit 清理/prune → Task 6 ✅
- 前端删 localStorage 解析 → Task 7 ✅
- 前端 commands 来源 + exit 清理 → Task 8 ✅
- 端到端验证(spec 验证清单)→ Task 9 ✅
- 无遗漏。

**2. Placeholder 扫描:** Task 5 Step 2 与 Task 8 Step 1 标注「先读现有测试文件再适配」——这是必要的对齐动作(不重写无关代码),非占位符;其余步骤均含完整代码/命令。

**3. 类型一致性:** `CmdCtx`/`CmdState`(Task 5 定义)→ server.ts(Task 6 使用)一致;`parseChunk`/`appendTruncated`/`save`/`load`/`remove`/`prune`/`sanitizeSessionId`(Task 1-2 定义)→ ws-handler(Task 5 使用)签名一致;`commands` 消息(server protocol Task 3 + 前端 `web/src/types.ts` Task 8 镜像)→ 前端 use-sessions(Task 8 监听)字段一致;`mgr.restored`(Task 4)→ server.ts(Task 6)一致。
