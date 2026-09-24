import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { PtyManager } from './pty-manager.js';
import * as tmux from './tmux.js';


// 查询 tmux pane 的滚动位置（copy-mode 下非空）
function scrollPos(socket: string, id: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('tmux', ['-L', socket, '-f', '/dev/null', 'display-message', '-p', '-t', id, '#{scroll_position}'],
      (e, stdout) => resolve((stdout ?? '').trim()));
  });
}

// 查询 tmux pane 的历史行数。注意不能用 attach 流包含 "500" 判断命令执行完：
// 输入回显里就含 "500"（zsh 未就绪时 tty ECHO 先回显、ZLE 起 raw 模式后丢弃输入队列），
// 而 tmux 的 history_size 才是"命令真执行了、输出滚入历史"的权威信号。
function historySize(socket: string, id: string): Promise<number> {
  return new Promise((resolve) => {
    execFile('tmux', ['-L', socket, '-f', '/dev/null', 'display-message', '-p', '-t', id, '#{history_size}'],
      (e, stdout) => resolve(Number((stdout ?? '').trim()) || 0));
  });
}

// pane 是否处于 alternate screen
function altFlag(socket: string, id: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('tmux', ['-L', socket, '-f', '/dev/null', 'display-message', '-p', '-t', id, '#{alternate_on}'],
      (e, stdout) => resolve((stdout ?? '').trim() === '1'));
  });
}

// pane 是否处于 copy-mode 等 mode
function modeFlag(socket: string, id: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('tmux', ['-L', socket, '-f', '/dev/null', 'display-message', '-p', '-t', id, '#{pane_in_mode}'],
      (e, stdout) => resolve((stdout ?? '').trim()));
  });
}

// pane 当前屏首行文本
function paneFirstLine(socket: string, id: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('tmux', ['-L', socket, '-f', '/dev/null', 'capture-pane', '-t', id, '-p'],
      (e, stdout) => resolve(((stdout ?? '').split('\n')[0] || '').trim()));
  });
}

// 往会话敲一条命令（须在 waitShellReady 之后）
function execWrite(mgr: PtyManager, id: string, cmd: string): void {
  mgr.write(id, cmd + '\n');
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor timeout');
}

// 每个测试独立 socket，结束 kill-server 清理，避免会话泄漏
const sockets: string[] = [];
function newManager(): { mgr: PtyManager; socket: string } {
  const socket = 'wmt-test-' + Math.random().toString(36).slice(2, 8);
  sockets.push(socket);
  return { mgr: new PtyManager({ socketName: socket }), socket };
}
afterEach(() => {
  for (const s of sockets.splice(0)) tmux.killServerSync({ socketName: s });
});

describe('PtyManager (tmux 后端)', () => {
  it('create 返回 wmt- 名且 list 可见', () => {
    const { mgr } = newManager();
    const id = mgr.create({ cols: 80, rows: 24 });
    expect(id).toMatch(/^wmt-/);
    expect(mgr.list().some((s) => s.sessionId === id)).toBe(true);
  });

  it('write 后 onData 收到输出并写入 ring buffer', async () => {
    const { mgr } = newManager();
    const id = mgr.create({ cols: 80, rows: 24 });
    let out = '';
    mgr.onData((sid, data) => { if (sid === id) out += data; });
    mgr.write(id, 'echo MARKER_42\n');
    await waitFor(() => out.includes('MARKER_42'));
    expect(out).toContain('MARKER_42');
    expect(mgr.getRawTail(id)).toContain('MARKER_42');
  });
});

describe('PtyManager cwd', () => {
  it('getCwd 返回会话 cwd', async () => {
    const { mgr } = newManager();
    const id = mgr.create({ cols: 80, rows: 24, cwd: '/tmp' });
    // macOS 上 /tmp 是 /private/tmp 符号链接，display-message 返回真实路径
    await waitFor(() => /\/tmp$/.test(mgr.getCwd(id)));
    expect(mgr.getCwd(id)).toMatch(/\/tmp$/);
  });

  it('cd 后 onCwd 触发且 getCwd 更新', async () => {
    const { mgr } = newManager();
    const id = mgr.create({ cols: 80, rows: 24, cwd: '/tmp' });
    await waitFor(() => /\/tmp$/.test(mgr.getCwd(id)));
    let seen = '';
    mgr.onCwd((sid, cwd) => { if (sid === id) seen = cwd; });
    mgr.write(id, 'cd /\n');
    await waitFor(() => seen === '/', 8000);
    expect(mgr.getCwd(id)).toBe('/');
  });
});

describe('PtyManager resize/close/exit', () => {
  it('resize 不报错且会话仍可用', async () => {
    const { mgr } = newManager();
    const id = mgr.create({ cols: 80, rows: 24 });
    expect(() => mgr.resize(id, 120, 40)).not.toThrow();
    let out = '';
    mgr.onData((sid, data) => { if (sid === id) out += data; });
    mgr.write(id, 'echo AFTER_RESIZE\n');
    await waitFor(() => out.includes('AFTER_RESIZE'));
  });

  it('shell 自然退出后 onExit 触发且会话从 list 移除', async () => {
    const { mgr } = newManager();
    const id = mgr.create({ cols: 80, rows: 24 });
    let exited = false;
    mgr.onExit((sid) => { if (sid === id) exited = true; });
    mgr.write(id, 'exit\n');
    await waitFor(() => exited);
    expect(mgr.list().some((s) => s.sessionId === id)).toBe(false);
  });

  it('close 销毁 tmux 会话（重启也不恢复）且从 list 移除', async () => {
    const { mgr, socket } = newManager();
    const id = mgr.create({ cols: 80, rows: 24 });
    let exited = false;
    mgr.onExit((sid) => { if (sid === id) exited = true; });
    mgr.close(id);
    await waitFor(() => exited);
    expect(mgr.list().some((s) => s.sessionId === id)).toBe(false);
    // 关键：tmux 会话真的被销毁，listNames 不再有
    const names = await tmux.listNames({ socketName: socket });
    expect(names).not.toContain(id);
  });
});


describe('PtyManager 启动恢复', () => {
  it('新实例同 socket 恢复已存在的会话（含输出交互与 cwd）', async () => {
    const socket = 'wmt-test-' + Math.random().toString(36).slice(2, 8);
    sockets.push(socket);

    // 第一个实例：建会话并产出输出，然后 dispose（模拟 server 退出，会话保留）
    const mgr1 = new PtyManager({ socketName: socket });
    const id = mgr1.create({ cols: 80, rows: 24, cwd: '/tmp' });
    mgr1.write(id, 'echo RESTOREMARK\n');
    await new Promise((r) => setTimeout(r, 400));
    mgr1.dispose();

    // 新实例同 socket：应通过 tmux ls 恢复该会话
    const mgr2 = new PtyManager({ socketName: socket });
    await waitFor(() => mgr2.list().some((s) => s.sessionId === id), 8000);
    expect(mgr2.list().some((s) => s.sessionId === id)).toBe(true);
    // 重新 attach 后 raw 文件应含历史输出（pipe-pane append 续写同一文件）
    expect(mgr2.getRawTail(id)).toContain('RESTOREMARK');
    // macOS /tmp → /private/tmp，用结尾匹配
    await waitFor(() => /\/tmp$/.test(mgr2.getCwd(id)));
    mgr2.dispose();
  });
});
