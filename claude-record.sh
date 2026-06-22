#!/bin/bash
# claude-record: 在 windows 窗口内启动 Claude Code 并把请求发往 windows-record 录制代理。
# 来源窗口识别：tmux -L <socket> display 取当前 session 名；非 windows 终端 → default。
# 用法: source claude-record.sh && claude-record -p "你好"
claude-record() {
  local socket="${WMT_SOCKET:-wmt}"
  local port="${WMT_PORT:-4000}"
  local wid="${WMT_WINDOW_ID:-$(tmux -L "$socket" display-message -p '#S' 2>/dev/null)}"
  wid="${wid:-default}"
  ANTHROPIC_BASE_URL="http://localhost:${port}" \
  ANTHROPIC_CUSTOM_HEADERS="X-Window-Id: ${wid}" \
  claude "$@"
}
