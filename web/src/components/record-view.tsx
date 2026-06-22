import { useEffect, useState } from 'react';
import type { RecordSummary } from '../types.js';

interface Props { windowId: string; onBack: () => void; }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = any;

export function RecordView({ windowId, onBack }: Props) {
  const [items, setItems] = useState<RecordSummary[]>([]);
  const [sel, setSel] = useState<Rec | null>(null);
  const [tab, setTab] = useState('response');

  useEffect(() => {
    let alive = true;
    fetch(`/api/record/list?window=${encodeURIComponent(windowId)}`).then((r) => r.json()).then((list: RecordSummary[]) => { if (alive) setItems(list); }).catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [windowId]);

  const open = async (date: string, id: string) => {
    const r = await fetch(`/api/record/${encodeURIComponent(windowId)}/${date}/${id}`);
    setSel(await r.json());
    setTab('response');
  };

  const idToTime = (id: string) => `${id.slice(0, 2)}:${id.slice(2, 4)}:${id.slice(4, 6)}`;

  return (
    <div className="record-view">
      <div className="rv-bar">
        <button className="rv-back" onClick={onBack}>← 返回终端</button>
        <span className="rv-title">录制 · {windowId}</span>
        <span className="rv-count">{items.length}</span>
      </div>
      <div className="rv-body">
        <aside className="rv-list">
          {items.length === 0 ? <div className="rv-empty">无录制</div> : items.map((it) => (
            <div className="rv-item" key={`${it.date}/${it.id}`} onClick={() => open(it.date, it.id)}>
              <span className={`rv-dot s${it.status ? String(it.status)[0] : ''}`} />
              <div className="rv-item-main">
                <div className="rv-item-top"><span className="rv-time">{it.date} {idToTime(it.id)}</span><span className="rv-code">{it.status ?? ''}</span></div>
                <div className="rv-model">{it.model ?? '?'}</div>
                <div className="rv-tok">↑{it.in} ↓{it.out}</div>
              </div>
            </div>
          ))}
        </aside>
        <main className="rv-detail">
          {!sel ? <div className="rv-empty">选择左侧请求查看详情</div> : (
            <>
              <MetaBar rec={sel} />
              <nav className="rv-tabs">
                {['response', 'system', 'messages', 'tools', 'raw'].map((t) => (
                  <button key={t} className={`rv-tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t}</button>
                ))}
              </nav>
              <div className="rv-tab-body">
                {tab === 'response' && <ResponseTab rec={sel} />}
                {tab === 'system' && <SystemTab sys={sel.request?.system} />}
                {tab === 'messages' && <MessagesTab messages={sel.request?.messages} />}
                {tab === 'tools' && <ToolsTab tools={sel.request?.tools} />}
                {tab === 'raw' && <pre className="rv-pre">{JSON.stringify(sel, null, 2)}</pre>}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

const MetaBar = ({ rec }: { rec: Rec }) => {
  const u = rec.response?.usage || {};
  const m = rec.meta || {};
  return (
    <div className="rv-meta">
      <Kv k="model" v={rec.model ?? '?'} />
      <Kv k="status" v={String(m.status ?? '?')} />
      <Kv k="耗时" v={m.duration_ms != null ? `${m.duration_ms}ms` : '?'} />
      <Kv k="输入" v={String(u.input_tokens || 0)} />
      <Kv k="输出" v={String(u.output_tokens || 0)} />
      {m.truncated && <span className="rv-flag warn">truncated</span>}
      {m.injected_websearch && <span className="rv-flag">web_search</span>}
    </div>
  );
};
const Kv = ({ k, v }: { k: string; v: string }) => (<div className="rv-kv"><div className="rv-k">{k}</div><div className="rv-v">{v}</div></div>);

const ResponseTab = ({ rec }: { rec: Rec }) => {
  const text = rec.response?.text;
  return (<>{text ? <pre className="rv-pre">{text}</pre> : <div className="rv-empty">无响应文本</div>}{rec.response?.stop_reason && <div className="rv-stop">stop_reason: {rec.response.stop_reason}</div>}</>);
};
const SystemTab = ({ sys }: { sys: Rec }) => {
  if (!sys) return <div className="rv-empty">无 system prompt</div>;
  const parts: string[] = typeof sys === 'string' ? [sys] : Array.isArray(sys) ? sys.map((s: Rec) => s?.text || '').filter(Boolean) : [JSON.stringify(sys, null, 2)];
  return (<details open><summary>system 全文</summary>{parts.map((t, i) => <pre className="rv-pre" key={i}>{t}</pre>)}</details>);
};
const MessagesTab = ({ messages }: { messages: Rec[] }) => {
  if (!Array.isArray(messages) || !messages.length) return <div className="rv-empty">无消息</div>;
  return (<>{messages.map((m, i) => (<div className={`rv-msg role-${m.role}`} key={i}><div className="rv-msg-head"><span className="rv-role">{m.role}</span><span className="rv-idx">#{i}</span></div><Content c={m.content} /></div>))}</>);
};
const ToolsTab = ({ tools }: { tools: Rec[] }) => {
  if (!Array.isArray(tools) || !tools.length) return <div className="rv-empty">无工具</div>;
  return (<>{tools.map((t, i) => (<details key={i}><summary><span className="rv-tool-name">{t.name || t.type}</span></summary>{t.description && <p className="rv-tool-desc">{t.description}</p>}{t.input_schema && <pre className="rv-pre">{JSON.stringify(t.input_schema, null, 2)}</pre>}</details>))}</>);
};
const Content = ({ c }: { c: Rec }) => {
  if (c == null) return <span className="rv-muted">（空）</span>;
  if (typeof c === 'string') return <div className="rv-text">{c}</div>;
  if (Array.isArray(c)) return (<>{c.map((b, i) => <Block key={i} b={b} />)}</>);
  return <pre className="rv-pre">{JSON.stringify(c, null, 2)}</pre>;
};
const Block = ({ b }: { b: Rec }) => {
  if (b?.type === 'text') return <div className="rv-text">{b.text}</div>;
  if (b?.type === 'tool_use') return (<details><summary><span className="rv-blk use">tool_use</span> {b.name}</summary><pre className="rv-pre">{JSON.stringify(b.input ?? {}, null, 2)}</pre></details>);
  if (b?.type === 'tool_result') return (<details><summary><span className={`rv-blk result${b.is_error ? ' err' : ''}`}>tool_result</span></summary><div className="rv-result"><Content c={b.content} /></div></details>);
  if (b?.type === 'thinking') return (<details><summary><span className="rv-blk think">thinking</span></summary><pre className="rv-pre">{b.thinking}</pre></details>);
  return <pre className="rv-pre">{JSON.stringify(b, null, 2)}</pre>;
};
