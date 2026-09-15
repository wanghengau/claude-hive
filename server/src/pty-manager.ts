import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type IPty } from 'node-pty';
import * as tmux from './tmux.js';
import { startPipePane, stopPipePane, removeRawLog, readRawTail, rawLogPath } from './raw-log.js';
import type { CwdHandler, DataHandler, ExitHandler, IPtyManager, SessionInfo } from './protocol.js';

const CWD_POLL_MS = 3000;
// pane 原始流（pipe-pane 导出）目录：历史回看的数据源，与真终端收到的字节一致
const RAW_DIR = process.env.RAW_LOG_DIR
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.run/raw');

interface Session {
  id: string;
  pty: IPty;
  createdAt: number;
  exited: boolean;
  exitCode?: number;
}

export class PtyManager implements IPtyManager {
  private sessions = new Map<string, Session>();
  // 每会话一个 raw 文件增量轮询定时器（数据源推送给前端）
  private rawWatchers = new Map<string, ReturnType<typeof setInterval>>();
  private dataHandlers = new Set<DataHandler>();
  private exitHandlers = new Set<ExitHandler>();
  private cwdHandlers = new Set<CwdHandler>();
  private cwdCache = new Map<string, string>();
  private cwdTimer: ReturnType<typeof setInterval> | null = null;
  restored: Promise<void> = Promise.resolve();
  protected readonly opts: tmux.TmuxOpts;

  constructor(opts: { socketName?: string } = {}) {
    this.opts = { socketName: opts.socketName ?? 'wmt' };
    this.cwdTimer = setInterval(() => this.pollCwds(), CWD_POLL_MS);
    this.cwdTimer.unref?.();
    // 启动恢复：attach 所有已存在的 wmt-* 会话（server 重启场景）
    this.restored = this.restore();
  }

  private refreshCwd(name: string): void {
    tmux.getCwd(this.opts, name)
      .then((cwd) => {
        if (cwd && this.sessions.has(name)) {
          this.cwdCache.set(name, cwd);
          this.cwdHandlers.forEach((h) => h(name, this.displayCwd(cwd)));
        }
      })
      .catch(() => {});
  }

  private pollCwds(): void {
    for (const [id, session] of this.sessions) {
      if (session.exited) continue;
      tmux.getCwd(this.opts, id)
        .then((cwd) => {
          if (!cwd) return;
          const prev = this.cwdCache.get(id);
          if (prev !== cwd) {
            this.cwdCache.set(id, cwd);
            this.cwdHandlers.forEach((h) => h(id, this.displayCwd(cwd)));
          }
        })
        .catch(() => {});
    }
  }

  private displayCwd(cwd: string): string {
    if (!cwd) return '';
    const home = os.homedir();
    if (cwd === home) return '~';
    if (home && cwd.startsWith(home + '/')) return '~' + cwd.slice(home.length);
    return cwd;
  }

  // spawn attach 进程并接入 ring buffer + handlers（create 与 restore 共用）
  protected spawnAttach(name: string, cols = 80, rows = 24): Session {
    const pty = spawn('tmux', tmux.attachArgs(this.opts, name), { cols, rows });
    const session: Session = { id: name, pty, createdAt: Date.now(), exited: false };
    // 开启 pane 原始流导出（重复调用替换旧 pipe 且 append 续写同一文件）。
    // 前端数据源 = 原始流（应用写给 pty 的字节，与真终端收到的一致）：claude 等
    // TUI 的流式输出在 xterm 主 buffer 固化进 scrollback（剥 1049 由前端 ws-client
    // 做），滚轮回看 = 原生滚动。attach 流（全屏 diff）只用于维持 attach 进程，不推前端。
    startPipePane(this.opts.socketName, name, RAW_DIR);
    // 轮询 raw 文件增量推送前端（100ms；macOS fs.watch 的 fsevents 怪癖多，轮询更稳）
    this.watchRaw(name);
    pty.onExit(({ exitCode }) => {
      session.exited = true;
      session.exitCode = exitCode;
      this.exitHandlers.forEach((h) => h(name, exitCode));
      this.unwatchRaw(name);
      this.sessions.delete(name);
    });
    this.sessions.set(name, session);
    this.refreshCwd(name);
    return session;
  }

  /** 轮询会话 raw 文件增量，经 dataHandlers 推送前端（数据源=pipe-pane 原始流） */
  private watchRaw(name: string): void {
    const file = rawLogPath(RAW_DIR, name);
    let offset = 0;
    try { offset = fs.statSync(file).size; } catch { /* 文件未创建，从 0 开始 */ }
    const timer = setInterval(() => {
      let size = 0;
      try { size = fs.statSync(file).size; } catch { return; }
      if (size <= offset) return;
      const chunk = Buffer.alloc(size - offset);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, chunk, 0, chunk.length, offset); } finally { fs.closeSync(fd); }
      offset = size;
      const data = chunk.toString('utf8');
      this.dataHandlers.forEach((h) => h(name, data));
    }, 100);
    timer.unref?.();
    this.rawWatchers.set(name, timer);
  }

  private unwatchRaw(name: string): void {
    const timer = this.rawWatchers.get(name);
    if (timer) { clearInterval(timer); this.rawWatchers.delete(name); }
  }

  private async restore(): Promise<void> {
    const names = await tmux.listNames(this.opts);
    for (const name of names) {
      if (this.sessions.has(name)) continue;
      this.spawnAttach(name);
    }
  }

  /** 删除 .run/raw 里已无对应会话的原始流文件。由 server 启动后调用一次——
   * 不放 restore()：多实例共享目录时（测试并发）会互删对方正在写的文件 */
  pruneOrphanRawLogs(): void {
    const valid = new Set(this.list().map((s) => s.sessionId));
    try {
      for (const f of fs.readdirSync(RAW_DIR)) {
        const m = f.match(/^([A-Za-z0-9_-]+)\.raw$/);
        if (m && !valid.has(m[1])) removeRawLog(RAW_DIR, m[1]);
      }
    } catch { /* 目录不存在等忽略 */ }
  }

  create(opts: { cols: number; rows: number; cwd?: string }): string {
    const cwd = opts.cwd ?? os.homedir();
    let name = tmux.genSessionName();
    // 重名（极小概率）重新生成重试
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        tmux.newSessionSync(this.opts, name, opts.cols, opts.rows, cwd);
        break;
      } catch (e) {
        if (attempt < 2) { name = tmux.genSessionName(); continue; }
        throw e;
      }
    }
    this.spawnAttach(name, opts.cols, opts.rows);
    return name;
  }

  write(sessionId: string, data: string): void {
    const s = this.sessions.get(sessionId);
    if (s && !s.exited) s.pty.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.exited) return;
    s.pty.resize(cols, rows);
    tmux.resizeSync(this.opts, sessionId, cols, rows);
  }

  close(sessionId: string): void {
    this.unwatchRaw(sessionId);
    // 先关 pipe-pane 并删除原始流文件（会话销毁即清理，对称）
    stopPipePane(this.opts.socketName, sessionId);
    removeRawLog(RAW_DIR, sessionId);
    // 先销毁 tmux 会话（pty.kill 只 detach，会话会保留——不符合"销毁"语义）
    tmux.killSessionSync(this.opts, sessionId);
    const s = this.sessions.get(sessionId);
    if (s && !s.exited) s.pty.kill(); // 兜底：确保 attach 进程退出 → onExit 触发
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.id,
      createdAt: s.createdAt,
      exited: s.exited,
      exitCode: s.exitCode,
    }));
  }

  getRawTail(sessionId: string): string {
    return readRawTail(RAW_DIR, sessionId);
  }

  getCwd(sessionId: string): string {
    return this.displayCwd(this.cwdCache.get(sessionId) ?? '');
  }

  onData(h: DataHandler): () => void {
    this.dataHandlers.add(h);
    return () => { this.dataHandlers.delete(h); };
  }
  onExit(h: ExitHandler): () => void {
    this.exitHandlers.add(h);
    return () => { this.exitHandlers.delete(h); };
  }
  onCwd(h: CwdHandler): () => void {
    this.cwdHandlers.add(h);
    return () => { this.cwdHandlers.delete(h); };
  }

  dispose(): void {
    if (this.cwdTimer) { clearInterval(this.cwdTimer); this.cwdTimer = null; }
    for (const name of this.rawWatchers.keys()) this.unwatchRaw(name);
    for (const s of this.sessions.values()) {
      if (!s.exited) { try { s.pty.kill(); } catch { /* 已退出 */ } }
    }
    this.sessions.clear();
  }
}
