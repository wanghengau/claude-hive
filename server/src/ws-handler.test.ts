import { describe, it, expect } from 'vitest';
import { handleConnection } from './ws-handler.js';
import type { IPtyManager, SessionInfo } from './protocol.js';

class FakePtyManager implements IPtyManager {
  creates: any[] = [];
  writes: any[] = [];
  resizes: any[] = [];
  closes: string[] = [];
  listed = false;
  private dataHandler?: (sid: string, data: string) => void;
  private exitHandler?: (sid: string, code: number) => void;
  private cwdHandler?: (sid: string, cwd: string) => void;
  rings = new Map<string, string>();

  create(opts: { cols: number; rows: number; cwd?: string }): string {
    const id = 's' + (this.creates.length + 1);
    this.creates.push(opts);
    return id;
  }
  write(sessionId: string, data: string) { this.writes.push({ sessionId, data }); }
  resize(sessionId: string, cols: number, rows: number) { this.resizes.push({ sessionId, cols, rows }); }
  close(sessionId: string) { this.closes.push(sessionId); }
  list(): SessionInfo[] { this.listed = true; return [{ sessionId: 's1', createdAt: 0, exited: false }]; }
  getRingBuffer(sessionId: string): string { return this.rings.get(sessionId) ?? ''; }
  getCwd(_sessionId: string): string { return ''; }
  onData(h: (sid: string, data: string) => void) { this.dataHandler = h; return () => {}; }
  onExit(h: (sid: string, code: number) => void) { this.exitHandler = h; return () => {}; }
  onCwd(h: (sid: string, cwd: string) => void) { this.cwdHandler = h; return () => {}; }
  emitData(sid: string, data: string) { this.dataHandler?.(sid, data); }
  emitExit(sid: string, code: number) { this.exitHandler?.(sid, code); }
  emitCwd(sid: string, cwd: string) { this.cwdHandler?.(sid, cwd); }
}

function makeFakeWs() {
  const sent: string[] = [];
  const listeners: Record<string, ((arg?: any) => void)[]> = {};
  return {
    sent,
    on(event: string, cb: (arg?: any) => void) { (listeners[event] ??= []).push(cb); },
    emit(event: string, arg?: any) { (listeners[event] ?? []).forEach((cb) => cb(arg)); },
    send(data: string) { sent.push(data); },
  };
}

describe('ws-handler', () => {
  it('create 转发并回 created', () => {
    const mgr = new FakePtyManager();
    const ws = makeFakeWs();
    handleConnection(ws as any, mgr);
    ws.emit('message', JSON.stringify({ type: 'create', cols: 80, rows: 24 }));
    expect(mgr.creates).toEqual([{ cols: 80, rows: 24 }]);
    expect(ws.sent).toContain(JSON.stringify({ type: 'created', sessionId: 's1' }));
  });

  it('pty data 事件转发为 data 消息', () => {
    const mgr = new FakePtyManager();
    const ws = makeFakeWs();
    handleConnection(ws as any, mgr);
    mgr.emitData('s1', 'hello');
    expect(ws.sent).toContain(JSON.stringify({ type: 'data', sessionId: 's1', payload: 'hello' }));
  });

  it('input/resize/close 路由到 mgr', () => {
    const mgr = new FakePtyManager();
    const ws = makeFakeWs();
    handleConnection(ws as any, mgr);
    ws.emit('message', JSON.stringify({ type: 'input', sessionId: 's1', data: 'x' }));
    ws.emit('message', JSON.stringify({ type: 'resize', sessionId: 's1', cols: 100, rows: 30 }));
    ws.emit('message', JSON.stringify({ type: 'close', sessionId: 's1' }));
    expect(mgr.writes).toEqual([{ sessionId: 's1', data: 'x' }]);
    expect(mgr.resizes).toEqual([{ sessionId: 's1', cols: 100, rows: 30 }]);
    expect(mgr.closes).toEqual(['s1']);
  });

  it('list 回 sessions 并回放 ring buffer', () => {
    const mgr = new FakePtyManager();
    mgr.rings.set('s1', 'REPLAY');
    const ws = makeFakeWs();
    handleConnection(ws as any, mgr);
    ws.emit('message', JSON.stringify({ type: 'list' }));
    expect(mgr.listed).toBe(true);
    expect(ws.sent).toContain(JSON.stringify({ type: 'data', sessionId: 's1', payload: 'REPLAY' }));
  });

  it('exit 转发为 exit 消息', () => {
    const mgr = new FakePtyManager();
    const ws = makeFakeWs();
    handleConnection(ws as any, mgr);
    mgr.emitExit('s1', 3);
    expect(ws.sent).toContain(JSON.stringify({ type: 'exit', sessionId: 's1', code: 3 }));
  });

  it('cwd 转发为 cwd 消息', () => {
    const mgr = new FakePtyManager();
    const ws = makeFakeWs();
    handleConnection(ws as any, mgr);
    mgr.emitCwd('s1', '/tmp');
    expect(ws.sent).toContain(JSON.stringify({ type: 'cwd', sessionId: 's1', cwd: '/tmp' }));
  });
});
