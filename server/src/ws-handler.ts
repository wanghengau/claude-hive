import type { ClientMessage, IPtyManager, ServerMessage } from './protocol.js';

export interface WSLike {
  send(data: string): void;
  on(event: 'message', cb: (data: string) => void): void;
  on(event: 'close', cb: () => void): void;
}

export function handleConnection(ws: WSLike, mgr: IPtyManager): void {
  const send = (m: ServerMessage) => ws.send(JSON.stringify(m));

  const offData = mgr.onData((sessionId, data) => send({ type: 'data', sessionId, payload: data }));
  const offExit = mgr.onExit((sessionId, code) => send({ type: 'exit', sessionId, code }));
  const offCwd = mgr.onCwd((sessionId, cwd) => send({ type: 'cwd', sessionId, cwd }));

  ws.on('message', (raw: string) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'create': {
        const id = mgr.create({ cols: msg.cols, rows: msg.rows, cwd: msg.cwd });
        send({ type: 'created', sessionId: id });
        break;
      }
      case 'input':
        mgr.write(msg.sessionId, msg.data);
        break;
      case 'resize':
        mgr.resize(msg.sessionId, msg.cols, msg.rows);
        break;
      case 'close':
        mgr.close(msg.sessionId);
        break;
      case 'list': {
        const items = mgr.list();
        send({ type: 'sessions', items });
        for (const info of items) {
          const replay = mgr.getRingBuffer(info.sessionId);
          if (replay) send({ type: 'data', sessionId: info.sessionId, payload: replay });
          const cwd = mgr.getCwd(info.sessionId);
          if (cwd) send({ type: 'cwd', sessionId: info.sessionId, cwd });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    offData();
    offExit();
    offCwd();
  });
}
