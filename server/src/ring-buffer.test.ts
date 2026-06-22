import { describe, it, expect } from 'vitest';
import { RingBuffer } from './ring-buffer.js';

describe('RingBuffer', () => {
  it('累积并读回内容', () => {
    const rb = new RingBuffer(100);
    rb.push('hello ');
    rb.push('world');
    expect(rb.toString()).toBe('hello world');
  });

  it('超过容量时只保留末尾', () => {
    const rb = new RingBuffer(10);
    rb.push('0123456789AAAA'); // 14 字节
    expect(rb.toString()).toBe('456789AAAA'); // 末尾 10 字节
    expect(rb.toString().length).toBe(10);
  });

  it('clear 清空', () => {
    const rb = new RingBuffer(100);
    rb.push('data');
    rb.clear();
    expect(rb.toString()).toBe('');
  });
});
