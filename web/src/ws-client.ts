import type { ClientMessage, ServerMessage } from './types.js';

type DataHandler = (sessionId: string, data: string) => void;
type MessageHandler = (msg: ServerMessage) => void;
type CommandHandler = (sessionId: string) => void;

const MAX_BUFFER = 2000000;
const MAX_HISTORY = 50;
const COMMANDS_KEY = 'term-commands';

export class WsClient {
  private ws: WebSocket | null = null;
  private dataHandlers = new Map<string, Set<DataHandler>>();
  private messageHandlers = new Set<MessageHandler>();
  private commandHandlers = new Set<CommandHandler>();
  private openHandlers = new Set<() => void>();
  private buffers = new Map<string, string>();
  private inputLines = new Map<string, string>();
  private opened = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private backoff = 1000;

  constructor(private readonly url: string) {}

  connect(): void {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.opened = true;
      this.backoff = 1000;
      this.openHandlers.forEach((h) => h());
    };
    this.ws.onmessage = (e: MessageEvent) => {
      let msg: ServerMessage;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'data') {
        let buf = this.buffers.get(msg.sessionId) ?? '';
        buf += msg.payload;
        if (buf.length > MAX_BUFFER) buf = buf.slice(buf.length - MAX_BUFFER);
        this.buffers.set(msg.sessionId, buf);
        this.dataHandlers.get(msg.sessionId)?.forEach((h) => h(msg.sessionId, msg.payload));
      }
      this.messageHandlers.forEach((h) => h(msg));
    };
    this.ws.onclose = () => {
      this.opened = false;
      if (this.shouldReconnect) {
        this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 10000);
      }
    };
  }

  send(msg: ClientMessage): void {
    if (msg.type === 'input') this.recordInput(msg.sessionId, msg.data);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  getBuffer(sessionId: string): string {
    return this.buffers.get(sessionId) ?? '';
  }

  // 命令历史持久化到 localStorage（按 sessionId），刷新后保留
  private loadCommands(): Record<string, string[]> {
    try {
      return JSON.parse(localStorage.getItem(COMMANDS_KEY) || '{}');
    } catch {
      return {};
    }
  }
  private saveCommands(all: Record<string, string[]>): void {
    try {
      localStorage.setItem(COMMANDS_KEY, JSON.stringify(all));
    } catch {
      /* ignore */
    }
  }

  getCommands(sessionId: string): string[] {
    return this.loadCommands()[sessionId] ?? [];
  }

  subscribeData(sessionId: string, h: DataHandler): () => void {
    let set = this.dataHandlers.get(sessionId);
    if (!set) { set = new Set(); this.dataHandlers.set(sessionId, set); }
    set.add(h);
    return () => { set!.delete(h); };
  }

  onMessage(h: MessageHandler): () => void {
    this.messageHandlers.add(h);
    return () => { this.messageHandlers.delete(h); };
  }

  onCommand(h: CommandHandler): () => void {
    this.commandHandlers.add(h);
    return () => { this.commandHandlers.delete(h); };
  }

  onOpen(h: () => void): () => void {
    this.openHandlers.add(h);
    if (this.opened) h();
    return () => { this.openHandlers.delete(h); };
  }

  dispose(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  // 记录用户键盘输入：累积可见字符，遇回车成形为一条命令，处理退格，跳过 ESC 转义。
  private recordInput(sessionId: string, data: string): void {
    let line = this.inputLines.get(sessionId) ?? '';
    const finish = (cmd: string) => {
      const all = this.loadCommands();
      const arr = all[sessionId] ?? [];
      arr.push(cmd);
      if (arr.length > MAX_HISTORY) arr.shift();
      all[sessionId] = arr;
      this.saveCommands(all);
      this.commandHandlers.forEach((h) => h(sessionId));
    };
    let i = 0;
    while (i < data.length) {
      const code = data.charCodeAt(i);
      const ch = data[i];
      if (code === 0x1b) {
        const next = data[i + 1];
        if (next === '[') {
          // CSI: ESC [ 参数... 终结字节(0x40-0x7e) —— 方向键/Home/End/Delete 等
          i += 2;
          while (i < data.length) {
            const c = data.charCodeAt(i);
            i++;
            if (c >= 0x40 && c <= 0x7e) break;
          }
        } else if (next === 'O') {
          // SS3: ESC O 终结字节 —— application 模式下的方向键/F1-F4/Home/End，固定 3 字节整体跳过，
          // 否则末尾字母(A/B/C/D/P/H/F…)会残留进命令，显示成"乱码前缀"
          i += 3;
        } else if (next === ']' || next === 'P' || next === '^' || next === '_') {
          // OSC/DCS/PM/APC: ESC X 参数... —— 以 BEL(\x07) 或 ST(ESC \) 结束。
          // xterm 响应 OSC 10/11 颜色查询时会经 onData 回流 ESC ] 10 ; rgb:... BEL，
          // 必须整体跳过，否则 "10;rgb:cbcb/d5d5/e1e1" 会残留成命令前缀
          i += 2;
          while (i < data.length) {
            const c = data.charCodeAt(i);
            if (c === 0x07) { i++; break; }                       // BEL 结束
            if (c === 0x1b && data.charCodeAt(i + 1) === 0x5c) { i += 2; break; }  // ST(ESC \) 结束
            i++;
          }
        } else if (next !== undefined) {
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        const cmd = line.trim();
        if (cmd) finish(cmd);
        line = '';
      } else if (code === 127 || code === 8) {
        line = line.slice(0, -1);
      } else if (code >= 32 || ch === '\t') {
        line += ch;
      }
      i++;
    }
    this.inputLines.set(sessionId, line);
  }
}
