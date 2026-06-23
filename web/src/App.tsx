import { useEffect, useRef, useState } from 'react';
import { WsClient } from './ws-client.js';
import { useSessions } from './use-sessions.js';
import { SessionList } from './components/session-list.js';
import { MainTerminal, type MainTerminalHandle } from './components/main-terminal.js';
import { QuickInput } from './components/quick-input.js';
import { RecordView } from './components/record-view.js';

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
        </div>
        <SessionList
          sessions={sessions}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={close}
          onShowRecord={setRecordViewId}
          onReorder={reorder}
        />
      </aside>
      <main className="main">
        {recordViewId ? (
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
