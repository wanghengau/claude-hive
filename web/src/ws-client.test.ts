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

// 测试环境补丁：当前 vitest+jsdom 配置未提供可用的 localStorage（getItem/setItem 均缺失），
// 注入一个内存版实现，供 recordInput 的命令持久化逻辑测试使用。
Object.defineProperty(globalThis, 'localStorage', {
  value: (() => {
    const store = new Map<string, string>();
    return {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() { return store.size; },
    };
  })(),
  configurable: true,
  writable: true,
});

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

describe('recordInput 命令解析', () => {
  beforeEach(() => { localStorage.clear(); });

  // 用单次 input 触发 recordInput，返回成形命令列表
  function run(data: string): string[] {
    const c = new WsClient('ws://x');
    c.connect();
    FakeWebSocket.instances[0]!.fireOpen();
    c.send({ type: 'input', sessionId: 's', data });
    return c.getCommands('s');
  }

  it('记录普通输入命令', () => {
    expect(run('git status\r')).toEqual(['git status']);
  });

  it('退格删除前一字符', () => {
    expect(run('abc\x7f\r')).toEqual(['ab']);
  });

  it('跳过 CSI 方向键(ESC [ X)，不残留', () => {
    expect(run('\x1b[Als\r')).toEqual(['ls']);
  });

  it('跳过 CSI Delete 序列(ESC [ 3 ~)', () => {
    expect(run('\x1b[3~cd\r')).toEqual(['cd']);
  });

  it('跳过 SS3 方向键(ESC O X)，不残留字母', () => {
    // application cursor keys 模式下方向键发送 ESC O A/B/C/D，必须整体跳过
    expect(run('\x1bOAls\r')).toEqual(['ls']);
  });

  it('跳过 SS3 功能键(ESC O P..S)', () => {
    expect(run('\x1bOPpwd\r')).toEqual(['pwd']);
  });

  it('跳过 OSC 颜色查询响应(BEL 结束)，不残留', () => {
    // xterm 响应 OSC 10/11 颜色查询时，通过 onData 回流 ESC ] 10 ; rgb:... BEL
    expect(run('\x1b]10;rgb:cbcb/d5d5/e1e1\x07ls\r')).toEqual(['ls']);
  });

  it('跳过 OSC 响应(ST=ESC\\ 结束)', () => {
    expect(run('\x1b]11;rgb:0a0a/1010/1818\x1b\\ls\r')).toEqual(['ls']);
  });

  it('用户实际场景：OSC 颜色响应后接中文输入', () => {
    expect(run('\x1b]10;rgb:cbcb/d5d5/e1e1\x07左侧小窗鼠标按住后可以拖动排序\r'))
      .toEqual(['左侧小窗鼠标按住后可以拖动排序']);
  });
});
