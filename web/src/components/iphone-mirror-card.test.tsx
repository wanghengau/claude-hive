import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { IPhoneMirrorCard } from './iphone-mirror-card.js';

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

function renderCard() {
  return render(<IPhoneMirrorCard />);
}

async function connect(fake: ReturnType<typeof makeFakeStream>) {
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

// 拖动/缩放共用的 pointer 手势：down → move → up
function gesture(el: Element, from: { x: number; y: number }, to: { x: number; y: number }) {
  firePointer(el, 'pointerdown', from);
  firePointer(el, 'pointermove', to);
  firePointer(el, 'pointerup', to);
}

function floatStyle() {
  const el = document.querySelector('.mirror-float') as HTMLElement;
  return el.style;
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

describe('IPhoneMirrorCard', () => {
  afterEach(() => vi.restoreAllMocks());

  it('idle 态渲染侧栏连接按钮，无悬浮窗', () => {
    renderCard();
    expect(screen.getByRole('button', { name: /iPhone 镜像/ })).toBeInTheDocument();
    expect(document.querySelector('.mirror-float')).toBeNull();
  });

  it('点击连接成功 → 弹出悬浮窗，video 绑定共享流', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    renderCard();
    const video = await connect(fake);
    expect(video.srcObject).toBe(fake.stream);
    expect(document.querySelector('.mirror-float')).not.toBeNull();
  });

  it('用户在选择器点取消 → 静默回 idle，不报错', async () => {
    stubGetDisplayMedia(() => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')));
    renderCard();
    screen.getByRole('button', { name: /iPhone 镜像/ }).click();
    await waitFor(() => expect(screen.getByRole('button', { name: /iPhone 镜像/ })).toBeInTheDocument());
    expect(screen.queryByText('LIVE')).not.toBeInTheDocument();
    expect(document.querySelector('.mirror-float')).toBeNull();
  });

  it('浏览器侧停止共享（track ended）→ 回收 track 并回 idle', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    renderCard();
    await connect(fake);
    fake.fire('ended');
    await waitFor(() => expect(screen.queryByText('LIVE')).not.toBeInTheDocument());
    expect(fake.track.stop).toHaveBeenCalled();
    expect(document.querySelector('.mirror-float')).toBeNull();
  });

  it('点停止按钮 → 回收 track 并回 idle', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    renderCard();
    await connect(fake);
    screen.getByRole('button', { name: '×' }).click();
    await waitFor(() => expect(screen.queryByText('LIVE')).not.toBeInTheDocument());
    expect(fake.track.stop).toHaveBeenCalled();
    expect(document.querySelector('.mirror-float')).toBeNull();
  });

  it('卸载组件 → 停止所有 track', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    const { unmount } = renderCard();
    await connect(fake);
    unmount();
    expect(fake.track.stop).toHaveBeenCalled();
  });

  it('拖动标题栏 → 悬浮窗位置随指针移动', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    renderCard();
    await connect(fake);
    const before = { left: floatStyle().left, top: floatStyle().top };
    // 左上方向移动，量控制在默认 y=16 的余量内，避开边界 clamp 干扰
    gesture(document.querySelector('.mirror-head')!, { x: 400, y: 300 }, { x: 350, y: 290 });
    // pointermove 属 React 18 continuous 事件，setState 异步调度，需等 re-render 提交
    await waitFor(() => expect(parseFloat(floatStyle().left)).toBeCloseTo(parseFloat(before.left) - 50));
    expect(parseFloat(floatStyle().top)).toBeCloseTo(parseFloat(before.top) - 10);
  });

  it('拖动右下角手柄 → 悬浮窗等量缩放，防消失下限 60px', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    renderCard();
    await connect(fake);
    const handle = document.querySelector('.mirror-resize')!;
    const before = { w: parseFloat(floatStyle().width), h: parseFloat(floatStyle().height) };
    // 缩小 (‑40, ‑60)
    gesture(handle, { x: 300, y: 300 }, { x: 260, y: 240 });
    await waitFor(() => expect(parseFloat(floatStyle().width)).toBeCloseTo(before.w - 40));
    expect(parseFloat(floatStyle().height)).toBeCloseTo(before.h - 60);
    // 拼命往小拖 → clamp 在防消失下限（两次都要等提交，第二次 down 的 base 才是最新几何）
    gesture(handle, { x: 500, y: 500 }, { x: 0, y: 0 });
    await waitFor(() => expect(parseFloat(floatStyle().width)).toBe(60));
    expect(parseFloat(floatStyle().height)).toBe(60);
  });

  it('resize 窗口 → 画布尺寸与视图变换保持不变（内容不随窗口缩放）', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    renderCard();
    const v = await connect(fake);
    await stubStage(400, 800);
    const winW0 = parseFloat(floatStyle().width);
    const frozen = { w: v.style.width, h: v.style.height, t: v.style.transform };
    // 视口尺寸变化（模拟窗口 resize）
    const box = boxEl();
    Object.defineProperty(box, 'clientWidth', { value: 600, configurable: true });
    Object.defineProperty(box, 'clientHeight', { value: 500, configurable: true });
    // 拖动手柄改窗口几何（触发 re-render）
    gesture(document.querySelector('.mirror-resize')!, { x: 300, y: 300 }, { x: 320, y: 320 });
    await waitFor(() => expect(parseFloat(floatStyle().width)).not.toBe(winW0));
    // 画布冻结：尺寸与 transform 都不变
    expect(v.style.width).toBe(frozen.w);
    expect(v.style.height).toBe(frozen.h);
    expect(v.style.transform).toBe(frozen.t);
  });

  it('双击标题栏 → 恢复默认位置与尺寸', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    renderCard();
    await connect(fake);
    const def = { left: floatStyle().left, top: floatStyle().top, w: floatStyle().width, h: floatStyle().height };
    gesture(document.querySelector('.mirror-head')!, { x: 400, y: 300 }, { x: 200, y: 200 });
    await waitFor(() => expect(floatStyle().left).not.toBe(def.left));
    fireEvent.dblClick(document.querySelector('.mirror-head')!);
    await waitFor(() => expect(floatStyle().left).toBe(def.left));
    expect(floatStyle().top).toBe(def.top);
    expect(floatStyle().width).toBe(def.w);
    expect(floatStyle().height).toBe(def.h);
  });

  it('滚轮上滚 → 画面放大（scale > 1）', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    renderCard();
    const v = await connect(fake);
    await stubStage(400, 800);
    fireEvent.wheel(boxEl(), { deltaY: -100, clientX: 100, clientY: 100 });
    await waitFor(() => expect(viewOf(v).s).toBeGreaterThan(1));
  });

  it('滚轮连续缩放 → 放大无上限，缩小 clamp 在 1x', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    renderCard();
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
    renderCard();
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
    renderCard();
    const v = await connect(fake);
    await stubStage(400, 800);
    const box = boxEl();
    for (let i = 0; i < 15; i++) fireEvent.wheel(box, { deltaY: -100, clientX: 200, clientY: 400 });
    await waitFor(() => expect(viewOf(v).s).toBeGreaterThanOrEqual(2));
    const before = v.style.transform;
    gesture(box, { x: 200, y: 400 }, { x: 240, y: 420 });
    await waitFor(() => expect(v.style.transform).not.toBe(before));
  });

  it('双击画面 → 复位缩放（1x 居中）', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    renderCard();
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

  it('透明度：◐ 按钮展开 1-100 滑杆，拖动实时调节', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    renderCard();
    await connect(fake);
    const floatEl = document.querySelector('.mirror-float') as HTMLElement;
    // 默认 100%
    expect(floatEl.style.opacity).toBe('1');
    // 点 ◐ 展开滑杆面板
    screen.getByRole('button', { name: /◐/ }).click();
    const slider = await screen.findByRole('slider');
    expect(slider).toHaveAttribute('min', '1');
    expect(slider).toHaveAttribute('max', '100');
    // 拖动滑杆到 35 → opacity 0.35，按钮显示 35%
    fireEvent.change(slider, { target: { value: '35' } });
    await waitFor(() => expect(floatEl.style.opacity).toBe('0.35'));
    expect(screen.getByRole('button', { name: /◐/ }).textContent).toBe('◐ 35%');
    // 调到下限 1
    fireEvent.change(slider, { target: { value: '1' } });
    await waitFor(() => expect(floatEl.style.opacity).toBe('0.01'));
  });

  it('透明度面板：再点 ◐ 或点面板外部 → 收起', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    renderCard();
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

  it('点透明度按钮/拖动滑杆不触发窗口拖动', async () => {
    const fake = makeFakeStream();
    stubGetDisplayMedia(() => Promise.resolve(fake.stream));
    renderCard();
    await connect(fake);
    const before = floatStyle().left;
    // 在透明度按钮上做完整拖动手势（若误触发拖动，窗口会移走）
    gesture(screen.getByRole('button', { name: /◐/ }), { x: 500, y: 40 }, { x: 400, y: 40 });
    await new Promise((r) => setTimeout(r, 50));
    expect(floatStyle().left).toBe(before);
    // 展开面板后在滑杆上拖动也不触发窗口拖动
    screen.getByRole('button', { name: /◐/ }).click();
    const slider = await screen.findByRole('slider');
    gesture(slider, { x: 500, y: 40 }, { x: 400, y: 40 });
    await new Promise((r) => setTimeout(r, 50));
    expect(floatStyle().left).toBe(before);
  });
});
