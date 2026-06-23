#!/bin/bash
# claude-record: 在 windows 窗口内启动 Claude Code 并把请求发往 windows-record 录制代理。
# 来源窗口识别：tmux -L <socket> display 取当前 session 名；非 windows 终端 → default。
# 用法: source claude-record.sh && claude-record -p "你好"
claude-record() {
  local socket="${WMT_SOCKET:-wmt}"
  local wid="${WMT_WINDOW_ID:-$(tmux -L "$socket" display-message -p '#S' 2>/dev/null)}"
  wid="${wid:-default}"
  # 注意: ANTHROPIC_BASE_URL 环境变量会被 ~/.claude/settings.json 的 env 覆盖(无效),
  # 故用 --settings record-settings.json 设 BASE_URL→代理(优先级高于 settings.json env);
  # ANTHROPIC_CUSTOM_HEADERS 不在 settings.json env 里, 环境变量有效, 用于注入动态 X-Window-Id。
  ANTHROPIC_CUSTOM_HEADERS="X-Window-Id: ${wid}" \
    claude --settings "/Users/Shared/workspace/windows-record/record-settings.json" "$@"
}
