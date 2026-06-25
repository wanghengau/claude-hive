import { describe, it, expect, beforeEach } from 'vitest';
import { WsClient } from './ws-client.js';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: () => void;
  readyState = 0;
  constructor(public url: string) { FakeWebSocket.instances.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
  fireOpen() { this.readyState = 1; this.onopen?.(); }
  fireMessage(data: string) { this.onmessage?.({ data }); }
}

beforeEach(() => { FakeWebSocket.instances = []; (globalThis as any).WebSocket = FakeWebSocket; });

describe('WsClient', () => {
  it('按 sessionId 分发 data 给订阅者', () => {
    const c = new WsClient('ws://x');
    c.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.fireOpen();
    let got = '';
    c.subscribeData('s1', (_sid, data) => { got += data; });
    ws.fireMessage(JSON.stringify({ type: 'data', sessionId: 's1', payload: 'hello' }));
    ws.fireMessage(JSON.stringify({ type: 'data', sessionId: 's2', payload: 'ignored' }));
    expect(got).toBe('hello');
  });

  it('send 序列化并发送', () => {
    const c = new WsClient('ws://x');
    c.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.fireOpen();
    c.send({ type: 'create', cols: 80, rows: 24 });
    expect(ws.sent).toEqual([JSON.stringify({ type: 'create', cols: 80, rows: 24 })]);
  });

  it('unsubscribeData 取消订阅', () => {
    const c = new WsClient('ws://x');
    c.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.fireOpen();
    let got = '';
    const off = c.subscribeData('s1', (_sid, data) => { got += data; });
    off();
    ws.fireMessage(JSON.stringify({ type: 'data', sessionId: 's1', payload: 'x' }));
    expect(got).toBe('');
  });

  it('buffer 超过 MAX_BUFFER 时截断保留末尾', () => {
    const c = new WsClient('ws://x');
    c.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.fireOpen();
    const big1 = 'a'.repeat(1000000);
    const big2 = 'b'.repeat(1500000);
    ws.fireMessage(JSON.stringify({ type: 'data', sessionId: 's1', payload: big1 }));
    ws.fireMessage(JSON.stringify({ type: 'data', sessionId: 's1', payload: big2 }));
    const buf = c.getBuffer('s1');
    expect(buf.length).toBe(2000000);
    expect(buf.slice(-10)).toBe('bbbbbbbbbb');
  });
});
