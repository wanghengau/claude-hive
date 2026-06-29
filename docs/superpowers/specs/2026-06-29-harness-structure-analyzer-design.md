# harness 结构分析器

## 背景与问题

claude-hive 作为 Claude Code 的 API 透明代理，已把每次 `/v1/messages` 调用旁路录制成 JSON（`data/<windowId>/<date>/<HHMMSS>-<hex>.json`），字段完整：`request`（system / tools / messages / model）、`response`（text / usage）、`meta`（status / duration_ms / bytes）。

现状（详见探索结论）：**录得完整，算得为零**。

- 现有查看器 `record-view.tsx` 只能逐条浏览单次请求（response/system/messages/tools/raw 五 tab + 单条 token），没有任何跨请求聚合。
- 存储层 `record-store.ts` 的 `RecordSummary` 只有单条 token + 计数。
- 想回答「Claude Code 这个 harness 到底怎么设计的」——目前无处可看。

录制数据天然是观察 harness 内部行为的窗口。真实样本里已能直接看到 harness 的稳定结构：

- `request.system`（2 段）：`"You are Claude Code..."` 身份声明 + 6283 字符完整规则（harness「宪法」）。
- `request.tools`（26 个）：Agent/Bash/Edit/Read/Workflow/TaskCreate… 正是 harness 注入的能力集（单 Workflow 工具 desc 就 18519 字符）。
- `usage.cache_read_input_tokens: 17600` ≫ `input_tokens: 8628` —— harness 高度依赖 prompt caching。
- `messages` 里混入 `role=system` 的 22126 字符消息 —— harness 还往上下文注入 CLAUDE.md / 环境内容。

用户诉求：给录制数据「增加分析」，用看板 + LLM 解读逆向出「整个 harness 是怎么设计的」。

## 目标

- 跨所有录制聚合，提取 Claude Code harness 的**稳定设计特征**（不随单次会话变化的那些），输出结构化 `HarnessProfile`。
- 看板展示 6 个维度：身份与宪法 / 能力集 / 固定开销 / 缓存策略 / 环境注入 / 模型与元数据。
- LLM 解读：服务端直调上游 LLM，基于 profile 生成「这个 harness 怎么设计的」归纳文案，页面一键「生成解读」。

## 非目标（YAGNI）

- **不做**单会话执行轨迹分析（逐轮还原一次任务怎么跑）——视角不同，需会话切分，留二期。
- **不做**成本 / 账单看板（token 折算费用）。
- **不做**调用链调试（哪个工具失败 / 为何重复调用）。
- **不做**实时边录边算；分析按需触发（点按钮）。
- **不引入**数据库 / 分词器依赖（JSON 文件 + 字符估算足够）。
- **不改**录制代理（`record-proxy.ts`）、`record-store.ts`、`record-view.tsx` 现有功能。

## 架构与数据流

```
data/**/*.json ──[analyzer 遍历聚合]──▶ HarnessProfile（取最高频版本，抗漂移）
                                          │
            ┌─────────────────────────────┼──────────────────────────┐
            ▼                             ▼                          ▼
   GET /api/analyze/harness      前端 analyze-view          POST /api/analyze/interpret
   (返回结构化 profile)           (看板 6 维渲染)            (服务端调 LLM → 解读文案)
```

- 分析是**只读、按需**的后处理，不在录制热路径上（录制仍零阻塞转发）。
- 默认**全局聚合**所有 window 的录制；支持 `?window=<wid>` 过滤单个 window（不同 window 可能挂不同 MCP / 工具集，可对比）。

## 组件与钩子

### `server/src/analyzer.ts`（新增，纯函数为主）

| 函数 | 职责 |
|---|---|
| `estimateTokens(text)` | 粗估 token：英文 `ceil(chars/4)`，CJK 段按字符数加权。零依赖，不引分词器 |
| `hashJson(obj)` | `JSON.stringify` 后做稳定 hash（用于 system/tools 版本去重计数） |
| `analyzeRecords(logDir, opts)` | 主入口：遍历 `data/<wid>/<date>/*.json`，按 `ts` 倒序取**最近 limit 条**（默认 500，最新行为最相关；超出则 `sampleSize` 如实反映），聚合出 `HarnessProfile`。只读关键字段，不全文加载 messages |
| `pickMostFrequent(map)` | 从 `Map<hash, {count, value}>` 取出现次数最多的版本（抗 system/tools 版本漂移） |
| `extractSystem(records)` | 聚合 system：取最高频版本 → `{ identity, rules, rulesTokens }` |
| `extractTools(records)` | 聚合 tools：取最高频清单 → 每工具 `{ name, desc, descTokens, schemaTokens }`，按 descTokens 降序 |
| `computeTokenOverhead(system, tools)` | 估算每次请求必带的固定 token（system + tools schema） |
| `computeCacheStats(records)` | 从 `usage` 聚合：平均 `cache_read_input_tokens`、平均 `input_tokens`、缓存命中率 = cache_read / (cache_read + input) |
| `extractInjections(records)` | 提取 `messages` 中 `role===system` 的注入内容（CLAUDE.md / 环境），取最高频 → `{ chars, preview, tokens }` |
| `extractModels(records)` | 模型分布：`{ model, count }[]` |
| `buildInterpretPrompt(profile)` | 组装给 LLM 的分析 prompt：system 全文 + tools 名（每个 desc 截断 200 字符）+ token 开销 + 缓存命中率 + 注入预览 + 分析指令（「分析这个 harness 的设计哲学、能力边界、上下文/缓存管理策略」） |

### `server/src/llm-client.ts`（新增）

| 函数 | 职责 |
|---|---|
| `interpretProfile(profile, opts)` | 组装 `/v1/messages` 请求体调上游 LLM，返回解读文本（非流式，超时 60s）。对称性：请求 `req.on('error')` + `req.end()`，响应 `res.on('end')` 正确收尾 |
| `buildAnalyzeRequest(profile, opts)` | 纯函数：`{ model, system: <分析员 system>, messages: [{role:'user', content: buildInterpretPrompt(profile)}], max_tokens }` |
| 缺 key | `opts.apiKey` 为空 → 抛 `NoAnalyzerKeyError`（不发起请求，由路由层降级） |

### `server/src/server.ts` 改动

- 新增环境变量（与 `RECORD_TARGET` / `RECORD_LOG_DIR` 同级风格）：
  - `ANALYZER_API_KEY`（缺则解读端点降级返回可复制 prompt）
  - `ANALYZER_TARGET`（默认复用 `RECORD_TARGET`）
  - `ANALYZER_MODEL`（默认 `glm-5v-turbo`）
- 新增两条路由：
  - `GET /api/analyze/harness?window=&limit=` → `json(200, analyzeRecords(RECORD_LOG_DIR, {window, limit}))`
  - `POST /api/analyze/interpret` → body 可带 `{window, limit}` 或 `{profile}`；调 `interpretProfile`，失败 / 缺 key 降级返回 `{ error, fallbackPrompt }`

### 前端 `web/src/components/analyze-view.tsx`（新增）

- `useEffect` fetch `/api/analyze/harness` → 渲染 6 维看板。
- 「生成解读」按钮 → `POST /api/analyze/interpret`：成功展示解读文案；失败展示降级的可复制 prompt + 复制按钮。
- 入口：`session-list.tsx` 顶部 header 加「🔧 分析 harness」按钮，切换到 `analyze-view`（与 `record-view` 同级的视图层，由 `App.tsx` 的视图状态控制）。

### 前端 `web/src/types.ts` 改动

- 新增 `HarnessProfile` 及其子类型（见数据模型），导出供组件用。

## 数据模型

```ts
interface HarnessProfile {
  sampleSize: number;              // 聚合采样了多少条录制
  windowScope: string | 'all';     // 聚合范围
  system: {
    identity: string;              // system[0] 身份声明
    rules: string;                 // system[1] 完整规则（最高频版本）
    rulesTokens: number;
  };
  tools: Array<{ name: string; desc: string; descTokens: number; schemaTokens: number }>;
  tokenOverhead: { systemTokens: number; toolsTokens: number; total: number };
  cacheStats: { avgCacheRead: number; avgInput: number; hitRate: number };
  injections: Array<{ chars: number; tokens: number; preview: string }>; // role=system 注入
  models: Array<{ model: string; count: number }>;
}
```

## API 设计

| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| GET | `/api/analyze/harness` | `?window=<wid>&limit=<n>` | `HarnessProfile` |
| POST | `/api/analyze/interpret` | `{ window?, limit?, profile? }` | `{ text }` 成功 / `{ error, fallbackPrompt }` 降级 |

## 环境变量

| 变量 | 默认 | 说明 |
|:--|:--|:--|
| `ANALYZER_API_KEY` | （空） | 解读端点调 LLM 用的 key；空则降级返回可复制 prompt |
| `ANALYZER_TARGET` | `= RECORD_TARGET` | LLM API 地址（复用录制上游，Anthropic 兼容端点） |
| `ANALYZER_MODEL` | `glm-5v-turbo` | 解读用的模型 |

## 安全校验（系统边界）

- analyzer 只**读** `RECORD_LOG_DIR`，不写；`window` 参数走既有 `sanitizeWindowId`（防路径穿越，规则同 `record-store`）。
- `ANALYZER_API_KEY` 仅服务端内存持有，**不落盘、不回显、不进日志**；降级返回的 `fallbackPrompt` 不含 key。
- analyzer 枚举目录时用正则白名单（`^\d{4}-\d{2}-\d{2}$` 日期目录、`<HHMMSS>-<hex>.json` 文件名），不信任任意文件名。

## 错误处理（沿用项目风格）

- 无录制 / 目录空 → `HarnessProfile` 各字段为空数组 / 0，前端显示「无录制」空态，不报错。
- 录制 JSON 非法 / 字段缺失 → 逐条 try/catch 跳过（同 `listRecords` 的坏文件处理），不影响聚合。
- `ANALYZER_API_KEY` 缺失 → interpret 端点返回 `{ error: 'no_analyzer_key', fallbackPrompt }`，前端展示可复制 prompt，不阻断。
- LLM 调用超时 / 失败 → 同样降级返回 `fallbackPrompt`（永远给用户一条出路：拿到 prompt 自己去问 LLM）。
- 聚合采样上限 `limit`（默认 500）防止巨量录制卡死服务；超限时 `sampleSize` 如实反映采样数。

## 测试

### `server/src/analyzer.test.ts`（新增）

1. **聚合正确性**（构造样本 JSON 数组）：
   - `extractSystem` 取最高频版本（混入 1 条不同 system，仍取多数派）。
   - `extractTools` 返回工具清单 + token 估算；按 descTokens 降序。
   - `computeCacheStats`：给定 cache_read / input 数值，命中率算对。
   - `extractInjections`：识别 `messages[role=system]`，忽略普通 user/assistant。
   - `extractModels`：模型计数正确。
2. **空态**：空目录 / 全坏文件 → profile 各字段空 / 0，不抛错。
3. **采样上限**：超过 `limit` 的录制被截断，`sampleSize` 反映实际采样数。
4. **`estimateTokens`**：英文段 `/4`、含中文段加权，边界（空串、纯中文）。
5. **`buildInterpretPrompt`**：输出含 system 摘要 + tools 名 + 各项数值 + 分析指令，结构稳定可断言。

### `server/src/llm-client.test.ts`（新增）

- `buildAnalyzeRequest` 纯函数：请求体结构正确（model/system/messages/max_tokens）。
- 缺 key → `interpretProfile` 抛 `NoAnalyzerKeyError`，不发起网络请求（mock 计数验证）。

### e2e（playwright MCP，主会话执行）

- 启动 `npm run dev`，进入分析页，看板 6 维渲染正确（用真实 `data/` 数据）。
- 未配 key 点「生成解读」→ 展示降级可复制 prompt。
- （配 key 后）点「生成解读」→ 展示 LLM 解读文案。

## 端到端验证清单

- [ ] 顶层「🔧 分析 harness」入口 → 进入 analyze-view。
- [ ] 看板 6 维全部渲染：身份/规则全文可展开、tools 清单按大小排序、token 开销、缓存命中率、注入预览、模型分布。
- [ ] `?window=` 过滤生效，不同 window profile 可对比。
- [ ] 未配 `ANALYZER_API_KEY` → 「生成解读」返回可复制 prompt，复制按钮工作。
- [ ] 配 `ANALYZER_API_KEY` → 「生成解读」返回 LLM 解读文案。
- [ ] 无录制 window → 空态不报错。
- [ ] `npm -w server test` 全绿；`npm -w web test` 全绿。

## 影响面（爆炸半径）

- **新增（server）**：`analyzer.ts` + `analyzer.test.ts`、`llm-client.ts` + `llm-client.test.ts`。
- **改（server）**：`server.ts`（2 条 analyze 路由 + 3 个环境变量）。
- **新增（web）**：`components/analyze-view.tsx`、`types.ts` 加 `HarnessProfile` 类型。
- **改（web）**：`session-list.tsx`（加入口按钮）、`App.tsx`（视图状态加 analyze 分支）。
- **不影响**：录制代理（`record-proxy.ts`）、录制存储（`record-store.ts`）、录制查看器（`record-view.tsx`）、命令历史、quick-commands、tmux / PTY。
