# 图片粘贴功能设计

**日期**：2026-06-30
**状态**：已确认
**目标**：在 xterm 终端内粘贴图片，自动保存到项目目录，以 `@path` 形式写入 CLI 输入。

## 背景

claude-hive 是基于 tmux + WebSocket 的多 Claude Code 管理器。用户希望通过浏览器页面直接粘贴图片到终端窗口，让 Claude Code CLI 能读取到该图片（通过 `@path` 语法）。

## 数据流

```
用户粘贴图片
    │
    ▼
xterm 终端内 paste 事件
    │
    ├─ 检查 clipboardData.items 是否有 image/*
    │   ├─ 否 → 走默认文本粘贴
    │   └─ 是 → 阻止默认，读取 blob
    │
    ▼
blob → base64 编码
    │
    ▼
WS 消息: { type: 'paste-image', sessionId, data: base64, mimeType: 'image/png' }
    │
    ▼
Server 接收
    │
    ├─ 确保 data/pasted-images/ 存在
    ├─ 生成文件名: ${sessionId}_${Date.now()}.${ext}
    ├─ base64 解码 → 写入文件
    └─ 回复: { type: 'image-pasted', sessionId, path: '...' }
    │
    ▼
前端收到回复 → 发送 input: `@path\r` 前的路径到 CLI（不自动回车）
```

## 存储

- **目录**：`./data/pasted-images/`（项目内，复用现有 `data/` 约定）
- **文件名**：`${sessionId}_${timestamp}.${ext}`
- **扩展名推导**：`image/png` → `png`，`image/jpeg` → `jpg`，`image/webp` → `webp`，`image/gif` → `gif`
- **路径格式**：绝对路径，如 `/Users/.../claude-hive/data/pasted-images/wmt-xxx_1719763200000.png`

## 协议扩展

### ClientMessage 新增

```typescript
| { type: 'paste-image'; sessionId: string; data: string; mimeType: string }
```

- `data`：base64 编码的图片二进制
- `mimeType`：原始 MIME 类型

### ServerMessage 新增

```typescript
| { type: 'image-pasted'; sessionId: string; path: string }
| { type: 'error'; sessionId: string; message: string }
```

## 错误处理

| 场景 | 处理方式 |
|------|---------|
| 目录创建失败 | console.error + 回复 error |
| 文件写入失败 | 回复 `{ type: 'error', message: '...' }` |
| Base64 解码失败 | 回复 error |
| 不支持的 MIME | 前端侧阻止，不发送 |
| 文件超过 5MB | 前端侧拒绝，console.warn |
| WS 断线期间粘贴 | 图片丢失，用户需重新粘贴 |

## 前端交互

- 粘贴图片时 **不显示任何 toast/提示**（静默处理，保持终端沉浸感）
- 失败时 `console.warn` 输出原因，不打扰用户
- `@path` 写入后 **不自动回车**，让用户可以追加其他参数再手动发送

## 安全

- 文件大小上限：5MB（前端侧检查）
- 只接受 `image/*` MIME（`image/png`, `image/jpeg`, `image/webp`, `image/gif`）
- 文件名不含用户输入，防路径穿越
- sessionId 来自 server 分配，可信

## 组件拆分

### 新建文件

- **`server/src/paste-store.ts`**：封装图片保存逻辑
  - `saveImage(sessionId, base64, mimeType) → Promise<path>`
  - `getImageDir() → string`
  - 负责 mkdir、生成路径、写文件

### 修改文件

- **`server/src/protocol.ts`**：新增消息类型定义
- **`server/src/ws-handler.ts`**：处理 `paste-image` 消息
- **`web/src/components/main-terminal.tsx`**：拦截粘贴、发送 WS、处理回复

## 测试

### 单元测试

- `paste-store.test.ts`：
  - 保存 PNG 成功，返回正确路径
  - 目录不存在时自动创建
  - MIME 不支持时抛出错误

### E2E 测试

- 在浏览器粘贴图片，确认：
  1. 文件被创建在 `data/pasted-images/`
  2. 终端输入出现 `@...` 路径
  3. 路径可被 CLI 读取
