import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slugifyCwd, expandHome, listTranscripts, readTranscript } from './transcript.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-tr-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

function writeTranscript(slug: string, id: string, lines: object[]): void {
  const dir = path.join(home, '.claude', 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

const CID = '11111111-2222-3333-4444-555555555555';

describe('slugifyCwd / expandHome', () => {
  it('非安全字符逐个替换为 -，与 claude 实际目录名规则一致', () => {
    expect(slugifyCwd('/Users/apple/work')).toBe('-Users-apple-work');
    expect(slugifyCwd('/Users/apple/Desktop/中文目录')).toBe('-Users-apple-Desktop-----');
  });
  it('~ 前缀展开', () => {
    expect(expandHome('~', home)).toBe(home);
    expect(expandHome('~/x/y', home)).toBe(path.join(home, 'x/y'));
    expect(expandHome('/abs', home)).toBe('/abs');
  });
});

describe('listTranscripts', () => {
  it('按 mtime 倒序列出 jsonl 对话，含首条用户消息预览', () => {
    writeTranscript('-Users-x-proj', CID, [
      { type: 'mode' },
      { type: 'user', message: { content: '帮我看下这个 bug' }, timestamp: '2026-09-14T01:00:00Z' },
    ]);
    const list = listTranscripts('/Users/x/proj', home);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(CID);
    expect(list[0].preview).toBe('帮我看下这个 bug');
    expect(list[0].size).toBeGreaterThan(0);
  });
  it('目录不存在返回空数组', () => {
    expect(listTranscripts('/nowhere', home)).toEqual([]);
  });
});

describe('readTranscript', () => {
  it('解析 user 字符串与 assistant 块数组，tool_use 折叠、thinking 跳过', () => {
    writeTranscript('-Users-x-proj', CID, [
      { type: 'system', message: { content: 'env' } },
      { type: 'user', message: { content: '跑下测试' }, timestamp: '2026-09-14T01:01:00Z' },
      { type: 'assistant', timestamp: '2026-09-14T01:01:05Z', message: { content: [
        { type: 'thinking', thinking: '内部推理不应出现' },
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
        { type: 'text', text: '测试全过' },
      ] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }, // tool_result 跳过
      { type: 'assistant', message: { content: [{ type: 'text', text: '收尾' }] } },
    ]);
    const t = readTranscript('/Users/x/proj', CID, home)!;
    expect(t.messages).toEqual([
      { role: 'user', text: '跑下测试', ts: '2026-09-14T01:01:00Z' },
      { role: 'assistant', tool: 'Bash', toolDetail: '{"command":"npm test"}', ts: '2026-09-14T01:01:05Z' },
      { role: 'assistant', text: '测试全过', ts: '2026-09-14T01:01:05Z' },
      { role: 'assistant', text: '收尾', ts: undefined },
    ]);
  });
  it('非法 id / 不存在返回 null', () => {
    expect(readTranscript('/Users/x/proj', '../evil', home)).toBeNull();
    expect(readTranscript('/Users/x/proj', '99999999-9999-9999-9999-999999999999', home)).toBeNull();
  });
});
