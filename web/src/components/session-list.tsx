import { useState, memo, type CSSProperties } from 'react';
import { FixedSizeList as List } from 'react-window';
import type { SessionWithStatus } from '../use-sessions.js';

interface Props {
  sessions: SessionWithStatus[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onShowRecord?: (id: string) => void;
  onReorder: (from: number, to: number) => void;
}

const ROW_HEIGHT = 172;
const VISIBLE_CMDS = 5;

function basename(p: string): string {
  if (!p) return '';
  const clean = p.replace(/\/+$/, '');
  const seg = clean.split('/').pop();
  return seg || p;
}

// Row 必须定义在 SessionList 之外（稳定组件类型）：否则每次重渲染内联 Row 都是新引用，
// react-window 会卸载并重挂载所有行，正在进行的 HTML5 拖拽会因源 DOM 节点消失而被浏览器中断
// （表现为"第一次拖拽无效、需拖第二次"）。改用 itemData 注入数据后，dragIndex 变化只更新行属性、
// 不重挂载节点，拖拽一次即可完成。
interface RowData {
  sessions: SessionWithStatus[];
  activeId: string | null;
  dragIndex: number | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onShowRecord?: (id: string) => void;
  onReorder: (from: number, to: number) => void;
  setDragIndex: (i: number | null) => void;
}

const Row = memo(function Row({ index, style, data }: { index: number; style: CSSProperties; data: RowData }) {
  const s = data.sessions[index];
  const statusClass = s.exited ? 'st-exited' : s.running ? 'st-running' : 'st-idle';
  const statusText = s.exited ? '已退出' : s.running ? '运行中' : '等待输入';
  const cmds = s.commands.slice(-VISIBLE_CMDS);
  return (
    <div style={style} className="row-slot">
      <div
        className={
          'row' +
          (s.sessionId === data.activeId ? ' active' : '') +
          (s.exited ? ' exited' : '') +
          (data.dragIndex === index ? ' dragging' : '') +
          (data.dragIndex !== null && data.dragIndex !== index ? ' drop-target' : '')
        }
        draggable
        onDragStart={() => data.setDragIndex(index)}
        onDragOver={(e) => e.preventDefault()}
        onDragEnd={() => data.setDragIndex(null)}
        onDrop={() => {
          if (data.dragIndex !== null && data.dragIndex !== index) data.onReorder(data.dragIndex, index);
          data.setDragIndex(null);
        }}
      >
        <div className="row-head" onClick={() => data.onSelect(s.sessionId)}>
          <span className="row-cwd" title={s.cwd}>{basename(s.cwd) || s.sessionId}</span>
          {s.recordCount > 0 && (
            <span className="row-record" title={`${s.recordCount} 条录制`} onClick={(e) => { e.stopPropagation(); data.onShowRecord?.(s.sessionId); }}>●录({s.recordCount})</span>
          )}
          {s.exited && s.exitCode !== undefined && <span className="row-code">exit {s.exitCode}</span>}
          <span className={`row-status ${statusClass}`}>
            <span className="dot" />
            {statusText}
          </span>
        </div>
        <div className="row-inputs" onClick={() => data.onSelect(s.sessionId)}>
          {cmds.length === 0 ? (
            <div className="row-input-empty">（暂无输入）</div>
          ) : (
            cmds.map((c, i) => (
              <div className="row-input-line" key={i} title={c}>{c}</div>
            ))
          )}
        </div>
        <button className="row-close" draggable={false} onClick={() => data.onClose(s.sessionId)}>×</button>
      </div>
    </div>
  );
});

export function SessionList({ sessions, activeId, onSelect, onClose, onShowRecord, onReorder }: Props) {
  // 拖拽中的源行索引；为 null 表示未在拖拽
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const data: RowData = { sessions, activeId, dragIndex, onSelect, onClose, onShowRecord, onReorder, setDragIndex };
  return (
    <List
      height={window.innerHeight - 80}
      itemCount={sessions.length}
      itemSize={ROW_HEIGHT}
      width="100%"
      itemData={data}
    >
      {Row}
    </List>
  );
}
