# 会话命令历史服务端持久化

## 背景与问题

左侧每张会话卡片（`session-list.tsx` 的 `row-inputs`）展示该终端会话最近 5 条命令历史（`s.commands.slice(-5)`，空态显示「（暂无输入）」）。

当前实现：

- 命令解析在**浏览器** `ws-client.ts` 的 `recordInput()`：解析 xterm onData 输入流，遇回车成形一条命令，按 sessionId 存浏览器 `localStorage`（key `term-commands`，结构 `{ [sessionId]: string[] }`，每会话上限 50 条）。
- `use-sessions.ts` 收到 `sessions` 消息（刷新 / 重连）时从 localStorage 回填每会话 commands。

问题根因：

1. 历史只活在浏览器本地——换浏览器、隐私窗口、清缓存即丢。
2. sessionId 是随机的 `wmt-[a-z0-9]{8}`（`tmux.ts:46`）。localStorage 按这个随机 id 做 key；server / tmux 重启后会话重建产生新 id，旧历史 orphan，看起来「丢了」。

用户诉求：历史要落到服务端可靠保留；清理时机 = 关闭该会话卡片。

## 目标

- 命令历史持久化到服务端 JSON 文件；刷新页面、换浏览器、隐私窗口、server/tmux 重建后，**只要会话还活着就不丢**。
- 关闭会话卡片（点 ×）→ 删除该会话历史。
- 服务端为单一真相源；前端不再使用 localStorage 存命令历史（不留降级缓存）。

## 非目标（YAGNI）

- 不做命令历史的搜索 / 过滤 / 导出。
- 不做跨会话命令汇总。
- 不引入数据库（JSON 文件足够）。
- 不改 `quick-commands.json`（快捷命令区）的现有落盘。
- 不改终端主画面、会话排序、resize、create 路径。

## 架构

命令解析从浏览器搬到服务端，服务端为唯一真相源：

- 新增服务端模块 `server/src/command-history.ts`，导出纯函数（parse / load / save / clear / prune / sanitize）。
- `ws-handler.ts` 的 `case 'input'`：收到 `msg.data`（用户输入流）后，除 `mgr.write(sessionId, data)` 外，额外执行解析编排（`parseChunk` 解析 → 成形则 `appendTruncated` 追加截断 → `save` 落盘 → `broadcast` 推送）。
- 解析逻辑 = 现 `ws-client.ts recordInput()` 的直接移植：累积可见字符，遇 `\r` / `\n` 成形（trim 后非空才记），处理退格（0x08 / 0x7f），整体跳过 ESC 转义序列（CSI `ESC[`、SS3 `ESC O`、OSC/DCS/PM/APC、单字母 ESC）。
- 成形新命令 → 追加到该 session 内存数组（上限 50，超出 `shift`）→ 异步落盘 → 通过新 `commands` 消息广播给所有 WS 连接。

## 组件与钩子

### `server/src/command-history.ts`（新增，纯函数）

| 函数 | 职责 |
|---|---|
| `sanitizeSessionId(raw)` | 边界校验：返回匹配 `^[A-Za-z0-9_-]+$` 的串，否则 `null`（防路径穿越，规则同 `record-store.sanitizeWindowId`） |
| `parseChunk(line, data)` | 纯解析：输入「当前半行 + 新数据」，输出「新半行 + 本次成形的命令数组」。无副作用，便于单测 |
| `appendTruncated(items, cmd, max)` | 纯追加：返回 `[...items, cmd]` 末尾，长度超 `max` 则丢最旧一条。无副作用，便于单测 |
| `filePath(dir, sessionId)` | `path.join(dir, sessionId + '.json')`，入参已 sanitize |
| `load(dir, sessionId)` | 读文件 → `string[]`；文件不存在 / JSON 非法 / sanitize 失败 → `[]` |
| `save(dir, sessionId, items)` | 异步写 `JSON.stringify(items, null, 2)`，吞错（不阻塞主路径） |
| `remove(dir, sessionId)` | `fs.unlink`，文件不存在静默（`{ force: true }` 思路或 catch ENOENT） |
| `prune(dir, liveIds)` | 列出 dir 下 `*.json`，文件名（去 `.json`）不在 `liveIds` 集合的删除 |

解析的半行状态（跨 input 调用需保持）与内存命令缓存，封装在一个**连接间共享**的上下文对象 `cmdCtx = { dir: string; sessions: Map<sessionId, { line: string; items: string[] }> }` 里，由 `server.ts` 创建、注入每次 `handleConnection`。命令历史是全局 per-session 状态（同一 session 可能被多个浏览器连接查看），因此**不能** per-connection，必须共享。

### `ws-handler.ts` 改动

- 函数签名扩展为 `handleConnection(ws, mgr, cmdCtx, broadcast)`：
  - `cmdCtx`：共享上下文（`{ dir; sessions: Map<sid, {line; items}> }`），由 server.ts 创建并传入。
  - `broadcast(msg)`：向所有 WS 连接广播（由 server.ts 基于 `wss.clients` 注入）。
- `case 'input'`：`mgr.write(sessionId, data)` 后，对 `cmdCtx.sessions` 中该 sid 的 state 执行：`const formed = parseChunk(state.line, data); state.line = formed.line; for (const cmd of formed.commands) { state.items = appendTruncated(state.items, cmd, 50); save(cmdCtx.dir, sid, state.items); broadcast({ type:'commands', sessionId: sid, items: state.items }); }`
- `case 'list'`：现有 `sessions` + 对每个存活 session 额外 `send({ type:'commands', sessionId, items: cmdCtx.sessions.get(sid)?.items ?? load(cmdCtx.dir, sid) })`（发给当前连接）。

### `pty-manager.ts` 改动（最小）

- 暴露 `restored: Promise<void>`：构造函数里 `this.restore()` 返回的 promise 赋值给公开字段，供 server.ts 在 restore 完成后执行 prune（避免 restore 未完成时误删正在 attach 的 session 历史）。
- 其余不变。

### `server.ts` 改动

- 新增 `const COMMANDS_DIR = process.env.COMMANDS_DIR || path.resolve(__dirname, '../../data/commands')`（与 `RECORD_LOG_DIR`、`QUICK_COMMANDS_FILE` 同级风格）。
- 创建共享命令上下文与广播函数：
  - `const cmdCtx = { dir: COMMANDS_DIR, sessions: new Map() }`、`broadcast(msg)` 遍历 `wss.clients`，`readyState === OPEN` 才 `send`。
  - `wss.on('connection', ws => handleConnection(ws, mgr, cmdCtx, broadcast))`。
- 注册一次全局清理：`mgr.onExit(sid => { cmdCtx.sessions.delete(sid); remove(COMMANDS_DIR, sid); })`。覆盖「点 × 关闭」与「shell 自然退出」两种会话结束（onExit 由 `pty.kill` / attach EOF 统一触发）。clear 幂等，注册一次即可，不 per-connection。
- restore 完成后清孤儿：`mgr.restored.then(() => prune(COMMANDS_DIR, new Set(mgr.list().map(s => s.sessionId))))`。

### `protocol.ts` 改动

- `ServerMessage` 新增分支：`{ type: 'commands'; sessionId: string; items: string[] }`。
- `ClientMessage`、`SessionInfo`、其余 `ServerMessage` 不变。

### 前端 `ws-client.ts`（删减）

删除：`recordInput`、`loadCommands`、`saveCommands`、`getCommands`、`inputLines`、`commandHandlers`、`onCommand`、`COMMANDS_KEY`、`MAX_HISTORY`、`CommandHandler` 类型，以及 `send()` 里对 `recordInput` 的调用。

保留：`buffers` / `MAX_BUFFER`、`send`（纯转发）、`subscribeData`、`onMessage`、`onOpen`、`connect` / reconnect、`dispose`。

### 前端 `use-sessions.ts`（改 commands 来源）

- 新增监听：`onMessage` 收到 `commands` 消息 → `setCommands(prev => ({ ...prev, [msg.sessionId]: msg.items }))`。
- `sessions` 分支：删除从 localStorage 回填 commands 的代码块（交给 `commands` 消息）。
- `exit` 分支：顺手清 `commands[sid]`（命令历史生命周期对称；session 已从列表移除，避免残留）。

### 前端 `session-list.tsx`

零改动，继续读 `s.commands.slice(-5)`。

## 文件布局

- 路径：`<COMMANDS_DIR>/<sessionId>.json`，内容 `string[]`。
- 默认 `data/commands/`。`data/` 已在 `.gitignore`，命令历史不进 git（运行时数据）。
- 文件名 = sanitize 后的 sessionId，杜绝 `../` 等路径穿越。

## 清理时机（对应「关闭窗口」）

1. **关闭会话卡片（×）/ shell 自然退出** → `mgr.onExit` → `cmdState.delete(sid)` + `remove(COMMANDS_DIR, sid)`。立即生效，仅清该 session。
2. **启动清孤儿** → `mgr.restored` 完成后 `prune(COMMANDS_DIR, liveSet)`：删除文件名对应 session 已不在存活集合的文件（tmux server 重启 → 旧 session 全没了 → 旧历史无依附 → 删，等价「会话没了历史也没」）。
   - 安全性：prune 仅删文件名匹配 `^[A-Za-z0-9_-]+\.json` 且不在 `liveSet` 的文件；存活 session 的历史保留。仅在 restore 完成后执行，避免误删正在 attach 的 session。

## 安全校验（系统边界）

- sessionId 来自外部（WS 消息）。落盘 / 删除 / 读取前一律 `sanitizeSessionId`；返回 `null` 则跳过该次持久化，但 input 转发给 PTY 不受影响。
- prune 枚举目录时也用正则白名单过滤文件名，不信任任意文件。

## 错误处理（沿用项目风格）

- 落盘 / 删除失败：catch 吞错，绝不阻塞 input / 转发主路径（同 `record-store.writeRecord`、`quick-commands`）。
- 读文件失败 / JSON 非法 / sanitize 失败：降级返回 `[]`（卡片显示「（暂无输入）」）。
- 广播时连接已关闭：`readyState` 判断跳过，不抛错。

## 测试

### `server/src/command-history.test.ts`（新增）

1. **解析正确性**（从 `ws-client.test.ts` 迁移用例）：
   - 普通命令 + 回车成形。
   - 退格（0x08 / 0x7f）删除字符。
   - CSI（`ESC[A` 方向键）整体跳过，不污染命令。
   - SS3（`ESC OA`）固定 3 字节跳过，不残留字母前缀。
   - OSC（`ESC ]10;rgb:cbcb/d5d5/e1e1 BEL`）整体跳过，回流颜色查询不残留。
   - 多命令、空行不计、trim。
2. **持久化**：`save` 后 `load` 读回一致；空 / 非法文件 `load` 返回 `[]`。
3. **appendTruncated**：`appendTruncated([...50 条], newCmd, 50)` 返回长度仍为 50 且丢掉最旧一条；边界：空数组、长度刚好等于 max、max=0。
4. **remove**：删除后文件不存在；再次 remove 不抛错。
5. **prune**：目录有 `a.json` / `b.json` / `c.json`，`prune(dir, new Set(['a','c']))` 后只剩 `a.json`、`c.json`；非 `*.json` / 非法名文件不动。
6. **sanitize**：`../etc`、`a b`、空串返回 `null`；`wmt-0mcx5sf2` 通过。

### 前端 `ws-client.test.ts`

- 删除已搬迁到服务端的 ANSI 解析用例（CSI/SS3/OSC 等）。
- 保留 buffers / reconnect 相关用例。
- `use-sessions.test.ts`：补一条「收到 `commands` 消息更新对应 session 的 commands」用例。

## 端到端验证清单

- [ ] 敲命令 → 对应卡片实时出现最近 5 条。
- [ ] 刷新页面 → 卡片历史仍在（不丢）。
- [ ] 换浏览器 / 隐私窗口打开同一服务 → 历史仍在。
- [ ] 点卡片 × 关闭 → `data/commands/<sid>.json` 删除；其他卡片历史不动。
- [ ] `windows-record restart`（tmux 未重启）→ 历史 restore 回来。
- [ ] `tmux -L wmt kill-server` 后重启服务 → 旧孤儿文件被清理，新会话从空开始。
- [ ] `npm -w server test` 全绿；`npm -w web test` 全绿。

## 影响面（爆炸半径）

- **改（server）**：新增 `command-history.ts`；`ws-handler.ts`（input / list 分支 + 签名）；`pty-manager.ts`（暴露 `restored`）；`server.ts`（COMMANDS_DIR、cmdState、broadcast、onExit 清理、prune）；`protocol.ts`（加 `commands` 消息）。
- **改（web）**：`ws-client.ts`（删减解析 + localStorage）；`use-sessions.ts`（commands 来源改 WS 消息）。
- **不影响**：录制（record-proxy / record-store）、quick-commands、终端主画面、会话排序、resize、create。
