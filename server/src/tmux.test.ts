import { execFileSync } from 'node:child_process';
import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import {
  hasTmux, genSessionName, newSessionSync, listNames, killServerSync,
  killSessionSync, getCwd, attachArgs, isAltScreen, scrollAsync,
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

  it('newSessionSync 把 history-limit 提到 50000（默认仅 2000，刷新/重连后可恢复的历史受此限制）', () => {
    newSessionSync(opts, 'wmt-hist', 80, 24, '/tmp');
    const out = execFileSync('tmux', ['-L', opts.socketName, '-f', '/dev/null', 'show-options', '-g', 'history-limit'], {
      encoding: 'utf-8', timeout: 2000,
    });
    expect(out.trim()).toBe('history-limit 50000');
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

describe('tmux scroll（滚轮桥接 copy-mode）', () => {
  const name = 'wmt-scroll';
  const pane = (fmt: string) =>
    execFileSync('tmux', [...base(), 'display-message', '-p', '-t', name, fmt], {
      encoding: 'utf-8', timeout: 2000,
    }).trim();
  const base = () => ['-L', opts.socketName, '-f', '/dev/null'];
  const scrollPos = () => pane('#{scroll_position}');
  const inMode = () => pane('#{pane_in_mode}') === '1';

  // 每个用例独立会话：500 行输出保证 tmux history 有回看内容
  beforeEach(() => {
    newSessionSync(opts, name, 80, 25, '/tmp');
    execFileSync('tmux', [...base(), 'send-keys', '-t', name, 'seq 1 500', 'Enter'], { timeout: 2000 });
    // 等 seq 输出完（最后一行 500 已渲染）再断言滚动位置
    execFileSync('bash', ['-c',
      `for i in $(seq 1 50); do tmux ${base().join(' ')} capture-pane -t ${name} -p | grep -qx 500 && break; sleep 0.1; done`,
    ], { timeout: 10000 });
  });
  afterEach(() => {
    killSessionSync(opts, name);
    execFileSync('bash', ['-c', 'rm -f /tmp/wmt-wheel-test.txt'], { timeout: 2000 });
  });

  it('isAltScreen：shell（主 buffer）返回 false', async () => {
    expect(await isAltScreen(opts, name)).toBe(false);
  });

  it('isAltScreen：less（alt screen）返回 true', async () => {
    execFileSync('bash', ['-c', 'seq 1 500 > /tmp/wmt-wheel-test.txt'], { timeout: 2000 });
    execFileSync('tmux', [...base(), 'send-keys', '-t', name, 'less /tmp/wmt-wheel-test.txt', 'Enter'], { timeout: 2000 });
    execFileSync('bash', ['-c', 'sleep 0.5'], { timeout: 5000 });
    expect(await isAltScreen(opts, name)).toBe(true);
    execFileSync('tmux', [...base(), 'send-keys', '-t', name, 'q'], { timeout: 2000 });
  });

  it('scrollAsync(-N) 向上：进 copy-mode 且滚动位置为 N，返回 false（非 alt）', async () => {
    await expect(scrollAsync(opts, name, -3)).resolves.toBe(false);
    expect(scrollPos()).toBe('3');
    expect(inMode()).toBe(true);
  });

  it('连续向上滚动位置累积（可加性，异步下不乱序丢失）', async () => {
    await Promise.all([scrollAsync(opts, name, -3), scrollAsync(opts, name, -4)]);
    expect(scrollPos()).toBe('7');
  });

  it('scrollAsync(+N) 向下：滚到底自动退出 copy-mode（-e），回到实时', async () => {
    await scrollAsync(opts, name, -10);
    await scrollAsync(opts, name, 10);
    expect(scrollPos()).toBe('');
    expect(inMode()).toBe(false);
  });

  it('非 copy-mode 时向下滚动：静默忽略不抛错', async () => {
    await expect(scrollAsync(opts, name, 5)).resolves.toBe(false);
    expect(inMode()).toBe(false);
  });

  it('alt screen（less）：返回 true 且不注入按键、不进 copy-mode（滚动归前端本地 scrollback）', async () => {
    execFileSync('bash', ['-c', 'seq 1 500 > /tmp/wmt-wheel-test.txt'], { timeout: 2000 });
    execFileSync('tmux', [...base(), 'send-keys', '-t', name, 'less /tmp/wmt-wheel-test.txt', 'Enter'], { timeout: 2000 });
    execFileSync('bash', ['-c', 'sleep 0.5'], { timeout: 5000 });

    // 向上/向下都只返回 alt 标记：不进 copy-mode、不 send-keys（claude 等程序会把
    // 方向键当输入框历史导航，滚轮翻它属副作用），屏首保持 "1" 未被翻动
    await expect(scrollAsync(opts, name, -2)).resolves.toBe(true);
    await expect(scrollAsync(opts, name, 5)).resolves.toBe(true);
    execFileSync('bash', ['-c', 'sleep 0.3'], { timeout: 5000 });
    expect(inMode()).toBe(false);
    const firstLine = execFileSync('tmux', [...base(), 'capture-pane', '-t', name, '-p'], {
      encoding: 'utf-8', timeout: 2000,
    }).split('\n')[0].trim();
    expect(firstLine).toBe('1');

    execFileSync('tmux', [...base(), 'send-keys', '-t', name, 'q'], { timeout: 2000 });
  });
});
