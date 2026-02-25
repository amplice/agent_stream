/**
 * nox-bridge/run.ts — tails the OpenClaw log and sends real events to the Nox server
 *
 * Log events we care about (all JSONL, field "1" is the message string):
 *   embedded run agent start      → thinking
 *   embedded run tool start       → executing (with tool name extracted)
 *   telegram sendMessage ok       → speaking
 *   embedded run done             → idle
 */

import { readFileSync, existsSync, statSync } from 'fs';
import path from 'path';

const NOX_WS = 'wss://nox-stream-production.up.railway.app/ws/openclaw';

// Find today's log file
function getLogPath(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `/tmp/openclaw/openclaw-${date}.log`;
}

function send(ws: WebSocket, type: string, payload: unknown = {}) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ts: Date.now(), payload }));
  }
}

function parseLine(line: string): { type: string; payload: unknown } | null {
  if (!line.trim()) return null;
  try {
    const obj = JSON.parse(line);
    const msg: string = obj['1'] ?? '';

    // agent start → thinking
    if (msg.includes('embedded run agent start')) {
      return { type: 'thinking', payload: { text: 'processing...' } };
    }

    // tool start → executing
    const toolMatch = msg.match(/embedded run tool start:.*tool=(\S+)/);
    if (toolMatch) {
      const tool = toolMatch[1];
      // Map tool names to display labels
      const labels: Record<string, string> = {
        exec: 'exec', read: 'read', write: 'write', edit: 'edit',
        web_search: 'web_search', web_fetch: 'web_fetch',
        browser: 'browser', message: 'message', memory_search: 'memory_search',
      };
      const label = labels[tool] ?? tool;
      return { type: 'executing', payload: { command: label } };
    }

    // telegram message sent → speaking (agent replied)
    if (msg.includes('telegram sendMessage ok')) {
      return { type: 'speaking', payload: { text: '' } };
    }

    // run done → idle (after short delay to let speaking render)
    if (msg.includes('embedded run done')) {
      return { type: 'idle', payload: {} };
    }

    return null;
  } catch {
    return null;
  }
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('[bridge] starting — connecting to', NOX_WS);

  const ws = new WebSocket(NOX_WS);

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => { console.log('[bridge] connected'); resolve(); };
    ws.onerror = (e) => reject(new Error('ws error'));
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });

  // Start tailing log
  let logPath = getLogPath();
  let offset = existsSync(logPath) ? statSync(logPath).size : 0;
  console.log(`[bridge] tailing ${logPath} from offset ${offset}`);

  let lastSpeakTime = 0;
  let idleTimeout: ReturnType<typeof setTimeout> | null = null;

  function scheduleIdle() {
    if (idleTimeout) clearTimeout(idleTimeout);
    idleTimeout = setTimeout(() => {
      send(ws, 'idle', {});
    }, 2000);
  }

  while (true) {
    // Rotate log path at midnight
    const todayPath = getLogPath();
    if (todayPath !== logPath) {
      logPath = todayPath;
      offset = 0;
      console.log(`[bridge] rotated to ${logPath}`);
    }

    if (!existsSync(logPath)) {
      await sleep(1000);
      continue;
    }

    const size = statSync(logPath).size;
    if (size > offset) {
      const buf = readFileSync(logPath);
      const newData = buf.slice(offset, size).toString('utf8');
      offset = size;

      const lines = newData.split('\n');
      for (const line of lines) {
        const event = parseLine(line);
        if (!event) continue;

        // Coalesce rapid tool-start events — only send every 200ms
        if (event.type === 'executing') {
          send(ws, event.type, event.payload);
        } else if (event.type === 'speaking') {
          const now = Date.now();
          if (now - lastSpeakTime > 500) {
            lastSpeakTime = now;
            send(ws, 'speaking', event.payload);
            scheduleIdle();
          }
        } else {
          send(ws, event.type, event.payload);
        }
      }
    }

    await sleep(150);
  }
}

main().catch(e => {
  console.error('[bridge] fatal:', e);
  process.exit(1);
});
