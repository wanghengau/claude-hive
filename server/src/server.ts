import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { PtyManager } from './pty-manager.js';
import { handleConnection } from './ws-handler.js';
import type { CmdCtx } from './ws-handler.js';
import { hasTmux } from './tmux.js';
import { handleProxy } from './record-proxy.js';
import { countRecords, listRecords, getRecord } from './record-store.js';
import { readQuickCommands, writeQuickCommands } from './quick-commands.js';
import { remove, prune } from './command-history.js';

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
  quickCommandsFile?: string;
}) {
  if (!hasTmux()) {
    throw new Error('tmux 未安装，终端持久化服务无法启动');
  }
  const mgr = new PtyManager(opts.socketName ? { socketName: opts.socketName } : {});

  const RECORD_TARGET = process.env.RECORD_TARGET || 'https://open.bigmodel.cn/api/anthropic';
  const RECORD_LOG_DIR = process.env.RECORD_LOG_DIR || path.resolve(__dirname, '../../data');
  const RECORD_MAX_BYTES = parseInt(process.env.RECORD_MAX_BYTES || String(10 * 1024 * 1024), 10);
  const RECORD_INJECT_WS = process.env.RECORD_INJECT_WEBSEARCH !== '0';
  const QUICK_COMMANDS_FILE = opts.quickCommandsFile
    || process.env.QUICK_COMMANDS_FILE
    || path.resolve(__dirname, '../../quick-commands.json');

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
    if (url === '/api/quick-commands') {
      const json = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (method === 'GET') return json(200, readQuickCommands(QUICK_COMMANDS_FILE));
      if (method === 'PUT') {
        let body = '';
        let tooBig = false;
        req.on('data', (c) => {
          body += c.toString('utf8');
          if (body.length > 256 * 1024) tooBig = true;
        });
        req.on('end', () => {
          if (tooBig) return json(413, { error: 'payload too large' });
          let arr: unknown;
          try { arr = JSON.parse(body); } catch { return json(400, { error: 'invalid json' }); }
          if (!Array.isArray(arr) || arr.length > 500 || arr.some((x) => typeof x !== 'string' || x.length > 2000)) {
            return json(400, { error: 'must be a string array (≤500 items, ≤2000 chars each)' });
          }
          try { writeQuickCommands(QUICK_COMMANDS_FILE, arr as string[]); } catch { return json(500, { error: 'write failed' }); }
          return json(200, { ok: true });
        });
        return;
      }
      return json(405, { error: 'method not allowed' });
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

  const COMMANDS_DIR = process.env.COMMANDS_DIR || path.resolve(__dirname, '../../data/commands');
  const cmdCtx: CmdCtx = { dir: COMMANDS_DIR, sessions: new Map() };
  const clients = new Set<Parameters<typeof handleConnection>[0]>();
  const broadcast = (m: import('./protocol.js').ServerMessage) => {
    const payload = JSON.stringify(m);
    for (const c of clients) c.send(payload);
  };

  // 会话结束(点 × 或 shell 自然退出)即清该会话历史 —— 对应「关闭窗口清理」
  mgr.onExit((sessionId) => {
    cmdCtx.sessions.delete(sessionId);
    remove(COMMANDS_DIR, sessionId);
  });

  // 启动清孤儿:restore 完成后,删 data/commands/ 里对应 tmux session 已不存在的文件
  mgr.restored.then(() => {
    prune(COMMANDS_DIR, new Set(mgr.list().map((s) => s.sessionId)));
  }).catch(() => { /* restore 失败不阻塞 */ });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    const wsLike = ws as unknown as Parameters<typeof handleConnection>[0];
    clients.add(wsLike);
    ws.on('close', () => { clients.delete(wsLike); });
    handleConnection(wsLike, mgr, cmdCtx, broadcast);
  });
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
