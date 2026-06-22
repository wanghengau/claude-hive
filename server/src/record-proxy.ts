import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { sanitizeWindowId, writeRecord } from './record-store.js';

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

export interface ProxyOpts {
  target: string;
  logDir: string;
  maxBytes: number;
  injectWebsearch: boolean;
}

export function handleProxy(req: http.IncomingMessage, res: http.ServerResponse, opts: ProxyOpts): void {
  const startedAt = Date.now();
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const reqBody = Buffer.concat(chunks);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let reqJson: any = null;
    try { reqJson = JSON.parse(reqBody.toString('utf8')); } catch { /* 非 JSON body */ }
    let outBody: Buffer = reqBody;
    let outJson = reqJson;
    let injected = false;
    if (opts.injectWebsearch && reqJson) {
      const inj = injectWebSearch(reqJson);
      if (inj) { outJson = inj; outBody = Buffer.from(JSON.stringify(inj), 'utf8'); injected = true; }
    }
    const windowId = sanitizeWindowId(req.headers['x-window-id'] as string | undefined);
    const u = buildTargetUrl(req.url ?? '/', opts.target);
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    // 转发前剥离内部窗口标记，不泄露给上游；其余 header 原样转发
    const fwdHeaders: http.OutgoingHttpHeaders = { ...req.headers, host: u.hostname, 'content-length': String(outBody.length) };
    delete fwdHeaders['x-window-id'];
    const proxyReq = mod.request({
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: req.method,
      headers: fwdHeaders,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      const tap = new PassThrough();
      const sse = new SSEAccumulator();
      let bytes = 0, truncated = false;
      tap.on('data', (c: Buffer) => {
        if (bytes <= opts.maxBytes) { sse.feed(c); bytes += c.length; } else truncated = true;
      });
      tap.on('end', () => {
        writeRecord(opts.logDir, {
          id: makeRecordId(),
          ts: new Date().toISOString(),
          windowId,
          model: (outJson && outJson.model) || null,
          stream: !!(outJson && outJson.stream),
          request: outJson || null,
          response: { text: sse.text, stop_reason: sse.stopReason, usage: sse.usage },
          meta: { status: proxyRes.statusCode ?? null, duration_ms: Date.now() - startedAt, bytes, truncated, injected_websearch: injected, response_headers: scrubAuth(proxyRes.headers as Record<string, unknown>) },
        });
      });
      proxyRes.pipe(res);   // 主路径：流式转发（零缓冲）
      proxyRes.pipe(tap);   // 旁路：累积录制
    });
    proxyReq.on('error', (err: Error) => {
      try { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'proxy_error', message: err.message })); } catch { /* 已写头 */ }
    });
    if (outBody.length) proxyReq.write(outBody);
    proxyReq.end();
  });
}
