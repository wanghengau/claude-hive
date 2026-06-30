# 图片粘贴功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 xterm 终端内粘贴图片，自动保存到项目目录，以 `@path` 形式写入 CLI 输入。

**Architecture:** 前端拦截 xterm 粘贴事件，提取图片 blob 转 base64，通过 WebSocket 发送给 server；server 解码后写入 `data/pasted-images/`，回复绝对路径；前端收到后发送 `@path` 到 CLI（不自动回车）。

**Tech Stack:** Node.js (fs, path), TypeScript, React, xterm.js, WebSocket

---

## 文件结构

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `server/src/protocol.ts` | 消息类型定义 | 修改 |
| `server/src/paste-store.ts` | 图片保存逻辑 | 新建 |
| `server/src/paste-store.test.ts` | paste-store 单测 | 新建 |
| `server/src/ws-handler.ts` | 处理 paste-image 消息 | 修改 |
| `web/src/types.ts` | 前端消息类型（与 protocol.ts 同步） | 修改 |
| `web/src/components/main-terminal.tsx` | 拦截粘贴、发送、处理回复 | 修改 |

---

### Task 1: 扩展协议类型

**Files:**
- Modify: `server/src/protocol.ts:25-38`
- Modify: `web/src/types.ts:8-21`

- [ ] **Step 1: 在 server/src/protocol.ts 添加新消息类型**

在 `ClientMessage` 联合类型末尾添加：
```typescript
| { type: 'paste-image'; sessionId: string; data: string; mimeType: string }
```

在 `ServerMessage` 联合类型末尾添加：
```typescript
| { type: 'image-pasted'; sessionId: string; path: string }
| { type: 'error'; sessionId: string; message: string }
```

- [ ] **Step 2: 在 web/src/types.ts 同步添加相同类型**

在 `ClientMessage` 联合类型末尾添加：
```typescript
| { type: 'paste-image'; sessionId: string; data: string; mimeType: string }
```

在 `ServerMessage` 联合类型末尾添加：
```typescript
| { type: 'image-pasted'; sessionId: string; path: string }
| { type: 'error'; sessionId: string; message: string }
```

- [ ] **Step 3: 提交**

```bash
git add server/src/protocol.ts web/src/types.ts
git commit -m "feat: extend protocol with paste-image and image-pasted messages"
```

---

### Task 2: 实现 paste-store (TDD)

**Files:**
- Create: `server/src/paste-store.test.ts`
- Create: `server/src/paste-store.ts`

- [ ] **Step 1: 写失败测试**

创建 `server/src/paste-store.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { saveImage, getImageDir } from './paste-store.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('paste-store', () => {
  let testDir: string;
  let origEnv: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-store-test-'));
    origEnv = process.env.PASTE_IMAGE_DIR;
    process.env.PASTE_IMAGE_DIR = testDir;
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.PASTE_IMAGE_DIR;
    else process.env.PASTE_IMAGE_DIR = origEnv;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('returns correct image directory', () => {
    expect(getImageDir()).toBe(testDir);
  });

  it('saves PNG image and returns absolute path', async () => {
    // 1x1 red PNG (base64)
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';
    const result = await saveImage('session-abc', base64, 'image/png');
    expect(result).toMatch(/^\/.*\.png$/);
    expect(fs.existsSync(result)).toBe(true);
    const stat = fs.statSync(result);
    expect(stat.size).toBeGreaterThan(0);
  });

  it('creates directory if not exists', async () => {
    const nested = path.join(testDir, 'nested', 'dir');
    process.env.PASTE_IMAGE_DIR = nested;
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';
    const result = await saveImage('session-xyz', base64, 'image/png');
    expect(fs.existsSync(result)).toBe(true);
  });

  it('uses correct extension for jpeg', async () => {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';
    const result = await saveImage('session-1', base64, 'image/jpeg');
    expect(result).toMatch(/\.jpg$/);
  });

  it('throws for unsupported MIME type', async () => {
    const base64 = 'AAAA';
    await expect(saveImage('session-1', base64, 'image/bmp')).rejects.toThrow('Unsupported MIME');
  });

  it('throws for invalid base64', async () => {
    await expect(saveImage('session-1', 'not-valid-base64!!!', 'image/png')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd server && npm test -- paste-store.test.ts --run
```

Expected: FAIL with "Cannot find module './paste-store.js'"

- [ ] **Step 3: 实现 paste-store.ts**

创建 `server/src/paste-store.ts`：

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const MAX_SIZE = 5 * 1024 * 1024; // 5MB

export function getImageDir(): string {
  return process.env.PASTE_IMAGE_DIR || path.resolve(__dirname, '../../data/pasted-images');
}

export async function saveImage(sessionId: string, base64: string, mimeType: string): Promise<string> {
  const ext = MIME_TO_EXT[mimeType];
  if (!ext) throw new Error(`Unsupported MIME type: ${mimeType}`);

  let buffer: Buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    throw new Error('Invalid base64 data');
  }

  if (buffer.length === 0 || buffer.length > MAX_SIZE) {
    throw new Error(`Invalid image size: ${buffer.length} bytes`);
  }

  const dir = getImageDir();
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${sessionId}_${Date.now()}.${ext}`;
  const filePath = path.resolve(dir, filename);
  fs.writeFileSync(filePath, buffer);

  return filePath;
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd server && npm test -- paste-store.test.ts --run
```

Expected: All tests pass

- [ ] **Step 5: 提交**

```bash
git add server/src/paste-store.ts server/src/paste-store.test.ts
git commit -m "feat: add paste-store for saving pasted images"
```

---

### Task 3: 扩展 ws-handler 处理 paste-image

**Files:**
- Modify: `server/src/ws-handler.ts:50-79`

- [ ] **Step 1: 在 ws-handler.ts 导入 paste-store**

在文件顶部添加导入：
```typescript
import { saveImage } from './paste-store.js';
```

- [ ] **Step 2: 在 switch 语句中添加 paste-image case**

在 `case 'list':` 之前添加：
```typescript
case 'paste-image': {
  try {
    const filePath = await saveImage(msg.sessionId, msg.data, msg.mimeType);
    send({ type: 'image-pasted', sessionId: msg.sessionId, path: filePath });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    send({ type: 'error', sessionId: msg.sessionId, message });
  }
  break;
}
```

- [ ] **Step 3: 将 handleConnection 改为 async**

修改函数签名：
```typescript
export async function handleConnection(ws: WSLike, mgr: IPtyManager, cmdCtx: CmdCtx, broadcast: Broadcast): Promise<void> {
```

- [ ] **Step 4: 在 server.ts 中适配 async handleConnection**

修改 `server/src/server.ts` 第 127 行：
```typescript
handleConnection(wsLike, mgr, cmdCtx, broadcast).catch((err) => console.error('ws handler error:', err));
```

- [ ] **Step 5: 运行 server 测试确认无破坏**

```bash
cd server && npm test -- --run
```

Expected: All existing tests pass

- [ ] **Step 6: 提交**

```bash
git add server/src/ws-handler.ts server/src/server.ts
git commit -m "feat: handle paste-image message in ws-handler"
```

---

### Task 4: 前端拦截粘贴并发送图片

**Files:**
- Modify: `web/src/components/main-terminal.tsx:31-118`

- [ ] **Step 1: 在 main-terminal.tsx 添加粘贴事件监听**

在 `const inputOff = term.onData(...)` 之后（约第 80 行后），添加：

```typescript
// 粘贴事件拦截：检测图片并发送到 server
const onPaste = async (e: ClipboardEvent) => {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const blob = item.getAsFile();
      if (!blob) continue;

      // 检查大小（5MB）
      if (blob.size > 5 * 1024 * 1024) {
        console.warn('[paste] Image too large:', blob.size, 'bytes');
        return;
      }

      try {
        const base64 = await blobToBase64(blob);
        client.send({ type: 'paste-image', sessionId, data: base64, mimeType: item.type });
      } catch (err) {
        console.warn('[paste] Failed to read image:', err);
      }
      return;
    }
  }
};

containerRef.current.addEventListener('paste', onPaste);
```

- [ ] **Step 2: 添加 blobToBase64 辅助函数**

在组件外部（文件顶部导入后）添加：
```typescript
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // data URL 格式: data:image/png;base64,XXXXX，提取逗号后部分
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
```

- [ ] **Step 3: 在 cleanup 中移除 paste 监听器**

在 return cleanup 函数中添加：
```typescript
containerRef.current?.removeEventListener('paste', onPaste);
```

完整 cleanup：
```typescript
return () => {
  containerRef.current?.removeEventListener('wheel', onWheel, { capture: true });
  containerRef.current?.removeEventListener('paste', onPaste);
  ro.disconnect();
  off();
  inputOff.dispose();
  term.dispose();
  termRef.current = null;
};
```

- [ ] **Step 4: 提交**

```bash
git add web/src/components/main-terminal.tsx
git commit -m "feat: intercept paste event and send image to server"
```

---

### Task 5: 前端处理 image-pasted 回复并写入 @path

**Files:**
- Modify: `web/src/components/main-terminal.tsx:31-118`

- [ ] **Step 1: 添加 onMessage 监听处理 image-pasted**

在 `const inputOff = term.onData(...)` 后添加：

```typescript
// 监听 server 回复的图片路径，写入终端
const offMsg = client.onMessage((msg) => {
  if (msg.type === 'image-pasted' && msg.sessionId === sessionId) {
    // 发送 @path 到 CLI，不自动回车
    client.send({ type: 'input', sessionId, data: `@${msg.path}` });
  }
});
```

- [ ] **Step 2: 在 cleanup 中取消监听**

在 cleanup 函数中添加：
```typescript
offMsg();
```

- [ ] **Step 3: 运行前端构建确认无错误**

```bash
cd web && npm run build
```

Expected: Build succeeds

- [ ] **Step 4: 提交**

```bash
git add web/src/components/main-terminal.tsx
git commit -m "feat: write @path to terminal on image-pasted response"
```

---

### Task 6: 端到端验证

**Files:** 无新增文件

- [ ] **Step 1: 启动开发服务器**

```bash
npm run dev
```

- [ ] **Step 2: 在浏览器中打开 http://localhost:4001**

- [ ] **Step 3: 创建一个终端会话**

点击 "+ 新建" 按钮

- [ ] **Step 4: 准备一张测试图片**

可以用截图工具截取屏幕，或准备一个 PNG 文件

- [ ] **Step 5: 在终端区域内粘贴图片**

点击终端区域使其获得焦点，然后 Cmd+V 粘贴

- [ ] **Step 6: 验证**

检查：
1. 终端输入区出现 `@/Users/.../claude-hive/data/pasted-images/xxx_xxx.png`
2. 文件确实被创建在 `data/pasted-images/` 目录
3. 没有自动回车（光标停在路径后面等待输入）
4. 按 Enter 后 Claude Code CLI 能读取到该图片

- [ ] **Step 7: 验证错误处理**

尝试粘贴一个超过 5MB 的图片（如果可能），检查 console.warn 输出

- [ ] **Step 8: 完成验证后提交最终修复（如有）**

```bash
# 如有修复
git add .
git commit -m "fix: address issues found in e2e verification"
```

---

## 验收标准

1. 在 xterm 终端内粘贴图片，`@path` 自动出现在输入区
2. 图片文件保存在 `data/pasted-images/` 目录
3. 文件名格式：`${sessionId}_${timestamp}.${ext}`
4. 支持 PNG/JPEG/WebP/GIF
5. 超过 5MB 的图片被拒绝
6. 粘贴文本时行为不受影响
7. `@path` 不自动回车，用户可追加参数
8. 所有单元测试通过
