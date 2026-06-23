# windows-record

windows（web 多终端）× claude-record-proxy（请求录制）合并版。以 windows 为主：录制内嵌进 server，模型请求按 windows 窗口（tmux session）分组。

## 启动
```bash
npm install
npm run dev          # 起 server(:4000) + web(vite)
```

## 常驻服务 (windows-record 命令)

装好后可在**任意目录**后台常驻运行，关闭终端不退出（nohup + 进程组管理）：

```bash
windows-record          # 启动 server(:4000) + web(:4001)，后台运行
windows-record status   # 查看运行状态
windows-record logs -f  # 实时跟随日志
windows-record stop     # 停止所有服务
windows-record restart  # 重启
```

- 安装：symlink 到 `~/.local/bin/windows-record`（该目录已在 PATH，无需 sudo）。
- 运行时文件：项目内 `.run/windows-record.{pid,log}`（已 gitignore）。
- 机制：子 shell + `set -m` 使 npm 自成进程组，`nohup` 让进程树忽略 SIGHUP，stop 时 `kill -- -PID` 清掉整棵树，端口兜底防残留。

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
| `PORT` | 4000 | windows server 端口（= 代理端口） |
| `RECORD_TARGET` | `https://open.bigmodel.cn/api/anthropic` | 上游 |
| `RECORD_LOG_DIR` | `./data` | 录制落盘根目录（按 `<windowId>/<date>/` 分组） |
| `RECORD_INJECT_WEBSEARCH` | `1` | 注入 GLM web_search；`0` 关闭 |
| `WMT_SOCKET` | `wmt` | claude-record 取窗口名用的 tmux socket |
| `WMT_PORT` | `4000` | claude-record 指向的代理端口 |

## 测试
```bash
npm -w server test
```
