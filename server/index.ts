import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { config } from './config.js';
import { eventRouter, setBroadcaster } from './eventRouter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);

fs.mkdirSync(config.ttsCacheDir, { recursive: true });
app.use('/audio', express.static(config.ttsCacheDir));
app.use(express.static(path.join(__dirname, '../dist')));
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

// WS servers (noServer = we handle upgrade manually)
const openclawWss = new WebSocketServer({ noServer: true });
const streamWss = new WebSocketServer({ noServer: true });
const streamSet = new Set<WebSocket>();

setBroadcaster((data: unknown) => {
  const payload = JSON.stringify(data);
  for (const ws of streamSet) {
    try { if ((ws.readyState as number) === 1) ws.send(payload); } catch {}
  }
});

server.on('upgrade', (req, socket, head) => {
  const url = req.url ?? '';
  if (url === '/ws/openclaw') {
    const auth = (req.headers['authorization'] as string) ?? '';
    const token = auth.replace(/^Bearer\s+/i, '');
    // Auth disabled for local connections
    // if (config.secret && token !== config.secret) {
    //   socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    //   socket.destroy();
    //   return;
    // }
    openclawWss.handleUpgrade(req, socket, head, (ws) => openclawWss.emit('connection', ws));
  } else if (url === '/ws/stream') {
    streamWss.handleUpgrade(req, socket, head, (ws) => streamWss.emit('connection', ws));
  } else {
    socket.destroy();
  }
});

openclawWss.on('connection', (ws) => {
  console.log('[openclaw] connected');
  ws.on('message', (data) => {
    try { eventRouter(JSON.parse(data.toString())); }
    catch (e) { console.error('[openclaw] bad event:', e); }
  });
  ws.on('close', () => console.log('[openclaw] disconnected'));
  ws.on('error', (e) => console.error('[openclaw] error:', e.message));
});

streamWss.on('connection', (ws) => {
  streamSet.add(ws);
  ws.send(JSON.stringify({ type: 'connected', ts: Date.now(), payload: {} }));
  ws.on('close', () => streamSet.delete(ws));
  ws.on('error', () => streamSet.delete(ws));
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`Nox server on :${config.port}`);
});
