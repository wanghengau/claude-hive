import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { MirrorBar, MirrorRow } from './iphone-mirror-card.js';
import { useMirrorStream } from '../use-mirror-stream.js';

// jsdom 没有 mediaDevices，伪造最小 MediaStream：一条 video track + ended 事件回调表
function makeFakeStream() {
  const listeners: Record<string, () => void> = {};
  const track = {
    stop: vi.fn(),
    addEventListener: vi.fn((ev: string, cb: () => void) => { listeners[ev] = cb; }),
  };
  const stream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  };
  return { stream, track, fire: (ev: string) => listeners[ev]?.() };
}

function stubGetDisplayMedia(impl: () => Promise<unknown>) {
  const gdm = vi.fn(impl);
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getDisplayMedia: gdm },
    configurable: true,
  });
  return gdm;
}

// 与 App 层同构的最小接线：流 hook 在列表外持有，Bar/Row 按 stream 有无条件渲染。
// 渲染期把 hook 返回值写给外部变量，测试直接读（渲染返回后即有效）
let mirrorApi: ReturnType<typeof useMirrorStream>;
function Harness() {
  mirrorApi = useMirrorStream();
  return (
    <>
      {mirrorApi.stream === null && <MirrorBar onStart={mirrorApi.start} />}
      {mirrorApi.stream !== null && (
        <div className="mirror-row-card">
          <MirrorRow stream={mirrorApi.stream} onStop={mirrorApi.stop} />
        </div>
      )}
    </>
  );
}

function renderHarness() {
  return render(<Harness />);
}

async function connect(_fake: ReturnType<typeof makeFakeStream>) {
  screen.getByRole('button', { name: /iPhone 镜像/ }).click();
  await waitFor(() => expect(screen.getByText('LIVE')).toBeInTheDocument());
  // muted+autoplay 的 video 在 jsdom 无障碍树里没有稳定的隐式角色，直接按类名取
  return document.querySelector('video.mirror-video') as HTMLVideoElement;
}

// jsdom 25 没有 PointerEvent，fireEvent.pointer* 会 fallback 到 new Event()，
// 而 Event 构造器只认 bubbles/cancelable，坐标全被丢弃（归零）——必须手动构造补上
function firePointer(el: Element, type: string, c: { x: number; y: number }) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, { clientX: c.x, clientY: c.y, pointerId: 1, buttons: 1 });
  el.dispatchEvent(ev);
}

// 拖动画面平移共用的 pointer 手势：down → move → up
function gesture(el: Element, from: { x: number; y: number }, to: { x: number; y: number }) {
  firePointer(el, 'pointerdown', from);
  firePointer(el, 'pointermove', to);
  firePointer(el, 'pointerup', to);
}

function videoEl() {
  return document.querySelector('video.mirror-video') as HTMLVideoElement;
}

function boxEl() {
  return document.querySelector('.mirror-video-box') as HTMLElement;
}

function viewOf(v: HTMLVideoElement) {
  const m = v.style.transform.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/);
  return m ? { tx: parseFloat(m[1]), ty: parseFloat(m[2]), s: parseFloat(m[3]) } : { tx: 0, ty: 0, s: 1 };
}

// 画布模型：视口(.mirror-video-box)尺寸 + 流分辨率 → loadedmetadata 触发 fitCanvas 冻结画布
async function stubStage(viewW: number, viewH: number, streamW = 318, streamH = 701) {
  const box = boxEl();
  const v = videoEl();
  Object.defineProperty(box, 'clientWidth', { value: viewW, configurable: true });
  Object.defineProperty(box, 'clientHeight', { value: viewH, configurable: true });
  Object.defineProperty(v, 'videoWidth', { value: streamW, configurable: true });
  Object.defineProperty(v, 'videoHeight', { value: streamH, configurable: true });
  v.dispatchEvent(new Event('loadedmetadata'));
  await waitFor(() => expect(parseFloat(v.style.width)).toBeGreaterThan(0));
}

describe('MirrorBar / MirrorRow / useMirrorStream', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('idle 态渲染侧栏连接条，无镜像卡', () => {
    renderHarness();
    expect(screen.getByRole('button', { name: /iPhone 镜像/ })).toBeInTheDocument();
    expect(document.querySelector('.mirror-row-card')).toBeNull();
  });

  it('点击连接成功 → 镜像卡出现，video 绑定共享流', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    renderHarness();
    const video = await connect(fake);
    expect(video.srcObject).toBe(fake.stream);
    expect(document.querySelector('.mirror-row-card')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /iPhone 镜像 · 连接/ })).not.toBeInTheDocument();
  });

  it('用户在选择器点取消 → 静默回 idle，不报错', async () => {
    stubGetDisplayMedia(() => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')));
    renderHarness();
    screen.getByRole('button', { name: /iPhone 镜像/ }).click();
    await waitFor(() => expect(screen.getByRole('button', { name: /iPhone 镜像/ })).toBeInTheDocument());
    expect(screen.queryByText('LIVE')).not.toBeInTheDocument();
    expect(document.querySelector('.mirror-row-card')).toBeNull();
  });

  it('浏览器侧停止共享（track ended）→ 回收 track 并回 idle', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    renderHarness();
    await connect(fake);
    fake.fire('ended');
    await waitFor(() => expect(screen.queryByText('LIVE')).not.toBeInTheDocument());
    expect(fake.track.stop).toHaveBeenCalled();
    expect(document.querySelector('.mirror-row-card')).toBeNull();
    expect(screen.getByRole('button', { name: /iPhone 镜像/ })).toBeInTheDocument();
  });

  it('点停止按钮 → 回收 track 并回 idle', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    renderHarness();
    await connect(fake);
    screen.getByRole('button', { name: '×' }).click();
    await waitFor(() => expect(screen.queryByText('LIVE')).not.toBeInTheDocument());
    expect(fake.track.stop).toHaveBeenCalled();
    expect(document.querySelector('.mirror-row-card')).toBeNull();
  });

  it('MirrorRow 卸载（虚拟列表滚动移出）→ 只解绑画面，绝不 stop tracks（续播防线）', () => {
    const fake = makeFakeStream();
    const { unmount } = render(<MirrorRow stream={fake.stream as unknown as MediaStream} onStop={() => {}} />);
    const v = videoEl();
    expect(v.srcObject).toBe(fake.stream);
    unmount();
    expect(fake.track.stop).not.toHaveBeenCalled();
  });

  it('卸载整个 Harness（含流 hook）→ 停止所有 track', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    const { unmount } = renderHarness();
    await connect(fake);
    unmount();
    expect(fake.track.stop).toHaveBeenCalled();
  });

  it('拖拽源仅限标题条：headDraggable 时仅 head 可拖、画面区永不可拖（防 pan 手势被 DnD 劫走）', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    renderHarness();
    await connect(fake);
    // Harness 未传 headDraggable（直挂场景不参与排序）：head 不可拖
    expect(document.querySelector('.mirror-head')!.getAttribute('draggable')).toBeNull();
    expect(document.querySelector('.mirror-video-box')!.getAttribute('draggable')).toBeNull();
    cleanup();
    // 列表内场景（headDraggable=true）：仅 head 成为拖拽源
    render(
      <MirrorRow
        stream={fake.stream as unknown as MediaStream}
        onStop={() => {}}
        headDraggable
        onHeadDragStart={() => {}}
        onHeadDragEnd={() => {}}
      />,
    );
    expect(document.querySelector('.mirror-head')!.getAttribute('draggable')).toBe('true');
    expect(document.querySelector('.mirror-video-box')!.getAttribute('draggable')).toBeNull();
    expect(document.querySelector('video.mirror-video')!.getAttribute('draggable')).toBeNull();
  });

  it('滚轮上滚 → 画面放大（scale > 1）', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    renderHarness();
    const v = await connect(fake);
    await stubStage(400, 800);
    fireEvent.wheel(boxEl(), { deltaY: -100, clientX: 100, clientY: 100 });
    await waitFor(() => expect(viewOf(v).s).toBeGreaterThan(1));
  });

  it('滚轮连续缩放 → 放大无上限，缩小 clamp 在 1x', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    renderHarness();
    const v = await connect(fake);
    await stubStage(400, 800);
    const box = boxEl();
    for (let i = 0; i < 60; i++) fireEvent.wheel(box, { deltaY: -100, clientX: 200, clientY: 400 });
    await waitFor(() => expect(viewOf(v).s).toBeGreaterThanOrEqual(1.05 ** 50));
    for (let i = 0; i < 200; i++) fireEvent.wheel(box, { deltaY: 100, clientX: 200, clientY: 400 });
    await waitFor(() => expect(viewOf(v).s).toBe(1));
  });

  it('同一光标连续放大 → 锚点严格不动（无 clamp 干扰的宽视口）', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    renderHarness();
    const v = await connect(fake);
    // 宽视口：4 次放大后内容仍远小于视口，clamp 不介入，验证纯锚点数学
    await stubStage(800, 800);
    const box = boxEl();
    // jsdom 里 box rect 全 0，光标取视口中心 (400, 400)；先记录 1x 初始视图（含居中偏移）
    const v0 = viewOf(v);
    for (let i = 0; i < 4; i++) fireEvent.wheel(box, { deltaY: -100, clientX: 400, clientY: 400 });
    await waitFor(() => expect(viewOf(v).s).toBeCloseTo(1.05 ** 4, 5));
    const { tx, ty, s } = viewOf(v);
    // 锚点不变量：局部 px = (光标 - 初始tx)/初始s，放大后 视觉 = px*s + tx 应仍等于光标
    const px = 400 - v0.tx;
    const py = 400 - v0.ty;
    expect(px * s + tx).toBeCloseTo(400, 5);
    expect(py * s + ty).toBeCloseTo(400, 5);
  });

  it('放大后拖动画面 → 平移查看局部区域', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    renderHarness();
    const v = await connect(fake);
    await stubStage(400, 800);
    const box = boxEl();
    for (let i = 0; i < 15; i++) fireEvent.wheel(box, { deltaY: -100, clientX: 200, clientY: 400 });
    const before = v.style.transform;
    gesture(box, { x: 200, y: 400 }, { x: 240, y: 420 });
    await waitFor(() => expect(v.style.transform).not.toBe(before));
  });

  it('双击画面 → 复位缩放（1x 居中）', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    renderHarness();
    const v = await connect(fake);
    await stubStage(400, 800);
    const box = boxEl();
    for (let i = 0; i < 15; i++) fireEvent.wheel(box, { deltaY: -100, clientX: 200, clientY: 400 });
    await waitFor(() => expect(viewOf(v).s).toBeGreaterThanOrEqual(2));
    fireEvent.dblClick(box);
    await waitFor(() => expect(viewOf(v).s).toBe(1));
    // 1x 复位 = 画布在视口内居中
    const { tx } = viewOf(v);
    const cw = parseFloat(v.style.width);
    expect(tx).toBeCloseTo((400 - cw) / 2, 1);
  });

  it('透明度：◐ 按钮展开 1-100 滑杆，拖动实时调节（仅画面，卡片框架不受影响）', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    renderHarness();
    const v = await connect(fake);
    const cardEl = document.querySelector('.mirror-row-card') as HTMLElement;
    // 默认 100%
    expect(v.style.opacity).toBe('1');
    // 透明度只作用于画面：卡片容器不设 opacity
    expect(cardEl.style.opacity).toBe('');
    // 点 ◐ 展开滑杆面板
    screen.getByRole('button', { name: /◐/ }).click();
    const slider = await screen.findByRole('slider');
    expect(slider).toHaveAttribute('min', '1');
    expect(slider).toHaveAttribute('max', '100');
    // 拖动滑杆到 35 → 画面 opacity 0.35，按钮显示 35%
    fireEvent.change(slider, { target: { value: '35' } });
    await waitFor(() => expect(v.style.opacity).toBe('0.35'));
    expect(screen.getByRole('button', { name: /◐/ }).textContent).toBe('◐ 35%');
    // 调到下限 1
    fireEvent.change(slider, { target: { value: '1' } });
    await waitFor(() => expect(v.style.opacity).toBe('0.01'));
  });

  it('iPhone 旋转（流分辨率互换）→ 画布按新比例重排并复位视图，不冻结竖屏', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    renderHarness();
    const v = await connect(fake);
    await stubStage(400, 800); // 竖屏 318×701 → contain fit: 362.9×800
    expect(parseFloat(v.style.height)).toBeGreaterThan(parseFloat(v.style.width));
    // 旋转：分辨率互换，video 触发 resize（不会重发 loadedmetadata）
    Object.defineProperty(v, 'videoWidth', { value: 701, configurable: true });
    Object.defineProperty(v, 'videoHeight', { value: 318, configurable: true });
    v.dispatchEvent(new Event('resize'));
    // 横屏 701×318 → contain fit: 400×181.5
    await waitFor(() => {
      expect(parseFloat(v.style.width)).toBeGreaterThan(parseFloat(v.style.height));
    });
    expect(parseFloat(v.style.width)).toBeCloseTo(400, 1);
    expect(parseFloat(v.style.height)).toBeCloseTo(400 / (701 / 318), 1);
    // 视图复位：1x 居中
    const { tx, ty, s } = viewOf(v);
    expect(s).toBe(1);
    expect(tx).toBeCloseTo((400 - parseFloat(v.style.width)) / 2, 1);
    expect(ty).toBeCloseTo((800 - parseFloat(v.style.height)) / 2, 1);
  });

  it('透明度面板：再点 ◐ 或点面板外部 → 收起', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    renderHarness();
    await connect(fake);
    const btn = screen.getByRole('button', { name: /◐/ });
    btn.click();
    await screen.findByRole('slider');
    btn.click();
    await waitFor(() => expect(screen.queryByRole('slider')).toBeNull());
    // 重新展开，点面板外部（document.body）收起
    btn.click();
    await screen.findByRole('slider');
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await waitFor(() => expect(screen.queryByRole('slider')).toBeNull());
  });

  // ⌃+双指上划透传:jsdom 同步连发 wheel(mock fetch 同步计数,不走 waitFor)
  function ctrlSwipe(el: Element, deltaY = 60) {
    fireEvent.wheel(el, { deltaY, ctrlKey: true, clientX: 100, clientY: 100 });
  }

  it('⌃+上划累计过阈值 → fetch 透传一次;冷却窗内 momentum 连发不重复触发', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve({ json: () => Promise.resolve({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    renderHarness();
    await connect(fake);
    await stubStage(400, 800);
    const v = videoEl();
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 3; i++) ctrlSwipe(boxEl());          // 累计 180 ≥ 120 → 触发 1 次
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [pInput, pInit] = fetchMock.mock.calls[0];
      expect(pInput).toBe('/api/mirror/swipe-up');
      expect((pInit as RequestInit).method).toBe('POST');
      const s0 = viewOf(v).s;
      for (let i = 0; i < 30; i++) ctrlSwipe(boxEl());         // 冷却内连发
      expect(fetchMock).toHaveBeenCalledTimes(1);               // 仍 1 次
      expect(viewOf(v).s).toBe(s0);                            // 且未触发缩放
      vi.advanceTimersByTime(900);                              // 冷却结束
      for (let i = 0; i < 3; i++) ctrlSwipe(boxEl());
      expect(fetchMock).toHaveBeenCalledTimes(2);               // 可再次触发
    } finally { vi.useRealTimers(); }
  });

  it('⌃+下划(deltaY<0) → 不透传,保持原缩放行为', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    const fetchMock = vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    renderHarness();
    const v = await connect(fake);
    await stubStage(400, 800);
    for (let i = 0; i < 5; i++) fireEvent.wheel(boxEl(), { deltaY: -100, ctrlKey: true, clientX: 200, clientY: 400 });
    await waitFor(() => expect(viewOf(v).s).toBeGreaterThan(1)); // 原缩放照旧
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('低幅 wheel 间隔 >600ms → 累计重置,不误触(pinch 噪声防线)', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    const fetchMock = vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    renderHarness();
    await connect(fake);
    await stubStage(400, 800);
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 2; i++) { ctrlSwipe(boxEl(), 50); vi.advanceTimersByTime(700); } // 各 50,间隔重置
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('透传失败(window-not-found / 网络拒绝)→ 标题条短暂提示,不静默', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ ok: false, reason: 'window-not-found' }) })));
    renderHarness();
    await connect(fake);
    await stubStage(400, 800);
    vi.useFakeTimers();
    try {
      for (let i = 0; i <  3; i++) ctrlSwipe(boxEl());
      await vi.advanceTimersByTimeAsync(0);  // flush fetch 两层 .then 微任务
      expect(document.querySelector('.mirror-err')).not.toBeNull();
      expect(document.querySelector('.mirror-err')!.textContent).toContain('iPhone 镜像窗口');
      await vi.advanceTimersByTimeAsync(2100);  // 异步推进:setState 后等 React 渲染 flush
      expect(document.querySelector('.mirror-err')).toBeNull();  // 2s 后淡出
    } finally { vi.useRealTimers(); }
  });

  it('在飞 busy → 静默(连划时并发拒绝不打扰用户)', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ ok: false, reason: 'busy' }) })));
    renderHarness();
    await connect(fake);
    await stubStage(400, 800);
    for (let i = 0; i < 3; i++) ctrlSwipe(boxEl());
    for (let i = 0; i < 5; i++) await Promise.resolve();  // flush fetch 两层 .then 微任务
    expect(document.querySelector('.mirror-err')).toBeNull();  // busy 不显示错误
  });
});
