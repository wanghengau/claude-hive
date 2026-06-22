import type { CSSProperties } from 'react';
import { FixedSizeList as List } from 'react-window';
import type { SessionWithStatus } from '../use-sessions.js';

interface Props {
  sessions: SessionWithStatus[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onShowRecord?: (id: string) => void;
}

const ROW_HEIGHT = 172;
const VISIBLE_CMDS = 5;

function basename(p: string): string {
  if (!p) return '';
  const clean = p.replace(/\/+$/, '');
  const seg = clean.split('/').pop();
  return seg || p;
}

export function SessionList({ sessions, activeId, onSelect, onClose, onShowRecord }: Props) {
  const Row = ({ index, style }: { index: number; style: CSSProperties }) => {
    const s = sessions[index];
    const statusClass = s.exited ? 'st-exited' : s.running ? 'st-running' : 'st-idle';
    const statusText = s.exited ? '已退出' : s.running ? '运行中' : '等待输入';
    const cmds = s.commands.slice(-VISIBLE_CMDS);
    return (
      <div style={style} className="row-slot">
        <div className={`row ${s.sessionId === activeId ? 'active' : ''} ${s.exited ? 'exited' : ''}`}>
          <div className="row-head" onClick={() => onSelect(s.sessionId)}>
            <span className="row-cwd" title={s.cwd}>{basename(s.cwd) || s.sessionId}</span>
            {s.recordCount > 0 && (
              <span className="row-record" title={`${s.recordCount} 条录制`} onClick={(e) => { e.stopPropagation(); onShowRecord?.(s.sessionId); }}>●录({s.recordCount})</span>
            )}
            {s.exited && s.exitCode !== undefined && <span className="row-code">exit {s.exitCode}</span>}
            <span className={`row-status ${statusClass}`}>
              <span className="dot" />
              {statusText}
            </span>
          </div>
          <div className="row-inputs" onClick={() => onSelect(s.sessionId)}>
            {cmds.length === 0 ? (
              <div className="row-input-empty">（暂无输入）</div>
            ) : (
              cmds.map((c, i) => (
                <div className="row-input-line" key={i} title={c}>{c}</div>
              ))
            )}
          </div>
          <button className="row-close" onClick={() => onClose(s.sessionId)}>×</button>
        </div>
      </div>
    );
  };

  return (
    <List height={window.innerHeight - 80} itemCount={sessions.length} itemSize={ROW_HEIGHT} width="100%">
      {Row}
    </List>
  );
}
