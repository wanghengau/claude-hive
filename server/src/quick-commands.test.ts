import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readQuickCommands, writeQuickCommands, DEFAULT_QUICK_COMMANDS } from './quick-commands.js';

let file: string;
beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-'));
  file = path.join(tmp, 'quick-commands.json');
});
afterEach(() => { fs.rmSync(path.dirname(file), { recursive: true, force: true }); });

describe('readQuickCommands', () => {
  it('文件不存在 → 返回默认命令', () => {
    expect(readQuickCommands(file)).toEqual(DEFAULT_QUICK_COMMANDS);
  });
  it('文件存在且合法 → 返回文件内容', () => {
    fs.writeFileSync(file, JSON.stringify(['a', 'b']));
    expect(readQuickCommands(file)).toEqual(['a', 'b']);
  });
  it('文件存在但非法 JSON → 回退默认', () => {
    fs.writeFileSync(file, 'not json');
    expect(readQuickCommands(file)).toEqual(DEFAULT_QUICK_COMMANDS);
  });
  it('文件存在但非字符串数组 → 回退默认', () => {
    fs.writeFileSync(file, JSON.stringify([1, 2, 3]));
    expect(readQuickCommands(file)).toEqual(DEFAULT_QUICK_COMMANDS);
    fs.writeFileSync(file, JSON.stringify({ a: 1 }));
    expect(readQuickCommands(file)).toEqual(DEFAULT_QUICK_COMMANDS);
  });
});

describe('writeQuickCommands', () => {
  it('写入后可读回', () => {
    writeQuickCommands(file, ['x', 'y']);
    expect(readQuickCommands(file)).toEqual(['x', 'y']);
  });
  it('非字符串数组 → 抛错（内部互信边界）', () => {
    expect(() => writeQuickCommands(file, [1 as unknown as string])).toThrow();
    expect(() => writeQuickCommands(file, 'nope' as unknown as string[])).toThrow();
  });
});
