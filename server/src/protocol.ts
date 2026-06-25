export interface SessionInfo {
  sessionId: string;
  createdAt: number;
  exited: boolean;
  exitCode?: number;
}

export type DataHandler = (sessionId: string, data: string) => void;
export type ExitHandler = (sessionId: string, exitCode: number) => void;
export type CwdHandler = (sessionId: string, cwd: string) => void;

export interface IPtyManager {
  create(opts: { cols: number; rows: number; cwd?: string }): string;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  close(sessionId: string): void;
  list(): SessionInfo[];
  getRingBuffer(sessionId: string): string;
  getCwd(sessionId: string): string;
  onData(h: DataHandler): () => void;
  onExit(h: ExitHandler): () => void;
  onCwd(h: CwdHandler): () => void;
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
