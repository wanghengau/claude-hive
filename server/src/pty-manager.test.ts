import { describe, it, expect, afterEach } from 'vitest';
import { PtyManager } from './pty-manager.js';
import * as tmux from './tmux.js';

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
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
    expect(mgr.getRingBuffer(id)).toContain('MARKER_42');
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
    // macOS /tmp → /private/tmp，用结尾匹配
    await waitFor(() => /\/tmp$/.test(mgr2.getCwd(id)));
    mgr2.dispose();
  });
});
