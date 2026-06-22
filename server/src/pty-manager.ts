import os from 'node:os';
import { spawn, type IPty } from 'node-pty';
import { RingBuffer } from './ring-buffer.js';
import * as tmux from './tmux.js';
import type { CwdHandler, DataHandler, ExitHandler, IPtyManager, SessionInfo } from './protocol.js';

const RING_MAX = 50 * 1024;
const CWD_POLL_MS = 3000;

interface Session {
  id: string;
  pty: IPty;
  createdAt: number;
  exited: boolean;
  exitCode?: number;
  ring: RingBuffer;
}

export class PtyManager implements IPtyManager {
  private sessions = new Map<string, Session>();
  private dataHandlers = new Set<DataHandler>();
  private exitHandlers = new Set<ExitHandler>();
  private cwdHandlers = new Set<CwdHandler>();
  private cwdCache = new Map<string, string>();
  private cwdTimer: ReturnType<typeof setInterval> | null = null;
  protected readonly opts: tmux.TmuxOpts;

  constructor(opts: { socketName?: string } = {}) {
    this.opts = { socketName: opts.socketName ?? 'wmt' };
    this.cwdTimer = setInterval(() => this.pollCwds(), CWD_POLL_MS);
    this.cwdTimer.unref?.();
    // 启动恢复：attach 所有已存在的 wmt-* 会话（server 重启场景）
    this.restore().catch(() => {});
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
    const session: Session = { id: name, pty, createdAt: Date.now(), exited: false, ring: new RingBuffer(RING_MAX) };
    pty.onData((data) => {
      session.ring.push(data);
      this.dataHandlers.forEach((h) => h(name, data));
    });
    pty.onExit(({ exitCode }) => {
      session.exited = true;
      session.exitCode = exitCode;
      this.exitHandlers.forEach((h) => h(name, exitCode));
      this.sessions.delete(name);
    });
    this.sessions.set(name, session);
    this.refreshCwd(name);
    return session;
  }

  private async restore(): Promise<void> {
    const names = await tmux.listNames(this.opts);
    for (const name of names) {
      if (this.sessions.has(name)) continue;
      this.spawnAttach(name);
    }
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

  getRingBuffer(sessionId: string): string {
    return this.sessions.get(sessionId)?.ring.toString() ?? '';
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
    for (const s of this.sessions.values()) {
      if (!s.exited) { try { s.pty.kill(); } catch { /* 已退出 */ } }
    }
    this.sessions.clear();
  }
}
