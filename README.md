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
