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

export interface AnalyzeOpts { window?: string; limit?: number }

// 枚举 logDir 下合法 window 目录（含日期子目录的才算；commands/ 等无日期子目录自然排除，
// 与 record-store.countRecords 一致）
function listWindowDirs(logDir: string): string[] {
  let wids: string[] = [];
  try { wids = fs.readdirSync(logDir); } catch { return []; }
  return wids.filter((w) => /^[A-Za-z0-9_-]+$/.test(w));
}

// 主入口：遍历录制 → 按 ts 倒序取最近 limit 条 → 聚合 HarnessProfile
export function analyzeRecords(logDir: string, opts: AnalyzeOpts = {}): HarnessProfile {
  const limit = opts.limit ?? 500;
  const windowScope = opts.window || 'all';
  const wids = opts.window ? [sanitizeWindowId(opts.window)] : listWindowDirs(logDir);

  const all: { ts: string; rec: AnyRec }[] = [];
  for (const wid of wids) {
    const wRoot = path.join(logDir, wid);
    let dayDirs: string[] = [];
    try { dayDirs = fs.readdirSync(wRoot).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)); } catch { continue; }
    for (const date of dayDirs) {
      let files: string[] = [];
      try { files = fs.readdirSync(path.join(wRoot, date)); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const rec = JSON.parse(fs.readFileSync(path.join(wRoot, date, f), 'utf8'));
          if (rec && typeof rec === 'object') all.push({ ts: rec.ts ?? `${date}${f}`, rec });
        } catch { /* 坏文件跳过 */ }
      }
    }
  }

  all.sort((a, b) => b.ts.localeCompare(a.ts));
  const records = all.slice(0, limit).map((x) => x.rec);

  const system = extractSystem(records);
  const tools = extractTools(records);
  const toolsTokens = tools.reduce((s, t) => s + t.descTokens + t.schemaTokens, 0);

  return {
    sampleSize: records.length,
    windowScope,
    system,
    tools,
    tokenOverhead: { systemTokens: system.rulesTokens, toolsTokens, total: system.rulesTokens + toolsTokens },
    cacheStats: computeCacheStats(records),
    injections: extractInjections(records),
    models: extractModels(records),
  };
}

// 组装给 LLM 的分析 prompt
export function buildInterpretPrompt(p: HarnessProfile): string {
  const L: string[] = [];
  L.push('下面是一个 Claude Code harness（驱动 Claude 的外壳）的 API 录制结构数据。');
  L.push('请基于这些数据分析：这个 harness 是怎么设计的——设计哲学、能力边界、上下文与缓存管理策略。中文，分点，务实。\n');
  L.push(`采样 ${p.sampleSize} 条录制（范围：${p.windowScope}）\n`);
  L.push('## 身份声明');
  L.push(p.system.identity || '（无）');
  L.push('\n## 完整规则（system prompt）');
  L.push(p.system.rules || '（无）');
  L.push('\n## 能力集（工具）');
  for (const t of p.tools) L.push(`- ${t.name}（${t.descTokens} tok）：${t.desc}`);
  L.push('\n## 固定 token 开销');
  L.push(`system ${p.tokenOverhead.systemTokens} / tools ${p.tokenOverhead.toolsTokens} / 合计 ${p.tokenOverhead.total}`);
  L.push('\n## 缓存策略');
  L.push(`平均 cache_read ${p.cacheStats.avgCacheRead} / 平均 input ${p.cacheStats.avgInput} / 命中率 ${Math.round(p.cacheStats.hitRate * 100)}%`);
  if (p.injections.length) {
    L.push('\n## 上下文注入（role=system 消息）');
    for (const i of p.injections) L.push(`- ${i.chars} 字符 / ${i.tokens} tok：${i.preview}…`);
  }
  L.push('\n## 模型分布');
  for (const m of p.models) L.push(`- ${m.model}：${m.count} 次`);
  return L.join('\n');
}
