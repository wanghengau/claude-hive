import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { WsClient } from '../ws-client.js';

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // data URL format: data:image/png;base64,XXXXX — extract part after comma
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

interface Props {
  client: WsClient;
  sessionId: string | null;
  reportSize: (sessionId: string, cols: number, rows: number) => void;
}

// 过滤 alt screen 切换（ESC[?1049h/l）：让 claude 等全屏 TUI 留在主 buffer——
// 其流式输出固化为 scrollback（真终端不进 alt screen 时的可回看语义），画面不被
// alt buffer 遮盖。与 ws-client 对实时流的处理保持一致。
function stripAltScreen(s: string): string {
  return s.replace(/\x1b\[\?1049[hl]/g, '');
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

    // Intercept paste: detect images and send to server
    const onPaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (!blob) continue;

          // Check size (5MB limit)
          if (blob.size > 5 * 1024 * 1024) {
            console.warn('[paste] Image too large:', blob.size, 'bytes');
            return;
          }

          try {
            const base64 = await blobToBase64(blob);
            client.send({ type: 'paste-image', sessionId, data: base64, mimeType: item.type });
          } catch (err) {
            console.warn('[paste] Failed to read image:', err);
          }
          return;
        }
      }
    };

    containerRef.current.addEventListener('paste', onPaste);

    // Listen for server's image-pasted response and write @path to terminal
    const offMsg = client.onMessage((msg) => {
      if (!('sessionId' in msg) || msg.sessionId !== sessionId) return;
      if (msg.type === 'image-pasted') {
        // Send @path to CLI, without auto-return (no \r)
        client.send({ type: 'input', sessionId, data: `@${msg.path}` });
      }
    });


    return () => {
      containerRef.current?.removeEventListener('paste', onPaste);
      offMsg();
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
