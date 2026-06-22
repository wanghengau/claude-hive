import fs from 'node:fs';
import path from 'node:path';
import { makeRecordId } from './record-proxy.js';

export interface RecordSummary {
  date: string;
  id: string;
  ts: string | null;
  model: string | null;
  status: number | null;
  in: number;
  out: number;
}

// 系统边界校验：windowId 来自外部 header，只允许 [A-Za-z0-9_-]，否则归 default（防路径穿越）
export function sanitizeWindowId(raw: string | undefined): string {
  if (!raw) return 'default';
  const clean = raw.trim();
  return /^[A-Za-z0-9_-]+$/.test(clean) ? clean : 'default';
}

const pad = (n: number) => String(n).padStart(2, '0');
const dateStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function recordFilePath(logDir: string, windowId: string, d: Date, id: string): string {
  return path.join(logDir, sanitizeWindowId(windowId), dateStr(d), `${id}.json`);
}

// 异步落盘，吞错（绝不阻塞转发主路径）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function writeRecord(logDir: string, record: any): void {
  const wid = sanitizeWindowId(record.windowId);
  const d = record.ts ? new Date(record.ts) : new Date();
  const dir = path.join(logDir, wid, dateStr(d));
  fs.mkdir(dir, { recursive: true }, () => {
    fs.writeFile(path.join(dir, `${record.id}.json`), JSON.stringify(record, null, 2), () => { /* 吞错 */ });
  });
}

export function listRecords(logDir: string, windowId: string, limit = 200): RecordSummary[] {
  const wid = sanitizeWindowId(windowId);
  const wRoot = path.join(logDir, wid);
  let dayDirs: string[] = [];
  try { dayDirs = fs.readdirSync(wRoot).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)); } catch { return []; }
  const entries: RecordSummary[] = [];
  for (const date of dayDirs) {
    let files: string[] = [];
    try { files = fs.readdirSync(path.join(wRoot, date)); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const entry: RecordSummary = { date, id: file.replace(/\.json$/, ''), ts: null, model: null, status: null, in: 0, out: 0 };
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = JSON.parse(fs.readFileSync(path.join(wRoot, date, file), 'utf8')) as any;
        entry.ts = raw.ts ?? null;
        entry.model = (raw.request && raw.request.model) || raw.model || null;
        entry.status = (raw.meta && raw.meta.status) ?? null;
        entry.in = (raw.response && raw.response.usage && raw.response.usage.input_tokens) || 0;
        entry.out = (raw.response && raw.response.usage && raw.response.usage.output_tokens) || 0;
      } catch { /* 坏文件跳过 */ }
      entries.push(entry);
    }
  }
  entries.sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id));
  return entries.slice(0, limit);
}

export function countRecords(logDir: string): Record<string, number> {
  const out: Record<string, number> = {};
  let wids: string[] = [];
  try { wids = fs.readdirSync(logDir); } catch { return out; }
  for (const wid of wids) {
    if (!/^[A-Za-z0-9_-]+$/.test(wid)) continue;
    const wRoot = path.join(logDir, wid);
    if (!fs.statSync(wRoot).isDirectory()) continue;
    let n = 0;
    let dayDirs: string[] = [];
    try { dayDirs = fs.readdirSync(wRoot); } catch { continue; }
    for (const dd of dayDirs) {
      try { if (fs.statSync(path.join(wRoot, dd)).isDirectory()) n += fs.readdirSync(path.join(wRoot, dd)).filter((f) => f.endsWith('.json')).length; } catch { /* skip */ }
    }
    if (n > 0) out[wid] = n;
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getRecord(logDir: string, windowId: string, date: string, id: string): any | null {
  const wid = sanitizeWindowId(windowId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[A-Za-z0-9-]+$/.test(id)) return null;
  const fp = path.join(logDir, wid, date, `${id}.json`);
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}
