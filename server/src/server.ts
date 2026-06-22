import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { PtyManager } from './pty-manager.js';
import { handleConnection } from './ws-handler.js';
import { hasTmux } from './tmux.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '../../web/dist');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

export async function createServer(opts: {
  port: number;
  socketName?: string;
}) {
  if (!hasTmux()) {
    throw new Error('tmux 未安装，终端持久化服务无法启动');
  }
  const mgr = new PtyManager(opts.socketName ? { socketName: opts.socketName } : {});

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/sessions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(mgr.list()));
      return;
    }
    const filePath = path.join(WEB_ROOT, url === '/' ? 'index.html' : url);
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => handleConnection(ws as unknown as Parameters<typeof handleConnection>[0], mgr));
  server.on('close', () => mgr.dispose());

  return new Promise<{ server: http.Server; port: number }>((resolve) => {
    server.listen(opts.port, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({ server, port });
    });
  });
}

// 直接运行时启动
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  createServer({ port: Number(process.env.PORT ?? 4000) }).then(({ port }) => {
    console.log(`listening on http://localhost:${port}`);
  });
}
