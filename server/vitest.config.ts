import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 测试专用 raw 导出目录：pty-manager 模块加载时读取 env（pipe-pane 落盘位置），
    // 必须在配置层注入，测试文件里的赋值会晚于 import 提升
    env: {
      RAW_LOG_DIR: '/tmp/wmt-vitest-raw',
    },
    // 集成测试依赖真实 tmux（socket/fork/pipe-pane），且多实例共享 RAW_DIR 会互删
    // 对方正在写的 raw 文件（prune 孤儿竞态）——文件级串行
    fileParallelism: false,
  },
});
