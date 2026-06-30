import fs from 'node:fs';
import path from 'node:path';
import { sanitizeWindowId } from './record-store.js';

// ── 类型（后端导出；前端 web/src/types.ts 定义同名副本，前后端不共享文件）──
export interface ToolStat { name: string; desc: string; descTokens: number; schemaTokens: number }
export interface Injection { chars: number; tokens: number; preview: string }
export interface ModelStat { model: string; count: number }
export interface HarnessProfile {
  sampleSize: number;
  windowScope: string;
  system: { identity: string; rules: string; rulesTokens: number };
  tools: ToolStat[];
  tokenOverhead: { systemTokens: number; toolsTokens: number; total: number };
  cacheStats: { avgCacheRead: number; avgInput: number; hitRate: number };
  injections: Injection[];
  models: ModelStat[];
}

// token 粗估：CJK 每字符≈1 token，其余≈4 字符/token。零依赖，不引分词器。
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  const nonCjk = text.length - cjk;
  return Math.ceil(cjk + nonCjk / 4);
}

// 从 {hash → {count, value}} 取出现次数最多的 value（抗 system/tools 版本漂移）
export function pickMostFrequent<T>(map: Map<string, { count: number; value: T }>): T | undefined {
  let best: { count: number; value: T } | undefined;
  for (const v of map.values()) if (!best || v.count > best.count) best = v;
  return best?.value;
}

// system 段落取文本：字符串原样，{type,text} 取 text
export function textOf(part: unknown): string {
  if (!part || typeof part !== 'object') return typeof part === 'string' ? part : '';
  const p = part as Record<string, unknown>;
  return typeof p.text === 'string' ? p.text : '';
}
