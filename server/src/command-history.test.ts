import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseChunk } from './command-history.js';

describe('parseChunk 命令解析', () => {
  // 输入「当前半行 + 新数据」,返回 { line: 新半行, commands: 本次成形的命令 }
  function run(...chunks: string[]): string[] {
    let line = '';
    const out: string[] = [];
    for (const c of chunks) {
      const r = parseChunk(line, c);
      line = r.line;
      out.push(...r.commands);
    }
    return out;
  }

  it('记录普通输入命令', () => {
    expect(run('git status\r')).toEqual(['git status']);
  });
  it('退格删除前一字符', () => {
    expect(run('abc\x7f\r')).toEqual(['ab']);
  });
  it('跳过 CSI 方向键(ESC [ X),不残留', () => {
    expect(run('\x1b[Als\r')).toEqual(['ls']);
  });
  it('跳过 CSI Delete 序列(ESC [ 3 ~)', () => {
    expect(run('\x1b[3~cd\r')).toEqual(['cd']);
  });
  it('跳过 SS3 方向键(ESC O X),不残留字母', () => {
    expect(run('\x1bOAls\r')).toEqual(['ls']);
  });
  it('跳过 SS3 功能键(ESC O P..S)', () => {
    expect(run('\x1bOPpwd\r')).toEqual(['pwd']);
  });
  it('跳过 OSC 颜色查询响应(BEL 结束),不残留', () => {
    expect(run('\x1b]10;rgb:cbcb/d5d5/e1e1\x07ls\r')).toEqual(['ls']);
  });
  it('跳过 OSC 响应(ST=ESC\\ 结束)', () => {
    expect(run('\x1b]11;rgb:0a0a/1010/1818\x1b\\ls\r')).toEqual(['ls']);
  });
  it('用户实际场景:OSC 颜色响应后接中文输入', () => {
    expect(run('\x1b]10;rgb:cbcb/d5d5/e1e1\x07左侧小窗鼠标按住后可以拖动排序\r'))
      .toEqual(['左侧小窗鼠标按住后可以拖动排序']);
  });
  it('多条命令与空行不计', () => {
    expect(run('a\r\r', 'b\r')).toEqual(['a', 'b']);
  });
  it('跨 chunk 的半行累积(无回车不成形)', () => {
    expect(run('git ', 'sta', 'tus\r')).toEqual(['git status']);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendTruncated, sanitizeSessionId, load, save, remove, prune } from './command-history.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('appendTruncated', () => {
  it('未达上限直接追加', () => {
    expect(appendTruncated(['a'], 'b', 50)).toEqual(['a', 'b']);
  });
  it('达到上限丢最旧', () => {
    expect(appendTruncated(['a', 'b', 'c'], 'd', 3)).toEqual(['b', 'c', 'd']);
  });
  it('空数组', () => {
    expect(appendTruncated([], 'x', 50)).toEqual(['x']);
  });
});

describe('sanitizeSessionId', () => {
  it('合法 id 通过', () => {
    expect(sanitizeSessionId('wmt-0mcx5sf2')).toBe('wmt-0mcx5sf2');
  });
  it('含路径穿越 → null', () => {
    expect(sanitizeSessionId('../etc')).toBeNull();
    expect(sanitizeSessionId('a/b')).toBeNull();
  });
  it('含空格 → null', () => {
    expect(sanitizeSessionId('a b')).toBeNull();
  });
  it('空串 → null', () => {
    expect(sanitizeSessionId('')).toBeNull();
  });
});

describe('load', () => {
  it('文件不存在 → []', () => {
    expect(load(dir, 'nope')).toEqual([]);
  });
  it('非法 JSON → []', () => {
    fs.writeFileSync(path.join(dir, 'bad.json'), 'not json');
    expect(load(dir, 'bad')).toEqual([]);
  });
  it('合法 → 返回内容', () => {
    fs.writeFileSync(path.join(dir, 's.json'), JSON.stringify(['x', 'y']));
    expect(load(dir, 's')).toEqual(['x', 'y']);
  });
  it('sessionId 非法 → []', () => {
    expect(load(dir, '../etc')).toEqual([]);
  });
});

describe('save', () => {
  it('写入后可 load 读回', () => {
    save(dir, 's', ['a', 'b']);
    expect(load(dir, 's')).toEqual(['a', 'b']);
  });
  it('sessionId 非法 → 不写文件(静默)', () => {
    save(dir, '../etc', ['a']);
    expect(fs.existsSync(path.join(dir, '..', 'etc.json'))).toBe(false);
  });
});

describe('remove', () => {
  it('删除已存在文件', () => {
    save(dir, 's', ['a']);
    remove(dir, 's');
    expect(fs.existsSync(path.join(dir, 's.json'))).toBe(false);
  });
  it('文件不存在不抛错', () => {
    expect(() => remove(dir, 'nope')).not.toThrow();
  });
});

describe('prune', () => {
  it('删除不在存活集合的文件', () => {
    save(dir, 'a', ['1']);
    save(dir, 'b', ['2']);
    save(dir, 'c', ['3']);
    prune(dir, new Set(['a', 'c']));
    expect(fs.existsSync(path.join(dir, 'a.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'c.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'b.json'))).toBe(false);
  });
  it('非 *.json / 非法名文件不动', () => {
    fs.writeFileSync(path.join(dir, 'readme.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'a.json'), '[]');
    prune(dir, new Set([]));
    expect(fs.existsSync(path.join(dir, 'readme.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'a.json'))).toBe(false);
  });
});
