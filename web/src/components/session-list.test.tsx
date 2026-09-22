import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { SessionList, toSessionIndex, toRenderIndex } from './session-list.js';
import { MIRROR_ROW_H } from './iphone-mirror-card.js';
import type { SessionWithStatus } from '../use-sessions.js';

// ---- 纯函数表测：渲染序列 ↔ sessions 序列换算 ----
// 模型：镜像渲染索引 m ≡ 其上方会话数（0=顶、n=底、null=未连接）
describe('toSessionIndex / toRenderIndex', () => {
  it('m=null（未连接）：纯会话序列，双射恒等', () => {
    for (let i = 0; i < 5; i++) {
      expect(toSessionIndex(i, null)).toBe(i);
      expect(toRenderIndex(i, null)).toBe(i);
    }
  });
  it('m=0（镜像在顶）：渲染 i 的会话为 i-1', () => {
    expect(toSessionIndex(1, 0)).toBe(0);
    expect(toSessionIndex(4, 0)).toBe(3);
    expect(toRenderIndex(0, 0)).toBe(1);
    expect(toRenderIndex(3, 0)).toBe(4);
  });
  it('m 居中：上方恒等、下方减一', () => {
    const m = 2;
    expect(toSessionIndex(0, m)).toBe(0);
    expect(toSessionIndex(1, m)).toBe(1);
    expect(toSessionIndex(3, m)).toBe(2);
    expect(toRenderIndex(0, m)).toBe(0);
    expect(toRenderIndex(2, m)).toBe(3);
    expect(toRenderIndex(4, m)).toBe(5);
  });
});

// ---- DOM 集成：拖拽排序协议 ----

function makeSession(id: string): SessionWithStatus {
  return {
    sessionId: id, cwd: `/tmp/${id}`, cols: 80, rows: 24, running: false,
    exited: false, commands: [], recordCount: 0, createdAt: 0,
  } as SessionWithStatus;
}
const makeSessions = (...ids: string[]) => ids.map(makeSession);

// jsdom 无布局，react-window 视口高度来自 props：stub 大 innerHeight 让全部行渲染
beforeEach(() => {
  Object.defineProperty(window, 'innerHeight', { value: 3000, configurable: true });
});

// 真实镜像卡按 cwd 定位（.row-cwd 文本），镜像行按 .mirror-row-card 定位
function rowOf(id: string) {
  return Array.from(document.querySelectorAll('.row')).find((r) => r.querySelector('.row-cwd')?.textContent === id)!;
}
const mirrorCard = () => document.querySelector('.mirror-row-card')!;
// 镜像槽外层是 react-window 的行 div（style 上有高度/偏移）
function mirrorSlotStyle() {
  const slot = mirrorCard()!.parentElement!;
  return slot.style;
}

// 与 App 层同构：真实持有 mirrorIndex state，drop 后重渲染换位
function ListHarness({ sessions, initialMirror, stream }: {
  sessions: SessionWithStatus[];
  initialMirror: number | null;
  stream: MediaStream;
}) {
  const [mirrorIndex, setMirrorIndex] = useState(initialMirror);
  return (
    <SessionList
      sessions={sessions}
      activeId={null}
      onSelect={() => {}}
      onClose={() => {}}
      onReorder={reorderSpy}
      mirrorStream={stream}
      mirrorIndex={mirrorIndex}
      onMoveMirror={(i) => { moveMirrorSpy(i); setMirrorIndex(i); }}
      onStopMirror={() => {}}
    />
  );
}

const reorderSpy = vi.fn<(from: number, to: number) => void>();
const moveMirrorSpy = vi.fn<(i: number) => void>();
const fakeStream = { getVideoTracks: () => [], getTracks: () => [] } as unknown as MediaStream;

function mount(sessions: SessionWithStatus[], initialMirror: number | null) {
  reorderSpy.mockClear();
  moveMirrorSpy.mockClear();
  return render(<ListHarness sessions={sessions} initialMirror={initialMirror} stream={fakeStream} />);
}

// jsdom 的 HTML5 DnD：fireEvent 直接触发 React 合成事件；协议不读 dataTransfer
function dragFrom(el: Element) { fireEvent.dragStart(el); }
function dropOn(el: Element) { fireEvent.dragOver(el); fireEvent.drop(el); }

describe('SessionList 镜像行拖拽排序', () => {
  it('镜像行高 MIRROR_ROW_H、后续会话行偏移正确（resetAfterIndex 生效）', () => {
    mount(makeSessions('a', 'b', 'c'), 1);
    expect(mirrorSlotStyle().height).toBe(`${MIRROR_ROW_H}px`);
    // 镜像在渲染 1：a(0, top 0) 镜像(1, top 172) b(2, top 172+460) c(3)
    expect(mirrorSlotStyle().top).toBe('172px');
    const bSlot = rowOf('b').parentElement!;
    expect(bSlot.style.top).toBe(`${172 + MIRROR_ROW_H}px`);
  });

  it('镜像 → 会话行：onMoveMirror 收到目标渲染索引（双向统一 m\'=t）', async () => {
    mount(makeSessions('a', 'b', 'c'), 3); // 镜像在底（渲染 3）
    dragFrom(document.querySelector('.mirror-head')!);
    dropOn(rowOf('a')); // 渲染 0
    expect(moveMirrorSpy).toHaveBeenCalledWith(0);
    // Harness 状态更新后镜像卡换位到顶部
    await waitFor(() => expect(mirrorSlotStyle().top).toBe('0px'));
    expect(reorderSpy).not.toHaveBeenCalled();
  });

  it('会话 → 镜像行（sf < m）：挪到镜像上方一组之末 to = m-1', () => {
    // 4 会话镜像在 m=1：渲染 [a, M, b, c, d]。拖 d（渲染 4，sf=3 ≥ m → to=m=1）
    mount(makeSessions('a', 'b', 'c', 'd'), 1);
    dragFrom(rowOf('d'));
    dropOn(mirrorCard());
    expect(reorderSpy).toHaveBeenCalledWith(3, 1);
  });

  it('会话 → 镜像行（sf < m）：to = m-1（上方组内重排）', () => {
    // 3 会话镜像在 m=2：渲染 [a, b, M, c]。拖 a（渲染 0，sf=0 < 2 → to=1）
    mount(makeSessions('a', 'b', 'c'), 2);
    dragFrom(rowOf('a'));
    dropOn(mirrorCard());
    expect(reorderSpy).toHaveBeenCalledWith(0, 1);
  });

  it('跨镜像的会话互拖：索引经哨兵换算', () => {
    // 渲染 [a, M, b]：拖 b（渲染 2，sf=1）到 a（渲染 0）→ reorder(1, 0)
    mount(makeSessions('a', 'b'), 1);
    dragFrom(rowOf('b'));
    dropOn(rowOf('a'));
    expect(reorderSpy).toHaveBeenCalledWith(1, 0);
    expect(moveMirrorSpy).not.toHaveBeenCalled();
  });

  it('自落（拖到自身）→ no-op，仅清拖拽态', () => {
    mount(makeSessions('a', 'b'), 2);
    dragFrom(rowOf('a'));
    dropOn(rowOf('a'));
    expect(reorderSpy).not.toHaveBeenCalled();
    // 拖拽态已清：卡片不再带 dragging/drop-target
    expect(rowOf('a').className).not.toContain('dragging');
    expect(rowOf('a').className).not.toContain('drop-target');
  });

  it('镜像自落 → no-op', () => {
    mount(makeSessions('a', 'b'), 1);
    dragFrom(document.querySelector('.mirror-head')!);
    dropOn(mirrorCard());
    expect(reorderSpy).not.toHaveBeenCalled();
    expect(moveMirrorSpy).not.toHaveBeenCalled();
    expect(mirrorCard()!.className).not.toContain('dragging');
  });

  it('mirrorIndex 越界（会话被关闭）→ 钳制到 n 不崩、镜像垫底', () => {
    mount(makeSessions('a', 'b'), 5);
    expect(mirrorSlotStyle().top).toBe(`${172 * 2}px`); // 渲染 2 = 两行会话之后
    dragFrom(document.querySelector('.mirror-head')!);
    dropOn(rowOf('a'));
    expect(moveMirrorSpy).toHaveBeenCalledWith(0);
  });
});
