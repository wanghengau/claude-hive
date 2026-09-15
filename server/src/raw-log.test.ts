import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rawLogPath, readRawTail, removeRawLog } from './raw-log.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rawlog-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('readRawTail', () => {
  it('文件不存在/为空返回空串', () => {
    expect(readRawTail(dir, 'wmt-abc123')).toBe('');
    fs.writeFileSync(rawLogPath(dir, 'wmt-abc123'), '');
    expect(readRawTail(dir, 'wmt-abc123')).toBe('');
  });

  it('小文件全量返回，前插 RIS 全重置序列', () => {
    fs.writeFileSync(rawLogPath(dir, 'wmt-abc123'), 'hello\nworld\n');
    const raw = readRawTail(dir, 'wmt-abc123');
    expect(raw.startsWith('\x1bc')).toBe(true);
    expect(raw.endsWith('hello\nworld\n')).toBe(true);
  });

  it('超过上限只取尾部，起点在换行之后', () => {
    const line = 'x'.repeat(100) + '\n';
    const big = line.repeat(1000); // 101KB
    fs.writeFileSync(rawLogPath(dir, 'wmt-big'), big);
    const raw = readRawTail(dir, 'wmt-big', 10 * 1024); // 上限 10KB
    // 上限 + 找换行的 4K 窗口之内
    expect(raw.length).toBeLessThan(10 * 1024 + 4096 + 10);
    // 起点不截断在行中间：内容全部是完整行
    const body = raw.slice(2); // 去 RIS（ESC c 两字符）
    expect(body.startsWith('x')).toBe(true);
    expect(body.split('\n').every((l) => l === '' || l === 'x'.repeat(100))).toBe(true);
  });

  it('非法会话 id 拒绝（防路径穿越）', () => {
    expect(() => rawLogPath(dir, '../evil')).toThrow();
    expect(() => rawLogPath(dir, 'a/b')).toThrow();
  });

  it('removeRawLog 删除文件且幂等', () => {
    fs.writeFileSync(rawLogPath(dir, 'wmt-x'), 'data');
    removeRawLog(dir, 'wmt-x');
    expect(fs.existsSync(rawLogPath(dir, 'wmt-x'))).toBe(false);
    expect(() => removeRawLog(dir, 'wmt-x')).not.toThrow();
  });
});
