import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runAsync = promisify(execFile);

export interface TmuxOpts {
  socketName: string;
}

const PREFIX = 'wmt-';
const BIN = 'tmux';

// 所有命令经独立 socket，并忽略用户 ~/.tmux.conf（-f /dev/null），保证行为可预测
function baseArgs(opts: TmuxOpts): string[] {
  return ['-L', opts.socketName, '-f', '/dev/null'];
}

// 同步执行 tmux；ignoreError=true 时失败返回空串（用于幂等/探测命令）
function runSync(args: string[], ignoreError = false): string {
  try {
    return execFileSync(BIN, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
  } catch (e) {
    if (ignoreError) return '';
    throw e;
  }
}

// 检测 tmux 是否安装（tmux -V 不启动 server）
export function hasTmux(): boolean {
  try {
    const v = execFileSync(BIN, ['-V'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    return /^tmux\s+\d/i.test(v.trim());
  } catch {
    return false;
  }
}

export function genSessionName(): string {
  return PREFIX + Math.random().toString(36).slice(2, 10);
}

// 后台创建 detached 会话；附带 set -g status off 使 web 终端画面无状态栏。
// 会话名已存在时 tmux 报错，由调用方捕获重试。
export function newSessionSync(opts: TmuxOpts, name: string, cols: number, rows: number, cwd: string): void {
  runSync([
    ...baseArgs(opts),
    // history-limit 必须在 new-session 之前设置：tmux 在 pane 创建时按此值分配历史缓冲，
    // 事后改无效。默认仅 2000 行——server 重启重新 attach 时只能重绘这点历史，
    // ring buffer 又被清空重建，导致刷新浏览器后滚不动多少。提到 50000 与 scrollback 对齐。
    'set', '-g', 'history-limit', '50000',
    ';', 'new-session', '-d', '-s', name,
    '-x', String(cols), '-y', String(rows),
    '-c', cwd,
    ';', 'set', '-g', 'status', 'off',
  ]);
}

// 列出本工具管理的会话（仅 wmt-* 前缀）
export async function listNames(opts: TmuxOpts): Promise<string[]> {
  try {
    const { stdout } = await runAsync(BIN, [...baseArgs(opts), 'ls', '-F', '#{session_name}'], {
      encoding: 'utf-8',
      timeout: 2000,
    });
    return stdout.split('\n').map((s) => s.trim()).filter((s) => s.startsWith(PREFIX));
  } catch {
    return []; // no server running / no sessions
  }
}

// 销毁整个 tmux server（测试清理用）
export function killServerSync(opts: TmuxOpts): void {
  runSync(['-L', opts.socketName, 'kill-server'], true);
}

// 销毁单个会话；幂等（不存在即忽略）
export function killSessionSync(opts: TmuxOpts, name: string): void {
  runSync([...baseArgs(opts), 'kill-session', '-t', name], true);
}

// 同步调整会话尺寸（resize 接口为同步）
export function resizeSync(opts: TmuxOpts, name: string, cols: number, rows: number): void {
  runSync([...baseArgs(opts), 'resize-window', '-t', name, '-x', String(cols), '-y', String(rows)], true);
}

// 异步取会话当前 cwd（替代 lsof，lsof 在 tmux attach 进程上失效）
export async function getCwd(opts: TmuxOpts, name: string): Promise<string> {
  try {
    const { stdout } = await runAsync(
      BIN,
      [...baseArgs(opts), 'display-message', '-p', '-t', name, '#{pane_current_path}'],
      { encoding: 'utf-8', timeout: 2000 },
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

// 抓取 pane 的 scrollback 历史（-S - 从历史起始到当前；-e 保留颜色等转义）。
// attach 进程只重绘当前 viewport，不含历史；server 重启后重新 attach 必须主动 capture 取回，
// 否则 ring 只有一屏、刷新浏览器后看不到旧输出。
// capture-pane 行尾是裸 \n（LF），xterm 重放需 \r\n：\n 只下移行不回行首，会逐行右移成阶梯串行。
export function capturePaneSync(opts: TmuxOpts, name: string): string {
  return runSync([...baseArgs(opts), 'capture-pane', '-t', name, '-p', '-e', '-S', '-'], true).replace(/\n/g, '\r\n');
}

// node-pty spawn 时用的 attach 参数
export function attachArgs(opts: TmuxOpts, name: string): string[] {
  return [...baseArgs(opts), 'attach', '-t', name];
}

// pane 是否处于 alternate screen（vim/less 等全屏程序）
export async function isAltScreen(opts: TmuxOpts, name: string): Promise<boolean> {
  try {
    const { stdout } = await runAsync(
      BIN,
      [...baseArgs(opts), 'display-message', '-p', '-t', name, '#{alternate_on}'],
      { encoding: 'utf-8', timeout: 2000 },
    );
    return stdout.trim() === '1';
  } catch {
    return false;
  }
}

// 滚轮回看：tmux 才是历史的权威持有者（attach 只发全屏重绘、不透传输出流，xterm 的
// scrollback 恒为一屏）。lines 正=向下、负=向上。
// normal pane 进 copy-mode 滚历史（-e 滚到底自动退出回实时，且命令幂等、重复进入不重置位置）。
// alt screen 程序（vim/less/claude TUI）不注入任何按键——方向键会被程序当自己的输入
// （claude 是翻输入框历史），改为返回 true 让调用方通知前端滚 xterm 本地 scrollback
// （claude 等 TUI 的旧画面会随 tmux 滚行 diff 积累在本地 scrollback，可回看）。
// 返回值 = 是否 alt screen。pane 退出等竞态下命令失败可接受。
export async function scrollAsync(opts: TmuxOpts, name: string, lines: number): Promise<boolean> {
  const n = Math.min(Math.abs(lines), 100); // 单次滚动行数上限，防御异常值
  if (n === 0) return false;
  try {
    if (await isAltScreen(opts, name)) return true;
    if (lines < 0) {
      await runAsync(BIN, [...baseArgs(opts), 'copy-mode', '-e', '-t', name], {
        encoding: 'utf-8', timeout: 2000,
      });
    }
    // 非 copy-mode 时 scroll-down 报 "not in a mode"，即已在实时底部，静默忽略
    await runAsync(
      BIN,
      [...baseArgs(opts), 'send-keys', '-t', name, '-X', '-N', String(n), lines < 0 ? 'scroll-up' : 'scroll-down'],
      { encoding: 'utf-8', timeout: 2000 },
    );
    return false;
  } catch {
    // 尽力而为：会话销毁/模式竞态下失败不影响正确性
    return false;
  }
}
