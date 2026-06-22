import { useEffect, useState } from 'react';
import type { WsClient } from '../ws-client.js';

const STORAGE_KEY = 'quick-inputs';
const DEFAULTS = ['ls -la', 'git status', 'git diff', 'clear', 'pwd', 'Ctrl-C'];

interface Props {
  client: WsClient;
  sessionId: string | null;
  onAfterSend?: () => void;
}

export function QuickInput({ client, sessionId, onAfterSend }: Props) {
  const [items, setItems] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch {
      /* ignore */
    }
    return DEFAULTS;
  });
  const [draft, setDraft] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {
      /* ignore */
    }
  }, [items]);

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
    setItems((arr) => [...arr, t]);
    setDraft('');
  };

  const remove = (idx: number) => {
    setItems((arr) => arr.filter((_, i) => i !== idx));
  };

  // 拖拽排序：从 dragIndex 拖到目标位置
  const onDrop = (to: number) => {
    if (dragIndex === null || dragIndex === to) {
      setDragIndex(null);
      return;
    }
    setItems((arr) => {
      const next = [...arr];
      const [moved] = next.splice(dragIndex, 1);
      next.splice(to, 0, moved);
      return next;
    });
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
