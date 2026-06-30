import http from 'node:http';
import https from 'node:https';
import { buildInterpretPrompt, type HarnessProfile } from './analyzer.js';

export class NoAnalyzerKeyError extends Error {
  constructor() {
    super('ANALYZER_API_KEY not configured');
    this.name = 'NoAnalyzerKeyError';
  }
}

export interface InterpretOpts {
  apiKey: string;
  target: string;
  model: string;
  timeoutMs?: number;
}

export interface AnalyzeRequestBody {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: string; content: string }>;
}

// 纯函数：拼上游 URL + 请求体（便于单测，无网络）
export function buildAnalyzeRequest(profile: HarnessProfile, opts: InterpretOpts): { url: string; body: AnalyzeRequestBody } {
  const base = new URL(opts.target);
  const basePath = base.pathname.replace(/\/+$/, '');
  const url = new URL(basePath + '/v1/messages', base.origin).toString();
  const body = {
    model: opts.model,
    max_tokens: 2000,
    system: '你是软件架构分析师。用户给你一个 Claude Code harness 的录制结构数据，请写一段清晰分析：这个 harness 怎么设计的、能力边界、上下文/缓存策略。中文，分点，务实，不堆砌套话。',
    messages: [{ role: 'user', content: buildInterpretPrompt(profile) }],
  };
  return { url, body };
}

// 调上游 LLM（非流式），返回解读文本。缺 key 抛 NoAnalyzerKeyError（由路由层降级为可复制 prompt）
export function interpretProfile(profile: HarnessProfile, opts: InterpretOpts): Promise<string> {
  if (!opts.apiKey) return Promise.reject(new NoAnalyzerKeyError());
  const { url, body } = buildAnalyzeRequest(profile, opts);
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  const payload = JSON.stringify(body);
  return new Promise<string>((resolve, reject) => {
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload)),
        authorization: `Bearer ${opts.apiKey}`,
        'x-api-key': opts.apiKey, // anthropic 风格双保险
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`llm http ${res.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        try {
          const j = JSON.parse(text);
          const out = j?.content?.[0]?.text ?? j?.content ?? text;
          resolve(typeof out === 'string' ? out : JSON.stringify(out));
        } catch { resolve(text); }
      });
    });
    req.on('error', reject);
    req.setTimeout(opts.timeoutMs ?? 60000, () => req.destroy(new Error('llm timeout')));
    req.end(payload); // 对称：请求必须 end
  });
}
