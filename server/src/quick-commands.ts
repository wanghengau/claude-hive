import fs from 'node:fs';

// 项目根 quick-commands.json 不存在时的兜底；首次 PUT 后才落盘
export const DEFAULT_QUICK_COMMANDS = ['ls -la', 'git status', 'git diff', 'clear', 'pwd', 'Ctrl-C'];

function isStringArr(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

// 读：文件不存在或内容非法一律回退默认，保证 GET 永远返回有效命令
export function readQuickCommands(filePath: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return DEFAULT_QUICK_COMMANDS;
  }
  try {
    const parsed = JSON.parse(raw);
    if (isStringArr(parsed)) return parsed;
  } catch {
    /* 回退默认 */
  }
  return DEFAULT_QUICK_COMMANDS;
}

// 写：内部互信，仅信任已校验的 string[]，否则抛错（由 server 边界 catch → 400）
export function writeQuickCommands(filePath: string, items: string[]): void {
  if (!isStringArr(items)) throw new TypeError('quick commands must be a string array');
  fs.writeFileSync(filePath, JSON.stringify(items, null, 2) + '\n', 'utf8');
}
