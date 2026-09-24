// tmux pipe-pane 原始流导出：把 pane 的原始输出（应用程序写入 pty 的字节，未经
// tmux attach 的全屏 diff 化）落到磁盘文件。历史回看直接渲染这份流——与真终端
// 收到的字节一致，xterm 自身仿真即 100% 忠实还原（行序/列位/颜色），无需清洗。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// 单次回看读取上限（尾部）；磁盘文件由 close 时清理，长会话靠读侧限制兜底
export const RAW_MAX_READ = 2 * 1024 * 1024;

// 会话 id 由 server 生成，但边界处仍校验（防路径穿越，与 record-store 同策略）
export function rawLogPath(dir: string, sessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error(`bad session id: ${sessionId}`);
  return path.join(dir, `${sessionId}.raw`);
}

/** 开启 pane 输出导出（重复调用替换旧 pipe 并以 append 续写同一文件，跨 server 重启不丢历史）。
 * 不用 -o 标志：tmux 3.6a 实测 -o（仅当无 pipe 时开启）在该场景下不产出文件。 */
export function startPipePane(socketName: string, sessionId: string, dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = rawLogPath(dir, sessionId); // 路径由校验过的 id 拼出，无空格/元字符
  execFileSync('tmux', [
    '-L', socketName, '-f', '/dev/null',
    'pipe-pane', '-t', sessionId, `cat >> ${file}`,
  ], { stdio: 'ignore', timeout: 2000 });
}

/** 关闭导出（不带命令的 pipe-pane 即解除） */
export function stopPipePane(socketName: string, sessionId: string): void {
  try {
    execFileSync('tmux', [
      '-L', socketName, '-f', '/dev/null', 'pipe-pane', '-t', sessionId,
    ], { stdio: 'ignore', timeout: 2000 });
  } catch { /* pane 已不存在等竞态可接受 */ }
}

/** 删除原始流文件（会话销毁时） */
export function removeRawLog(dir: string, sessionId: string): void {
  try { fs.unlinkSync(rawLogPath(dir, sessionId)); } catch { /* 不存在即无需删 */ }
}

/**
 * 读取原始流尾部（供 xterm 回放）。
 * 前插 ESC c（RIS 全重置）保证从截断点解析时状态干净；
 * 发生截断时起点向后推到最近的换行（避免截在多字节 UTF-8 字符/行中间），
 * 全量读取（文件本身 ≤ 上限）不推。
 */
export function readRawTail(dir: string, sessionId: string, maxBytes = RAW_MAX_READ): string {
  const file = rawLogPath(dir, sessionId);
  let size: number;
  try { size = fs.statSync(file).size; } catch { return ''; }
  if (size === 0) return '';
  const want = Math.min(size, maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(want + (size > want ? 4096 : 0)); // 截断时多读一窗找换行
    const readLen = buf.length;
    fs.readSync(fd, buf, 0, readLen, size - readLen);
    let start = 0;
    if (size > readLen) {
      const nl = buf.indexOf(0x0a);
      if (nl >= 0) start = nl + 1;
    }
    return '\x1bc' + buf.subarray(start).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}
