import { useState, useRef, useEffect, useLayoutEffect, useCallback, memo, type CSSProperties } from 'react';
import { VariableSizeList as List } from 'react-window';
import type { SessionWithStatus } from '../use-sessions.js';
import { MirrorRow, MIRROR_ROW_H } from './iphone-mirror-card.js';

interface Props {
  sessions: SessionWithStatus[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onShowRecord?: (id: string) => void;
  onReorder: (from: number, to: number) => void;
  // iPhone 镜像：stream 非 null 时镜像卡作为一行混入列表（参与拖拽排序），
  // mirrorIndex 为其在渲染序列中的位置（钳制后）；null 表示未连接、纯会话序列
  mirrorStream: MediaStream | null;
  mirrorIndex: number | null;
  onMoveMirror: (renderIndex: number) => void;
  onStopMirror: () => void;
  // 列表底部被其他元素（idle 态 iPhone 镜像连接条）占用的高度，react-window 需要显式减去
  bottomOffset?: number;
}

const ROW_HEIGHT = 172;

// ---- 渲染序列换算：序列 = sessions 与镜像哨兵交错，镜像渲染索引 m ≡ 其上方会话数 ----
// 恒等：渲染 i < m → 会话 i；i > m → 会话 i-1（toSessionIndex 仅对会话行调用，i ≠ m）。
// m 为 null（未连接）时序列即纯 sessions，两函数退化为恒等。
export function toSessionIndex(i: number, m: number | null): number {
  return m === null || i < m ? i : i - 1;
}
export function toRenderIndex(k: number, m: number | null): number {
  return m === null || k < m ? k : k + 1;
}

function basename(p: string): string {
  if (!p) return '';
  const clean = p.replace(/\/+$/, '');
  const seg = clean.split('/').pop();
  return seg || p;
}

// Row / MirrorSlot 必须定义在 SessionList 之外（稳定组件类型）：否则每次重渲染内联组件
// 都是新引用，react-window 会卸载并重挂载所有行，正在进行的 HTML5 拖拽会因源 DOM 节点
// 消失而被浏览器中断（表现为"第一次拖拽无效、需拖第二次"）。改用 itemData 注入数据后，
// dragIndex 变化只更新行属性、不重挂载节点，拖拽一次即可完成。

interface RowData {
  sessions: SessionWithStatus[];
  activeId: string | null;
  dragIndex: number | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onShowRecord?: (id: string) => void;
  onReorder: (from: number, to: number) => void;
  setDragIndex: (i: number | null) => void;
  mirrorIndex: number | null;
  mirrorStream: MediaStream | null;
  onMoveMirror: (renderIndex: number) => void;
  onStopMirror: () => void;
}

// 镜像行槽：标题条是拖拽源（画面区的 pointer pan 手势不能被 HTML5 DnD 劫走，
// 因此 draggable 只挂在 .mirror-head 上，由 MirrorRow 透传）。
// drop 换算（会话 s 被拖到镜像上 = 挪到镜像上方一组的末尾，above-group 长度恒为 m）：
// sf = toSessionIndex(d, m)，to = sf < m ? m - 1 : m（sf<m 蕴含 m≥1，sf≥m 蕴含 m≤n-1，无越界）
const MirrorSlot = memo(function MirrorSlot({ style, data }: { style: CSSProperties; data: RowData }) {
  const m = data.mirrorIndex!;
  return (
    <div style={style} className="row-slot">
      <div
        className={
          'mirror-row-card' +
          (data.dragIndex === m ? ' dragging' : '') +
          (data.dragIndex !== null && data.dragIndex !== m ? ' drop-target' : '')
        }
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => {
          const d = data.dragIndex;
          if (d === null || d === m) { data.setDragIndex(null); return; }
          const sf = toSessionIndex(d, m);
          const to = sf < m ? m - 1 : m;
          if (sf !== to) data.onReorder(sf, to);
          data.setDragIndex(null); // 自带清尾：镜像未动但换算后可能原地，dragend 兜底不可依赖
        }}
      >
        <MirrorRow
          stream={data.mirrorStream!}
          onStop={data.onStopMirror}
          headDraggable
          onHeadDragStart={() => data.setDragIndex(m)}
          onHeadDragEnd={() => data.setDragIndex(null)}
        />
      </div>
    </div>
  );
});

// 分流组件：自身不含 hooks（否则同一实例在会话行/镜像行间换型时 hooks 数量不一致，
// 违反 React hooks 规则），只按哨兵位把渲染交给 SessionRow 或 MirrorSlot
const Item = memo(function Item({ index, style, data }: { index: number; style: CSSProperties; data: RowData }) {
  if (data.mirrorIndex !== null && index === data.mirrorIndex) {
    return <MirrorSlot style={style} data={data} />;
  }
  return <SessionRow index={index} style={style} data={data} />;
});

const SessionRow = memo(function SessionRow({ index, style, data }: { index: number; style: CSSProperties; data: RowData }) {
  const s = data.sessions[toSessionIndex(index, data.mirrorIndex)];
  const inputsRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const statusClass = s.exited ? 'st-exited' : s.running ? 'st-running' : 'st-idle';
  const statusText = s.exited ? '已退出' : s.running ? '运行中' : '等待输入';
  const cmds = s.commands;
  useLayoutEffect(() => {
    const el = inputsRef.current;
    if (!el) return;
    if (pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [s.commands.length, s.sessionId]);
  // 用原生 addEventListener(passive:false)而非 React onWheel：React 17+ 把合成 wheel 事件
  // 注册为 passive listener，合成事件里的 preventDefault 会被浏览器忽略，无法阻止默认滚动
  // 祖先链（滚到顶后会带动外层 react-window 列表）。passive:false 才能 preventDefault，与
  // 主窗口终端(main-terminal.tsx)滚轮拦截方案一致。
  useEffect(() => {
    const el = inputsRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      let dy = e.deltaY;
      if (e.deltaMode === 1) {
        dy *= 18; // DOM_DELTA_LINE → px
      } else if (e.deltaMode === 2) {
        dy *= el.clientHeight; // DOM_DELTA_PAGE → px
      }
      el.scrollTop += dy;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
      pinnedRef.current = atBottom;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const handleMouseLeave = useCallback(() => {
    pinnedRef.current = true;
    const el = inputsRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);
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
          const d = data.dragIndex;
          if (d === null || d === index) { data.setDragIndex(null); return; }
          if (data.mirrorIndex !== null && d === data.mirrorIndex) {
            // 镜像→会话行：镜像占据该渲染槽（"渲染索引≡上方会话数"使双向公式统一）
            data.onMoveMirror(index);
          } else {
            // 会话↔会话：现状语义（哨兵索引不变，reorder 只交换等高行，无需 reset）
            const from = toSessionIndex(d, data.mirrorIndex);
            const to = toSessionIndex(index, data.mirrorIndex);
            if (from !== to) data.onReorder(from, to);
          }
          data.setDragIndex(null); // 必须自带清尾：镜像移动后哨兵处组件换型重挂，dragend 会丢
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
        <div
          ref={inputsRef}
          className="row-inputs"
          onClick={() => data.onSelect(s.sessionId)}
          onMouseLeave={handleMouseLeave}
        >
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

export function SessionList({
  sessions, activeId, onSelect, onClose, onShowRecord, onReorder,
  mirrorStream, mirrorIndex, onMoveMirror, onStopMirror, bottomOffset = 0,
}: Props) {
  // 拖拽中的源行索引（渲染序列索引，可指向镜像哨兵）；为 null 表示未在拖拽
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const listRef = useRef<List | null>(null);
  const n = sessions.length;
  // 钳制：会话关闭后 mirrorIndex 可能越界（内存态、无持久化），派生时收敛到 [0, n]
  const m = mirrorIndex === null ? null : Math.min(mirrorIndex, n);
  const data: RowData = {
    sessions, activeId, dragIndex, onSelect, onClose, onShowRecord, onReorder, setDragIndex,
    mirrorIndex: m, mirrorStream, onMoveMirror, onStopMirror,
  };
  // 仅镜像位置或会话数变化才失效尺寸缓存（itemMetadataMap 按渲染索引存高度，哨兵
  // 移位 = 高度分布变化）；reorder 只交换等高行、偏移依旧成立，无需 reset。
  // 必须放 useLayoutEffect：resetAfterIndex 同步 forceUpdate，事件处理器里紧随 setState
  // 调用会用旧闭包把缓存重新填满旧高度，随后新状态提交反而命中脏缓存。
  useLayoutEffect(() => { listRef.current?.resetAfterIndex(0); }, [m, n]);
  return (
    <List
      ref={listRef}
      height={window.innerHeight - 80 - bottomOffset}
      itemCount={n + (m === null ? 0 : 1)}
      itemSize={(i: number) => (m !== null && i === m ? MIRROR_ROW_H : ROW_HEIGHT)}
      estimatedItemSize={ROW_HEIGHT}
      width="100%"
      itemData={data}
    >
      {Item}
    </List>
  );
}
