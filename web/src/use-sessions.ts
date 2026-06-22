import { useEffect, useState, useCallback, useRef } from 'react';
import type { SessionInfo, RecordCounts } from './types.js';
import type { WsClient } from './ws-client.js';

export interface SessionWithStatus extends SessionInfo {
  cols: number;
  rows: number;
  running: boolean;
  cwd: string;
  commands: string[];
  recordCount: number;
}

// 有输出即视为"运行中"，静止超过此时长转为"等待输入"（事件驱动，非轮询）
const RUNNING_THRESHOLD_MS = 800;

export function useSessions(client: WsClient) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sizes, setSizes] = useState<Record<string, { cols: number; rows: number }>>({});
  const [cwds, setCwds] = useState<Record<string, string>>({});
  const [commands, setCommands] = useState<Record<string, string[]>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [recordCounts, setRecordCounts] = useState<RecordCounts>({});
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch('/api/record/counts');
        if (r.ok && alive) setRecordCounts(await r.json());
      } catch { /* server 未就绪忽略 */ }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  // 每会话的运行超时定时器（有新输出即重置）
  const runTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    return client.onMessage((msg) => {
      if (msg.type === 'created') {
        setSessions((s) => [...s, { sessionId: msg.sessionId, createdAt: Date.now(), exited: false }]);
        setActiveId(msg.sessionId);
      } else if (msg.type === 'data') {
        // 事件驱动 running：收到输出即运行中，重置超时定时器
        setRunning((prev) => (prev[msg.sessionId] ? prev : { ...prev, [msg.sessionId]: true }));
        if (runTimers.current[msg.sessionId]) clearTimeout(runTimers.current[msg.sessionId]);
        runTimers.current[msg.sessionId] = setTimeout(() => {
          setRunning((prev) => ({ ...prev, [msg.sessionId]: false }));
        }, RUNNING_THRESHOLD_MS);
      } else if (msg.type === 'exit') {
        // 会话退出（含点 × 关闭）即从列表移除
        setSessions((s) => s.filter((x) => x.sessionId !== msg.sessionId));
      } else if (msg.type === 'sessions') {
        setSessions(msg.items);
        setActiveId((cur) => cur ?? (msg.items[0]?.sessionId ?? null));
        // 刷新/重连恢复：从 localStorage 回填每会话命令历史
        const restored: Record<string, string[]> = {};
        for (const item of msg.items) restored[item.sessionId] = client.getCommands(item.sessionId);
        setCommands(restored);
      } else if (msg.type === 'cwd') {
        setCwds((prev) => (prev[msg.sessionId] === msg.cwd ? prev : { ...prev, [msg.sessionId]: msg.cwd }));
      }
    });
  }, [client]);

  // 命令成形时刷新该会话的命令历史
  useEffect(() => {
    return client.onCommand((sid) => {
      setCommands((prev) => ({ ...prev, [sid]: client.getCommands(sid) }));
    });
  }, [client]);

  // 卸载时清理所有运行定时器
  useEffect(() => {
    return () => {
      Object.values(runTimers.current).forEach(clearTimeout);
    };
  }, []);

  // activeId 失效时（如关闭了 active 会话）自动切到第一个剩余会话
  useEffect(() => {
    if (sessions.length === 0) {
      if (activeId !== null) setActiveId(null);
      return;
    }
    if (!sessions.some((s) => s.sessionId === activeId)) {
      setActiveId(sessions[0].sessionId);
    }
  }, [sessions, activeId]);

  const create = useCallback((cols: number, rows: number) => {
    client.send({ type: 'create', cols, rows });
  }, [client]);

  const close = useCallback((sessionId: string) => {
    client.send({ type: 'close', sessionId });
  }, [client]);

  const reportSize = useCallback((sessionId: string, cols: number, rows: number) => {
    setSizes((prev) => {
      const cur = prev[sessionId];
      if (cur && cur.cols === cols && cur.rows === rows) return prev;
      return { ...prev, [sessionId]: { cols, rows } };
    });
  }, []);

  const sessionsWithStatus: SessionWithStatus[] = sessions.map((s) => {
    const size = sizes[s.sessionId] ?? { cols: 80, rows: 24 };
    return {
      ...s,
      cols: size.cols,
      rows: size.rows,
      running: !s.exited && (running[s.sessionId] ?? false),
      cwd: cwds[s.sessionId] ?? '',
      commands: commands[s.sessionId] ?? [],
      recordCount: recordCounts[s.sessionId] ?? 0,
    };
  });

  return { sessions: sessionsWithStatus, activeId, setActiveId, create, close, reportSize, recordCounts };
}
