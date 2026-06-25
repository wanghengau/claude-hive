import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
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
const ORDER_KEY = 'term-session-order';

// 会话顺序持久化到 localStorage，刷新后保留用户拖拽的排序；不可用时降级为仅内存
function loadOrder(): string[] | null {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.every((x) => typeof x === 'string') ? arr : null;
  } catch {
    return null;
  }
}
function saveOrder(ids: string[]): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(ids));
  } catch {
    /* localStorage 不可用则降级为仅内存 */
  }
}

export function useSessions(client: WsClient) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sizes, setSizes] = useState<Record<string, { cols: number; rows: number }>>({});
  const [cwds, setCwds] = useState<Record<string, string>>({});
  const [commands, setCommands] = useState<Record<string, string[]>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [recordCounts, setRecordCounts] = useState<RecordCounts>({});
  // 用户拖拽产生的本地顺序覆盖；初始从 localStorage 恢复，null 表示沿用 server 下发顺序
  const [order, setOrder] = useState<string[] | null>(loadOrder);
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
        setCommands((prev) => {
          if (!(msg.sessionId in prev)) return prev;
          const next = { ...prev };
          delete next[msg.sessionId];
          return next;
        });
      } else if (msg.type === 'sessions') {
        setSessions(msg.items);
        setActiveId((cur) => cur ?? (msg.items[0]?.sessionId ?? null));
      } else if (msg.type === 'cwd') {
        setCwds((prev) => (prev[msg.sessionId] === msg.cwd ? prev : { ...prev, [msg.sessionId]: msg.cwd }));
      } else if (msg.type === 'commands') {
        setCommands((prev) => (prev[msg.sessionId] === msg.items ? prev : { ...prev, [msg.sessionId]: msg.items }));
      }
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

  // 按 order 重排：order 里的 id 优先（跳过已不存在的），新会话追加末尾。order 为 null 时沿用 server 顺序
  const orderedSessions = useMemo(() => {
    if (!order) return sessions;
    const byId = new Map(sessions.map((s) => [s.sessionId, s]));
    const seen = new Set<string>();
    const result: SessionInfo[] = [];
    for (const id of order) {
      const s = byId.get(id);
      if (s && !seen.has(id)) { result.push(s); seen.add(id); }
    }
    for (const s of sessions) {
      if (!seen.has(s.sessionId)) { result.push(s); seen.add(s.sessionId); }
    }
    return result;
  }, [sessions, order]);

  // 拖拽重排：基于当前显示顺序的索引，把 from 移到 to；写回 localStorage 供刷新后恢复
  const reorder = useCallback((from: number, to: number) => {
    setOrder((prev) => {
      const ids = orderedSessions.map((s) => s.sessionId);
      if (from === to || from < 0 || to < 0 || from >= ids.length || to >= ids.length) return prev;
      const next = [...ids];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      saveOrder(next);
      return next;
    });
  }, [orderedSessions]);

  const sessionsWithStatus: SessionWithStatus[] = orderedSessions.map((s) => {
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

  return { sessions: sessionsWithStatus, activeId, setActiveId, create, close, reportSize, reorder, recordCounts };
}
