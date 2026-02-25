import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { config } from './config.js';
import { eventRouter, setBroadcaster } from './eventRouter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '../dist');

fs.mkdirSync(config.ttsCacheDir, { recursive: true });

// Stream clients using Bun's ServerWebSocket
const streamClients = new Set<any>();

setBroadcaster((data: unknown) => {
  const payload = JSON.stringify(data);
  for (const ws of streamClients) {
    try { ws.send(payload); } catch {}
  }
});

function serveStatic(filePath: string): Response {
  if (!fs.existsSync(filePath)) return new Response('Not found', { status: 404 });
  const ext = path.extname(filePath);
  const types: Record<string, string> = {
    '.html': 'text/html', '.js': 'application/javascript',
    '.css': 'text/css', '.vrm': 'application/octet-stream',
    '.json': 'application/json', '.png': 'image/png',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  };
  const file = Bun.file(filePath);
  return new Response(file, {
    headers: { 'Content-Type': types[ext] || 'application/octet-stream' }
  });
}

const server = Bun.serve<{ type: string }>({
  port: config.port,
  hostname: '0.0.0.0',

  fetch(req, server): Response | undefined {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // Health check
    if (pathname === '/health') {
      return Response.json({ status: 'ok', ts: Date.now() });
    }

    // WebSocket upgrade
    if (req.headers.get('upgrade') === 'websocket') {
      const isStream = pathname === '/ws/stream';
      const isOpenClaw = pathname === '/ws/openclaw';

      if (isOpenClaw || isStream) {
        const upgraded = server.upgrade(req, { data: { type: isStream ? 'stream' : 'openclaw' } });
        if (upgraded) return;
      }
      return new Response('Not found', { status: 404 });
    }

    // Audio files
    if (pathname.startsWith('/audio/')) {
      const file = path.join(config.ttsCacheDir, pathname.slice(7));
      return serveStatic(file);
    }

    // Static files from dist
    let filePath = path.join(distDir, pathname === '/' ? 'index.html' : pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return serveStatic(filePath);
    }
    // Fallback to index.html
    return serveStatic(path.join(distDir, 'index.html'));
  },

  websocket: {
    open(ws) {
      const { type } = ws.data as any;
      if (type === 'stream') {
        streamClients.add(ws);
        ws.send(JSON.stringify({ type: 'connected', ts: Date.now(), payload: {} }));
        console.log('[stream] client connected');
      } else {
        console.log('[openclaw] connected');
      }
    },
    message(ws, message) {
      const { type } = ws.data as any;
      if (type === 'openclaw') {
        try {
          const event = JSON.parse(message.toString());
          eventRouter(event);
        } catch (e) {
          console.error('[openclaw] bad event:', e);
        }
      }
    },
    close(ws) {
      const { type } = ws.data as any;
      streamClients.delete(ws);
      console.log(`[${type}] disconnected`);
    },
  }
});

console.log(`Nox server (Bun native) on :${server.port}`);
