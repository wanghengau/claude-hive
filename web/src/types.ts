export interface SessionInfo {
  sessionId: string;
  createdAt: number;
  exited: boolean;
  exitCode?: number;
}

export type ClientMessage =
  | { type: 'create'; cols: number; rows: number; cwd?: string }
  | { type: 'input'; sessionId: string; data: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number }
  | { type: 'close'; sessionId: string }
  | { type: 'list' };

export type ServerMessage =
  | { type: 'created'; sessionId: string }
  | { type: 'data'; sessionId: string; payload: string }
  | { type: 'exit'; sessionId: string; code: number }
  | { type: 'sessions'; items: SessionInfo[] }
  | { type: 'cwd'; sessionId: string; cwd: string }
  | { type: 'commands'; sessionId: string; items: string[] };

export interface RecordSummary {
  date: string;
  id: string;
  ts: string | null;
  model: string | null;
  status: number | null;
  in: number;
  out: number;
}
export type RecordCounts = Record<string, number>;
