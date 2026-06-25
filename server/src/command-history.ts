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
