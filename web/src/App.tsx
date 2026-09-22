import { useEffect, useRef, useState } from 'react';
import { WsClient } from './ws-client.js';
import { useSessions } from './use-sessions.js';
import { useMirrorStream } from './use-mirror-stream.js';
import { SessionList } from './components/session-list.js';
import { MirrorBar, MIRROR_BAR_H } from './components/iphone-mirror-card.js';
import { MainTerminal, type MainTerminalHandle } from './components/main-terminal.js';
import { QuickInput } from './components/quick-input.js';
import { RecordView } from './components/record-view.js';
import { AnalyzeView } from './components/analyze-view.js';
import { TranscriptView } from './components/transcript-view.js';

const WS_URL = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;

export function App() {
  // StrictMode 会双调用 useState 初始化函数，从而创建两个 WsClient、两条 WS 连接：
  // 没注册 onOpen 的那条收不到 list 的 ring 重放，term 就只有一屏实时数据（length≈rows、baseY=0）。
  // 改用 ref 单例：ref.current 首次赋值后，StrictMode 二次 render 直接复用，全程只建一个连接。
  const clientRef = useRef<WsClient | null>(null);
  if (!clientRef.current) {
    const c = new WsClient(WS_URL);
    c.connect();
    clientRef.current = c;
  }
  const client = clientRef.current;

  const { sessions, activeId, setActiveId, create, close, reportSize, reorder } = useSessions(client);
  const active = sessions.find((s) => s.sessionId === activeId) ?? null;
  const mainRef = useRef<MainTerminalHandle>(null);
  const [recordViewId, setRecordViewId] = useState<string | null>(null);
  const [showAnalyze, setShowAnalyze] = useState(false);
  const [transcriptCwd, setTranscriptCwd] = useState<string | null>(null);
  // iPhone 镜像：流生命周期在列表外（hook），mirrorIndex 为镜像卡在渲染序列中的位置。
  // 不持久化：刷新后回列表底部
  const mirror = useMirrorStream();
  const [mirrorIndex, setMirrorIndex] = useState<number | null>(null);
  const startMirror = async () => {
    if (await mirror.start()) setMirrorIndex(sessions.length);
  };

  useEffect(() => {
    // 连接打开后再 list，避免连接未就绪时发送被丢弃；刷新 / 断线重连后恢复会话与历史
    return client.onOpen(() => client.send({ type: 'list' }));
  }, [client]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <span className="brand">TERMINAL</span>
          <button onClick={() => create(80, 24)}>+ 新建</button>
          <button className="brand-analyze" onClick={() => setShowAnalyze(true)}>🔧 分析</button>
        </div>
        <SessionList
          sessions={sessions}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={close}
          onShowRecord={setRecordViewId}
          onReorder={reorder}
          mirrorStream={mirror.stream}
          mirrorIndex={mirrorIndex}
          onMoveMirror={setMirrorIndex}
          onStopMirror={mirror.stop}
          bottomOffset={mirror.stream ? 0 : MIRROR_BAR_H}
        />
        {mirror.stream === null && <MirrorBar onStart={startMirror} />}
      </aside>
      <main className="main">
        {showAnalyze ? (
          <AnalyzeView onBack={() => setShowAnalyze(false)} />
        ) : transcriptCwd ? (
          <TranscriptView cwd={transcriptCwd} onBack={() => setTranscriptCwd(null)} />
        ) : recordViewId ? (
          <RecordView windowId={recordViewId} onBack={() => setRecordViewId(null)} />
        ) : (
          <>
            <div className="main-head">
              {active ? (
                <>
                  <span className="mh-cwd">{active.cwd || '~'}</span>
                  <span className={`row-status ${active.exited ? 'st-exited' : active.running ? 'st-running' : 'st-idle'}`}>
                    <span className="dot" />
                    {active.exited ? 'EXITED' : active.running ? 'RUNNING' : 'IDLE'}
                  </span>
                  <span className="mh-id">{active.sessionId}</span>
                  <button className="mh-transcript" title="查看 claude 对话历史（官方 transcript，完整可读）" onClick={() => setTranscriptCwd(active.cwd || '~')}>💬 对话</button>
                </>
              ) : (
                <span className="mh-id">NO ACTIVE SESSION</span>
              )}
            </div>
            <MainTerminal ref={mainRef} client={client} sessionId={activeId} reportSize={reportSize} />
            <QuickInput
              client={client}
              sessionId={activeId}
              onAfterSend={() => mainRef.current?.focus()}
            />
          </>
        )}
      </main>
    </div>
  );
}
