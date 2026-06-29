# claude-hive

**多个 Claude Code 同时工作，API 交互按窗口录制回放。**

> 🐝 Hive = 蜂巢，每个窗口一只工蜂，录制就是采蜜。
> <img width="2555" height="1285" alt="image" src="https://github.com/user-attachments/assets/1923b650-b5fc-4054-bc06-c43d0f01b312" />

<!-- screenshot: 主界面截图占位 -->

## ✨ 特性

- 🎬 **请求录制** — 透明代理，零阻塞转发，旁路记录完整请求/响应/工具调用/token 用量
- 🪟 **Web 多终端** — 基于 tmux，浏览器管理多个 Claude Code 实例，每个窗口独立录制
- 📜 **命令历史持久化** — 自动解析终端输出提取命令，服务重启后自动还原
- 📡 **快捷广播** — 一条输入同时发往所有会话
- 🔒 **安全脱敏** — API Key / Authorization 落盘前自动替换为 `***`
- 🛡️ **进程守护** — nohup + 进程组管理，关闭终端不退出，看门狗自动抓取死亡现场

## 🚀 快速开始

### 前置条件
- macOS / Linux
- [tmux](https://github.com/tmux/tmux)
- Node.js >= 18
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)

### 安装
```bash
git clone https://github.com/wanghengau/claude-hive.git
cd claude-hive
npm install

# 安装守护命令（可选）
ln -s "$(pwd)/bin/windows-record" ~/.local/bin/
```

### 启动
```bash
npm run dev          # 开发模式：server(:4000) + web(:4001)

# 或后台常驻（需先 symlink bin/windows-record 到 PATH）
windows-record start
windows-record status
windows-record logs -f
windows-record stop
```

### 开始录制
在某个 windows 终端窗口内：
```bash
source claude-record.sh
claude-record -p "你的问题"   # 该窗口会出现 ●录(N) 徽标
```

> 普通 `claude`（不改 BASE_URL）→ 直连上游，不经代理，无录制。

## 📼 查看录制

在 Web UI 中点击窗口名旁的录制徽标，进入录制查看器：
- 按时间线浏览每次 API 交互
- 查看完整请求/响应文本、工具调用详情
- 统计 input/output token 用量

<!-- screenshot: 录制查看器截图占位 -->

## ⚙️ 环境变量

| 变量 | 默认值 | 说明 |
|:--|:--|:--|
| `PORT` | `4000` | 服务端口（= 代理端口） |
| `WEB_PORT` | `4001` | Web UI 端口（开发模式） |
| `RECORD_TARGET` | `https://open.bigmodel.cn/api/anthropic` | 上游 API 地址 |
| `RECORD_LOG_DIR` | `./data` | 录制落盘目录（按 `<windowId>/<date>/` 分组） |
| `RECORD_INJECT_WEBSEARCH` | `1` | 注入 GLM web_search；`0` 关闭 |
| `WMT_SOCKET` | `wmt` | tmux socket 名称 |
| `WMT_PORT` | `4000` | claude-record 指向的代理端口 |

## 🧪 开发 & 测试

```bash
npm run dev          # 同时启动 server + web（热重载）
npm -w server test   # 服务端单元测试
npm -w web test      # 前端测试
npm test             # 全部测试
```

## 📄 License

[MIT](LICENSE)

---

> 💤 作者很懒，有 bug 自行启动 Claude Code 调试。
