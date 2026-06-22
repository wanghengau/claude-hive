import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { PtyManager } from './pty-manager.js';
import { handleConnection } from './ws-handler.js';
import { hasTmux } from './tmux.js';
import { handleProxy } from './record-proxy.js';
import { countRecords, listRecords, getRecord } from './record-store.js';

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

  const RECORD_TARGET = process.env.RECORD_TARGET || 'https://open.bigmodel.cn/api/anthropic';
  const RECORD_LOG_DIR = process.env.RECORD_LOG_DIR || path.resolve(__dirname, '../../data');
  const RECORD_MAX_BYTES = parseInt(process.env.RECORD_MAX_BYTES || String(10 * 1024 * 1024), 10);
  const RECORD_INJECT_WS = process.env.RECORD_INJECT_WEBSEARCH !== '0';

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';
    if (method === 'GET' && url.startsWith('/api/record/')) {
      const u = new URL(url, `http://localhost`);
      const json = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (u.pathname === '/api/record/counts') return json(200, countRecords(RECORD_LOG_DIR));
      if (u.pathname === '/api/record/list') {
        const wid = u.searchParams.get('window') || 'default';
        return json(200, listRecords(RECORD_LOG_DIR, wid));
      }
      const m = u.pathname.match(/^\/api\/record\/([A-Za-z0-9_-]+)\/(\d{4}-\d{2}-\d{2})\/([\w-]+)$/);
      if (m) {
        const rec = getRecord(RECORD_LOG_DIR, m[1], m[2], m[3]);
        if (!rec) return json(404, { error: 'not found' });
        return json(200, rec);
      }
      return json(404, { error: 'not found' });
    }
    if (method !== 'GET') {
      handleProxy(req, res, { target: RECORD_TARGET, logDir: RECORD_LOG_DIR, maxBytes: RECORD_MAX_BYTES, injectWebsearch: RECORD_INJECT_WS });
      return;
    }
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
