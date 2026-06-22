# windows-record：windows × claude-record-proxy 合并设计

- **日期**: 2026-06-22
- **状态**: 已批准（brainstorming 产出），待实现
- **作者**: brainstorming 协作产出
- **新仓库**: `/Users/Shared/workspace/windows-record/`（全新目录，不改动 `windows/` 与 `claude-record-proxy/`）

---

## 1. 背景与动机

现有两个独立项目：

| 项目 | 作用 | 与本需求的关系 |
|:--|:--|:--|
| `windows`（web-multi-terminal） | 基于 tmux 的 web 多终端管理器；每个"窗口"= 一个 tmux session（node-pty attach，`wmt-*` 命名），TS + React + WebSocket | **主体**（以 windows 为主） |
| `claude-record-proxy` | Claude Code 请求录制代理（纯 Node.js）；通过 `ANTHROPIC_BASE_URL` 让 claude 把请求发到本地代理，透传上游 + 旁路录制；数据按日期落盘；同进程提供 web 查看（端口 8766） | **被合并方**（核心逻辑内嵌进 windows） |

**需求**：合并两者，以 windows 为主——

1. 录制请求**按 windows 窗口（tmux session）分组**。
2. **record 与否仍由终端里敲 `claude` 还是 `claude-record` 决定**（沿用现有习惯，windows 不在创建窗口时加 record 开关）。
3. 普通 `claude` 窗口不录制、不显示 record 信息（自然结果：未改 `ANTHROPIC_BASE_URL` → 直连上游 → 不经代理）。`claude-record` 窗口在 windows 主 UI 上有入口看该窗口的录制。
4. 新建项目目录，原两项目保持不动。

**核心难题**：现有 record-proxy 收到请求时无法区分来源窗口。要让录制"按窗口分组"，必须让代理识别请求来自哪个 windows 窗口。

## 2. 现状（资产盘点）

### windows（主体）

- `server/src/`：`server.ts`（http + ws server，端口默认 3000，提供静态文件 + `/sessions` + `/ws`）、`pty-manager.ts`（tmux session 管理，socketName 默认 `wmt`）、`tmux.ts`、`ws-handler.ts`、`protocol.ts`、`ring-buffer.ts`，配 vitest 测试。
- `web/src/`：React + Vite；`App.tsx`、`components/{session-list,main-terminal,quick-input}.tsx`、`ws-client.ts`、`use-sessions.ts`、`types.ts`。
- npm workspaces：`server` + `web`；`npm run dev` 并发起 server(web) + web(vite)。

### claude-record-proxy（被合并方）

- `record-proxy.js`（约 240 行）：`buildTargetUrl`/`scrubAuth`/`makeRecordId`/`recordDir`/`collectRecords`/`SSEAccumulator`/`injectWebSearch` 纯函数 + 透传 handler + web 路由。
- `record-viewer.html`（19KB，内联 JS）：录制列表 + 详情（system 全文 / messages / tools / usage token）。
- `record-proxy.test.js`：纯函数单测（`node --test`）。
- `record-proxy-manager.sh`、`record-settings.json`、`.zshrc` 的 `claude-record` profile（export `ANTHROPIC_BASE_URL=http://localhost:8766` 后启动 claude）。

## 3. 目标

- record-proxy 核心逻辑（透传 + 旁路录制 + SSE 累积 + 脱敏）用 **TS 重写**为 windows server 的一个**同进程模块**。
- 代理能**识别请求来源的 windows 窗口**，录制数据按 `windowId` 分组。
- windows 主 UI 在有录制的窗口上显示徽标，点徽标查看该窗口录制。
- **critical path 零阻塞**：转发主路径只做流式 pipe，录制异步旁路。
- 不改动 `windows/` 与 `claude-record-proxy/`。

## 4. 非目标（YAGNI）

- 不做 windows 窗口创建时的 record 开关（record 由 `claude-record` 手动触发）。
- 不做实时 ws 推送录制计数（用轮询）。
- 不做并发限流、多上游对比、mitmproxy 系统代理。
- 不修改 Claude Code 本体或官方 transcript 行为。
- 不改动 `~/.zshrc` 既有 `claude-record` 定义（新项目提供独立 profile 脚本）。

## 5. 架构与数据流

### 整体形态

record-proxy 核心逻辑 TS 重写为 `server/src/record-proxy.ts` + `server/src/record-store.ts`，作为 windows server 的 HTTP 路由模块。**windows server 单端口**（默认 3000）同时承载：web UI、WebSocket(`/ws`)、claude API 代理（录制）、录制查看 API。一个进程、一个端口，生命周期随 windows。

### 识别机制（关键决策）

经 claude-code-guide 验证：

1. `ANTHROPIC_BASE_URL` **保留路径前缀**：设 `…/record/abc` → 实际请求 `/record/abc/v1/messages`。
2. 支持 `ANTHROPIC_CUSTOM_HEADERS` 环境变量注入自定义 header。

**采用 Header 方案**（URL path 前缀作为备选）：

- `claude-record` 设 `ANTHROPIC_BASE_URL=http://localhost:3000` + `ANTHROPIC_CUSTOM_HEADERS="X-Window-Id: <id>"`。
- 代理读 `X-Window-Id` 分组，**URL 完全透传**，现有 `buildTargetUrl` 零改动。
- 实现第一步先跑冒烟验证 header 确实带上；带不上回退 path 前缀方案（`ANTHROPIC_BASE_URL=http://localhost:3000/r/<id>`，代理剥前缀）。

### 数据流

```
1. 用户在 windows 窗口(某 wmt-* tmux session)内敲 claude-record
   → profile 执行: tmux -L wmt display -p '#S' 取当前窗口名 → wid
2. profile export ANTHROPIC_BASE_URL=http://localhost:3000
                + ANTHROPIC_CUSTOM_HEADERS="X-Window-Id: <wid>"
   → 启动 claude
3. claude POST /v1/messages → windows server 代理路由:
     读 X-Window-Id → sanitize → wid
     【主路径】剥离 X-Window-Id header 后流式透传到 GLM
     【旁路】PassThrough tee + SSE 累积 → 异步落盘 data/<wid>/<date>/<id>.json
4. 普通 claude(未改 BASE_URL) → 直连 GLM,不经代理,无录制 ✓"不加载"
5. web UI: 每 3s 轮询 /api/record/counts → 有数据的窗口显示徽标 ●录(N)
          点徽标 → 主区域切到该窗口录制列表 → 点单条看详情
```

### 窗口关联（P2：profile 自取 session 名）

**不改 windows server 的 session 创建逻辑**。窗口关联在 profile 内完成：

```bash
# claude-record.sh（新项目提供，用户 source 即可）
claude-record() {
  local wid="${WMT_WINDOW_ID:-$(tmux -L "${WMT_SOCKET:-wmt}" display-message -p '#S' 2>/dev/null)}"
  wid="${wid:-default}"   # 非 windows 终端 → default 分组
  ANTHROPIC_BASE_URL="http://localhost:${WMT_PORT:-3000}" \
  ANTHROPIC_CUSTOM_HEADERS="X-Window-Id: $wid" \
  claude "$@"
}
```

- windows 窗口内跑 → `tmux -L wmt display '#S'` 取到 `wmt-xxx` → 录制挂到该窗口徽标。
- 普通 terminal 跑 → `tmux display` 失败 → `default` 分组。
- socket 名 `wmt` 与 windows `PtyManager` 默认 `socketName` 一致，通过 `WMT_SOCKET` 可配。
- 旧 `claude-record`（指 8766）不受影响，端口不冲突。

## 6. 项目结构

```
windows-record/
├── package.json                 # workspaces: server, web（沿用 windows）
├── server/
│   ├── package.json             # node-pty, ws, tsx, typescript, vitest
│   ├── tsconfig.json
│   └── src/
│       ├── server.ts            # 改：挂载 record 路由(代理 + 录制 API)到同一 http server
│       ├── pty-manager.ts       # 原样复用（窗口关联走 profile）
│       ├── tmux.ts / ws-handler.ts / protocol.ts / ring-buffer.ts   # 原样复用
│       ├── record-proxy.ts      # 新：TS 移植(透传+旁路录制+SSE累积+脱敏+buildTargetUrl等纯函数)
│       ├── record-store.ts      # 新：按 windowId 分组的写入/列表/查询 + windowId sanitize
│       └── *.test.ts            # 移植纯函数测试 + 新增 record-store/header 测试
├── web/
│   ├── src/
│   │   ├── App.tsx              # 改：record 计数与视图切换
│   │   ├── types.ts             # 改：record 相关类型
│   │   ├── use-sessions.ts      # 改：record counts 轮询
│   │   ├── ws-client.ts         # 原样复用
│   │   └── components/
│   │       ├── session-list.tsx     # 改：窗口徽标 ●录(N)
│   │       ├── record-view.tsx      # 新：该窗口录制列表/详情（从 record-viewer.html 迁移）
│   │       ├── main-terminal.tsx    # 原样复用
│   │       └── quick-input.tsx      # 原样复用
│   └── vite.config.ts / tsconfig.json / index.html
├── claude-record.sh             # 新：claude-record profile（见第 5 节）
└── docs/superpowers/specs/      # 本设计文档
```

## 7. 数据结构

### 落盘

```
data/<windowId>/<YYYY-MM-DD>/<HHMMSS>-<id>.json
data/default/<YYYY-MM-DD>/...        # 非 windows 终端的录制
```

### 单条 record JSON（沿用现有 + windowId）

```jsonc
{
  "id": "143012-8f3a",
  "ts": "2026-06-22T14:30:12Z",
  "windowId": "wmt-b2",
  "model": "glm-5.2",
  "stream": true,
  "request": { /* system / messages / tools / cache_control 全文 */ },
  "response": { "text": "...", "stop_reason": "end_turn", "usage": { /* tokens */ } },
  "meta": {
    "status": 200,
    "duration_ms": 540,
    "bytes": 99876,
    "truncated": false,
    "injected_websearch": false,
    "response_headers": { /* scrubAuth 脱敏后 */ }
  }
}
```

### 录制 API（挂到 windows server 同端口 3000）

| 路由 | 作用 |
|:--|:--|
| `GET /api/record/counts` | `{ "wmt-b2": 3, "default": 1 }`，供徽标轮询 |
| `GET /api/record/list?window=<wid>` | 该窗口录制摘要列表（ts/model/status/in/out tokens） |
| `GET /api/record/<wid>/<date>/<id>` | 单条完整 JSON |
| `POST /v1/messages`（及其他 claude API 路径） | 透传上游 + 旁路录制（claude API 路由，非 GET） |

> **路由分发规则**（`server.ts` 内明确，避免与静态文件 fallback 冲突）：沿用 record-proxy 现有的"非 GET 即代理"语义，叠加 windows 的 GET 路由——
> - **非 GET 请求**（claude 的 `POST /v1/messages` 等）→ 代理（读 `X-Window-Id` → 透传上游 + 旁路录制）。
> - `GET /sessions`、`GET /api/record/*` → 各自 API handler。
> - 其余 `GET` → 静态文件（web UI）。

## 8. web UI

- **徽标**：`session-list.tsx` 每个窗口 tab，`count > 0` 显示 `●录(N)`。计数来源：`use-sessions.ts` 每 3s 轮询 `/api/record/counts`，合并到 session 状态。
- **录制视图**：`record-view.tsx`——从 `record-viewer.html` 迁移核心展示逻辑到 React：
  - 列表：该 windowId 的录制卡片（时间 / model / 状态 / token）。
  - 详情：system 全文 / messages / tools / usage（复用 record-viewer.html 的展示与折叠逻辑）。
- **视图切换**：点窗口徽标 → 主区域由终端切到该窗口 `record-view`；返回按钮回终端。session 不销毁。

## 9. 错误处理

| 场景 | 行为 | 回退 |
|:--|:--|:--|
| 上游连不上 / 5xx | 原样把状态码返给 Claude Code（**不静默**） | 用户感知报错，自行重试 |
| 落盘写失败 | 只记 error 日志，**绝不影响转发** | 该请求丢录制，claude 正常 |
| response >10MB | 截断 + `"truncated": true`，主路径不受影响 | 查看时提示截断 |
| 鉴权 | `x-api-key`/`authorization` 原样转发上游；**落盘前 `scrubAuth` 替换为 `***`** | 落盘天然不含 key |
| `X-Window-Id` 缺失 | 归 `default`，照常录制 | 录制可用，仅未分组 |
| **转发前剥离 `X-Window-Id`** | 不把内部窗口标记泄露给 GLM | — |
| windowId 非法（含 `/`/`..` 等） | sanitize：只允许 `[A-Za-z0-9_-]`，否则归 `default` | 防路径穿越 |
| 代理路由异常 | claude 连不上 → 报错（非静默走坏数据） | 切普通 `claude` 回直连 |

**对称性**：录制写入与查询路径一致；header 剥离仅在转发方向，落盘保留 windowId。

## 10. 测试（vitest）

- **移植** `record-proxy.test.js` 纯函数测试到 TS：`buildTargetUrl` / `scrubAuth` / `makeRecordId` / `recordDir` / `SSEAccumulator` / `injectWebSearch`。
- **新增 `record-store` 测试**：按 windowId 分组写入、列表（跨天倒序）、单条查询、`default` 归类。
- **新增边界测试**：windowId sanitize（`..`/`/`/空/含空格 → default）、`X-Window-Id` header 读取 + 缺失归 default。
- **新增集成测试**：模拟带 `X-Window-Id: wmt-b2` 的 POST `/v1/messages` → 验证录制落到 `data/wmt-b2/<date>/` 且转发上游的 body/header 未含 `X-Window-Id`。
- windows 现有测试（`ring-buffer` / `tmux` / `pty-manager` / `ws-handler` / `server` / `e2e`）原样保留并应继续通过。

## 11. 验证标准（端到端）

1. `windows-record` 复制 windows 基座后 `npm install && npm run dev` 正常起；现有测试全绿。
2. **冒烟**：在某 windows 窗口内 `source claude-record.sh && claude-record -p "你好"`，claude 正常响应；确认请求带 `X-Window-Id`（代理日志可见 wid）。若未带 → 回退 path 前缀方案。
3. **分组**：该窗口徽标出现 `●录(1)`；另一普通 `claude` 窗口无徽标。
4. **查看**：点徽标 → 看到该窗口录制列表 → 点单条看到 system 全文 / messages / tools / usage。
5. **脱敏**：落盘 JSON 里 API key 为 `***`；转发 GLM 的请求未含 `X-Window-Id`。
6. **default**：普通 terminal 跑 `claude-record` → 录制落到 `data/default/`。
7. **效率**：响应延迟与直连无感差异（计时对比）。
8. **边界**：response 截断标 `truncated`；故意发非法 windowId → 归 default。

## 12. 实现顺序（供 writing-plans 展开）

1. 建 `windows-record/`，整体复制 `windows/` 基座（`server` + `web` + 根 `package.json` 等），`npm install`，确认 `npm run dev` / `build` / `test` 绿。
2. `record-proxy.ts` 移植纯函数 + 透传 handler（去 web 路由，web 路由并入 server.ts）；移植纯函数测试。
3. `record-store.ts`：windowId 分组写入 / 列表 / 查询 + sanitize；新增测试。
4. `server.ts` 挂载：POST claude API → 透传+录制（读 `X-Window-Id`、转发前剥离、windowId sanitize）；GET `/api/record/counts|list|<wid>/<date>/<id>`。路由分发与静态文件不冲突。
5. `claude-record.sh` profile；冒烟验证 header 带上。
6. web：`use-sessions.ts` 加 counts 轮询；`session-list.tsx` 徽标；`record-view.tsx` 迁移 `record-viewer.html`；`App.tsx` 视图切换。
7. 按第 11 节端到端验证。

## 13. 风险

| 风险 | 应对 |
|:--|:--|
| `ANTHROPIC_CUSTOM_HEADERS` 实测未生效 | 回退 path 前缀方案（机制②，已验证 path 保留） |
| `record-viewer.html` → React 迁移工作量（19KB 内联 JS） | 列表先上，详情可分阶段；保留原 HTML 作参考 |
| 代理路由与 windows 静态文件路由冲突 | 在 `server.ts` 明确分发：claude API 路径与非 GET 走代理，其余走静态/会话 |
| socket 名非默认 `wmt` | profile 用 `WMT_SOCKET` 可配；README 注明 |
