import { describe, it, expect, afterAll } from 'vitest';
import {
  hasTmux, genSessionName, newSessionSync, listNames, killServerSync,
  killSessionSync, getCwd, attachArgs,
  type TmuxOpts,
} from './tmux.js';

const opts: TmuxOpts = { socketName: 'wmt-test-' + Math.random().toString(36).slice(2, 8) };
afterAll(() => killServerSync(opts));

describe('tmux 检测与命名', () => {
  it('hasTmux 在已安装环境返回 true', () => {
    expect(hasTmux()).toBe(true);
  });
  it('genSessionName 带 wmt- 前缀且唯一', () => {
    const a = genSessionName();
    const b = genSessionName();
    expect(a).toMatch(/^wmt-/);
    expect(a).not.toBe(b);
  });
});

describe('tmux 会话生命周期', () => {
  it('newSessionSync 后 listNames 能列出该会话', async () => {
    newSessionSync(opts, 'wmt-life', 80, 24, '/tmp');
    const names = await listNames(opts);
    expect(names).toContain('wmt-life');
  });
});

describe('tmux kill/cwd/attach', () => {
  it('killSessionSync 后会话从 listNames 消失（幂等，不存在的会话不报错）', async () => {
    newSessionSync(opts, 'wmt-kill', 80, 24, '/tmp');
    killSessionSync(opts, 'wmt-kill');
    killSessionSync(opts, 'wmt-never-exist'); // 幂等不抛
    const names = await listNames(opts);
    expect(names).not.toContain('wmt-kill');
  });

  it('getCwd 返回会话创建时的 cwd', async () => {
    newSessionSync(opts, 'wmt-cwd', 80, 24, '/tmp');
    const cwd = await getCwd(opts, 'wmt-cwd');
    expect(cwd).toMatch(/\/tmp$/); // macOS 返回 /private/tmp
    killSessionSync(opts, 'wmt-cwd');
  });

  it('attachArgs 含 socket 名、attach、目标会话名', () => {
    const a = attachArgs(opts, 'wmt-x');
    expect(a).toContain('-L');
    expect(a).toContain(opts.socketName);
    expect(a).toContain('attach');
    expect(a).toContain('wmt-x');
  });
});
