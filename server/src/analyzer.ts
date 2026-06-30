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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRec = any;

// system 取最高频版本：identity = parts[0]，rules = 其余拼接
export function extractSystem(records: AnyRec[]): HarnessProfile['system'] {
  const map = new Map<string, { count: number; value: AnyRec[] }>();
  for (const r of records) {
    const sys = r?.request?.system;
    if (!Array.isArray(sys)) continue;
    const key = JSON.stringify(sys);
    const e = map.get(key) ?? { count: 0, value: sys };
    e.count++; map.set(key, e);
  }
  const parts = pickMostFrequent(map);
  if (!parts || !parts.length) return { identity: '', rules: '', rulesTokens: 0 };
  const identity = textOf(parts[0]);
  const rules = parts.slice(1).map(textOf).filter(Boolean).join('\n\n');
  return { identity, rules, rulesTokens: estimateTokens(identity + '\n' + rules) };
}

// tools 取最高频清单 → ToolStat[]，按 descTokens 降序
export function extractTools(records: AnyRec[]): ToolStat[] {
  const map = new Map<string, { count: number; value: AnyRec[] }>();
  for (const r of records) {
    const tools = r?.request?.tools;
    if (!Array.isArray(tools)) continue;
    const key = JSON.stringify(tools);
    const e = map.get(key) ?? { count: 0, value: tools };
    e.count++; map.set(key, e);
  }
  const tools = pickMostFrequent(map);
  if (!tools) return [];
  return tools
    .map((t: AnyRec) => ({
      name: String(t?.name ?? t?.type ?? '?'),
      desc: String(t?.description ?? ''),
      descTokens: estimateTokens(String(t?.description ?? '')),
      schemaTokens: estimateTokens(JSON.stringify(t?.input_schema ?? {})),
    }))
    .sort((a, b) => b.descTokens - a.descTokens);
}

// 缓存策略：平均 cache_read / input，命中率 = cache_read / (cache_read + input)
export function computeCacheStats(records: AnyRec[]): HarnessProfile['cacheStats'] {
  let cr = 0, inp = 0, n = 0;
  for (const r of records) {
    const u = r?.response?.usage;
    if (!u) continue;
    cr += Number(u.cache_read_input_tokens) || 0;
    inp += Number(u.input_tokens) || 0;
    n++;
  }
  if (n === 0) return { avgCacheRead: 0, avgInput: 0, hitRate: 0 };
  const avgCR = Math.round(cr / n), avgIn = Math.round(inp / n);
  const total = avgCR + avgIn;
  return { avgCacheRead: avgCR, avgInput: avgIn, hitRate: total > 0 ? Math.round((avgCR / total) * 100) / 100 : 0 };
}

// 上下文注入：messages[role=system]，取 top3 频繁
export function extractInjections(records: AnyRec[]): Injection[] {
  const map = new Map<string, number>();
  for (const r of records) {
    const msgs = r?.request?.messages;
    if (!Array.isArray(msgs)) continue;
    for (const m of msgs) {
      if (m?.role !== 'system') continue;
      const t = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      if (!t) continue;
      map.set(t, (map.get(t) ?? 0) + 1);
    }
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => ({ chars: t.length, tokens: estimateTokens(t), preview: t.slice(0, 200) }));
}

// 模型分布：计数，按次数降序
export function extractModels(records: AnyRec[]): ModelStat[] {
  const map = new Map<string, number>();
  for (const r of records) {
    const m = r?.request?.model || r?.model;
    if (!m) continue;
    map.set(m, (map.get(m) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count);
}
