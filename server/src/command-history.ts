import fs from 'node:fs';
import path from 'node:path';

const MAX_HISTORY = 50;
const NAME_RE = /^[A-Za-z0-9_-]+$/;

// 纯追加:超 max 丢最旧一条。无副作用。
export function appendTruncated(items: string[], cmd: string, max: number = MAX_HISTORY): string[] {
  const next = [...items, cmd];
  if (next.length > max) next.splice(0, next.length - max);
  return next;
}

// 边界校验:sessionId 来自外部 WS 消息,只允许 [A-Za-z0-9_-],防路径穿越。
export function sanitizeSessionId(raw: string): string | null {
  return NAME_RE.test(raw) ? raw : null;
}

function filePath(dir: string, sessionId: string): string {
  return path.join(dir, `${sessionId}.json`);
}

// 读:文件不存在 / 非法 / sanitize 失败 → []
export function load(dir: string, sessionId: string): string[] {
  const sid = sanitizeSessionId(sessionId);
  if (!sid) return [];
  try {
    const raw = fs.readFileSync(filePath(dir, sid), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

// 写:同步落盘,吞错(不阻塞主路径——命令成形才触发,低频)。sessionId 非法则静默跳过。
export function save(dir: string, sessionId: string, items: string[]): void {
  const sid = sanitizeSessionId(sessionId);
  if (!sid) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath(dir, sid), JSON.stringify(items, null, 2));
  } catch { /* 吞错 */ }
}

// 删:同步,文件不存在静默(幂等)
export function remove(dir: string, sessionId: string): void {
  const sid = sanitizeSessionId(sessionId);
  if (!sid) return;
  try { fs.unlinkSync(filePath(dir, sid)); } catch { /* ENOENT 静默 */ }
}

// 清孤儿:同步枚举+删除,文件名(去 .json)不在 liveIds 集合、且名合法的 *.json
export function prune(dir: string, liveIds: Set<string>): void {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const sid = name.slice(0, -5);
    if (!NAME_RE.test(sid)) continue;
    if (!liveIds.has(sid)) {
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* 吞错 */ }
    }
  }
}

export interface ParseResult {
  line: string;
  commands: string[];
}

// 纯解析:累积可见字符,遇回车成形(trim 后非空才记),处理退格,跳过 ESC 转义。
// 逻辑移植自原 web/src/ws-client.ts recordInput。
export function parseChunk(prevLine: string, data: string): ParseResult {
  let line = prevLine;
  const commands: string[] = [];
  let i = 0;
  while (i < data.length) {
    const code = data.charCodeAt(i);
    const ch = data[i];
    if (code === 0x1b) {
      const next = data[i + 1];
      if (next === '[') {
        // CSI: ESC [ 参数... 终结字节(0x40-0x7e) — 方向键/Home/End/Delete
        i += 2;
        while (i < data.length) {
          const c = data.charCodeAt(i);
          i++;
          if (c >= 0x40 && c <= 0x7e) break;
        }
      } else if (next === 'O') {
        // SS3: ESC O 终结字节 — application 模式方向键/F1-F4,固定 3 字节整体跳过
        i += 3;
      } else if (next === ']' || next === 'P' || next === '^' || next === '_') {
        // OSC/DCS/PM/APC: ESC X 参数... — 以 BEL(\x07) 或 ST(ESC \) 结束
        i += 2;
        while (i < data.length) {
          const c = data.charCodeAt(i);
          if (c === 0x07) { i++; break; }
          if (c === 0x1b && data.charCodeAt(i + 1) === 0x5c) { i += 2; break; }
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
      if (cmd) commands.push(cmd);
      line = '';
    } else if (code === 127 || code === 8) {
      line = line.slice(0, -1);
    } else if (code >= 32 || ch === '\t') {
      line += ch;
    }
    i++;
  }
  return { line, commands };
}
