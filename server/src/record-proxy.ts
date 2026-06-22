import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import path from 'node:path';

export function buildTargetUrl(reqUrl: string, target: string): URL {
  // 不能用 new URL(reqUrl, target)：reqUrl 为绝对路径时会丢弃 target 的 path。手动拼接。
  const base = new URL(target);
  const basePath = base.pathname.replace(/\/+$/, '');
  const suffix = reqUrl.startsWith('/') ? reqUrl : '/' + reqUrl;
  return new URL(basePath + suffix, base.origin);
}

export function scrubAuth(headers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    out[k] = lk === 'authorization' || lk === 'x-api-key' || lk.includes('token') || lk.includes('key') ? '***' : v;
  }
  return out;
}

export function makeRecordId(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}

export function recordDir(d: Date = new Date(), logDir: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return path.join(logDir, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
}

export interface SseEvent { type: string; message?: { usage?: Record<string, number> }; delta?: { type?: string; text?: string; stop_reason?: string }; usage?: Record<string, number> }

export class SSEAccumulator {
  buffer = '';
  text = '';
  usage: Record<string, number> = {};
  stopReason: string | null = null;
  feed(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const data = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (!data || data === '[DONE]') continue;
      try { this.handle(JSON.parse(data) as SseEvent); } catch { /* 忽略坏帧 */ }
    }
  }
  private handle(e: SseEvent): void {
    if (e.type === 'message_start' && e.message?.usage) Object.assign(this.usage, e.message.usage);
    else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') this.text += e.delta.text ?? '';
    else if (e.type === 'message_delta') {
      if (e.usage) Object.assign(this.usage, e.usage);
      if (e.delta?.stop_reason) this.stopReason = e.delta.stop_reason;
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function injectWebSearch(reqJson: any): Record<string, unknown> | null {
  if (!reqJson || typeof reqJson !== 'object' || Array.isArray(reqJson)) return null;
  const tools = Array.isArray(reqJson.tools) ? reqJson.tools : [];
  if (tools.some((t: Record<string, unknown>) => t && (t.name === 'web_search' || t.type === 'web_search_20250305'))) return null;
  return { ...reqJson, tools: [...tools, { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] };
}
