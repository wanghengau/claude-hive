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
      fontSize: 14,
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

    return () => {
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
