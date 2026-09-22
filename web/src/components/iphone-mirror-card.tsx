import { useEffect, useRef, useState, useCallback } from 'react';

// idle 态侧栏底部连接条高度。流式时镜像卡进入会话列表（见 session-list.tsx 的
// MirrorSlot），侧栏底部不再占位，App.tsx 据此切换 SessionList 的 bottomOffset。
export const MIRROR_BAR_H = 44;
// 流式态镜像行在会话列表中的卡片高度：与会话行（session-list 的 ROW_HEIGHT）等高，
// 侧栏卡片尺寸统一；画面 contain fit 后偏小，可卡内滚轮放大细看
export const MIRROR_ROW_H = 172;
// 画面缩放：只保 1x 下限（缩到底=画布原始冻结尺寸），放大不设上限
const MAX_S = Infinity;
// 流分辨率未知时的兜底比例（iPhone 竖屏）
const FALLBACK_STREAM_W = 318;
const FALLBACK_STREAM_H = 701;
// ⌃+双指上划透传：累计阈值/冷却/累计重置间隔(ms)。自然滚动下双指上划 deltaY>0；
// 若系统关闭自然滚动方向不符，翻转此符号即可
const SWIPE_UP_DELTA_SIGN = 1;
const SWIPE_TRIGGER_DELTA = 120;
const SWIPE_COOLDOWN_MS = 800;
const SWIPE_RESET_GAP_MS = 600;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

// 平移范围双向泛化：内容小于视口时 [0, 视口-内容] 内自由移动（1x 居中），
// 大于视口时 [视口-内容, 0] 边缘不出界
function clampShift(t: number, s: number, viewSize: number, canvasSize: number) {
  const span = viewSize - canvasSize * s;
  return clamp(t, Math.min(0, span), Math.max(0, span));
}

// idle 态侧栏底部连接条：点击发起屏幕共享选择
export function MirrorBar({ onStart }: { onStart: () => void }) {
  return (
    <div className="mirror-card" style={{ height: MIRROR_BAR_H }}>
      <button className="mirror-connect" onClick={onStart} title="选择共享「iPhone镜像」窗口">
        📱 iPhone 镜像 · 连接
      </button>
    </div>
  );
}

interface MirrorRowProps {
  stream: MediaStream;
  onStop: () => void;
  // 拖拽源仅限标题条（与会话卡片的 HTML5 排序拖拽一致）。整卡不能 draggable：
  // 画面区是 pointer pan 手势，一旦处于 draggable 祖先内，拖动即进入原生 DnD
  // 会话、pointermove 停发，平移/缩放全废。undefined 时不参与排序（单测直挂场景）。
  headDraggable?: boolean;
  onHeadDragStart?: () => void;
  onHeadDragEnd?: () => void;
}

// 会话列表行内的画面卡片。流由 useMirrorStream 持有（列表外），
// 本组件卸载只解绑 srcObject、绝不 stop tracks——虚拟列表滚动重挂后画面无缝续播。
// view/canvas/opacity 留在组件内：重挂即复位（缩放回 1x、透明度回 100），流不断是底线。
// 双击画面复位；滚轮缩放（锚点=光标）；拖动平移（含黑边区域）。
export function MirrorRow({ stream, onStop, headDraggable, onHeadDragStart, onHeadDragEnd }: MirrorRowProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // 视口层（.mirror-video-box）：flex 填满卡片剩余空间、overflow hidden
  const boxRef = useRef<HTMLDivElement>(null);
  // 画布尺寸：按流比例对视口 contain fit 后冻结，流分辨率变化（iPhone 旋转）时由 resize 监听重算
  const [canvas, setCanvas] = useState({ w: 0, h: 0 });
  // 画面视图：滚轮缩放 + 拖动平移（transform-origin 0 0，作用于画布）；pan 手势基准
  const [view, setView] = useState({ s: 1, tx: 0, ty: 0 });
  const panRef = useRef<{ startX: number; startY: number; baseTx: number; baseTy: number } | null>(null);
  // 画面透明度：1-100 整数档（◐ 按钮展开滑杆面板连续调节）
  const [opacity, setOpacity] = useState(100);
  const [showOpacityPanel, setShowOpacityPanel] = useState(false);
  // 透传聚合（非渲染态）与失败提示：ctrl 按住累计 deltaY，过阈值 POST 一次并冷却；
  // 事件间隔超 SWIPE_RESET_GAP_MS 视为新 gesture 重置累计（防 pinch 噪声慢性累计）
  const swipeRef = useRef({ acc: 0, last: 0, cooldownUntil: 0 });
  const [errFlash, setErrFlash] = useState('');
  const errTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashError = useCallback((msg: string) => {
    setErrFlash(msg);
    if (errTimerRef.current) clearTimeout(errTimerRef.current);
    errTimerRef.current = setTimeout(() => setErrFlash(''), 2000);
  }, []);
  useEffect(() => () => { if (errTimerRef.current) clearTimeout(errTimerRef.current); }, []);
  const triggerSwipeUp = useCallback(() => {
    fetch('/api/mirror/swipe-up', { method: 'POST' })
      .then((r) => r.json() as Promise<{ ok: boolean; reason?: string }>)
      .then((d) => {
        if (d.ok) return;
        if (d.reason === 'busy') return;  // 连划时的并发拒绝:静默,不打扰
        flashError(d.reason === 'window-not-found' ? '未找到 iPhone 镜像窗口' : '注入失败:检查辅助功能授权');
      })
      .catch(() => flashError('透传服务不可达'));
  }, [flashError]);

  // 画布 contain fit：按流分辨率对当前视口算等比尺寸（挂载/metadata/旋转 resize 时调用）
  const fitCanvas = useCallback(() => {
    const box = boxRef.current;
    const v = videoRef.current;
    if (!box || !v) return;
    const vw = v.videoWidth || FALLBACK_STREAM_W;
    const vh = v.videoHeight || FALLBACK_STREAM_H;
    const bw = box.clientWidth;
    const bh = box.clientHeight;
    if (!bw || !bh) return; // jsdom 无布局时等显式 stub 后由 loadedmetadata 触发
    const r = vw / vh;
    const fit = bw / bh > r ? { w: bh * r, h: bh } : { w: bw, h: bw / r };
    setCanvas(fit);
    // 1x 初始视图：画布在视口内居中
    setView({ s: 1, tx: (bw - fit.w) / 2, ty: (bh - fit.h) / 2 });
  }, []);

  // 挂载/换流时绑 srcObject 并尝试 fit（metadata 到达后 onLoadedMetadata 会再修正）；
  // 卸载只解绑画面，流的生命周期归 useMirrorStream 管
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = stream;
    fitCanvas();
    // iPhone 旋转 → 流分辨率互换只触发 video 的 resize（不冒泡，不重发
    // loadedmetadata），冻结画布须随 resize 重算，否则横屏画面 contain 在
    // 旧竖框里大黑边。原生监听与 wheel 同方案，卸载时对称移除
    v.addEventListener('resize', fitCanvas);
    // play() 的返回值不可假设为 Promise（jsdom 等环境返回 undefined），防御性判空
    const p = v.play() as Promise<void> | undefined;
    p?.catch(() => {});
    return () => {
      v.removeEventListener('resize', fitCanvas);
      v.srcObject = null;
    };
  }, [stream, fitCanvas]);

  // 点面板/按钮外部收起透明度滑杆面板（全局监听，卸载与收起时对称移除）
  useEffect(() => {
    if (!showOpacityPanel) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('.mirror-opacity-panel, .mirror-opacity')) setShowOpacityPanel(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [showOpacityPanel]);

  // wheel 必须用原生 addEventListener(passive:false)：React 合成 wheel 是 passive 的，
  // preventDefault 会被忽略；且卡片 DOM 挂在会话列表内，不拦截会冒泡滚动列表
  // （与 session-list.tsx 的 Row 滚轮拦截同方案，卸载时对称移除）
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // ⌃+双指上划 → 透传 iPhone 上划：不缩放、不冒泡；momentum 聚合防连发
      if (e.ctrlKey && SWIPE_UP_DELTA_SIGN * e.deltaY > 0) {
        e.preventDefault();
        e.stopPropagation();
        const now = Date.now();
        const s = swipeRef.current;
        if (now < s.cooldownUntil) return;
        if (now - s.last > SWIPE_RESET_GAP_MS) s.acc = 0;
        s.last = now;
        s.acc += SWIPE_UP_DELTA_SIGN * e.deltaY;  // 带符号累计:翻转 SIGN 时方向语义才对称
        if (s.acc >= SWIPE_TRIGGER_DELTA) {
          s.acc = 0;
          s.cooldownUntil = now + SWIPE_COOLDOWN_MS;
          triggerSwipeUp();
        }
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      // 步进 1.05：更平滑的逐级缩放
      const f = e.deltaY < 0 ? 1.05 : 1 / 1.05;
      // 视口 rect 不含 transform：视口相对坐标 → 画布局部只需减平移再除 scale
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      setView((v) => {
        const ns = clamp(v.s * f, 1, MAX_S);
        if (ns === v.s) return v;
        const px = (cx - v.tx) / v.s;
        const py = (cy - v.ty) / v.s;
        return {
          s: ns,
          // 锚点不动：px*s + t = px*ns + t' → t' = t - px*(ns - s)
          tx: clampShift(v.tx - px * (ns - v.s), ns, cw, canvas.w),
          ty: clampShift(v.ty - py * (ns - v.s), ns, ch, canvas.h),
        };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [canvas]);

  const onVideoPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    panRef.current = { startX: e.clientX, startY: e.clientY, baseTx: view.tx, baseTy: view.ty };
  };
  const onVideoPointerMove = (e: React.PointerEvent) => {
    const p = panRef.current;
    if (!p) return;
    const box = boxRef.current;
    setView((v) => ({
      ...v,
      tx: clampShift(p.baseTx + e.clientX - p.startX, v.s, box?.clientWidth ?? 0, canvas.w),
      ty: clampShift(p.baseTy + e.clientY - p.startY, v.s, box?.clientHeight ?? 0, canvas.h),
    }));
  };
  const endPan = (e: React.PointerEvent) => {
    panRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  return (
    <>
      <div
        className="mirror-head"
        draggable={headDraggable}
        onDragStart={onHeadDragStart}
        onDragEnd={onHeadDragEnd}
        title="拖动此条调整卡片位置"
      >
        <span className="mirror-live"><span className="dot" />LIVE</span>
        <span className="mirror-title">📱 iPhone 镜像</span>
        {errFlash && <span className="mirror-err">{errFlash}</span>}
        <button
          className="mirror-opacity"
          onClick={() => setShowOpacityPanel((s) => !s)}
          title="透明度：点击展开 1-100 调节"
        >
          ◐ {opacity}%
        </button>
        <button className="mirror-stop" onClick={onStop} title="停止共享">×</button>
        {showOpacityPanel && (
          <div className="mirror-opacity-panel" title="拖动调节透明度">
            <input
              type="range"
              min={1}
              max={100}
              value={opacity}
              onChange={(e) => setOpacity(Number(e.target.value))}
              aria-label="透明度"
            />
          </div>
        )}
      </div>
      <div
        ref={boxRef}
        className="mirror-video-box"
        onPointerDown={onVideoPointerDown}
        onPointerMove={onVideoPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onDoubleClick={() => {
          const box = boxRef.current;
          setView({ s: 1, tx: ((box?.clientWidth ?? 0) - canvas.w) / 2, ty: ((box?.clientHeight ?? 0) - canvas.h) / 2 });
        }}
        title="滚轮缩放 · 拖动平移 · 双击复位"
      >
        <video
          ref={videoRef}
          className="mirror-video"
          style={{
            width: canvas.w,
            height: canvas.h,
            transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`,
            transformOrigin: '0 0',
            // 透明度只作用于画面：卡片框架（标题条/边框）保持实体，画面变淡穿透
            opacity: opacity / 100,
          }}
          onLoadedMetadata={fitCanvas}
          muted
          autoPlay
          playsInline
        />
      </div>
    </>
  );
}
