import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock child_process.execFile:结果按队列顺序出队;记录调用序列供断言。
// 必须 callback 风格:util.promisify 只认 callback,忽略 mock 返回的 Promise
// (返回 Promise 会被丢弃 → promisify 自建 Promise 永远 pending → 超时)
const calls: { cmd: string; args: string[] }[] = [];
const results: { stdout?: string; reject?: Error }[] = [];
vi.mock('node:child_process', () => ({ execFile: (...a: unknown[]) => {
  const cb = a[a.length - 1] as (err: Error | null, res: { stdout: string; stderr: string }) => void;
  calls.push({ cmd: a[0] as string, args: a[1] as string[] });
  const r = results.shift() ?? { stdout: '' };
  if (r.reject) cb(r.reject, { stdout: '', stderr: '' });
  else cb(null, { stdout: r.stdout ?? '', stderr: '' });
} }));

import { swipeUpOnMirror, MIRROR_PROCESS } from './mirror-control.js';

describe('swipeUpOnMirror', () => {
  beforeEach(() => { calls.length = 0; results.length = 0; });

  it('成功:定位+提前 → 注入 → 恢复焦点,坐标按窗口几何换算', async () => {
    results.push({ stdout: 'Safari|1136,640,671,348\n' }, { stdout: 'OK' }, { stdout: '' });
    const r = await swipeUpOnMirror();
    expect(r).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    // ① AppleScript:定位+提前,脚本含进程名
    expect(calls[0].cmd).toBe('osascript');
    expect(calls[0].args[1]).toContain(MIRROR_PROCESS);
    // ② JXA 注入:x=1136+671/2=1471.5, y0=640+348*5/6=930, y1=640+348/3=756
    expect(calls[1].args).toEqual(
      ['-l', 'JavaScript', '-e', expect.stringContaining('CGEventPost'), '1471.5', '930', '756'],
    );
    // ③ 恢复原焦点进程
    expect(calls[2].args[1]).toContain('Safari');
  });

  it('进程不存在(镜像未开/未连接)→ window-not-found,不做注入不抢焦点', async () => {
    results.push({ reject: new Error("System Events got an error: Can't get process") });
    const r = await swipeUpOnMirror();
    expect(r).toMatchObject({ ok: false, reason: 'window-not-found' });
    expect(calls).toHaveLength(1);
  });

  it('主窗口过小(仅悬浮小条)→ window-not-found', async () => {
    results.push({ stdout: 'ERR|window-not-found' });
    expect(await swipeUpOnMirror()).toEqual({ ok: false, reason: 'window-not-found' });
    expect(calls).toHaveLength(1);
  });

  it('注入阶段失败 → inject-failed,但焦点仍被恢复(对称性)', async () => {
    results.push(
      { stdout: 'Safari|1136,640,671,348' },
      { reject: new Error('osascript failed') },
      { stdout: '' },
    );
    const r = await swipeUpOnMirror();
    expect(r).toMatchObject({ ok: false, reason: 'inject-failed' });
    expect(calls).toHaveLength(3);
    expect(calls[2].args[1]).toContain('Safari');
  });

  it('prep 输出格式异常 → inject-failed', async () => {
    results.push({ stdout: 'garbage' });
    const r = await swipeUpOnMirror();
    expect(r).toMatchObject({ ok: false, reason: 'inject-failed' });
  });
});
