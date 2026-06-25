import type { ClientMessage, ServerMessage } from './types.js';

type DataHandler = (sessionId: string, data: string) => void;
type MessageHandler = (msg: ServerMessage) => void;

const MAX_BUFFER = 2000000;

export class WsClient {
  private ws: WebSocket | null = null;
  private dataHandlers = new Map<string, Set<DataHandler>>();
  private messageHandlers = new Set<MessageHandler>();
  private openHandlers = new Set<() => void>();
  private buffers = new Map<string, string>();
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
        // 过滤 alt screen 切换（ESC[?1049h/l）：claude 等全屏 TUI 进 alt screen 后，启动前的 shell 输出
        // 会被 alt buffer 遮盖、终端滚动条滚不到。去掉该序列让应用留在主 buffer，历史进 scrollback 可回看。
        const payload = msg.payload.replace(/\x1b\[\?1049[hl]/g, '');
        let buf = this.buffers.get(msg.sessionId) ?? '';
        buf += payload;
        if (buf.length > MAX_BUFFER) buf = buf.slice(buf.length - MAX_BUFFER);
        this.buffers.set(msg.sessionId, buf);
        this.dataHandlers.get(msg.sessionId)?.forEach((h) => h(msg.sessionId, payload));
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
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  getBuffer(sessionId: string): string {
    return this.buffers.get(sessionId) ?? '';
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
}
