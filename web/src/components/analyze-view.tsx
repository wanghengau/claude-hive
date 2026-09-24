import { useEffect, useState } from 'react';
import type { HarnessProfile } from '../types.js';

interface Props { onBack: () => void; }

export function AnalyzeView({ onBack }: Props) {
  const [profile, setProfile] = useState<HarnessProfile | null>(null);
  const [interp, setInterp] = useState<{ text?: string; error?: string; fallbackPrompt?: string; message?: string } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/analyze/harness')
      .then((r) => r.json())
      .then((p: HarnessProfile) => { if (alive) setProfile(p); })
      .catch(() => { if (alive) setProfile(null); });
    return () => { alive = false; };
  }, []);

  const genInterp = async () => {
    setLoading(true);
    setInterp(null);
    try {
      const r = await fetch('/api/analyze/interpret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      setInterp(await r.json());
    } catch (e) {
      setInterp({ error: 'fetch_failed', fallbackPrompt: String(e) });
    } finally {
      setLoading(false);
    }
  };

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text);
  };

  if (!profile) {
    return (
      <div className="analyze-view">
        <div className="az-bar">
          <button className="az-back" onClick={onBack}>← 返回</button>
          <span className="az-title">分析 harness</span>
        </div>
        <div className="az-empty">加载中…</div>
      </div>
    );
  }

  return (
    <div className="analyze-view">
      <div className="az-bar">
        <button className="az-back" onClick={onBack}>← 返回</button>
        <span className="az-title">🔧 harness 结构分析</span>
        <span className="az-sub">{profile.sampleSize} 条 · {profile.windowScope}</span>
      </div>
      <div className="az-body">
        <section className="az-card">
          <h3>① 身份</h3>
          <p className="az-identity">{profile.system.identity || '（无）'}</p>
          <details>
            <summary>完整规则（{profile.system.rulesTokens} tok）</summary>
            <pre className="az-pre">{profile.system.rules || '（无）'}</pre>
          </details>
        </section>

        <section className="az-card">
          <h3>② 能力集（{profile.tools.length} 个工具）</h3>
          <ul className="az-tools">
            {profile.tools.map((t) => (
              <li key={t.name}>
                <span className="az-tool-name">{t.name}</span>
                <span className="az-tool-tok">{t.descTokens}+{t.schemaTokens} tok</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="az-card az-kv-grid">
          <h3>③ 固定开销 / ④ 缓存</h3>
          <div className="az-kv"><span>system</span><b>{profile.tokenOverhead.systemTokens}</b></div>
          <div className="az-kv"><span>tools</span><b>{profile.tokenOverhead.toolsTokens}</b></div>
          <div className="az-kv"><span>合计</span><b>{profile.tokenOverhead.total}</b></div>
          <div className="az-kv"><span>cache_read</span><b>{profile.cacheStats.avgCacheRead}</b></div>
          <div className="az-kv"><span>input</span><b>{profile.cacheStats.avgInput}</b></div>
          <div className="az-kv"><span>命中率</span><b>{Math.round(profile.cacheStats.hitRate * 100)}%</b></div>
        </section>

        {profile.injections.length > 0 && (
          <section className="az-card">
            <h3>⑤ 上下文注入（role=system）</h3>
            {profile.injections.map((inj, n) => (
              <div className="az-inj" key={n}>
                <span>{inj.chars} 字符 / {inj.tokens} tok</span>
                <pre className="az-pre">{inj.preview}…</pre>
              </div>
            ))}
          </section>
        )}

        <section className="az-card">
          <h3>⑥ 模型分布</h3>
          <ul className="az-models">
            {profile.models.map((m) => (
              <li key={m.model}>
                <span>{m.model}</span>
                <b>{m.count}</b>
              </li>
            ))}
          </ul>
        </section>

        <section className="az-card">
          <h3>LLM 解读：这个 harness 怎么设计的</h3>
          <button className="az-gen" onClick={genInterp} disabled={loading}>
            {loading ? '生成中…' : '生成解读'}
          </button>
          {interp?.text && <pre className="az-pre az-interp">{interp.text}</pre>}
          {interp?.error && (
            <div className="az-fallback">
              <p>解读失败（{interp.error}{interp.message ? `：${interp.message}` : ''}）。可复制下方 prompt 到任意 LLM：</p>
              <button onClick={() => interp.fallbackPrompt && copy(interp.fallbackPrompt)}>复制 prompt</button>
              <pre className="az-pre">{interp.fallbackPrompt}</pre>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
