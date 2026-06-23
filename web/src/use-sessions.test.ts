import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSessions } from './use-sessions.js';
import { WsClient } from './ws-client.js';

class MockWsClient {
  sent: any[] = [];
  private handlers = new Set<(m: any) => void>();
  send(m: any) { this.sent.push(m); }
  onMessage(h: (m: any) => void) { this.handlers.add(h); return () => { this.handlers.delete(h); }; }
  onCommand(_h: (sid: string) => void) { return () => {}; }
  getCommands(_sid: string): string[] { return []; }
  emit(m: any) { this.handlers.forEach((h) => h(m)); }
}

describe('useSessions', () => {
  it('created 消息追加会话并设为 active', () => {
    const client = new MockWsClient() as unknown as WsClient;
    const { result } = renderHook(() => useSessions(client));
    act(() => (client as unknown as MockWsClient).emit({ type: 'created', sessionId: 's1' }));
    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0].sessionId).toBe('s1');
    expect(result.current.activeId).toBe('s1');
  });

  it('exit 消息从列表移除会话', () => {
    const client = new MockWsClient() as unknown as WsClient;
    const { result } = renderHook(() => useSessions(client));
    act(() => (client as unknown as MockWsClient).emit({ type: 'created', sessionId: 's1' }));
    act(() => (client as unknown as MockWsClient).emit({ type: 'exit', sessionId: 's1', code: 0 }));
    expect(result.current.sessions).toHaveLength(0);
  });

  it('create() 发送 create 消息', () => {
    const client = new MockWsClient() as unknown as WsClient;
    const { result } = renderHook(() => useSessions(client));
    act(() => result.current.create(80, 24));
    expect((client as unknown as MockWsClient).sent).toEqual([{ type: 'create', cols: 80, rows: 24 }]);
  });

  it('reorder 调整会话显示顺序', () => {
    const client = new MockWsClient() as unknown as WsClient;
    const { result } = renderHook(() => useSessions(client));
    act(() => (client as unknown as MockWsClient).emit({
      type: 'sessions',
      items: [
        { sessionId: 's1', createdAt: 1, exited: false },
        { sessionId: 's2', createdAt: 2, exited: false },
        { sessionId: 's3', createdAt: 3, exited: false },
      ],
    }));
    expect(result.current.sessions.map((s) => s.sessionId)).toEqual(['s1', 's2', 's3']);
    act(() => result.current.reorder(0, 2)); // 把 s1 移到末尾
    expect(result.current.sessions.map((s) => s.sessionId)).toEqual(['s2', 's3', 's1']);
  });

  it('reorder 同位置或越界不改顺序', () => {
    const client = new MockWsClient() as unknown as WsClient;
    const { result } = renderHook(() => useSessions(client));
    act(() => (client as unknown as MockWsClient).emit({
      type: 'sessions',
      items: [
        { sessionId: 's1', createdAt: 1, exited: false },
        { sessionId: 's2', createdAt: 2, exited: false },
      ],
    }));
    act(() => result.current.reorder(0, 0)); // 同位置
    act(() => result.current.reorder(5, 0)); // 越界
    expect(result.current.sessions.map((s) => s.sessionId)).toEqual(['s1', 's2']);
  });

  it('新会话追加到已排序顺序的末尾', () => {
    const client = new MockWsClient() as unknown as WsClient;
    const { result } = renderHook(() => useSessions(client));
    act(() => (client as unknown as MockWsClient).emit({
      type: 'sessions',
      items: [
        { sessionId: 's1', createdAt: 1, exited: false },
        { sessionId: 's2', createdAt: 2, exited: false },
      ],
    }));
    act(() => result.current.reorder(0, 1)); // [s2, s1]
    act(() => (client as unknown as MockWsClient).emit({ type: 'created', sessionId: 's3' }));
    expect(result.current.sessions.map((s) => s.sessionId)).toEqual(['s2', 's1', 's3']);
  });
});
