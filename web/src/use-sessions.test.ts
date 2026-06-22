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
});
