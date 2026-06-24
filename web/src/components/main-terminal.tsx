import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { WsClient } from '../ws-client.js';

interface Props {
  client: WsClient;
  sessionId: string | null;
  reportSize: (sessionId: string, cols: number, rows: number) => void;
}

export interface MainTerminalHandle {
  focus: () => void;
}

export const MainTerminal = forwardRef<MainTerminalHandle, Props>(function MainTerminal(
  { client, sessionId, reportSize },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => termRef.current?.focus(),
    }),
    [],
  );

  useEffect(() => {
    if (!containerRef.current || !sessionId) return;
    const term = new Terminal({
      fontSize: 18,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', ui-monospace, Menlo, Consolas, monospace",
      scrollback: 50000,
      cursorBlink: true,
      cursorStyle: 'bar',
      theme: {
        background: '#0A1018',
        foreground: '#CBD5E1',
        cursor: '#22C55E',
        cursorAccent: '#0A1018',
        selectionBackground: 'rgba(34, 197, 94, 0.2)',
        black: '#0A1018', red: '#EF4444', green: '#22C55E', yellow: '#F59E0B',
        blue: '#38BDF8', magenta: '#A78BFA', cyan: '#22D3EE', white: '#CBD5E1',
        brightBlack: '#8294AB', brightRed: '#F87171', brightGreen: '#4ADE80',
        brightYellow: '#FBBF24', brightBlue: '#7DD3FC', brightMagenta: '#C4B5FD',
        brightCyan: '#67E8F9', brightWhite: '#F1F5F9',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    termRef.current = term;

    // fit 后把尺寸同步给 PTY（resize）和缩略图（reportSize），去重避免抖动
    let lastCols = 0;
    let lastRows = 0;
    const doFit = () => {
      fit.fit();
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        client.send({ type: 'resize', sessionId, cols: term.cols, rows: term.rows });
        reportSize(sessionId, term.cols, term.rows);
      }
    };
    doFit();

    // ResizeObserver 让终端始终铺满容器
    const ro = new ResizeObserver(doFit);
    ro.observe(containerRef.current);

    // 重放该会话历史，使切换到大窗时能看到之前的输出
    const buf = client.getBuffer(sessionId);
    if (buf) term.write(buf);

    const off = client.subscribeData(sessionId, (_sid, data) => term.write(data));
    const inputOff = term.onData((data) => client.send({ type: 'input', sessionId, data }));

    // 鼠标滚轮：滚动 xterm 的 scrollback 历史（回看整个会话输出），而不是发给应用——
    // claude 会截获滚轮去滚动它自己的输入框。tmux 未开 mouse 不拦截，滚轮会透传给 claude。
    // 在捕获阶段（capture）抢先处理：stopImmediatePropagation 阻止 xterm 内层元素的 wheel
    // 监听（即把滚轮作为鼠标报告发给应用），preventDefault 阻止浏览器默认滚动（需 passive:false），
    // 再手动 term.scrollLines 滚动历史。只拦滚轮，点击/选择/拖拽不受影响。
    // 像素模式(deltaMode=0)下触控板/高精度鼠标单次 deltaY 很小（常 <25px），直接 /25 取整会得 0
    // 导致完全不滚动；因此累积位移，每满一行高(~25px)才滚一行，余数留到下次。
    let wheelAccum = 0;
    const onWheel = (e: WheelEvent) => {
      const b = term.buffer.active;
      // alt screen（如 claude 全屏 TUI）：xterm scrollback 被 alt buffer 遮盖、根本滚不动，
      // 此时拦截滚轮只会让会话彻底无法回看——改为放行滚轮给应用，由 claude 自行翻历史。
      // 仅主 buffer（普通 shell 输出）才拦截滚轮、滚动 xterm scrollback。
      if (b.type === 'alt') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      let lines: number;
      if (e.deltaMode === 1) lines = e.deltaY;                   // DOM_DELTA_LINE：已是行数
      else if (e.deltaMode === 2) lines = e.deltaY * term.rows;  // DOM_DELTA_PAGE：换算成行
      else {                                                      // DOM_DELTA_PIXEL：累积折算
        wheelAccum += e.deltaY;
        lines = Math.trunc(wheelAccum / 25);
        wheelAccum -= lines * 25;
      }
      if (lines !== 0) term.scrollLines(lines);
    };
    containerRef.current.addEventListener('wheel', onWheel, { capture: true, passive: false });

    return () => {
      containerRef.current?.removeEventListener('wheel', onWheel, { capture: true });
      ro.disconnect();
      off();
      inputOff.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [client, sessionId, reportSize]);

  if (!sessionId) return <div className="main-empty">选择或新建一个终端会话</div>;
  return <div className="main-terminal" ref={containerRef} />;
});
