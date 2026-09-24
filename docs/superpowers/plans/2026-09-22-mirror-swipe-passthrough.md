# iPhone 镜像 ⌃+双指上划透传 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 网页 iPhone 镜像小窗内 ⌃+双指上划 → 通过本地服务端向 macOS「iPhone 镜像」窗口注入拖拽,使 iPhone 执行上划(回主屏)。

**Architecture:** 前端 wheel 拦截(ctrlKey+deltaY>0,momentum 聚合去抖)→ 同源 `POST /api/mirror/swipe-up` → `mirror-control.ts` 三段 osascript 串联:AppleScript 定位镜像窗口+提前 frontmost → JXA 全局 `CGEventPost` 带节奏注入拖拽 → AppleScript 恢复原焦点(spike 实测 PostToPid 对 Continuity 无效)。其余现有交互零改动。

**Tech Stack:** React+TS(现有)、Node http(现有 server.ts)、osascript JXA(系统自带,零新依赖)、vitest + @testing-library/react、playwright MCP(演示)。

**Spec:** `docs/superpowers/specs/2026-09-22-mirror-swipe-passthrough-design.md`(本计划据其展开,执行者须同时读 spec)

## Global Constraints

- 手势触发条件:`e.ctrlKey && e.deltaY > 0`(自然滚动假设;方向不符时翻转模块常量 `SWIPE_UP_DELTA_SIGN`,一行修正)
- momentum 聚合:累计 deltaY ≥ `120` 触发一次,触发后 `800` ms 冷却;事件间隔 >`600` ms 重置累计(spec §4.1)
- 裸滚动缩放、拖动平移、双击复位行为**零改动**;ctrl+下划(deltaY<0)走原有缩放分支
- 服务端路由 `POST /api/mirror/swipe-up` 必须注册在 `handleProxy` 之前(spec §2,已知陷阱)
- 注入用全局 `CGEventPost(0, ev)` + 窗口提前 frontmost + 节奏延时(spike 实测 `CGEventPostToPid` 对 Continuity 无效);注入后必须恢复原焦点进程(对称性);禁止引入外部二进制(cliclick 等)
- JXA 里 CG 常量一律内联数值(`kCGWindowListOptionOnScreenOnly|ExcludeDesktopElements`=17,`kCGEventLeftMouseDown`=1,`kCGEventMouseMoved`=5,`kCGEventLeftMouseUp`=6,`kCGMouseButtonLeft`=0),不依赖 enum 宏桥接
- 错误码仅两个:`window-not-found` / `inject-failed`;HTTP 一律 200 + `{ok, reason?}`(spec §4.2)
- 本机工具无鉴权,与 `/api/analyze` 一致;只接受精确路径的 POST

## Review Focus

(spec 未显式覆盖、但真用起来最容易咬人的输入类;每条已折进所属任务的测试步骤)

1. **触摸板 momentum 连发**——一次上划惯性发几十个 wheel,若逐事件透传会疯狂连点上划。→ Task 4 测试:冷却窗内连发只 fetch 一次。
2. **ctrl+下划(deltaY<0)**——不应误触透传,也不应吞掉原有缩放。→ Task 4 测试:不 fetch 且 scale 变化。
3. **pinch 噪声(小 delta 累计)**——捏合的合成 ctrlKey wheel 若累计越阈值会误触。→ Task 4 测试:间隔 >600ms 的两次低幅 wheel 不触发。
4. **路由被 handleProxy 吞**——POST 若落到代理,透传静默失效。→ Task 3 测试:POST 返回 200 `{ok:true}` 而非代理响应。
5. **注入失败的用户可见反馈**——iPhone 未连接/未授权/服务未起,静默吞错会让人以为手势失灵。→ Task 2/3/4 测试:`window-not-found` 透传、fetch reject → 标题条短暂提示。

---

### Task 1: Spike——JXA 注入链路真机验证(throwaway,需用户在场)

**Files:**
- Create(临时,不提交): `/tmp/mirror-spike.jxa`

**Interfaces:**
- Consumes: 无(纯系统验证)
- Produces: 决策记录——①窗口匹配串实际值 ②`$.CGPointMake`/`$.CGEventPostToPid` 在 JXA 可用性 ③Continuity 是否响应合成拖拽 ④辅助功能授权行为。写入本文件下方「Spike 结论」节。**Task 2 直接消费这些结论;若结论为"JXA 桥接失败",Task 2 切方案 C(swiftc 小工具),届时先回来改本计划再继续。**

**前置(向用户确认):** iPhone 已与 Mac 连接,「iPhone 镜像」窗口已打开且在前台可见。

- [ ] **Step 1: 写 spike 脚本**

`/tmp/mirror-spike.jxa` 内容(探测 + 定位 + 注入一体,分阶段打印):

```javascript
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
// 阶段 0:桥接能力探测
function probe(name) { try { return String($[name]) !== 'undefined'; } catch (e) { return false; } }
console.log('CGPointMake: ' + probe('CGPointMake'));
console.log('CGEventCreateMouseEvent: ' + probe('CGEventCreateMouseEvent'));
console.log('CGEventPostToPid: ' + probe('CGEventPostToPid'));
// 阶段 1:定位窗口(打印全部 on-screen 窗口 owner,找镜像窗口真名)
var list = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(17, 0)) || [];
var owners = {};
list.forEach(function (w) { var n = w.kCGWindowOwnerName || '?'; owners[n] = (owners[n] || 0) + 1; });
console.log('owners: ' + JSON.stringify(owners));
var win = list.filter(function (w) { return /iPhone|Mirroring|镜像/i.test(String(w.kCGWindowOwnerName)); })
  .find(function (w) { return w.kCGWindowBounds && Number(w.kCGWindowBounds.Height) > 100; });
if (!win) { console.log('MIRROR WINDOW NOT FOUND'); exit(1); }
console.log('win: ' + JSON.stringify(win));
// 阶段 2:注入拖拽(下部 1/6 → 上部 1/3)
var b = win.kCGWindowBounds, pid = Number(win.kCGWindowOwnerPID);
var x = Number(b.X) + Number(b.Width) / 2;
var y0 = Number(b.Y) + Number(b.Height) * 5 / 6;
var y1 = Number(b.Y) + Number(b.Height) / 3;
function post(type, y) {
  var ev = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(x, y), 0);
  $.CGEventPostToPid(pid, ev);
}
post(1, y0);
for (var i = 1; i <= 8; i++) { post(5, y0 + (y1 - y0) * i / 8); }
post(6, y1);
console.log('INJECTED');
```

- [ ] **Step 2: 跑探测与定位**

Run: `osascript -l JavaScript /tmp/mirror-spike.jxa`
Expected: 三个 probe 至少 CGPointMake 与 CGEventCreateMouseEvent 为 true;owners 列表里能认出镜像窗口 owner 名;win 行打印出 bounds。若 probe 有 false → 桥接失败信号,重试一次后仍 false 则记录并准备切方案 C。

- [ ] **Step 3: 真机验证注入效果(用户观察 iPhone)**

再次运行同脚本,请用户看 iPhone 是否执行了上划(回主屏/多任务)。可能出现的授权弹窗(辅助功能)按系统引导给 `osascript`/终端授权后重试。
Expected: iPhone 画面发生上划。若完全无反应:按序试 ①`$.CGEventPost(0, ev)` 替换 PostToPid(会动真实光标,仅诊断用) ②move 步之间加 `usleep` 间隔。都无效 → Continuity 拒绝合成事件,切方案 C(swift 小工具走 CGEventPostToPid),先更新本计划。

- [ ] **Step 4: 记录结论到本文件**

在下方「Spike 结论」节如实填写四项 + 最终方案(A=JXA / C=swift)。不 commit(throwaway,脚本留在 /tmp)。

**Spike 结论(2026-09-22 实测):**
- 窗口匹配串:进程名 `iPhone Mirroring`(窗口名「iPhone镜像」本地化,不采用);进程有**两个窗口**(66×20 悬浮小条 + 主镜像窗),**取面积最大者**。定位用 AppleScript System Events(`position/size/unix id`)——JXA `CGWindowListCopyWindowInfo` 返回未桥接 CF Ref(typeof function),不可用。
- 桥接:`CGPointMake`/`CGEventCreateMouseEvent`/`CGEventPost` 可用;**`CGEventPostToPid` 调用不报错但对 Continuity 完全无效**(mouseMoved/leftMouseDragged 两种事件类型都试过)。
- Continuity 响应合成拖拽:**是**,但需三个条件齐备:①**窗口必须 frontmost**(被遮挡时事件被前方窗口吃掉)②**全局 `CGEventPost(0, ev)`**(kCGHIDEventTap)③**步进节奏**(down → 40ms → 16×(leftMouseDragged + 20ms) → 40ms → up,约 400ms;瞬发序列无效——注:瞬发实验是在窗口被遮挡时做的,延时是否绝对必需未单独隔离验证,保守保留)。
- 辅助功能授权:本机已具备(全程无授权弹窗)。
- 最终方案:**A' = AppleScript(定位+提前/恢复焦点)+ JXA(CGEventPost 注入)三段 execFile 串联**。体验代价:每次透传窗口焦点闪切一次(镜像提前→注入约 0.6s→恢复),用户已在 spike 中见过该行为。

---

### Task 2: `server/src/mirror-control.ts` 注入执行器(TDD)

**Files:**
- Create: `server/src/mirror-control.ts`
- Test: `server/src/mirror-control.test.ts`

**Interfaces:**
- Consumes: Task 1 Spike 结论(进程名 `iPhone Mirroring`、三段链路形态)
- Produces: `export type SwipeResult = { ok: true } | { ok: false; reason: 'window-not-found' | 'inject-failed'; detail?: string };` `export const MIRROR_PROCESS = 'iPhone Mirroring';` `export function swipeUpOnMirror(): Promise<SwipeResult>`(Task 3 的路由调用此函数;签名固定,勿改)

- [ ] **Step 1: 写失败测试**

`server/src/mirror-control.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock child_process.execFile:结果按队列顺序出队;记录调用序列供断言。
// promisify(execFile) 尾插 callback,记录时截掉;mock 返回 Promise,promisify 直接采用
const calls: { cmd: string; args: string[] }[] = [];
const results: { stdout?: string; reject?: Error }[] = [];
vi.mock('node:child_process', () => ({ execFile: (...a: unknown[]) => {
  calls.push({ cmd: a[0] as string, args: (a.slice(1, -1) as string[]) });
  const r = results.shift() ?? { stdout: '' };
  return r.reject ? Promise.reject(r.reject) : Promise.resolve({ stdout: r.stdout ?? '', stderr: '' });
} }));

import { swipeUpOnMirror, MIRROR_PROCESS } from './mirror-control.js';

describe('swipeUpOnMirror', () => {
  beforeEach(() => { calls.length = 0; results.length = 0; });

  it('成功:定位+提前 → 注入 → 恢复焦点,坐标按窗口几何换算', async () => {
    results.push({ stdout: 'Safari|1136,640,671,348\n' }, { stdout: 'OK' }, { stdout: '' });
    const r = await swipeUpOnMirror();
    expect(r).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    // ① AppleScript:定位+提前,脚本含进程名
    expect(calls[0].cmd).toBe('osascript');
    expect(calls[0].args[1]).toContain(MIRROR_PROCESS);
    // ② JXA 注入:x=1136+671/2=1471.5, y0=640+348*5/6=930, y1=640+348/3=756
    expect(calls[1].args).toEqual(
      ['-l', 'JavaScript', '-e', expect.stringContaining('CGEventPost'), '1471.5', '930', '756'],
    );
    // ③ 恢复原焦点进程
    expect(calls[2].args[1]).toContain('Safari');
  });

  it('进程不存在(镜像未开/未连接)→ window-not-found,不做注入不抢焦点', async () => {
    results.push({ reject: new Error("System Events got an error: Can't get process") });
    const r = await swipeUpOnMirror();
    expect(r).toEqual({ ok: false, reason: 'window-not-found' });
    expect(calls).toHaveLength(1);
  });

  it('主窗口过小(仅悬浮小条)→ window-not-found', async () => {
    results.push({ stdout: 'ERR|window-not-found' });
    expect(await swipeUpOnMirror()).toEqual({ ok: false, reason: 'window-not-found' });
    expect(calls).toHaveLength(1);
  });

  it('注入阶段失败 → inject-failed,但焦点仍被恢复(对称性)', async () => {
    results.push(
      { stdout: 'Safari|1136,640,671,348' },
      { reject: new Error('osascript failed') },
      { stdout: '' },
    );
    const r = await swipeUpOnMirror();
    expect(r).toMatchObject({ ok: false, reason: 'inject-failed' });
    expect(calls).toHaveLength(3);
    expect(calls[2].args[1]).toContain('Safari');
  });

  it('prep 输出格式异常 → inject-failed', async () => {
    results.push({ stdout: 'garbage' });
    const r = await swipeUpOnMirror();
    expect(r).toMatchObject({ ok: false, reason: 'inject-failed' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run src/mirror-control.test.ts`
Expected: FAIL——`mirror-control.js` 不存在(vitest 模块解析报错)。

- [ ] **Step 3: 最小实现**

`server/src/mirror-control.ts`:

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// 「iPhone 镜像」(Continuity) 进程名(spike 实测,与系统语言无关)
export const MIRROR_PROCESS = 'iPhone Mirroring';

export type SwipeResult =
  | { ok: true }
  | { ok: false; reason: 'window-not-found' | 'inject-failed'; detail?: string };

// ① AppleScript:读当前焦点进程 + 镜像主窗口(面积最大者,过滤 66×20 悬浮小条)几何,
//   并把镜像提为 frontmost——被遮挡时 CGEvent 会被前方窗口吃掉(spike 实测)。
//   输出 "prevFront|x,y,w,h";窗口过小 → "ERR|window-not-found"(此时未抢焦点)
const ASC_PREP = [
  'tell application "System Events"',
  '  set prevFront to name of first application process whose frontmost is true',
  `  tell process "${MIRROR_PROCESS}"`,
  '    set maxA to 0',
  '    set bx to 0',
  '    set by to 0',
  '    set bw to 0',
  '    set bh to 0',
  '    repeat with w in windows',
  '      set {x, y} to position of w',
  '      set {ww, hh} to size of w',
  '      if ww * hh > maxA then',
  '        set maxA to ww * hh',
  '        set bx to x',
  '        set by to y',
  '        set bw to ww',
  '        set bh to hh',
  '      end if',
  '    end repeat',
  '  end tell',
  '  if bw < 50 or bh < 50 then return "ERR|window-not-found"',
  `  set frontmost of process "${MIRROR_PROCESS}" to true`,
  '  delay 0.25',
  '  return prevFront & "|" & (bx as text) & "," & (by as text) & "," & (bw as text) & "," & (bh as text)',
  'end tell',
].join('\n');

// ② JXA:全局 CGEventPost(0 = kCGHIDEventTap)合成 leftDown → 16 步 leftMouseDragged → leftUp,
//   「下部 1/6 → 上部 1/3」。事件常量内联数值(enum 宏不保证被 ObjC bridge 暴露):
//   1/4/6 = leftMouseDown/leftMouseDragged/leftMouseUp,0 = kCGMouseButtonLeft。
//   节奏必需:瞬发序列 Continuity 不认;PostToPid 无效(spike 实测)
const JXA_SWIPE = `
ObjC.import('CoreGraphics');
ObjC.import('unistd');
function run(argv) {
  var x = parseFloat(argv[0]), y0 = parseFloat(argv[1]), y1 = parseFloat(argv[2]);
  function post(type, y) {
    var ev = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(x, y), 0);
    $.CGEventPost(0, ev);
  }
  post(1, y0);
  $.usleep(40000);
  for (var i = 1; i <= 16; i++) { post(4, y0 + (y1 - y0) * i / 16); $.usleep(20000); }
  $.usleep(40000);
  post(6, y1);
  return 'OK';
}`;

const ascRestore = (proc: string) =>
  `tell application "System Events" to set frontmost of process "${proc.replace(/"/g, '\\"')}" to true`;

export async function swipeUpOnMirror(): Promise<SwipeResult> {
  let prevFront = '';
  try {
    const { stdout: prepOut } = await execFileP('osascript', ['-e', ASC_PREP]);
    const out = prepOut.trim();
    if (out === 'ERR|window-not-found') return { ok: false, reason: 'window-not-found' };
    const m = out.match(/^([^|]+)\|(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)$/);
    if (!m) return { ok: false, reason: 'inject-failed', detail: 'bad prep output: ' + out.slice(0, 120) };
    prevFront = m[1];
    const bx = +m[2], by = +m[3], bw = +m[4], bh = +m[5];
    await execFileP('osascript', ['-l', 'JavaScript', '-e', JXA_SWIPE,
      String(bx + bw / 2), String(by + bh * 5 / 6), String(by + bh / 3)]);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Can.t get process|window-not-found/i.test(msg)) {
      return { ok: false, reason: 'window-not-found', detail: msg.slice(0, 200) };
    }
    return { ok: false, reason: 'inject-failed', detail: msg.slice(0, 200) };
  } finally {
    // 提前过焦点就要恢复(对称);prep 未成功(没抢焦点)时 prevFront 为空跳过
    if (prevFront) {
      try { await execFileP('osascript', ['-e', ascRestore(prevFront)]); } catch { /* 恢复失败不影响注入结果 */ }
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx vitest run src/mirror-control.test.ts`
Expected: 5 passed。

- [ ] **Step 5: Commit**

```bash
git add server/src/mirror-control.ts server/src/mirror-control.test.ts
git commit -m "feat(server): mirror-control JXA 注入执行器(定位 iPhone 镜像窗口+CGEvent 拖拽)"
```

---

### Task 3: `server.ts` 路由 `POST /api/mirror/swipe-up`(TDD)

**Files:**
- Modify: `server/src/server.ts:150`(插在 `if (method !== 'GET') { handleProxy(...)` 之前,即 analyze 路由块之后)
- Modify: `server/src/server.ts` 顶部 import 区(加 `import { swipeUpOnMirror } from './mirror-control.js';`)
- Test: `server/src/server.test.ts`(文件级 `vi.mock` mirror-control)

**Interfaces:**
- Consumes: `swipeUpOnMirror(): Promise<SwipeResult>`(Task 2)
- Produces: `POST /api/mirror/swipe-up` → HTTP 200 `{ok:true}` 或 `{ok:false, reason}`(Task 4 前端 fetch 此端点)

- [ ] **Step 1: 写失败测试**

`server/src/server.test.ts` 顶部(import 之后)加:

```typescript
import { swipeUpOnMirror } from './mirror-control.js';
vi.mock('./mirror-control.js', () => ({ swipeUpOnMirror: vi.fn() }));
```

(文件现有 `import { describe, it, expect, afterAll } from 'vitest';` 补上 `vi`。)
在 `describe('server integration', ...)` 内追加:

```typescript
  it('POST /api/mirror/swipe-up → 调 swipeUpOnMirror 并回 ok(路由在代理前)', async () => {
    vi.mocked(swipeUpOnMirror).mockResolvedValueOnce({ ok: true });
    const r = await fetch(`http://localhost:${port}/api/mirror/swipe-up`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(swipeUpOnMirror).toHaveBeenCalledTimes(1);
  });

  it('POST /api/mirror/swipe-up 注入失败 → 200 + {ok:false, reason}', async () => {
    vi.mocked(swipeUpOnMirror).mockResolvedValueOnce({ ok: false, reason: 'window-not-found' });
    const r = await fetch(`http://localhost:${port}/api/mirror/swipe-up`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: false, reason: 'window-not-found' });
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run src/server.test.ts`
Expected: FAIL——POST 落入 handleProxy(非 200 JSON 或超时/代理错误),证明路由不存在。

- [ ] **Step 3: 实现路由**

`server/src/server.ts`,在 `if (url === '/api/analyze/interpret' && method === 'POST') {...}` 块之后、`if (method !== 'GET')` 之前插入:

```typescript
    if (url === '/api/mirror/swipe-up' && method === 'POST') {
      const json = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      swipeUpOnMirror()
        .then((r) => json(200, r))
        .catch((e: unknown) => json(200, { ok: false, reason: 'inject-failed', detail: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
      return;
    }
```

并在紧邻的注释行 `// ── analyze 路由必须在 handleProxy 之前...` 处把注释改为覆盖两条路由:`// ── analyze/mirror 路由必须在 handleProxy 之前，否则 POST 会被代理吞掉 ──`。

- [ ] **Step 4: 跑测试确认通过(含既有回归)**

Run: `cd server && npx vitest run src/server.test.ts`
Expected: 全部 passed(含既有 5+ 用例)。

- [ ] **Step 5: Commit**

```bash
git add server/src/server.ts server/src/server.test.ts
git commit -m "feat(server): POST /api/mirror/swipe-up 透传路由(注册于 handleProxy 前)"
```

---

### Task 4: 前端手势拦截 + momentum 聚合 + 失败提示(TDD)

**Files:**
- Modify: `web/src/components/iphone-mirror-card.tsx`(wheel handler 区 107-136 行附近 + 标题条渲染)
- Test: `web/src/components/iphone-mirror-card.test.tsx`(追加用例;文件尾部 `afterEach` 补 `vi.unstubAllGlobals()`)

**Interfaces:**
- Consumes: `POST /api/mirror/swipe-up`(Task 3,同源相对路径)
- Produces: 无对外新接口(组件内部行为)

- [ ] **Step 1: 写失败测试**

`web/src/components/iphone-mirror-card.test.tsx` 的 `afterEach` 改为:

```typescript
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
```

describe 内追加:

```typescript
  // ⌃+双指上划透传:jsdom 同步连发 wheel(mock fetch 同步计数,不走 waitFor)
  function ctrlSwipe(el: Element, deltaY = 60) {
    fireEvent.wheel(el, { deltaY, ctrlKey: true, clientX: 100, clientY: 100 });
  }

  it('⌃+上划累计过阈值 → fetch 透传一次;冷却窗内 momentum 连发不重复触发', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    const fetchMock = vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    renderHarness();
    await connect(fake);
    await stubStage(400, 800);
    const v = videoEl();
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 3; i++) ctrlSwipe(boxEl());          // 累计 180 ≥ 120 → 触发 1 次
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('/api/mirror/swipe-up');
      expect(fetchMock.mock.calls[0][1].method).toBe('POST');
      const s0 = viewOf(v).s;
      for (let i = 0; i < 30; i++) ctrlSwipe(boxEl());         // 冷却内连发
      expect(fetchMock).toHaveBeenCalledTimes(1);               // 仍 1 次
      expect(viewOf(v).s).toBe(s0);                            // 且未触发缩放
      vi.advanceTimersByTime(900);                              // 冷却结束
      for (let i = 0; i < 3; i++) ctrlSwipe(boxEl());
      expect(fetchMock).toHaveBeenCalledTimes(2);               // 可再次触发
    } finally { vi.useRealTimers(); }
  });

  it('⌃+下划(deltaY<0) → 不透传,保持原缩放行为', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    const fetchMock = vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    renderHarness();
    const v = await connect(fake);
    await stubStage(400, 800);
    for (let i = 0; i < 5; i++) fireEvent.wheel(boxEl(), { deltaY: -100, ctrlKey: true, clientX: 200, clientY: 400 });
    await waitFor(() => expect(viewOf(v).s).toBeGreaterThan(1)); // 原缩放照旧
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('低幅 wheel 间隔 >600ms → 累计重置,不误触(pinch 噪声防线)', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    const fetchMock = vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    renderHarness();
    await connect(fake);
    await stubStage(400, 800);
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 2; i++) { ctrlSwipe(boxEl(), 50); vi.advanceTimersByTime(700); } // 各 50,间隔重置
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('透传失败(window-not-found / 网络拒绝)→ 标题条短暂提示,不静默', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ ok: false, reason: 'window-not-found' }) })));
    renderHarness();
    await connect(fake);
    await stubStage(400, 800);
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 3; i++) ctrlSwipe(boxEl());
      expect(document.querySelector('.mirror-err')).not.toBeNull();
      expect(document.querySelector('.mirror-err')!.textContent).toContain('iPhone 镜像窗口');
      vi.advanceTimersByTime(2100);
      expect(document.querySelector('.mirror-err')).toBeNull();  // 2s 后淡出
    } finally { vi.useRealTimers(); }
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run src/components/iphone-mirror-card.test.tsx`
Expected: 新增 4 例 FAIL(fetch 未被调用 / `.mirror-err` 不存在);既有 16 例 PASS。

- [ ] **Step 3: 最小实现**

`web/src/components/iphone-mirror-card.tsx`,文件常量区(FALLBACK_STREAM_H 之后)加:

```typescript
// ⌃+双指上划透传:累计阈值/冷却/累计重置间隔(ms)。自然滚动下双指上划 deltaY>0;
// 若系统关闭自然滚动方向不符,翻转此符号即可
const SWIPE_UP_DELTA_SIGN = 1;
const SWIPE_TRIGGER_DELTA = 120;
const SWIPE_COOLDOWN_MS = 800;
const SWIPE_RESET_GAP_MS = 600;
```

组件内(`showOpacityPanel` state 之后)加:

```typescript
  // 透传聚合(非渲染态)与失败提示:ctrl 按住累计 deltaY,过阈值 POST 一次并冷却;
  // 事件间隔超 SWIPE_RESET_GAP_MS 视为新 gesture 重置累计(防 pinch 噪声慢性累计)
  const swipeRef = useRef({ acc: 0, last: 0, cooldownUntil: 0 });
  const [errFlash, setErrFlash] = useState('');
  const errTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashError = useCallback((msg: string) => {
    setErrFlash(msg);
    if (errTimerRef.current) clearTimeout(errTimerRef.current);
    errTimerRef.current = setTimeout(() => setErrFlash(''), 2000);
  }, []);
  useEffect(() => () => { if (errTimerRef.current) clearTimeout(errTimerRef.current); }, []);
  const triggerSwipeUp = useCallback(() => {
    fetch('/api/mirror/swipe-up', { method: 'POST' })
      .then((r) => r.json() as Promise<{ ok: boolean; reason?: string }>)
      .then((d) => {
        if (d.ok) return;
        flashError(d.reason === 'window-not-found' ? '未找到 iPhone 镜像窗口' : '注入失败:检查辅助功能授权');
      })
      .catch(() => flashError('透传服务不可达'));
  }, [flashError]);
```

wheel handler(`onWheel` 函数体最前、原 `e.preventDefault()` 之前)加:

```typescript
    // ⌃+双指上划 → 透传 iPhone 上划:不缩放、不冒泡;momentum 聚合防连发
    if (e.ctrlKey && SWIPE_UP_DELTA_SIGN * e.deltaY > 0) {
      e.preventDefault();
      e.stopPropagation();
      const now = Date.now();
      const s = swipeRef.current;
      if (now < s.cooldownUntil) return;
      if (now - s.last > SWIPE_RESET_GAP_MS) s.acc = 0;
      s.last = now;
      s.acc += e.deltaY;
      if (s.acc >= SWIPE_TRIGGER_DELTA) {
        s.acc = 0;
        s.cooldownUntil = now + SWIPE_COOLDOWN_MS;
        triggerSwipeUp();
      }
      return;
    }
```

标题条(`.mirror-title` span)之后渲染提示:

```tsx
        {errFlash && <span className="mirror-err">{errFlash}</span>}
```

`web/src/styles.css` 追加(挨着既有 mirror 样式放):

```css
.mirror-err { color: #ff6b6b; font-size: 11px; margin-left: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
```

- [ ] **Step 4: 跑测试确认通过(含既有回归)**

Run: `cd web && npx vitest run src/components/iphone-mirror-card.test.tsx`
Expected: 全部 passed(新增 4 + 既有 16)。

- [ ] **Step 5: Commit**

```bash
git add web/src/components/iphone-mirror-card.tsx web/src/components/iphone-mirror-card.test.tsx web/src/styles.css
git commit -m "feat(web): 镜像小窗 ⌃+双指上划透传(momentum 聚合+失败提示)"
```

---

### Task 5: 全量验证 + build + MCP 演示(主会话)

**Files:**
- 无新文件(验证与收尾)

**Interfaces:**
- Consumes: Task 2/3/4 全部产物
- Produces: 验证通过的构建产物 `web/dist`(4000 端口服务的是 dist——**改了前端必须 build 再测**,已知陷阱)

- [ ] **Step 1: 全量单测**

Run: `cd server && npx vitest run && cd ../web && npx vitest run`
Expected: 两端全部 passed,零回归。

- [ ] **Step 2: 构建前端**

Run: `cd web && npm run build`
Expected: 构建成功,dist 更新。

- [ ] **Step 3: playwright MCP 演示(必须在主会话,子 agent 无 MCP)**

用 MCP 工具拉起 4000 页面:①`browser_evaluate` 注入 canvas 假流 stub `getDisplayMedia`(记忆中的既有手法:2×2 canvas + captureStream)挂起小窗;②stub `window.fetch` 记录调用;③`browser_evaluate` 对 `.mirror-video-box` 连发 3 个 `new WheelEvent('wheel', {deltaY: 60, ctrlKey: true, cancelable: true, bubbles: true})`;④断言 fetch 以 `'/api/mirror/swipe-up'` + POST 被调恰一次、画面 scale 不变(读 video 的 transform);⑤连发 30 个仍只一次。实际看过画面渲染无异常后截图留档。

- [ ] **Step 4: 真机人工验收(用户)**

请用户连上 iPhone 开镜像窗口,在网页小窗内 ⌃+双指上划,确认 iPhone 回主屏;再验 iPhone 断开时标题条出现「未找到 iPhone 镜像窗口」提示。

- [ ] **Step 5: Commit(演示截图不入库,gitignore 已覆盖)**

```bash
git status   # 确认无意外未跟踪文件
git log --oneline -4   # Task 2/3/4 三个 commit + spec commit
```

---

## Self-Review 记录

- **Spec 覆盖**:§4.1 前端手势→Task 4;§4.2 路由→Task 3;§4.3 JXA 注入→Task 1(spike)+Task 2;§6 错误/授权→Task 2/4;§7 测试策略→各任务 Step 1 + Task 5(MCP/真机)。§8 pinch 歧义→Global Constraints + Task 4 低幅测试。无缺口。
- **占位符**:Task 1 结论节为执行时填写的有意留白(决策记录,非 TBD 代码);其余无。
- **类型一致**:`SwipeResult`/`swipeUpOnMirror` 在 Task 2 定义、Task 3 消费签名一致;`/api/mirror/swipe-up` Task 3 产出、Task 4 消费一致;`.mirror-err` class 测试与实现一致。
- **Review Focus 5 条**均已折进 Task 3/4 测试。
