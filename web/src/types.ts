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
  | { type: 'list' }
  | { type: 'paste-image'; sessionId: string; data: string; mimeType: string };

export type ServerMessage =
  | { type: 'created'; sessionId: string }
  | { type: 'data'; sessionId: string; payload: string }
  | { type: 'exit'; sessionId: string; code: number }
  | { type: 'sessions'; items: SessionInfo[] }
  | { type: 'cwd'; sessionId: string; cwd: string }
  | { type: 'commands'; sessionId: string; items: string[] }
  | { type: 'image-pasted'; sessionId: string; path: string }
  | { type: 'error'; sessionId: string; message: string };

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

export interface ToolStat { name: string; desc: string; descTokens: number; schemaTokens: number }
export interface Injection { chars: number; tokens: number; preview: string }
export interface ModelStat { model: string; count: number }
export interface HarnessProfile {
  sampleSize: number;
  windowScope: string;
  system: { identity: string; rules: string; rulesTokens: number };
  tools: ToolStat[];
  tokenOverhead: { systemTokens: number; toolsTokens: number; total: number };
  cacheStats: { avgCacheRead: number; avgInput: number; hitRate: number };
  injections: Injection[];
  models: ModelStat[];
}
