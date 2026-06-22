import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeWindowId, recordFilePath, listRecords, countRecords, getRecord } from './record-store.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('sanitizeWindowId', () => {
  it('合法 id 原样返回', () => {
    expect(sanitizeWindowId('wmt-b2')).toBe('wmt-b2');
    expect(sanitizeWindowId('default')).toBe('default');
  });
  it('空/undefined → default', () => {
    expect(sanitizeWindowId(undefined)).toBe('default');
    expect(sanitizeWindowId('')).toBe('default');
    expect(sanitizeWindowId('   ')).toBe('default');
  });
  it('含路径穿越字符 → default（安全边界）', () => {
    expect(sanitizeWindowId('../etc')).toBe('default');
    expect(sanitizeWindowId('a/b')).toBe('default');
    expect(sanitizeWindowId('a b')).toBe('default');
    expect(sanitizeWindowId('..')).toBe('default');
  });
});

describe('recordFilePath', () => {
  it('按 windowId/date/id 分层', () => {
    const p = recordFilePath(tmp, 'wmt-b2', new Date(2026, 5, 22), '112233-aabb');
    expect(p).toBe(path.join(tmp, 'wmt-b2', '2026-06-22', '112233-aabb.json'));
  });
});

describe('listRecords', () => {
  it('跨日期倒序，仅该 windowId', () => {
    fs.mkdirSync(path.join(tmp, 'wmt-b2', '2026-06-18'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'wmt-b2', '2026-06-22'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'default', '2026-06-22'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'wmt-b2', '2026-06-18', '181642-75cc.json'), '{}');
    fs.writeFileSync(path.join(tmp, 'wmt-b2', '2026-06-22', '112342-e133.json'), '{}');
    fs.writeFileSync(path.join(tmp, 'wmt-b2', '2026-06-22', '112454-a55a.json'), '{}');
    fs.writeFileSync(path.join(tmp, 'default', '2026-06-22', '999999-zzzz.json'), '{}');
    const list = listRecords(tmp, 'wmt-b2');
    expect(list.map((e) => `${e.date}/${e.id}`)).toEqual([
      '2026-06-22/112454-a55a', '2026-06-22/112342-e133', '2026-06-18/181642-75cc',
    ]);
  });
  it('limit 截断', () => {
    fs.mkdirSync(path.join(tmp, 'wmt-b2', '2026-06-22'), { recursive: true });
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(tmp, 'wmt-b2', '2026-06-22', `10000${i}-aaaa.json`), '{}');
    expect(listRecords(tmp, 'wmt-b2', 3)).toHaveLength(3);
  });
  it('目录不存在返回空数组', () => {
    expect(listRecords(tmp, 'nope')).toEqual([]);
  });
  it('提取摘要字段', () => {
    fs.mkdirSync(path.join(tmp, 'wmt-b2', '2026-06-22'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'wmt-b2', '2026-06-22', '100000-aaaa.json'),
      JSON.stringify({ ts: '2026-06-22T02:00:00.000Z', model: 'glm-5.2', request: { model: 'glm-5.2' }, response: { usage: { input_tokens: 100, output_tokens: 50 } }, meta: { status: 200 } }));
    const e = listRecords(tmp, 'wmt-b2')[0];
    expect(e.model).toBe('glm-5.2');
    expect(e.status).toBe(200);
    expect(e.in).toBe(100);
    expect(e.out).toBe(50);
  });
});

describe('countRecords', () => {
  it('按 windowId 汇总计数', () => {
    fs.mkdirSync(path.join(tmp, 'wmt-b2', '2026-06-22'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'default', '2026-06-22'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'wmt-b2', '2026-06-22', '1-aaaa.json'), '{}');
    fs.writeFileSync(path.join(tmp, 'wmt-b2', '2026-06-22', '2-bbbb.json'), '{}');
    fs.writeFileSync(path.join(tmp, 'default', '2026-06-22', '3-cccc.json'), '{}');
    fs.mkdirSync(path.join(tmp, 'not-a-window'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'not-a-window', 'readme.txt'), 'x');
    expect(countRecords(tmp)).toEqual({ 'wmt-b2': 2, default: 1 });
  });
  it('空目录返回空对象', () => {
    expect(countRecords(tmp)).toEqual({});
  });
});

describe('getRecord', () => {
  it('返回单条完整 JSON', () => {
    fs.mkdirSync(path.join(tmp, 'wmt-b2', '2026-06-22'), { recursive: true });
    const rec = { id: '100000-aaaa', windowId: 'wmt-b2', model: 'glm-5.2' };
    fs.writeFileSync(path.join(tmp, 'wmt-b2', '2026-06-22', '100000-aaaa.json'), JSON.stringify(rec));
    expect(getRecord(tmp, 'wmt-b2', '2026-06-22', '100000-aaaa')).toEqual(rec);
  });
  it('不存在返回 null', () => {
    expect(getRecord(tmp, 'wmt-b2', '2026-06-22', 'missing')).toBeNull();
  });
  it('windowId 含穿越字符也安全（归 default 查询）', () => {
    expect(getRecord(tmp, '..', '2026-06-22', 'x')).toBeNull();
  });
});
