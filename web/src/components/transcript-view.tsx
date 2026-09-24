import { useEffect, useState } from 'react';

interface Props { cwd: string; onBack: () => void; }

interface Summary { id: string; mtime: string; size: number; preview: string; }
interface Message { role: 'user' | 'assistant'; text?: string; tool?: string; toolDetail?: string; ts?: string; }

// claude 对话历史视图：数据源是 ~/.claude/projects 的官方 transcript（jsonl），
// 结构化且 100% 完整——终端流层面（TUI 全屏重绘）还原不出干净历史，这里是权威源。
export function TranscriptView({ cwd, onBack }: Props) {
  const [list, setList] = useState<Summary[] | null>(null);
  const [detail, setDetail] = useState<{ id: string; messages: Message[] } | null>(null);

  useEffect(() => {
    let alive = true;
    setList(null);
    fetch(`/api/transcript/list?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => r.json())
      .then((items: Summary[]) => { if (alive) setList(items); })
      .catch(() => { if (alive) setList([]); });
    return () => { alive = false; };
  }, [cwd]);

  const open = (id: string) => {
    setDetail(null);
    fetch(`/api/transcript/item?cwd=${encodeURIComponent(cwd)}&id=${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((t: { messages: Message[] }) => setDetail({ id, messages: t.messages }))
      .catch(() => setDetail({ id, messages: [] }));
  };

  const fmtTime = (iso: string) => {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const fmtSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

  return (
    <div className="tv">
      <div className="tv-bar">
        {detail ? (
          <button className="tv-back" onClick={() => setDetail(null)}>← 对话列表</button>
        ) : null}
        <button className="tv-back" onClick={onBack}>← 返回终端</button>
        <span className="tv-title">💬 claude 对话历史</span>
        <span className="tv-cwd">{cwd}</span>
      </div>
      {detail ? (
        <div className="tv-msgs">
          {detail.messages.length === 0 && <div className="tv-empty">对话内容为空或加载失败</div>}
          {detail.messages.map((m, i) =>
            m.tool ? (
              <div key={i} className="tv-tool">
                <span className="tv-tool-name">⚙ {m.tool}</span>
                {m.toolDetail ? <span className="tv-tool-detail">{m.toolDetail}</span> : null}
              </div>
            ) : (
              <div key={i} className={`tv-msg ${m.role}`}>
                <div className="tv-msg-meta">{m.role === 'user' ? '你' : 'claude'}{m.ts ? ` · ${fmtTime(m.ts)}` : ''}</div>
                <div className="tv-msg-body">{m.text}</div>
              </div>
            ),
          )}
        </div>
      ) : (
        <div className="tv-list">
          {list === null && <div className="tv-empty">加载中…</div>}
          {list?.length === 0 && <div className="tv-empty">该目录下没有 claude 对话记录</div>}
          {list?.map((t) => (
            <button key={t.id} className="tv-item" onClick={() => open(t.id)}>
              <div className="tv-item-preview">{t.preview || '（无预览）'}</div>
              <div className="tv-item-meta">{fmtTime(t.mtime)} · {fmtSize(t.size)}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
