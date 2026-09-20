import { useEffect, useRef, useState, useCallback } from 'react';

// idle 态侧栏按钮条高度。连接后画面进悬浮窗、不占侧栏空间，
// App.tsx 据此恒定缩减会话列表高度（react-window 显式高度）。
export const MIRROR_BAR_H = 44;

// 悬浮窗几何：默认尺寸贴近 iPhone 竖屏比例（318:701），停靠视口右上。
// 缩放不设上限；60px 下限只是防窗口缩没后无法再操作（双击标题栏可复位）
const MIN_WH = 60;
const DEF_W = 220;
const DEF_H = 484;
// 画面缩放：只保 1x 下限（缩到底=画布原始冻结尺寸），放大不设上限
const MAX_S = Infinity;
// 流分辨率未知时的兜底比例（iPhone 竖屏）
const FALLBACK_STREAM_W = 318;
const FALLBACK_STREAM_H = 701;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

interface Geo { x: number; y: number; w: number; h: number }

function defaultGeo(): Geo {
  return {
    x: Math.max(0, window.innerWidth - DEF_W - 16),
    y: 16,
    w: DEF_W,
    h: Math.min(DEF_H, window.innerHeight - 32),
  };
}

interface DragBase { startX: number; startY: number }

// 平移范围双向泛化：内容小于视口时 [0, 视口-内容] 内自由移动（1x 居中），
// 大于视口时 [视口-内容, 0] 边缘不出界
function clampShift(t: number, s: number, viewSize: number, canvasSize: number) {
  const span = viewSize - canvasSize * s;
  return clamp(t, Math.min(0, span), Math.max(0, span));
}

// iPhone 镜像悬浮小窗：getDisplayMedia 选「iPhone镜像」窗口后实时播放。
// 窗口层：拖标题栏移动、右下角手柄调大小（视口=取景框，内容不随窗口缩放）、双击标题栏恢复默认几何。
// 画面层：固定尺寸画布 + 视口裁切。滚轮缩放（1x 起，锚点=光标）、拖动平移、双击画面居中复位。
// 回收路径有三条且必须全部成立（对称性）：浏览器"停止共享"（track ended）、停止按钮、组件卸载。
export function IPhoneMirrorCard() {
  const videoRef = useRef<HTMLVideoElement>(null);
  // 视口层（.mirror-video-box）：flex 填满窗口剩余空间、overflow hidden，随窗口 resize 变化
  const boxRef = useRef<HTMLDivElement>(null);
  // 流放 ref 而非 state：srcObject 是命令式绑定，不需要触发重渲染
  const streamRef = useRef<MediaStream | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [geo, setGeo] = useState<Geo>(defaultGeo);
  // 拖动/缩放窗口的起点与基准几何；为 null 表示手势未开始
  const dragRef = useRef<(DragBase & { base: Geo }) | null>(null);
  // 画布尺寸：连接时按流比例对视口 contain fit 一次后冻结——
  // 之后窗口 resize 只改裁切范围，画布与视图变换都不动（内容不随窗口缩放）
  const [canvas, setCanvas] = useState({ w: 0, h: 0 });
  // 画面视图：滚轮缩放 + 拖动平移（transform-origin 0 0，作用于画布）；pan 手势基准
  const [view, setView] = useState({ s: 1, tx: 0, ty: 0 });
  const panRef = useRef<{ startX: number; startY: number; baseTx: number; baseTy: number } | null>(null);
  // 悬浮窗透明度：1-100 整数档（◐ 按钮展开滑杆面板连续调节）
  const [opacity, setOpacity] = useState(100);
  const [showOpacityPanel, setShowOpacityPanel] = useState(false);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setStreaming(false);
  }, []);

  // 卸载时回收共享流，避免浏览器工具栏残留"正在共享屏幕"指示条
  useEffect(() => () => { streamRef.current?.getTracks().forEach((t) => t.stop()); }, []);

  const start = async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) return;
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      streamRef.current = s;
      // 用户点浏览器工具栏"停止共享"时 track 触发 ended，走统一回收
      s.getVideoTracks()[0].addEventListener('ended', stop);
      setStreaming(true);
    } catch {
      // 用户在选择器点了取消：静默保持 idle，不算错误
    }
  };

  // 画布 contain fit：按流分辨率对当前视口算一次等比尺寸并冻结
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

  // streaming=true 后 <video> 才挂载，挂载完成再绑流并尝试 fit（metadata 到达后 onLoadedMetadata 会再修正）
  useEffect(() => {
    if (streaming && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      fitCanvas();
      // play() 的返回值不可假设为 Promise（jsdom 等环境返回 undefined），防御性判空
      const p = videoRef.current.play() as Promise<void> | undefined;
      p?.catch(() => {});
    }
  }, [streaming, fitCanvas]);

  // ---- 窗口层：拖动（标题栏）与缩放（右下角手柄），clamp 保证不出视口、不小于防消失下限 ----

  const beginGesture = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, base: geo };
  };
  const endGesture = (e: React.PointerEvent) => {
    dragRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  const onTitlePointerDown = (e: React.PointerEvent) => {
    // 标题栏上的按钮与透明度滑杆面板不触发拖动
    if ((e.target as HTMLElement).closest('button, .mirror-opacity-panel')) return;
    beginGesture(e);
  };
  const onTitlePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    setGeo((g) => ({
      ...g,
      x: clamp(d.base.x + dx, 0, window.innerWidth - g.w),
      y: clamp(d.base.y + dy, 0, window.innerHeight - g.h),
    }));
  };

  const onResizePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    setGeo((g) => ({
      ...g,
      w: clamp(d.base.w + dx, MIN_WH, window.innerWidth - g.x),
      h: clamp(d.base.h + dy, MIN_WH, window.innerHeight - g.y),
    }));
  };

  // ---- 画面层：滚轮缩放（锚点=光标）+ 拖动平移，监听与手势都在视口层（含黑边区域） ----

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
  // preventDefault 会被忽略；且悬浮窗 DOM 挂在侧栏内，不拦截会冒泡滚动会话列表
  // （与 session-list.tsx 的 Row 滚轮拦截同方案，卸载时对称移除）
  useEffect(() => {
    if (!streaming) return;
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
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
  }, [streaming, canvas]);

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

  if (!streaming) {
    return (
      <div className="mirror-card" style={{ height: MIRROR_BAR_H }}>
        <button className="mirror-connect" onClick={start} title="选择共享「iPhone镜像」窗口">
          📱 iPhone 镜像 · 连接
        </button>
      </div>
    );
  }

  return (
    <div
      className="mirror-float"
      style={{ left: geo.x, top: geo.y, width: geo.w, height: geo.h, opacity: opacity / 100 }}
    >
      <div
        className="mirror-head"
        onPointerDown={onTitlePointerDown}
        onPointerMove={onTitlePointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onDoubleClick={() => setGeo(defaultGeo())}
        title="拖动移动 · 双击复位"
      >
        <span className="mirror-live"><span className="dot" />LIVE</span>
        <span className="mirror-title">📱 iPhone 镜像</span>
        <button
          className="mirror-opacity"
          onClick={() => setShowOpacityPanel((s) => !s)}
          title="透明度：点击展开 1-100 调节"
        >
          ◐ {opacity}%
        </button>
        <button className="mirror-stop" onClick={stop} title="停止共享">×</button>
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
          }}
          onLoadedMetadata={fitCanvas}
          muted
          autoPlay
          playsInline
        />
      </div>
      <div
        className="mirror-resize"
        onPointerDown={beginGesture}
        onPointerMove={onResizePointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        title="拖动缩放"
      />
    </div>
  );
}
