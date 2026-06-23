import { useEffect, useState } from 'react';
import type { WsClient } from '../ws-client.js';

const DEFAULTS = ['ls -la', 'git status', 'git diff', 'clear', 'pwd', 'Ctrl-C'];
const API = '/api/quick-commands';

interface Props {
  client: WsClient;
  sessionId: string | null;
  onAfterSend?: () => void;
}

export function QuickInput({ client, sessionId, onAfterSend }: Props) {
  // 加载前先显示默认值，避免首屏空
  const [items, setItems] = useState<string[]>(DEFAULTS);
  const [draft, setDraft] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  // 每次加载：用项目文件 quick-commands.json 的内容加载
  useEffect(() => {
    let alive = true;
    fetch(API)
      .then((r) => r.json())
      .then((arr: unknown) => {
        if (alive && Array.isArray(arr) && arr.every((x) => typeof x === 'string')) setItems(arr as string[]);
      })
      .catch(() => { /* 加载失败保留默认 */ });
    return () => { alive = false; };
  }, []);

  // 修改后同步写回项目文件
  const persist = (next: string[]) => {
    setItems(next);
    fetch(API, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
    }).catch(() => { /* 忽略写失败 */ });
  };

  const send = (text: string) => {
    if (!sessionId) return;
    if (text === 'Ctrl-C') {
      client.send({ type: 'input', sessionId, data: '\x03' });
    } else {
      client.send({ type: 'input', sessionId, data: text + '\r' });
    }
    onAfterSend?.();
  };

  const add = () => {
    const t = draft.trim();
    if (!t || items.includes(t)) return;
    persist([...items, t]);
    setDraft('');
  };

  const remove = (idx: number) => {
    persist(items.filter((_, i) => i !== idx));
  };

  // 拖拽排序：从 dragIndex 拖到目标位置
  const onDrop = (to: number) => {
    if (dragIndex === null || dragIndex === to) {
      setDragIndex(null);
      return;
    }
    const next = [...items];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(to, 0, moved);
    persist(next);
    setDragIndex(null);
  };

  return (
    <div className="quick-input">
      <div className="qi-items">
        {items.map((it, i) => (
          <span
            className={
              'qi-chip' +
              (dragIndex === i ? ' qi-dragging' : '') +
              (dragIndex !== null && dragIndex !== i ? ' qi-drop-target' : '')
            }
            key={`${it}-${i}`}
            draggable
            onDragStart={() => setDragIndex(i)}
            onDragOver={(e) => e.preventDefault()}
            onDragEnd={() => setDragIndex(null)}
            onDrop={() => onDrop(i)}
          >
            <button className="qi-send" onClick={() => send(it)} disabled={!sessionId}>{it}</button>
            <button className="qi-del" onClick={() => remove(i)} title="删除">×</button>
          </span>
        ))}
      </div>
      <div className="qi-add">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          placeholder="+ 添加快捷命令（回车添加，可拖拽排序）"
        />
        <button onClick={add}>添加</button>
      </div>
    </div>
  );
}
