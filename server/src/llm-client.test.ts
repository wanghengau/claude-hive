import { describe, it, expect } from 'vitest';
import { buildAnalyzeRequest, interpretProfile, NoAnalyzerKeyError } from './llm-client.js';
import type { HarnessProfile } from './analyzer.js';

const profile: HarnessProfile = {
  sampleSize: 1, windowScope: 'all',
  system: { identity: 'I am C', rules: 'r', rulesTokens: 1 },
  tools: [], tokenOverhead: { systemTokens: 1, toolsTokens: 0, total: 1 },
  cacheStats: { avgCacheRead: 0, avgInput: 0, hitRate: 0 },
  injections: [], models: [],
};

describe('buildAnalyzeRequest', () => {
  it('拼出 /v1/messages URL + 含 system/messages 的 body', () => {
    const { url, body } = buildAnalyzeRequest(profile, { apiKey: 'k', target: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-a' });
    expect(url).toBe('https://open.bigmodel.cn/api/anthropic/v1/messages');
    expect(body.model).toBe('glm-a');
    expect(body.system).toContain('架构分析师');
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toContain('I am C');
  });
  it('target 末尾斜杠被规整', () => {
    const { url } = buildAnalyzeRequest(profile, { apiKey: 'k', target: 'https://x/api/', model: 'm' });
    expect(url).toBe('https://x/api/v1/messages');
  });
});

describe('interpretProfile', () => {
  it('缺 apiKey → 抛 NoAnalyzerKeyError，不发起请求', async () => {
    await expect(interpretProfile(profile, { apiKey: '', target: 'https://x/api', model: 'm' }))
      .rejects.toBeInstanceOf(NoAnalyzerKeyError);
  });
});
