// claude code 官方对话记录（transcript）读取：~/.claude/projects/<cwd-slug>/<sessionId>.jsonl
// 是每个对话的完整结构化数据（用户消息/AI 回复/工具调用）。终端流层面无法还原
// TUI 的干净历史（全屏重绘无固化语义），这里是历史回看的权威数据源。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TranscriptSummary {
  id: string;
  mtime: string;   // ISO
  size: number;
  preview: string; // 首条用户消息（截断）
}

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  text?: string;        // 文本内容（assistant 的 text 块合并）
  tool?: string;        // tool_use 名称（折叠为一行摘要）
  toolDetail?: string;  // 工具输入摘要（截断）
  ts?: string;
}

export interface Transcript {
  id: string;
  cwd: string;
  messages: TranscriptMessage[];
}

/** cwd → claude projects 目录名：非 [A-Za-z0-9._~-] 字符逐个替换为 '-'，前导 '/' 亦然 */
export function slugifyCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9._~-]/g, '-');
}

/** 展开显示用 cwd（~/xxx）为绝对路径 */
export function expandHome(cwd: string, home = os.homedir()): string {
  if (cwd === '~') return home;
  if (cwd.startsWith('~/')) return path.join(home, cwd.slice(2));
  return cwd;
}

function projectDir(cwd: string, home = os.homedir()): string {
  return path.join(home, '.claude', 'projects', slugifyCwd(expandHome(cwd, home)));
}

/** 从一行 jsonl 提取纯文本（user.content 为 string 或 text 块） */
function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
      .map((b) => String((b as { text?: string }).text ?? ''))
      .join('\n');
  }
  return '';
}

const PREVIEW_MAX = 80;

/** 列出某 cwd 的对话（按 mtime 倒序） */
export function listTranscripts(cwd: string, home = os.homedir(), limit = 50): TranscriptSummary[] {
  const dir = projectDir(cwd, home);
  let files: string[];
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out: TranscriptSummary[] = [];
  for (const f of files) {
    if (!/^[0-9a-f-]{36}\.jsonl$/i.test(f)) continue;
    const full = path.join(dir, f);
    try {
      const st = fs.statSync(full);
      out.push({ id: f.replace(/\.jsonl$/, ''), mtime: st.mtime.toISOString(), size: st.size, preview: previewOf(full) });
    } catch { /* 竞态忽略 */ }
  }
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return out.slice(0, limit);
}

/** 读首条用户消息做预览（只扫前 200 行，大文件不全文解析） */
function previewOf(file: string): string {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, head, 0, head.length, 0);
      for (const line of head.subarray(0, n).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
          if (d.type === 'user') {
            const t = userText(d.message?.content).trim().replace(/\s+/g, ' ');
            if (t) return t.slice(0, PREVIEW_MAX);
          }
        } catch { /* 行级容错 */ }
      }
    } finally { fs.closeSync(fd); }
  } catch { /* 读失败给空预览 */ }
  return '';
}

const TOOL_DETAIL_MAX = 120;

/** 解析单个对话为消息流（user/assistant 文本 + tool_use 折叠；thinking/system 等跳过） */
export function readTranscript(cwd: string, id: string, home = os.homedir()): Transcript | null {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null; // 边界校验：sessionId 是 uuid，防路径穿越
  const file = path.join(projectDir(cwd, home), `${id}.jsonl`);
  let lines: string[];
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { return null; }

  const messages: TranscriptMessage[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let d: { type?: string; timestamp?: string; message?: { content?: unknown } };
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'user' && d.type !== 'assistant') continue;
    const content = d.message?.content;
    const ts = d.timestamp;
    if (d.type === 'user') {
      const text = userText(content).trim();
      if (!text) continue; // tool_result 等非用户输入
      messages.push({ role: 'user', text, ts });
      continue;
    }
    // assistant：content 为块数组，text 块合并为一条，tool_use 各折叠一行，thinking 跳过
    if (!Array.isArray(content)) continue;
    const texts: string[] = [];
    for (const b of content as Array<{ type?: string; text?: string; name?: string; input?: unknown }>) {
      if (b?.type === 'text' && b.text?.trim()) texts.push(b.text.trim());
      else if (b?.type === 'tool_use') {
        const detail = JSON.stringify(b.input ?? {});
        messages.push({
          role: 'assistant',
          tool: String(b.name ?? ''),
          toolDetail: detail.length > TOOL_DETAIL_MAX ? detail.slice(0, TOOL_DETAIL_MAX) + '…' : detail,
          ts,
        });
      }
    }
    if (texts.length) messages.push({ role: 'assistant', text: texts.join('\n'), ts });
  }
  return { id, cwd: expandHome(cwd, home), messages };
}
