import { describe, it, expect } from 'vitest';
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
