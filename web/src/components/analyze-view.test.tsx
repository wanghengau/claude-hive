import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AnalyzeView } from './analyze-view.js';
import type { HarnessProfile } from '../types.js';

const profile: HarnessProfile = {
  sampleSize: 42, windowScope: 'all',
  system: { identity: 'I am Claude Code', rules: 'rules text', rulesTokens: 10 },
  tools: [{ name: 'Bash', desc: 'shell', descTokens: 2, schemaTokens: 1 }],
  tokenOverhead: { systemTokens: 10, toolsTokens: 3, total: 13 },
  cacheStats: { avgCacheRead: 100, avgInput: 50, hitRate: 0.67 },
  injections: [{ chars: 80, tokens: 60, preview: 'CLAUDE.md...' }],
  models: [{ model: 'glm-a', count: 42 }],
};

describe('AnalyzeView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fetch harness 并渲染采样数与工具', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(profile) }));
    render(<AnalyzeView onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText(/42 条/)).toBeInTheDocument());
    expect(screen.getByText('Bash')).toBeInTheDocument();
  });

  it('未配 key 点生成解读 → 展示降级 prompt', async () => {
    const seq = [
      { ok: true, json: () => Promise.resolve(profile) },
      { ok: true, json: () => Promise.resolve({ error: 'no_analyzer_key', fallbackPrompt: 'PASTE ME' }) },
    ];
    let i = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(seq[i++ % seq.length])));
    render(<AnalyzeView onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText(/42 条/)).toBeInTheDocument());
    screen.getByText('生成解读').click();
    await waitFor(() => expect(screen.getByText(/PASTE ME/)).toBeInTheDocument());
  });
});
