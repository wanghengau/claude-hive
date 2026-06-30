import { describe, it, expect } from 'vitest';
import { estimateTokens, pickMostFrequent, textOf } from './analyzer.js';

describe('estimateTokens', () => {
  it('英文按 /4 向上取整', () => {
    expect(estimateTokens('hello world')).toBe(3); // 11/4=2.75→3
  });
  it('中文按字符数计', () => {
    expect(estimateTokens('你好世界')).toBe(4);
  });
  it('中英混合', () => {
    expect(estimateTokens('你好 ab')).toBe(3); // 2 CJK + 3 non-CJK(含空格): ceil(2 + 3/4)=ceil(2.75)→3
  });
  it('空串为 0', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('pickMostFrequent', () => {
  it('取出现次数最多的版本', () => {
    const m = new Map<string, { count: number; value: string }>();
    const add = (k: string, v: string) => m.set(k, { count: (m.get(k)?.count ?? 0) + 1, value: v });
    add('a', 'A'); add('b', 'B'); add('b', 'B');
    expect(pickMostFrequent(m)).toBe('B');
  });
  it('空 map 返回 undefined', () => {
    expect(pickMostFrequent(new Map())).toBeUndefined();
  });
});

describe('textOf', () => {
  it('字符串原样返回', () => {
    expect(textOf('hi')).toBe('hi');
  });
  it('{type,text} 取 text', () => {
    expect(textOf({ type: 'text', text: 'hello' })).toBe('hello');
  });
  it('null/空对象返回空串', () => {
    expect(textOf(null)).toBe('');
    expect(textOf({})).toBe('');
  });
});
